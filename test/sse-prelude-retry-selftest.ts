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

// G: the decline arrived with a NON-SSE content-type. measured 2026-09-26 09:28/09:38: two native
// gpt-6-sol turns were shed, recorded terminal_sse + sendCount 1, and this wrapper never logged a
// line because it had bailed on the content-type check while the relay still parsed the body.
resends = 0;
const g = withSsePreludeDeclineRetry(
  new Response(streamOf([created("r1"), overloadEvent]), { status: 200, headers: { "content-type": "application/json" } }),
  {
    delaysMs: [20],
    acceptAnyContentType: true,
    resend: async () => { resends += 1; return sseResponse([created("r2"), delta("recovered"), completed("r2")]); },
  },
);
const gText = await readAll(g);
check("G: a decline with a wrong content-type is still retried", resends === 1, "resends=" + resends);
check("G: and the overload never reaches the client", !gText.includes("overloaded"));
check("G: the spliced attempt's content arrives", gText.includes("recovered"));

// G2: the same body WITHOUT the opt-in keeps the old behaviour (a caller that did not ask for it).
resends = 0;
const g2 = withSsePreludeDeclineRetry(
  new Response(streamOf([created("r1"), overloadEvent]), { status: 200, headers: { "content-type": "application/json" } }),
  { delaysMs: [20], resend: async () => { resends += 1; return sseResponse([delta("nope")]); } },
);
await readAll(g2);
check("G2: the opt-out is respected", resends === 0, "resends=" + resends);

// H: the decline is the LAST bytes, with no trailing frame separator at all.
resends = 0;
const h = withSsePreludeDeclineRetry(
  new Response(streamOf(['{"type":"response.failed","response":{"status":"failed","error":{"message":"Our servers are currently overloaded."}}}']),
    { status: 200, headers: SSE_HEADERS }),
  {
    delaysMs: [20],
    resend: async () => { resends += 1; return sseResponse([created("r2"), delta("second try"), completed("r2")]); },
  },
);
const hText = await readAll(h);
check("H: an unsplit trailing decline is retried", resends === 1, "resends=" + resends);
check("H: and its text never reaches the client", !hText.includes("overloaded"));
check("H: the second attempt answers", hText.includes("second try"));

// I: the safety case -- a SUCCESSFUL completion whose answer quotes the word "overloaded" must be
// delivered, never mistaken for a decline (this investigation's own answers contain that word).
resends = 0;
const quoted = frame({ type: "response.completed", response: { id: "r1", status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "the origin answered overloaded twice" }] }] } });
const i = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), quoted]),
  { delaysMs: [20], resend: async () => { resends += 1; return sseResponse([delta("nope")]); } },
);
const iText = await readAll(i);
check("I: a successful answer quoting the decline word is delivered",
  iText.includes("overloaded twice") && resends === 0,
  "resends=" + resends);

// J: a whole JSON body (no event framing) that merely MENTIONS capacity is an answer, not a
// decline. Delivered as-is, nothing re-sent.
resends = 0;
const plainAnswer = '{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"说明：上游此时报了 capacity，所以重试了三次。"}]}]}';
const j = withSsePreludeDeclineRetry(
  new Response(streamOf([plainAnswer]), { status: 200, headers: { "content-type": "application/json" } }),
  {
    delaysMs: [20],
    acceptAnyContentType: true,
    resend: async () => { resends += 1; return sseResponse([delta("nope")]); },
  },
);
const jText = await readAll(j);
check("J: a plain JSON answer mentioning capacity is delivered", jText.includes("capacity") && resends === 0,
  "resends=" + resends);

// J2: but a whole JSON body that IS an explicit refusal is retried.
resends = 0;
const plainDecline = '{"error":{"type":"server_error","code":"server_is_overloaded","message":"Our servers are currently overloaded."}}';
const j2 = withSsePreludeDeclineRetry(
  new Response(streamOf([plainDecline]), { status: 200, headers: { "content-type": "application/json" } }),
  {
    delaysMs: [20],
    acceptAnyContentType: true,
    resend: async () => { resends += 1; return sseResponse([created("r2"), delta("recovered"), completed("r2")]); },
  },
);
const j2Text = await readAll(j2);
check("J2: an explicit JSON refusal is retried", resends === 1, "resends=" + resends);
check("J2: and the client gets the recovered answer", j2Text.includes("recovered"));

// K: the shape that reached production on 2026-09-26 10:01:04 -- a STRUCTURAL frame
// (response.output_item.added) arrives first, then the capacity decline. Nothing the user can see
// was delivered, so the attempt must still be re-dialled, and the discarded attempt's structural
// frame must never be shown.
resends = 0;
const structural = frame({ type: "response.output_item.added", output_index: 0,
  item: { id: "msg_1", type: "message", status: "in_progress", content: [] } });
const k = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), structural, overloadEvent]),
  {
    delaysMs: [20],
    resend: async () => { resends += 1; return sseResponse([created("r2"), delta("recovered"), completed("r2")]); },
  },
);
const kText = await readAll(k);
check("K: a decline after a structural frame is still retried", resends === 1, "resends=" + resends);
check("K: the overload never reaches the client", !kText.includes("overloaded"));
check("K: the discarded attempt's item is not shown", !kText.includes("output_item.added"));
check("K: the second attempt's content arrives", kText.includes("recovered"));

// K2: but once a TEXT delta has gone out, the rule still refuses to resend.
resends = 0;
const k2 = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), structural, delta("partial answer"), overloadEvent]),
  { delaysMs: [20], resend: async () => { resends += 1; return sseResponse([delta("nope")]); } },
);
const k2Text = await readAll(k2);
check("K2: text already delivered still blocks the resend", resends === 0, "resends=" + resends);
check("K2: and the partial answer is delivered", k2Text.includes("partial answer"));

// L: the shape behind the 2026-09-26 20:15/20:33 failures -- the origin closes an item with an
// EMPTY response.output_item.done, then sheds. No delta of any kind had arrived (the row's
// firstOutputMs was null), so nothing was delivered and the attempt must be re-dialled.
resends = 0;
const emptyDone = frame({ type: "response.output_item.done", output_index: 0,
  item: { id: "rs_1", type: "reasoning", status: "completed", content: [] } });
const l = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), emptyDone, overloadEvent]),
  {
    delaysMs: [20],
    resend: async () => { resends += 1; return sseResponse([created("r2"), delta("recovered"), completed("r2")]); },
  },
);
const lText = await readAll(l);
check("L: a decline after an EMPTY .done is retried", resends === 1, "resends=" + resends);
check("L: the overload never reaches the client", !lText.includes("overloaded"));
check("L: the second attempt answers", lText.includes("recovered"));

// L2: a .done that DOES carry text still blocks the resend.
resends = 0;
const textDone = frame({ type: "response.output_text.done", output_index: 0, text: "already visible" });
const l2 = withSsePreludeDeclineRetry(
  sseResponse([created("r1"), textDone, overloadEvent]),
  { delaysMs: [20], resend: async () => { resends += 1; return sseResponse([delta("nope")]); } },
);
const l2Text = await readAll(l2);
check("L2: a payload-bearing .done still blocks the resend", resends === 0, "resends=" + resends);
check("L2: and its text is delivered", l2Text.includes("already visible"));

console.log(failures === 0 ? "ALL SSE PRELUDE RETRY CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
