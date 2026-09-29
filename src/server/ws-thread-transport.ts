/**
 * Per-thread transport demotion for the ChatGPT Codex WebSocket lane.
 *
 * Why this exists: the Codex backend serves the `responses_websockets` path from a measurably
 * faster queue, so every request rides WS by default. That lane is not uniformly available to every
 * conversation, though: on 2026-09-23 one conversation answered `Our servers are currently
 * overloaded` on 50% of its turns (17 of 34) while a sibling conversation on the SAME account,
 * model, effort, tier and cache profile answered 200 on 61 of 61 turns in the same minutes. Moving
 * only the failing conversation to plain HTTP dropped it to 1 failure in 7 turns.
 *
 * So the demotion is per THREAD, not per account: a conversation that collects repeated overload
 * verdicts steps off the WS lane for a while, and everything else keeps the faster lane. The hold
 * escalates (30m -> 1h -> 2h) because the backend's shedding of that conversation is persistent
 * rather than momentary, and it decays after a quiet window so a recovered thread starts fresh.
 */
import { normalizeLogConversationId } from "./request-log-conversation";
import { readFileSync, statSync } from "node:fs";
import { atomicWriteFile } from "../config/atomic-write";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";

/**
 * Overload verdicts inside {@link VERDICT_WINDOW_MS} before the thread steps off the WS lane.
 *
 * Six, not two. The demotion was written when the WS lane had no protection of its own, so moving
 * a shedding conversation to plain HTTP was strictly better. The lanes have since swapped: the WS
 * exchange now HOLDS its prelude and can re-dial a declined attempt, while the SSE delivery path
 * still relays a pre-content overload straight into the client's stream. Demoting on two verdicts
 * therefore pushed this conversation onto the one lane that cannot recover from a shed -- measured
 * 2026-09-24: after a demotion, every remaining failure of that conversation was `ws=n`,
 * `transportPhase: terminal_sse`, with nothing retryable left to act on. The threshold stays high
 * enough to catch a lane that is genuinely unusable, not merely busy. */
const VERDICT_THRESHOLD = 6;
const VERDICT_WINDOW_MS = 10 * 60_000;
/** Escalating holds; the last value repeats. */
const DEMOTION_HOLD_MS = [30 * 60_000, 60 * 60_000, 120 * 60_000];
/** A thread with no verdicts for this long starts over at the first hold. */
const VERDICT_DECAY_MS = 30 * 60_000;
/** Bounded ledger: threads are long-lived, but memory is not. */
const LEDGER_CAPACITY = 512;
/**
 * How long one shed verdict keeps this thread's routing identity re-rolled.
 *
 * Six hours, not one. The A/B on 2026-09-23 (arm 22:59:30 -> disarm 23:11:49) put the shed back
 * within ten seconds of the disarm and kept the conversation at ~8s turns while armed, so the hold
 * is the thing that is working: a one-hour window simply expires in the middle of a working session
 * and the conversation falls back onto whatever lane it had before.
 */
const AFFINITY_RESET_HOLD_MS = 6 * 60 * 60_000;
/** Re-read budget for the operator's manual-arm file. */
const MANUAL_ARM_TTL_MS = 10_000;

