/**
 * Self-test for the WS prelude hold + layered capacity recovery (2026-09-24).
 *
 * Layering, cheapest path first:
 *  1. decline before any content, socket OPEN  -> resend the create frame on the live socket
 *     (1.5s, then 4s), discarding the declined attempt's held prelude;
 *  2. decline when the socket is gone or the resend budget is spent -> settle a REPLAYABLE 503 so
 *     the caller's capacity ladder re-dials a FRESH socket (5/12/25/45s);
 *  3. decline AFTER content was relayed -> forwarded untouched (a resend would double-generate).
 *
 * Also checks that a decline stated as \`response.failed\` is recognised, which the older absorb
 * was not: that is why it never reached rung 2 in production (12 of 12 stops at rung 1).
 *
 * Run: bun ~/.opencodex/tools/codex-ws-capacity-selftest.ts
 */
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { codexWsExchange } = await import(PKG + "/server/responses/codex-ws-exchange.ts");
const { CODEX_RESPONSES_HTTP_URL } = await import(PKG + "/server/responses/codex-ws-request.ts");
const { isNonReplayableResponse } = await import(PKG + "/lib/upstream-retry.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

function fakeSocket() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const socket = {
    readyState: 1,
    sent: [] as string[],
    addEventListener(type: string, fn: (event: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    send(text: string) { socket.sent.push(text); },
    close() { socket.readyState = 3; },
    ping() {},
    emit(type: string, event: unknown) {
      if (type === "close") socket.readyState = 3;
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
  return socket;
}

function fakeSession(socket: ReturnType<typeof fakeSocket>) {
  return {
    socket,
    opened: true,
    closed: false,
    busy: true,
    retainable: false,
    reused: false,
    reserve: () => true,
    bindOwner: () => () => {},
    dispose() { socket.close(); },
    release() {},
    hasCompleted: () => false,
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const text = (payload: unknown) => JSON.stringify(payload);
const EVENT = {
  created: (id: string) => text({ type: "response.created", response: { id, status: "in_progress", output: [] } }),
  overload: text({ type: "error", error: { type: "server_error", message: "Our servers are currently overloaded. Please try again later." } }),
  overloadFailed: text({ type: "response.failed", response: { id: "resp_1", status: "failed", error: { message: "Our servers are currently overloaded. Please try again later." } } }),
  otherError: text({ type: "error", error: { type: "invalid_request_error", message: "bad payload" } }),
  delta: text({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello" }),
  completed: (id: string) => text({ type: "response.completed", response: { id, status: "completed", output: [] } }),
};

async function run(script: (socket: ReturnType<typeof fakeSocket>) => void | Promise<void>) {
  const socket = fakeSocket();
  const pending = codexWsExchange({
    session: fakeSession(socket) as never,
    url: CODEX_RESPONSES_HTTP_URL,
    init: { method: "POST" },
    prepared: {
      frameText: text({ type: "response.create", stream: true }),
      headers: { "content-type": "application/json" },
      httpInit: { method: "POST" },
      canonical: true,
    },
    sseFallback: (async () => new Response("fallback", { status: 500 })) as never,
    bunVersion: "1.4.0-selftest",
  });
  const scriptDone = Promise.resolve(script(socket));
  const response = await pending;
  let relayed = "";
  if (response.status === 200 && response.body) {
    const reader = response.body.getReader();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) relayed += new TextDecoder().decode(value);
      }
    })();
    await Promise.race([pump, sleep(4000)]);
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  await Promise.race([scriptDone, sleep(200)]);
  return { status: response.status, nonReplayable: isNonReplayableResponse(response), relayed, sends: socket.sent.length };
}

// A1: decline while the socket is already gone -> replayable 503, nothing relayed.
const a1 = await run((socket) => {
  socket.emit("message", { data: EVENT.created("resp_1") });
  socket.close();
  socket.emit("message", { data: EVENT.overload });
});
check("A1: settled as 503", a1.status === 503, "status=" + a1.status);
check("A1: the 503 is REPLAYABLE", a1.nonReplayable === false);
check("A1: nothing reached the client", a1.relayed === "");

// A2: decline with a live socket -> resend, twice, then settle the replayable 503.
const a2 = await run(async (socket) => {
  socket.emit("message", { data: EVENT.created("resp_1") });
  socket.emit("message", { data: EVENT.overload });
  await sleep(2200);
  socket.emit("message", { data: EVENT.overloadFailed });
  await sleep(5000);
  socket.emit("message", { data: EVENT.overload });
});
check("A2: two in-socket resends were spent", a2.sends === 3, "sends=" + a2.sends);
check("A2: the session then settles a replayable 503", a2.status === 503 && !a2.nonReplayable, "status=" + a2.status);
check("A2: nothing reached the client", a2.relayed === "");

// B: content first -> the decline is relayed and nothing is re-sent.
const b = await run((socket) => {
  socket.emit("message", { data: EVENT.created("resp_1") });
  socket.emit("message", { data: EVENT.delta });
  socket.emit("message", { data: EVENT.overload });
});
check("B: content is delivered", b.relayed.includes("hello"));
check("B: the late decline is relayed", b.relayed.includes("\"type\":\"error\""));
check("B: no re-send", b.sends === 1, "sends=" + b.sends);

// C: non-capacity error before content -> forwarded as before.
const c = await run((socket) => {
  socket.emit("message", { data: EVENT.created("resp_1") });
  socket.emit("message", { data: EVENT.otherError });
});
check("C: non-capacity error is forwarded", c.relayed.includes("bad payload"));
check("C: non-capacity error is not swallowed", c.status === 200, "status=" + c.status);

// D: the held prelude is released as soon as content arrives.
const d = await run((socket) => {
  socket.emit("message", { data: EVENT.created("resp_1") });
  socket.emit("message", { data: EVENT.delta });
  socket.emit("message", { data: EVENT.completed("resp_1") });
});
check("D: prelude + content both reach the client", d.relayed.includes("response.created") && d.relayed.includes("hello"));
check("D: stream carries the terminal event", d.relayed.includes("response.completed"));


// E: the socket dies after the prelude but before anything was relayed -> the settle is
// REPLAYABLE, so the caller's ladder re-dials instead of the client seeing a failed turn.
const e = await run((socket) => {
  socket.emit("message", { data: EVENT.created("resp_1") });
  socket.emit("close", { code: 1006, reason: "Connection ended" });
});
check("E: a pre-content close settles as 502", e.status === 502, "status=" + e.status);
check("E: that 502 is REPLAYABLE (the ladder may re-dial)", e.nonReplayable === false);
check("E: the client saw nothing", e.relayed === "");

console.log(failures === 0 ? "ALL CODEX-WS CAPACITY CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
