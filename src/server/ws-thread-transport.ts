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