interface ThreadTransportEntry {
  /** Verdict timestamps inside the current window. */
  verdicts: number[];
  /**
   * Restriction verdicts inside the current window: the origin answered about THIS conversation's
   * identity (client not allowed, policy block), not about its load. Optional because every entry
   * constructed before this field existed has none.
   */
  restrictionVerdicts?: number[];
  /**
   * Turns of this conversation that were CUT mid-stream by the origin inside the window.
   *
   * Not a verdict the origin stated -- it is the shape the user sees as "stream disconnected
   * before completion" after the answer had already started. Nothing can be replayed at that
   * point (the output is out), so the only thing worth doing is to stop riding this route: the
   * same re-roll an overload verdict arms. Measured 2026-09-29: one conversation collected 13 of
   * these in two hours (native gpt-6-sol, single official account, no combo to hop with) while
   * its sibling collected 3, and no verdict path armed anything because the cut carries no
   * capacity or restriction text.
   */
  cutVerdicts?: number[];
  /**
   * Headers that arrived slower than {@link SLOW_HEADERS_THRESHOLD_MS}, inside the window.
   *
   * Time from send to response headers is the backend's own queueing and prompt work, so unlike
   * total turn time (a hard reasoning turn is legitimately minutes long) it is comparable across
   * turns and across conversations. The measured asymmetry behind the affinity roll was exactly
   * this number: 14-22s for the conversation the backend was serving badly, 8s for its sibling.
   */
  slowHeaderHits?: number[];
  /**
   * Turns of this conversation that were much slower than the conversation's OWN recent normal.
   *
   * The other signals are absolute (a cut, a 20s header wait). This one is relative because the
   * felt complaint is relative: "this Session is especially slow". Total turn time depends on the
   * work being done, so it is only evidence when compared against the same conversation's own
   * median -- a lane whose tasks got harder will drift its baseline with them. Measured
   * 2026-09-29: one conversation held a 28.2s median against its sibling's 11.6s for hours with
   * nothing wrong enough to state a verdict.
   */
  relativeSlowHits?: number[];
  /**
   * While now < this, the thread's outbound `x-codex-window-id` is dropped.
   *
   * The shed conversation is not merely shedding: it is served 2-3x slower than its sibling at
   * EVERY hour of the evening (13.9s vs 6.3s median time-to-first-token across 593/837 successful
   * turns, with comparable input sizes -- measured 2026-09-23), and it collects 51 sheds against
   * its sibling's 11. A per-turn cost explanation cannot produce that: after its compaction the
   * shed conversation sent SMALLER prompts (175k vs 443k) and stayed both slow and shed. What is
   * left is how that conversation is `routed`, and the one per-conversation routing hint the client
   * sends is `x-codex-window-id`. Dropping it asks the backend to place this conversation afresh;
   * the proxy changes no content, no model and no credential.
   */
  affinityResetUntil: number;
  /** Demotion level reached so far (index into {@link DEMOTION_HOLD_MS}). */
  rung: number;
  /** While now < this, the thread must use plain HTTP. */
  httpOnlyUntil: number;
  lastAt: number;
}

const ledger = new Map<string, ThreadTransportEntry>();

/**
 * The armed conversations, persisted so a restart cannot silently un-fix a working conversation.
 *
 * The ledger itself is deliberately in-memory: a demotion is a fresh judgement about recent
 * verdicts. The AFFINITY hold is different -- it is the one piece of state whose loss costs the
 * operator a slow, shedding conversation again (observed: the shed came back ten seconds after a
 * disarm, and every restart in this session cleared the holds). Only the key and its expiry are
 * written; verdict history is not.
 */
const AFFINITY_STATE_FILE = "thread-affinity.json";
const AFFINITY_STATE_VERSION = 1;

function affinityStatePath(): string {
  return join(getConfigDir(), AFFINITY_STATE_FILE);
}

function loadAffinityState(): void {
  try {
    const raw = JSON.parse(readFileSync(affinityStatePath(), "utf8")) as { version?: unknown; armed?: unknown };
    if (raw.version !== AFFINITY_STATE_VERSION || typeof raw.armed !== "object" || raw.armed === null) return;
    const now = Date.now();
    for (const [key, until] of Object.entries(raw.armed as Record<string, unknown>)) {
      if (typeof until !== "number" || !Number.isFinite(until) || until <= now) continue;
      const entry: ThreadTransportEntry = { verdicts: [], rung: 0, httpOnlyUntil: 0, affinityResetUntil: until, lastAt: now };
      ledger.set(key, entry);
    }
  } catch {
    /* absent or malformed state means "nothing armed" */
  }
}

function persistAffinityState(now: number): void {
  const armed: Record<string, number> = {};
  for (const [key, entry] of ledger) {
    if (entry.affinityResetUntil > now) armed[key] = entry.affinityResetUntil;
  }
  try {
    // atomicWriteFile, not writeFileSync: it is upstream's platform-aware replace -- a private
    // temp plus a rename that retries EBUSY/EPERM/EACCES on Windows, where a plain overwrite of a
    // file another process has open fails or truncates. The hold is small state, but it is exactly
    // the state an operator notices losing.
    atomicWriteFile(affinityStatePath(), JSON.stringify({ version: AFFINITY_STATE_VERSION, armed }, null, 2) + "\n");
  } catch {
    /* persistence is best-effort: the in-memory hold still applies for this process */
  }
}

