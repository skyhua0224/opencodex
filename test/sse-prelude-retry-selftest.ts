/**
 * Self-test for lib/sse-prelude-retry.ts (2026-09-24).
 *
 * The SSE lane's version of the WS prelude hold: a capacity decline that arrives after a 200 and
 * before any content must not reach the client -- the wrapper holds the prelude, throws that
 * attempt away, and splices the next attempt's frames into the same body.
 *
 * Run: bun ~/.opencodex/tools/sse-prelude-retry-selftest.ts
 */
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { withSsePreludeDeclineRetry } = await import(PKG + "/lib/sse-prelude-retry.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const SSE_HEADERS = { "content-type": "text/event-stream" };
const frame = (payload: unknown) => "event: " + (payload as { type?: string }).type + "\ndata: " + JSON.stringify(payload) + "\n\n";
const created = (id: string) => frame({ type: "response.created", response: { id, status: "in_progress", output: [] } });
const inProgress = () => frame({ type: "response.in_progress", response: { id: "r1", status: "in_progress" } });
const delta = (text: string) => frame({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text });
const overloadEvent = frame({ type: "error", error: { type: "server_error", message: "Our servers are currently overloaded. Please try again later." } });
const completed = (id: string) => frame({ type: "response.completed", response: { id, status: "completed", output: [] } });

function streamOf(parts: string[], options: { delayMs?: number; neverEnd?: boolean } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      }
      if (!options.neverEnd) controller.close();
    },
  });
}

function sseResponse(parts: string[], options?: { delayMs?: number; neverEnd?: boolean; status?: number }) {
  return new Response(streamOf(parts, options), { status: options?.status ?? 200, headers: SSE_HEADERS });
}

async function readAll(response: Response, timeoutMs = 3000) {
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

// A: prelude, then a capacity decline before any content -> the second attempt is spliced in.
let resends = 0;
const a = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), inProgress(), overloadEvent]),
  {
    delaysMs: [20],
    resend: async () => { resends += 1; return sseResponse([created("r2"), delta("hello"), completed("r2")]); },
  },
);
const aText = await readAll(a);
const createdLines = (aText.match(/event: response\.created/g) ?? []).length;
check("A: the declined attempt is discarded (one prelude only)", createdLines === 1, "created=" + createdLines);
check("A: the client never sees the overload event", !aText.includes("overloaded"));
check("A: the second attempt's content is delivered", aText.includes("hello"));
check("A: exactly one resend", resends === 1, "resends=" + resends);

// B: content first -> the decline is passed through and nothing is re-sent.
resends = 0;
const b = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), delta("hello"), overloadEvent]),
  { delaysMs: [20], resend: async () => { resends += 1; return sseResponse([delta("nope")]); } },
);
const bText = await readAll(b);
check("B: content is delivered", bText.includes("hello"));
check("B: the late decline is passed through", bText.includes("overloaded"));
check("B: no resend after content", resends === 0, "resends=" + resends);

// C: a normal stream keeps its prelude and order.
resends = 0;
const c = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), inProgress(), delta("hello"), completed("r1")]),
  { delaysMs: [20], resend: async () => { resends += 1; return sseResponse([]); } },
);
const cText = await readAll(c);
check("C: prelude and content both survive", cText.includes("response.created") && cText.includes("hello"));
check("C: order is preserved", cText.indexOf("response.created") < cText.indexOf("hello"));
check("C: no resend on a healthy stream", resends === 0, "resends=" + resends);

// D: a decline with no rung left is passed through rather than swallowed.
resends = 0;
const d = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), overloadEvent]),
  { delaysMs: [], resend: async () => { resends += 1; return sseResponse([]); } },
);
const dText = await readAll(d);
check("D: the decline reaches the client when nothing can be retried", dText.includes("overloaded"));
check("D: no resend was attempted", resends === 0, "resends=" + resends);

// E: a held prelude is released when the hold window expires.
const e = withSsePreludeDeclineRetry(
  sseResponse([created("r1")], { neverEnd: true }),
  { delaysMs: [20], holdMs: 80, resend: async () => sseResponse([]) },
);
const eText = await readAll(e, 600);
check("E: the held prelude is released on the hold timer", eText.includes("response.created"), "len=" + eText.length);


// F: the same stream framed with CRLF separators (which SSE allows) must still be retried.
// Before the splitter accepted \r\n\r\n the frames never split, the hold timer released them,
// and the decline slipped through to the client unretried -- the 2026-09-24 22:32 failure.
const crlf = (text: string) => text.replace(/\n\n/g, "\r\n\r\n");
resends = 0;
const f = withSsePreludeDeclineRetry(
  sseResponse([crlf(created("r1")) + crlf(overloadEvent)]),
  { delaysMs: [20], resend: async () => { resends += 1; return sseResponse([crlf(delta("hello"))]); } },
);
const fText = await readAll(f);
check("F: a CRLF-framed decline is retried", resends === 1, "resends=" + resends);
check("F: the CRLF decline never reaches the client", !fText.includes("overloaded"));
check("F: the retried attempt's content arrives", fText.includes("hello"));

console.log(failures === 0 ? "ALL SSE PRELUDE RETRY CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
