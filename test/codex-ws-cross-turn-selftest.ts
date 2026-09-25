/**
 * Self-test for cross-turn WebSocket reuse (2026-09-25).
 *
 * One question, three answers:
 *  1. identity  - the NEXT turn of the same conversation keys the same socket when the feature is
 *                 on, keys a fresh one per turn when it is off, and the breaker flips it back;
 *  2. lifetime  - a retained socket survives the 30s per-turn idle window under the wider
 *                 cross-turn windows, and does not survive it when the feature is off;
 *  3. marking   - the lease says whether it is a cross-turn reuse or a resend inside one turn, so
 *                 every later settle can be attributed to the right half of the lane.
 *
 * Run: bun test/codex-ws-cross-turn-selftest.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Evidence rows must not land in the operator's real ledger.
process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-cross-turn-"));

const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { CodexWsPool, codexWsReuseIdentity, codexWsCrossTurnReuseEnabled, codexWsCrossTurnStats,
  noteCodexWsCrossTurnResult, resetCodexWsCrossTurnState } =
  await import(PKG + "/server/responses/codex-ws-pool.ts");
const { CODEX_RESPONSES_HTTP_URL } = await import(PKG + "/server/responses/codex-ws-request.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const HEADERS = { authorization: "Bearer selftest", "chatgpt-account-id": "acct-selftest" };
function frame(thread: string, turn: string, model = "gpt-6-sol"): string {
  return JSON.stringify({ model, stream: true, client_metadata: { thread_id: thread, turn_id: turn } });
}
function identity(thread: string, turn: string, model = "gpt-6-sol") {
  return codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, HEADERS, frame(thread, turn, model));
}
function key(thread: string, turn: string, model = "gpt-6-sol"): string | undefined {
  return identity(thread, turn, model)?.key;
}

// --- identity -----------------------------------------------------------------------------------
process.env.OCX_WS_CROSS_TURN_REUSE = "1";
resetCodexWsCrossTurnState();
const first = identity("thread-a", "turn-1");
const second = identity("thread-a", "turn-2");
check("identity: the next turn of one conversation shares the socket key",
  first !== null && second !== null && first.key === second.key);
check("identity: the turn that opened the socket is still recorded",
  first !== null && second !== null && first.turn !== second.turn);
check("identity: another conversation never shares it", key("thread-b", "turn-1") !== first?.key);
check("identity: a different model is a different socket",
  key("thread-a", "turn-2", "gpt-6-luna") !== first?.key);

process.env.OCX_WS_CROSS_TURN_REUSE = "0";
check("switch off: one socket per turn",
  key("thread-a", "turn-1") !== key("thread-a", "turn-2"));

// A real Codex turn carries a multi-kilobyte x-oai-attestation header (measured 4170 bytes). The
// 4 KiB per-field bound this pool inherited from the response-id validator rejected every one of
// them, which is why the pool never saw real traffic. Large values are hashed into the key instead.
process.env.OCX_WS_CROSS_TURN_REUSE = "1";
const attested = { ...HEADERS, "x-oai-attestation": "a".repeat(4170) };
const attestedOne = codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, attested, frame("thread-a", "turn-1"));
const attestedTwo = codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, attested, frame("thread-a", "turn-2"));
check("identity: a 4 KiB attestation header still keys a socket", attestedOne !== null);
check("identity: and the next turn of that conversation shares it",
  attestedOne !== null && attestedOne.key === attestedTwo?.key);
// Measured on a real conversation: the attestation is refreshed per attempt, so a key that read it
// could never match twice.
const refreshed = { ...HEADERS, "x-oai-attestation": "b".repeat(4000) };
check("identity: a refreshed attestation does not split the socket",
  attestedOne !== null
  && codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, refreshed, frame("thread-a", "turn-2"))?.key === attestedOne.key);
check("identity: an unusable header value still refuses",
  codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL,
    { ...HEADERS, "x-codex-beta-features": "a" + String.fromCharCode(1) + "b" }, frame("thread-a", "turn-1")) === null);
process.env.OCX_WS_CROSS_TURN_REUSE = "0";

// --- breaker ------------------------------------------------------------------------------------
process.env.OCX_WS_CROSS_TURN_REUSE = "1";
resetCodexWsCrossTurnState();
check("breaker: reuse starts enabled", codexWsCrossTurnReuseEnabled());
for (let index = 0; index < 4; index += 1) {
  noteCodexWsCrossTurnResult(false, { reason: "selftest" });
}
const tripped = codexWsCrossTurnStats();
check("breaker: opens after a run of reused-socket failures",
  tripped.enabled === false && tripped.trips === 1, JSON.stringify(tripped));
check("breaker: the lane keys a fresh socket per turn again while it is open",
  key("thread-a", "turn-1") !== key("thread-a", "turn-2"));
resetCodexWsCrossTurnState();
check("breaker: reset restores reuse (test seam only)", codexWsCrossTurnReuseEnabled());

// --- lifetime -----------------------------------------------------------------------------------
const server = Bun.serve({
  port: 0,
  fetch(request, srv) {
    return srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 });
  },
  websocket: { message() { /* the pool never reads frames in this test */ } },
});
const URL_UNDER_TEST = "ws://127.0.0.1:" + server.port + "/v1/responses";
const sessionHeaders = { "x-selftest": "cross-turn" };

