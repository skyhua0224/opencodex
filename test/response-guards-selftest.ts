/**
 * Self-test for the native response guards (2026-09-25):
 *
 *  * guardNativeDegenerateOutput -- a native (non-combo) stream that starts repeating itself is cut
 *    with a response.failed carrying code degenerate_output, and the verdict is announced once.
 *  * withResponseAttestation -- the origin reporting a different model, a lower service tier, or a
 *    safety buffer is recorded in ~/.opencodex/model-attestation.jsonl without touching the bytes.
 *
 * Run: bun test/response-guards-selftest.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Isolate the config home BEFORE the modules load: the attestation ledger path is resolved from it.
process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-guards-selftest-"));
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { guardNativeDegenerateOutput } = await import(PKG + "/server/responses/combo-degenerate-output.ts");
const { withResponseAttestation, attestationLedgerPath } = await import(PKG + "/lib/response-attestation.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const encoder = new TextEncoder();
const frame = (payload: unknown) => "event: " + (payload as { type?: string }).type + "\ndata: " + JSON.stringify(payload) + "\n\n";
const created = (model: string) => frame({ type: "response.created", response: { id: "r1", model, status: "in_progress", output: [] } });
const delta = (text: string) => frame({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text });
const completed = (model: string, tier?: string) => frame({ type: "response.completed", response: { id: "r1", model, status: "completed", ...(tier ? { service_tier: tier } : {}), output: [] } });

function streamResponse(frames: string[], headers: Record<string, string> = {}) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of frames) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

async function readAll(response: Response) {
  const reader = response.body!.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) text += new TextDecoder().decode(value);
  }
  return text;
}

function ledger() {
  try {
    return readFileSync(attestationLedgerPath(), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

// 1. A native stream that repeats one paragraph is cut instead of being relayed to the end.
const verdicts: string[] = [];
const paragraph = "the same paragraph comes back over and over without adding anything new";
const repeated = (count: number) => Array.from({ length: count }, () => delta(paragraph + "\n\n"));
const degenerateOut = await readAll(guardNativeDegenerateOutput(
  streamResponse([created("gpt-6-sol"), ...repeated(5), delta("tail")]),
  { lane: "lane-degenerate", label: "openai/gpt-6-sol", onVerdict: detail => verdicts.push(detail) },
));
check("degenerate: verdict announced exactly once", verdicts.length === 1, "verdicts=" + verdicts.length + " " + (verdicts[0] ?? ""));
check("degenerate: stream is terminated with degenerate_output", degenerateOut.includes("degenerate_output"));
check("degenerate: the cut frame is a response.failed", degenerateOut.includes("response.failed"));

// 1b. A run with no separators at all is caught by the compression rule instead of the segment rule.
const zlibVerdicts: string[] = [];
const longRun = "abcdefghij".repeat(400);   // ~4 KB of the same ten characters: zlib ratio explodes
await readAll(guardNativeDegenerateOutput(
  streamResponse([created("gpt-6-sol"), delta(longRun)]),
  { lane: "lane-zlib", onVerdict: detail => zlibVerdicts.push(detail) },
));
check("degenerate: a separator-free run is still caught", zlibVerdicts.length === 1, JSON.stringify(zlibVerdicts));

// 2. A model mismatch is recorded once, and the bytes still reach the client untouched.
const mismatchOut = await readAll(withResponseAttestation(
  streamResponse([created("gpt-6-luna"), delta("hello"), completed("gpt-6-luna", "default")]),
  { requestedModel: "gpt-6-sol", provider: "openai", lane: "lane-model" },
));
const afterMismatch = ledger();
check("model mismatch: recorded", afterMismatch.some(e => e.kind === "model-mismatch"), JSON.stringify(afterMismatch.map(e => e.kind)));
check("model mismatch: body untouched", mismatchOut.includes("hello"));

// 3. A tier downgrade against what was configured is recorded.
await readAll(withResponseAttestation(
  streamResponse([created("gpt-6-sol"), completed("gpt-6-sol", "default")]),
  { requestedModel: "gpt-6-sol", configuredTier: "fast", provider: "openai", lane: "lane-tier" },
));
const tiers = ledger().filter(e => e.kind === "tier-downgrade");
check("tier: downgrade recorded", tiers.length === 1, JSON.stringify(tiers));

// 4. The origin's safety buffer is recorded from the response headers alone.
await readAll(withResponseAttestation(
  streamResponse([created("gpt-6-sol"), completed("gpt-6-sol")], {
    "x-codex-safety-buffering-enabled": "true",
    "x-codex-safety-buffering-faster-model": "gpt-6-luna",
  }),
  { requestedModel: "gpt-6-sol", provider: "openai", lane: "lane-buffer" },
));
const buffers = ledger().filter(e => e.kind === "safety-buffering");
check("safety buffer: recorded", buffers.length === 1 && buffers[0].reported === "gpt-6-luna", JSON.stringify(buffers));

// 5. A healthy stream records nothing.
const before = ledger().length;
const healthyOut = await readAll(withResponseAttestation(
  streamResponse([created("gpt-6-sol"), delta("hello"), completed("gpt-6-sol", "default")]),
  { requestedModel: "gpt-6-sol", provider: "openai", lane: "lane-healthy" },
));
check("healthy: nothing recorded", ledger().length === before, "entries=" + (ledger().length - before));
check("healthy: body intact", healthyOut.includes("hello") && healthyOut.includes("response.completed"));

console.log(failures === 0 ? "ALL RESPONSE GUARD CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
