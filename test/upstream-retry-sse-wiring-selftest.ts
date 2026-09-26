/**
 * Wiring test: the SSE decline retry must be reachable from the real retry helper.
 *
 * The unit test next door proves the wrapper behaves; this one proves the canonical lane's opt-in
 * actually reaches it, with a real `fetchWithTransientRetry` call and a stubbed fetch. It is the
 * question the 2026-09-26 incident asked: the wrapper existed, the decline happened, and nothing
 * logged -- so "is it even in this path?" has to be answerable without waiting for a live shed.
 *
 * The second attempt deliberately answers as a proper SSE stream, because the splice requires a
 * stream: a non-stream answer would be refused by the wrapper's own guard.
 *
 * Run: bun test/upstream-retry-sse-wiring-selftest.ts
 */
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { fetchWithTransientRetry } = await import(PKG + "/lib/upstream-retry.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const encoder = new TextEncoder();
const frame = (payload: Record<string, unknown>) =>
  "event: " + String(payload.type) + "\ndata: " + JSON.stringify(payload) + "\n\n";
const sse = (parts: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); },
}), { status: 200, headers: { "content-type": "text/event-stream" } });
const jsonBody = (payload: unknown) => new Response(encoder.encode(JSON.stringify(payload)),
  { status: 200, headers: { "content-type": "application/json" } });

async function readAll(response: Response, timeoutMs = 4000): Promise<string> {
  const reader = response.body!.getReader();
  let text = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += new TextDecoder().decode(value);
    }
  })();
  await Promise.race([pump, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
  try { await reader.cancel(); } catch { /* already done */ }
  return text;
}

// 1. The canonical opt-in path: a 200 + JSON refusal (wrong content-type) must be retried.
let sends = 0;
const first = await fetchWithTransientRetry(async () => {
  sends += 1;
  if (sends === 1) {
    return jsonBody({ error: { type: "server_error", code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later." } });
  }
  return sse([
    frame({ type: "response.created", response: { id: "r2", status: "in_progress", output: [] } }),
    frame({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "recovered" }),
    frame({ type: "response.completed", response: { id: "r2", status: "completed", output: [] } }),
  ]);
}, { retrySsePreludeDecline: true, retryCapacityDeferralsMs: [20], attempts: 1 });
const firstText = await readAll(first);
check("a canonical 200 refusal is re-sent through the real helper", sends === 2, "sends=" + sends);
check("the client sees the second attempt's answer", firstText.includes("recovered"));
check("and never the refusal", !firstText.includes("server_is_overloaded"));

// 2. Without the opt-in the helper must not wrap anything: one send, the refusal reaches the caller
//    (that is the pre-2026-09-26 behaviour for lanes that never asked for the wrapper).
sends = 0;
const second = await fetchWithTransientRetry(async () => {
  sends += 1;
  return jsonBody({ error: { type: "server_error", code: "server_is_overloaded", message: "overloaded" } });
}, { attempts: 1 });
const secondText = await readAll(second);
check("without the opt-in nothing is re-sent", sends === 1, "sends=" + sends);
check("and the refusal is delivered unchanged", secondText.includes("server_is_overloaded"));

console.log(failures === 0 ? "ALL SSE WIRING CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
