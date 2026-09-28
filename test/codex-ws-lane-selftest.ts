/**
 * Self-test for the lane-level WebSocket breaker (2026-09-26).
 *
 * The shape being detected: every dial completes, receives control frames only, and is closed by
 * the origin with an abnormal code and no response event -- measured 2026-09-26 07:00 for the whole
 * account at once, while HTTP answered normally. What must hold:
 *
 *  1. two control-only closes do not trip it; the third inside the window does;
 *  2. an ordinary turn failure never counts (relayed content, normal codes, many frames);
 *  3. the hold escalates across trips and expires on its own, then trusts the lane again;
 *  4. a real response clears the window, and a recovered lane resets the rung;
 *  5. the hold survives a restart through its state file.
 *
 * Run: bun test/codex-ws-lane-selftest.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-ws-lane-"));
const home = process.env.OPENCODEX_HOME;

const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { codexWsLaneDisabled, codexWsLaneSnapshot, noteCodexWsLaneRefusal, noteCodexWsLaneSuccess,
  clearCodexWsLaneHold, resetCodexWsLaneForTests } = await import(PKG + "/server/responses/codex-ws-lane.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const refusal = (now: number) => noteCodexWsLaneRefusal(
  { closeCode: 1011, relayedEvents: 0, upstreamFrames: 2, firstFrameMs: 1054, elapsedMs: 1070 }, now);

resetCodexWsLaneForTests();
check("a fresh lane is trusted", codexWsLaneDisabled(1000) === false);
refusal(1000);
refusal(2000);
check("two control-only closes do not trip it", codexWsLaneDisabled(3000) === false);
check("the third one does", refusal(3000) === true && codexWsLaneDisabled(3000));
const first = codexWsLaneSnapshot(3000);
check("the first hold is the short one", first.rung === 1 && first.trips === 1);

check("an ordinary turn failure never counts", (() => {
  resetCodexWsLaneForTests();
  for (let i = 0; i < 5; i++) {
    noteCodexWsLaneRefusal({ closeCode: 1011, relayedEvents: 4, upstreamFrames: 12 }, 1000 + i);
    noteCodexWsLaneRefusal({ closeCode: 1000, relayedEvents: 0, upstreamFrames: 2 }, 1000 + i);
    noteCodexWsLaneRefusal({ closeCode: 1006, relayedEvents: 0, upstreamFrames: 40 }, 1000 + i);
  }
  return codexWsLaneDisabled(2000) === false;
})());

resetCodexWsLaneForTests();
const tripAt = 10_000_000;
refusal(tripAt); refusal(tripAt + 1); refusal(tripAt + 2);
check("the hold expires on its own", codexWsLaneDisabled(tripAt + 10 * 60_000 + 100) === false);
refusal(tripAt + 10 * 60_000 + 101); refusal(tripAt + 10 * 60_000 + 102); refusal(tripAt + 10 * 60_000 + 103);
const escalated = codexWsLaneSnapshot(tripAt + 10 * 60_000 + 104);
check("a second trip escalates the hold", escalated.rung === 2 && escalated.trips === 2,
  JSON.stringify(escalated));

check("a real response clears the window and the rung", (() => {
  const now = tripAt + 10 * 60_000 + 105;
  noteCodexWsLaneSuccess(now);
  const snapshot = codexWsLaneSnapshot(now);
  return snapshot.refusals === 0 && snapshot.rung === 0;
})());

const stateFile = JSON.parse(readFileSync(join(home, "ws-lane.json"), "utf8"));
check("the hold is persisted for the next process", typeof stateFile.holdUntil === "number"
  && stateFile.version === 1, JSON.stringify(stateFile));

clearCodexWsLaneHold();
check("the operator override clears it", codexWsLaneDisabled() === false);
const evidence = readFileSync(join(home, "ws-lane.jsonl"), "utf8").trim().split("\n")
  .map(line => JSON.parse(line));
check("holds and the override leave evidence", evidence.some(row => row.event === "lane-hold")
  && evidence.some(row => row.event === "lane-hold-cleared"));

console.log(failures === 0 ? "ALL CODEX-WS LANE CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
