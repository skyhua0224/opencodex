/**
 * Self-test for the per-thread affinity reset (2026-09-23).
 *
 * A conversation the backend keeps serving slowly and shedding gets its window hint dropped, so
 * the backend places it afresh. This checks the arming, the refresh and the expiry of that hold.
 *
 * Run: bun ~/.opencodex/tools/thread-affinity-selftest.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Isolate the config home BEFORE the module loads: the operator's real arm file and persisted
// affinity state would otherwise decide the outcome of every check below.
process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-affinity-selftest-"));
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { noteThreadOverloadVerdict, noteThreadRestrictionVerdict, noteThreadUpstreamCut, noteThreadSlowHeaders, noteThreadTurnDuration, sessionVerdictSummary, isRestrictionVerdictText, threadAffinityResetActive, threadTransportDemotedToHttp, clearThreadTransportLedgerForTests, clearThreadTurnSamplesForTests, clearManualAffinityArmCacheForTests } =
  await import(PKG + "/server/ws-thread-transport.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const key = "e0db9ac1bbb54d385cebfb645f072ec7";
const t0 = Date.now();
clearThreadTransportLedgerForTests();
clearManualAffinityArmCacheForTests();
check("no verdict -> no reset", threadAffinityResetActive(key, t0) === false);

noteThreadOverloadVerdict(key, "Our servers are currently overloaded. Please try again later.", t0);
check("one shed arms the reset", threadAffinityResetActive(key, t0 + 1000) === true);
check("a sibling conversation is untouched", threadAffinityResetActive("7c23bb4ab98ae187346e5ad92094397e", t0 + 1000) === false);
check("a non-capacity error never arms it", (() => {
  noteThreadOverloadVerdict("other-thread", "invalid request", t0);
  return threadAffinityResetActive("other-thread", t0 + 1000) === false;
})());

noteThreadOverloadVerdict(key, "overloaded", t0 + 30 * 60_000);
check("a later shed refreshes the hold", threadAffinityResetActive(key, t0 + 30 * 60_000 + 1000) === true);
// The hold is six hours (see AFFINITY_RESET_HOLD_MS): an hour-long window expired in the middle of
// a working session, which is exactly when the conversation fell back onto its slow lane.
check("the hold expires after its window", threadAffinityResetActive(key, t0 + 30 * 60_000 + 6 * 60 * 60_000 + 60_000) === false);

// The transport demotion still exists, but it must NOT fire on the two verdicts that used to
// trigger it: the WS lane now holds its prelude and re-dials, while the HTTP lane cannot, so a
// routine demotion pushed this conversation onto the weaker lane (measured 2026-09-24).
clearThreadTransportLedgerForTests();
noteThreadOverloadVerdict(key, "overloaded", t0);
noteThreadOverloadVerdict(key, "overloaded", t0 + 60_000);
check("two verdicts no longer demote the transport", threadTransportDemotedToHttp(key, t0 + 61_000) === false);
for (let i = 0; i < 4; i++) noteThreadOverloadVerdict(key, "overloaded", t0 + 120_000 + i * 1000);
check("a lane that is genuinely unusable still demotes", threadTransportDemotedToHttp(key, t0 + 130_000) === true);

// A restriction verdict is about the CLIENT, not the load: the origin answered "not you", so the
// routing identity is re-rolled on the FIRST verdict (no six-verdict threshold to wait for) with a
// short hold, and the summary can tell the two verdict kinds apart.
clearThreadTransportLedgerForTests();
clearManualAffinityArmCacheForTests();
const restriction = "This account only allows Codex official clients";
check("the restriction text is recognised", isRestrictionVerdictText(restriction));
check("a load message is not a restriction", isRestrictionVerdictText("Our servers are currently overloaded") === false);
check("a non-restriction message does nothing", (() => {
  noteThreadRestrictionVerdict(key, "invalid request", t0);
  return threadAffinityResetActive(key, t0 + 1000) === false;
})());
noteThreadRestrictionVerdict(key, restriction, t0 + 2000);
check("one restriction verdict re-rolls the identity now", threadAffinityResetActive(key, t0 + 3000) === true);
const summary = sessionVerdictSummary(key, t0 + 3000);
check("the summary names the verdict kind",
  summary?.restriction === 1 && summary?.overload === 0 && summary?.affinityResetActive === true,
  JSON.stringify(summary));
check("the restriction hold is short, not the six-hour one",
  threadAffinityResetActive(key, t0 + 31 * 60_000) === false
  && threadAffinityResetActive(key, t0 + 5 * 60 * 60_000) === false);
check("a transport demotion is still not triggered by a restriction", threadTransportDemotedToHttp(key, t0 + 3000) === false);

// 2026-09-29: the two shapes the single-official-account deployment actually produces never armed
// anything before this -- a response the origin CUT mid-stream (the user sees "stream disconnected
// before completion") and a conversation whose HEADERS keep arriving slow. Both now arm the same
// re-roll, with a shorter hold than the six-hour overload arm, and neither is a transport demotion.
clearThreadTransportLedgerForTests();
const cutKey = "9f2c1b7a4e6d8053";
check("a pre-content failure is not a cut verdict", (() => {
  noteThreadUpstreamCut(cutKey, { status: 502, midStream: false }, t0);
  return threadAffinityResetActive(cutKey, t0 + 1000) === false;
})());
check("a 4xx mid-stream failure is not a routing verdict", (() => {
  noteThreadUpstreamCut(cutKey, { status: 429, midStream: true }, t0 + 1000);
  return threadAffinityResetActive(cutKey, t0 + 2000) === false;
})());
noteThreadUpstreamCut(cutKey, { status: 502, midStream: true }, t0 + 3000);
check("one mid-stream cut arms the re-roll", threadAffinityResetActive(cutKey, t0 + 4000) === true);
check("the cut hold is the short one, not six hours",
  threadAffinityResetActive(cutKey, t0 + 2 * 60 * 60_000 + 60_000) === false);

// Slow headers: one slow wait is a busy moment, two inside the window is how a conversation served
// badly looks. The threshold is 20s and the sibling conversation must stay untouched.
clearThreadTransportLedgerForTests();
const slowKey = "5d81ff0c2ab34e77";
noteThreadSlowHeaders(slowKey, 21_000, t0);
check("one slow header wait is not enough", threadAffinityResetActive(slowKey, t0 + 1000) === false);
noteThreadSlowHeaders(slowKey, 19_000, t0 + 2000);
check("a header wait under the threshold does not count", threadAffinityResetActive(slowKey, t0 + 3000) === false);
noteThreadSlowHeaders(slowKey, 24_000, t0 + 4000);
check("two slow header waits arm the re-roll", threadAffinityResetActive(slowKey, t0 + 5000) === true);
check("the slow-header arm is not a transport demotion", threadTransportDemotedToHttp(slowKey, t0 + 5000) === false);
check("the slow-header hold is the short one",
  threadAffinityResetActive(slowKey, t0 + 2 * 60 * 60_000 + 60_000) === false);

// Relative slowness: judged against the conversation's OWN median, not an absolute number, because
// a hard reasoning turn is legitimately long. Six samples establish the baseline, then two turns
// at least twice that median arm the same short re-roll.
clearThreadTransportLedgerForTests();
clearThreadTurnSamplesForTests();
const relKey = "3ab9c40d17e28f56";
const relT0 = Date.now();
for (let i = 0; i < 7; i++) noteThreadTurnDuration(relKey, 10_000, 3_000, relT0 + i * 1000);
check("a conversation with no baseline yet is never armed", (() => {
  noteThreadTurnDuration("fresh-thread", 60_000, 5_000, relT0);
  return threadAffinityResetActive("fresh-thread", relT0 + 1000) === false;
})());
noteThreadTurnDuration(relKey, 22_000, 4_000, relT0 + 20_000);
check("one turn at twice the median is not enough", threadAffinityResetActive(relKey, relT0 + 21_000) === false);
check("a turn under the floor does not count", (() => {
  // 10s median, so 16s is above 2x the floor... but 16s is under the 20s floor.
  noteThreadTurnDuration("floor-thread", 1_000, 500, relT0);
  for (let i = 0; i < 6; i++) noteThreadTurnDuration("floor-thread", 8_000, 2_000, relT0 + i * 1000);
  noteThreadTurnDuration("floor-thread", 16_000, 3_000, relT0 + 20_000);
  return threadAffinityResetActive("floor-thread", relT0 + 21_000) === false;
})());
noteThreadTurnDuration(relKey, 26_000, 5_000, relT0 + 40_000);
check("two turns against its own median arm the re-roll", threadAffinityResetActive(relKey, relT0 + 41_000) === true);
check("the relative arm is not a transport demotion", threadTransportDemotedToHttp(relKey, relT0 + 41_000) === false);
check("the relative arm expires with the short hold",
  threadAffinityResetActive(relKey, relT0 + 2 * 60 * 60_000 + 60_000) === false);

console.log(failures === 0 ? "ALL THREAD AFFINITY CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