async function waitOpen(session: { opened: boolean }, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.opened) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return session.opened;
}

let clock = 1_000_000;
const pool = new CodexWsPool({
  now: () => clock,
  idleMs: 30_000,
  maxAgeMs: 300_000,
  crossTurnIdleMs: 60_000,
  crossTurnMaxAgeMs: 600_000,
});
// The identity a turn keys is derived from the conversation, not the turn, whenever cross-turn
// reuse is on -- so the next turn carries the SAME key and a different turn label.
const openIdentity = { key: "k-a", scope: "s-a", turn: "t1" };
const nextIdentity = { key: "k-a", scope: "s-a", turn: "t2" };
// A different model keeps the conversation scope and changes the key: same-retire, new socket.
const otherModelIdentity = { key: "k-a-luna", scope: "s-a", turn: "t2" };
const plainIdentity = { key: "k-p1", scope: "s-p1", turn: "t1" };
const plainNextIdentity = { key: "k-p2", scope: "s-p2", turn: "t2" };
const turnOne = pool.acquire(openIdentity, URL_UNDER_TEST, sessionHeaders);
check("pool: the first turn dials a socket", turnOne !== null && !turnOne.crossTurnReuse);
if (turnOne) {
  check("pool: that socket connected", await waitOpen(turnOne));
  turnOne.release("resp_1");
  const resend = pool.acquire(openIdentity, URL_UNDER_TEST, sessionHeaders);
  check("pool: a resend inside the same turn is not a cross-turn reuse",
    resend === turnOne && !turnOne.crossTurnReuse);
  resend?.release("resp_2");
  clock += 45_000;
  pool.sweep();
  check("lifetime: the retained socket outlives the 30s per-turn window",
    pool.snapshot().size === 1, JSON.stringify(pool.snapshot()));
  const later = pool.acquire(nextIdentity, URL_UNDER_TEST, sessionHeaders);
  check("lifetime: the next turn gets that same socket", later === turnOne);
  check("lifetime: and the lease says it is a cross-turn reuse", later?.crossTurnReuse === true);
  const switched = pool.acquire(otherModelIdentity, URL_UNDER_TEST, sessionHeaders);
  check("scope: a different model retires the socket instead of sharing it", switched !== turnOne);
  switched?.release(null);
  later?.release(null);
}

process.env.OCX_WS_CROSS_TURN_REUSE = "0";
let plainClock = 1_000_000;
const plainPool = new CodexWsPool({
  now: () => plainClock,
  idleMs: 30_000,
  maxAgeMs: 300_000,
  crossTurnIdleMs: 60_000,
  crossTurnMaxAgeMs: 600_000,
});
const plainOne = plainPool.acquire(plainIdentity, URL_UNDER_TEST, sessionHeaders);
if (plainOne) {
  await waitOpen(plainOne);
  plainOne.release("resp_1");
  plainClock += 45_000;
  plainPool.sweep();
  check("switch off: the per-turn window still retires the socket",
    plainPool.snapshot().size === 0, JSON.stringify(plainPool.snapshot()));
  const plainTwo = plainPool.acquire(plainNextIdentity, URL_UNDER_TEST, sessionHeaders);
  check("switch off: the next turn dials its own socket", plainTwo !== plainOne);
  plainTwo?.release(null);
}

pool.dispose();
plainPool.dispose();
server.stop(true);

console.log(failures === 0 ? "ALL CODEX-WS CROSS-TURN CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