loadAffinityState();

/** Messages that mean "this conversation is being shed", not "this request was malformed". */
export function isOverloadVerdictText(message: string | undefined): boolean {
  const text = (message ?? "").toLowerCase();
  if (text.length === 0) return false;
  // Substring matching on purpose: relays spell it `capacity_exceeded`, `at capacity`, `Capacity`,
  // and the canonical backend answers "Our servers are currently overloaded". A word-boundary
  // pattern misses the underscore forms, which are exactly the ones a relay sends.
  return /currently overloaded|server_is_overloaded|overloaded|capacity/.test(text);
}

/**
 * Messages that mean "this conversation's identity is the problem".
 *
 * Deliberately narrow: these are verdicts about the CLIENT, and misreading a load message as a
 * restriction would re-roll a healthy conversation's routing identity for nothing. The canonical
 * text is the backend's own ("This account only allows Codex official clients"); the rest covers
 * the shapes relays use for policy and abuse blocks.
 */
export function isRestrictionVerdictText(message: string | undefined): boolean {
  const text = (message ?? "").toLowerCase();
  if (text.length === 0) return false;
  return /only allows codex official clients|official clients only|cyber|policy_violation|content policy violation|abuse|unusual activity|flagged for review/.test(text);
}

function trim(threadId: string | undefined): string | undefined {
  const value = threadId?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * The identity both sides of this ledger agree on.
 *
 * The recording side sees `logCtx.conversationId`, which the proxy derives (and hashes) from the
 * request headers with a fixed precedence. Recomputing that same value from the outgoing request's
 * headers is what lets a verdict recorded during the response land on the thread that asked for it.
 */
export function conversationKeyFromHeaders(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined;
  let map: Headers;
  try {
    map = new Headers(headers);
  } catch {
    return undefined;
  }
  return normalizeLogConversationId(
    map.get("x-codex-parent-thread-id")
      ?? map.get("session_id")
      ?? map.get("session-id")
      ?? map.get("thread-id"),
  );
}

/**
 * Record one overload verdict for a thread and demote it once the threshold is reached.
 *
 * Called from the request-log funnel that already classifies the upstream error text, so the
 * ledger sees exactly the verdicts the operator sees in `/api/logs`.
 */
export function noteThreadOverloadVerdict(
  threadId: string | undefined,
  message: string | undefined,
  now = Date.now(),
): void {
  const key = trim(threadId);
  if (!key || !isOverloadVerdictText(message)) return;
  const previous = ledger.get(key);
  // Quiet time is measured from whichever came LAST: the newest verdict or the end of the hold.
  // Measuring it from the verdict alone would reset the ladder during every hold (a demoted thread
  // produces no verdicts while it rides HTTP), so a thread that is shed again the moment its hold
  // expires would start over at 30 minutes forever instead of escalating.
  const quietSince = Math.max(previous?.lastAt ?? 0, previous?.httpOnlyUntil ?? 0);
  const entry: ThreadTransportEntry = previous && now - quietSince < VERDICT_DECAY_MS
    ? { ...previous, verdicts: [...previous.verdicts, now] }
    : { verdicts: [now], rung: 0, httpOnlyUntil: 0, affinityResetUntil: 0, lastAt: now };
  entry.verdicts = entry.verdicts.filter(at => now - at < VERDICT_WINDOW_MS);
  entry.lastAt = now;
  // Armed on the first verdict, not on the demotion threshold: the window id is a ROUTING hint,
  // and the point of the experiment is to find out whether re-rolling it changes the service this
  // conversation gets. Refreshed by every later verdict, so a conversation that keeps shedding
  // keeps the reset until it has been quiet for the decay window.
  if (entry.affinityResetUntil <= now) {
    entry.affinityResetUntil = now + AFFINITY_RESET_HOLD_MS;
    persistAffinityState(now);
    console.warn(
      `[opencodex] thread ${key.slice(0, 8)}: dropping x-codex-window-id for ${Math.round(AFFINITY_RESET_HOLD_MS / 60_000)}min `
      + `(this conversation is served slower and sheds more than its siblings; asking the backend to route it afresh)`,
    );
  } else {
    entry.affinityResetUntil = now + AFFINITY_RESET_HOLD_MS;
    persistAffinityState(now);
  }
  if (entry.verdicts.length >= VERDICT_THRESHOLD && entry.httpOnlyUntil <= now) {
    const hold = DEMOTION_HOLD_MS[Math.min(entry.rung, DEMOTION_HOLD_MS.length - 1)]!;
    entry.httpOnlyUntil = now + hold;
    entry.rung = Math.min(entry.rung + 1, DEMOTION_HOLD_MS.length - 1);
    entry.verdicts = [];
    console.warn(
      `[opencodex] thread ${key.slice(0, 8)} demoted to HTTP for ${Math.round(hold / 60_000)}min `
      + `(ChatGPT WebSocket lane kept answering overloaded; ${message?.slice(0, 60) ?? ""})`,
    );
  }
  ledger.delete(key);
  ledger.set(key, entry);
  while (ledger.size > LEDGER_CAPACITY) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

/**
 * Record a restriction verdict and re-roll this conversation's routing identity immediately.
 *
 * Unlike an overload verdict there is no threshold to wait for: the origin did not say "busy", it
 * said "not you". The one action that has measurably moved such a conversation (2026-09-23:
 * 14-22s -> 8.1-8.3s for the ten minutes after a re-roll) is asking the backend to place it
 * afresh, so that happens on the first verdict, with a short hold because these blocks are
 * typically local and short-lived (the same reason an operator's "静置再蹬" works).
 */
const RESTRICTION_RESET_HOLD_MS = 30 * 60_000;
/**
 * How long one cut or slow-header signal keeps this conversation's routing identity re-rolled.
 *
 * Shorter than the six-hour overload hold on purpose: a cut is one lost turn, not a pattern the
 * origin stated, and the re-roll's cost (the backend places the conversation again) is small but
 * not free. Two hours covers the shape that started this: 13 cuts spread over two hours, each one
 * refreshing the window, so the hold lapses about two hours after the last bad turn.
 */
const EXPERIMENTAL_RESET_HOLD_MS = 2 * 60 * 60_000;
/** Slow-header signals inside {@link VERDICT_WINDOW_MS} before the identity is re-rolled. */
const SLOW_HEADERS_HITS = 2;
/**
 * A header wait this long is the "this conversation is being served badly" number, not the model
 * thinking: measured p90 for healthy conversations on this deployment is ~15s (n=34, 2026-09-29),
 * and the shed conversation sits at 14-22s against its sibling's 8s.
 */
const SLOW_HEADERS_THRESHOLD_MS = 20_000;
/**
 * Relative-slowness trigger: a turn this many times the conversation's own recent median.
 *
 * Two, with a floor: a conversation that normally takes 10s and takes 25s is the shape the
 * operator notices, while a 40s turn on a conversation whose normal IS 35s is not a routing
 * problem at all. The floor keeps tiny turns (a 2s ping answered in 5s) out of the count.
 */
const RELATIVE_SLOW_RATIO = 2;
const RELATIVE_SLOW_FLOOR_MS = 20_000;
/** Samples before a conversation's own median is trusted as a baseline. */
const RELATIVE_SLOW_MIN_SAMPLES = 6;
/** Relative-slowness hits inside the window before the identity is re-rolled. */
const RELATIVE_SLOW_HITS = 2;
/** Bounded history per conversation: enough to be stable, small enough for a long-lived process. */
const TURN_SAMPLE_CAP = 24;
/**
 * Per-conversation turn durations, most recent last.
 *
 * Not part of the ledger entry: the ledger records verdicts (what happened), this is a baseline
 * (what this conversation normally looks like). Keeping it separate means a re-roll or a demotion
 * cannot silently rewrite the yardstick it is judged against.
 */
const turnSamples = new Map<string, number[]>();

/** Test seam: forget every conversation's duration baseline. */
export function clearThreadTurnSamplesForTests(): void {
  turnSamples.clear();
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * One completed turn of this conversation: baseline first, then the verdict.
 *
 * Called from the request's terminal seam, so it sees every transport and every route. Only
 * successful turns are reported -- the caller filters -- because a cancelled turn is the user
 * leaving, not the backend being slow, and would drag the baseline down.
 */
export function noteThreadTurnDuration(
  threadId: string | undefined,
  durationMs: number,
  firstOutputMs: number | undefined,
  now = Date.now(),
): void {
  const key = trim(threadId);
  if (!key || !Number.isFinite(durationMs) || durationMs <= 0) return;
  const history = turnSamples.get(key) ?? [];
  const baseline = history.length >= RELATIVE_SLOW_MIN_SAMPLES ? medianOf(history) : 0;
  history.push(durationMs);
  while (history.length > TURN_SAMPLE_CAP) history.shift();
  turnSamples.delete(key);
  turnSamples.set(key, history);
  if (baseline <= 0) return;
  if (durationMs < RELATIVE_SLOW_FLOOR_MS || durationMs < baseline * RELATIVE_SLOW_RATIO) return;

  const previous = ledger.get(key);
  const entry: ThreadTransportEntry = previous
    ? { ...previous, relativeSlowHits: [...(previous.relativeSlowHits ?? []), now] }
    : { verdicts: [], rung: 0, httpOnlyUntil: 0, affinityResetUntil: 0, lastAt: now, relativeSlowHits: [now] };
  entry.relativeSlowHits = (entry.relativeSlowHits ?? []).filter(at => now - at < VERDICT_WINDOW_MS);
  entry.lastAt = now;
  const hits = entry.relativeSlowHits.length;
  const wasRolled = entry.affinityResetUntil > now;
  if (hits >= RELATIVE_SLOW_HITS) {
    entry.affinityResetUntil = Math.max(entry.affinityResetUntil, now + EXPERIMENTAL_RESET_HOLD_MS);
  }
  ledger.delete(key);
  ledger.set(key, entry);
  if (hits < RELATIVE_SLOW_HITS) return;
  persistAffinityState(now);
  if (!wasRolled) {
    console.warn(
      "[opencodex] thread " + key.slice(0, 8) + ": " + hits + " turns at "
      + Math.round(durationMs / 1000) + "s against its own " + Math.round(baseline / 1000)
      + "s median" + (firstOutputMs === undefined ? "" : " (first output " + Math.round(firstOutputMs / 1000) + "s)")
      + " - re-rolling its routing identity for " + Math.round(EXPERIMENTAL_RESET_HOLD_MS / 60_000) + "min",
    );
  }
}

/**
 * The origin cut a started response. Arms the same re-roll an overload verdict arms.
 *
 * `midStream` is the caller's own knowledge that output had already reached the client; without
 * it the signal would also fire for ordinary pre-content refusals, which the retry ladders already
 * handle and which say nothing about how this conversation is routed.
 */
/**
 * Should this terminal failure arm the re-roll?
 *
 * Two shapes qualify, and the second one is what the first version of this rule missed: output had
 * reached the client (a cut in the middle of an answer), OR the origin had answered with headers
 * and then died before producing anything (measured 2026-09-29 on one conversation: four such
 * turns between 20:32 and 21:10, each 43-54s of waiting for nothing, `terminal_sse` with no first
 * output). A PRE-header failure does not qualify: the retry ladder owns those, and for the official
 * row the capacity park owns them too.
 */
export function shouldArmUpstreamCut(
  status: number,
  transportPhase: string | undefined,
  firstOutputMs: number | undefined,
): boolean {
  if (!Number.isFinite(status) || status < 500) return false;
  return firstOutputMs !== undefined || transportPhase === "terminal_sse";
}

export function noteThreadUpstreamCut(
  threadId: string | undefined,
  options: { status?: number | undefined; midStream?: boolean | undefined } = {},
  now = Date.now(),
): void {
  const key = trim(threadId);
  if (!key || options.midStream !== true) return;
  const status = options.status ?? 0;
  if (status !== 0 && status < 500) return;
  const previous = ledger.get(key);
  const wasRolled = (previous?.affinityResetUntil ?? 0) > now;
  const entry: ThreadTransportEntry = previous
    ? { ...previous, cutVerdicts: [...(previous.cutVerdicts ?? []), now] }
    : { verdicts: [], rung: 0, httpOnlyUntil: 0, affinityResetUntil: 0, lastAt: now, cutVerdicts: [now] };
  entry.cutVerdicts = (entry.cutVerdicts ?? []).filter(at => now - at < VERDICT_WINDOW_MS);
  entry.lastAt = now;
  entry.affinityResetUntil = Math.max(entry.affinityResetUntil, now + EXPERIMENTAL_RESET_HOLD_MS);
  ledger.delete(key);
  ledger.set(key, entry);
  persistAffinityState(now);
  if (!wasRolled) {
    console.warn(
      "[opencodex] thread " + key.slice(0, 8) + ": the origin cut a response after it had started ("
      + status + ") - re-rolling its routing identity for "
      + Math.round(EXPERIMENTAL_RESET_HOLD_MS / 60_000) + "min so the next turn is placed afresh",
    );
  }
}

/**
 * Headers for this conversation took longer than {@link SLOW_HEADERS_THRESHOLD_MS}.
 *
 * Arms on the second hit inside the window: one slow header wait is a busy moment, two in ten
 * minutes is how a conversation that is being served badly looks before it also starts shedding.
 */
export function noteThreadSlowHeaders(
  threadId: string | undefined,
  headersMs: number,
  now = Date.now(),
): void {
  const key = trim(threadId);
  if (!key || !Number.isFinite(headersMs) || headersMs < SLOW_HEADERS_THRESHOLD_MS) return;
  const previous = ledger.get(key);
  const entry: ThreadTransportEntry = previous
    ? { ...previous, slowHeaderHits: [...(previous.slowHeaderHits ?? []), now] }
    : { verdicts: [], rung: 0, httpOnlyUntil: 0, affinityResetUntil: 0, lastAt: now, slowHeaderHits: [now] };
  entry.slowHeaderHits = (entry.slowHeaderHits ?? []).filter(at => now - at < VERDICT_WINDOW_MS);
  entry.lastAt = now;
  const hits = entry.slowHeaderHits.length;
  if (hits >= SLOW_HEADERS_HITS) {
    const wasRolled = entry.affinityResetUntil > now;
    entry.affinityResetUntil = Math.max(entry.affinityResetUntil, now + EXPERIMENTAL_RESET_HOLD_MS);
    ledger.delete(key);
    ledger.set(key, entry);
    persistAffinityState(now);
    if (!wasRolled) {
      console.warn(
        "[opencodex] thread " + key.slice(0, 8) + ": " + hits + " header waits over "
        + Math.round(SLOW_HEADERS_THRESHOLD_MS / 1000) + "s in "
        + Math.round(VERDICT_WINDOW_MS / 60_000) + "min (last " + Math.round(headersMs / 1000)
        + "s) - re-rolling its routing identity for "
        + Math.round(EXPERIMENTAL_RESET_HOLD_MS / 60_000) + "min",
      );
    }
    return;
  }
  ledger.delete(key);
  ledger.set(key, entry);
}

export function noteThreadRestrictionVerdict(
  threadId: string | undefined,
  message: string | undefined,
  now = Date.now(),
): void {
  const key = trim(threadId);
  if (!key || !isRestrictionVerdictText(message)) return;
  const previous = ledger.get(key);
  const entry: ThreadTransportEntry = previous
    ? { ...previous, restrictionVerdicts: [...(previous.restrictionVerdicts ?? []), now] }
    : { verdicts: [], rung: 0, httpOnlyUntil: 0, affinityResetUntil: 0, lastAt: now, restrictionVerdicts: [now] };
  entry.restrictionVerdicts = (entry.restrictionVerdicts ?? []).filter(at => now - at < VERDICT_WINDOW_MS);
  entry.lastAt = now;
  const wasRolled = entry.affinityResetUntil > now;
  entry.affinityResetUntil = Math.max(entry.affinityResetUntil, now + RESTRICTION_RESET_HOLD_MS);
  ledger.delete(key);
  ledger.set(key, entry);
  persistAffinityState(now);
  if (!wasRolled) {
    console.warn(
      "[opencodex] thread " + key.slice(0, 8) + ": origin answered about this client, not its load ("
      + (message ?? "").slice(0, 70) + ") - re-rolling its routing identity for "
      + Math.round(RESTRICTION_RESET_HOLD_MS / 60_000) + "min",
    );
  }
}

/** Recent verdict kinds for one conversation, for reports and tests. */
export function sessionVerdictSummary(
  threadId: string | undefined,
  now = Date.now(),
): { overload: number; restriction: number; affinityResetActive: boolean } | undefined {
  const key = trim(threadId);
  if (!key) return undefined;
  const entry = ledger.get(key);
  if (!entry) return undefined;
  return {
    overload: entry.verdicts.filter(at => now - at < VERDICT_WINDOW_MS).length,
    restriction: (entry.restrictionVerdicts ?? []).filter(at => now - at < VERDICT_WINDOW_MS).length,
    affinityResetActive: entry.affinityResetUntil > now,
  };
}

/** True while this thread must use plain HTTP instead of the WebSocket lane. */
export function threadTransportDemotedToHttp(
  threadId: string | undefined,
  now = Date.now(),
): boolean {
  const key = trim(threadId);
  if (!key) return false;
  const entry = ledger.get(key);
  if (!entry) return false;
  if (entry.httpOnlyUntil <= now) return false;
  // Refresh recency so an active demoted thread is not evicted by the capacity bound.
  ledger.delete(key);
  ledger.set(key, entry);
  return true;
}

/** Test-only reset, alongside the combo state resets. */
export function clearThreadTransportLedgerForTests(): void {
  ledger.clear();
}

/**
 * True while this conversation's outbound routing identity should be re-rolled.
 *
 * The caller (the canonical OpenAI forward header builder) drops `x-codex-window-id` when this
 * answers true. Nothing else about the request changes: same credential, same model, same body.
 */
export function threadAffinityResetActive(
  threadId: string | undefined,
  now = Date.now(),
): boolean {
  const key = trim(threadId);
  if (!key) return false;
  if (manualArmMatches(key, now)) return true;
  const entry = ledger.get(key);
  if (!entry || entry.affinityResetUntil <= now) return false;
  ledger.delete(key);
  ledger.set(key, entry);
  return true;
}

/**
 * The operator's on-demand arm: `~/.opencodex/affinity-arm.json` = {keys:[prefix...], until:epochMs}.
 *
 * The verdict-driven arm can only fire once the backend has already shed the conversation, which
 * makes it useless for testing whether a re-roll changes the service a STILL-SLOW conversation gets
 * (measured: one conversation at 14-22s time-to-first-token against its sibling's 8s, for hours).
 * Prefixes rather than full keys, because the ledger's key is the proxy's own conversation hash and
 * the first eight characters are what every log line already shows. Read with a short TTL: the file
 * is operator state, not hot-path input.
 */
let manualArmCache: { at: number; keys: string[]; until: number; mtimeMs: number } | undefined;
function manualArmState(now: number): { keys: string[]; until: number } {
  const path = join(getConfigDir(), "affinity-arm.json");
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = 0; }
  if (manualArmCache && manualArmCache.mtimeMs === mtimeMs && now - manualArmCache.at < MANUAL_ARM_TTL_MS) {
    return manualArmCache;
  }
  let keys: string[] = [];
  let until = 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { keys?: unknown; until?: unknown };
    if (Array.isArray(parsed.keys)) {
      keys = parsed.keys.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map(value => value.trim());
    }
    if (typeof parsed.until === "number" && Number.isFinite(parsed.until)) until = parsed.until;
  } catch {
    /* absent or malformed file means "no manual arm" */
  }
  manualArmCache = { at: now, keys, until, mtimeMs };
  return manualArmCache;
}

function manualArmMatches(key: string, now: number): boolean {
  const state = manualArmState(now);
  if (state.until <= now || state.keys.length === 0) return false;
  return state.keys.some(prefix => key.startsWith(prefix));
}

/** Test-only reset for the manual-arm cache. */
export function clearManualAffinityArmCacheForTests(): void {
  manualArmCache = undefined;
}

/** Diagnostics for tests and the operator: the current demotion, or undefined. */
export function threadTransportDemotion(
  threadId: string | undefined,
  now = Date.now(),
): { until: number; rung: number } | undefined {
  const key = trim(threadId);
  if (!key) return undefined;
  const entry = ledger.get(key);
  if (!entry || entry.httpOnlyUntil <= now) return undefined;
  return { until: entry.httpOnlyUntil, rung: entry.rung };
}
