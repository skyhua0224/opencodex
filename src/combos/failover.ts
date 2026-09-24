import { parseResetCooldownMs } from "../codex/routing";
import { classifyError, isCyberPolicyCode } from "../lib/errors";
import { isNonReplayableUpstreamCode } from "../lib/upstream-retry";
import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "../lib/state-store-sweeper";

interface TargetCooldown {
  cooldownUntil: number;
  /**
   * True when the hold came from the BREAKER (consecutive failures past the threshold), not from
   * a single post-failure cooldown. Only a tripped breaker is a hard exclusion; everything short
   * of it is a demotion that still lets the ladder reach the row when nothing better is left.
   */
  breakerTripped?: boolean;
}

/**
 * Circuit-breaker policy, the 熔断 half of what cc-switch does next to its 降级 queue.
 *
 * Failover alone only says "this attempt failed, try the next one"; without a breaker a provider
 * that is down for an hour still costs one full attempt on every request. These numbers mirror
 * the cc-switch settings shape: consecutive failures to open, a recovery wait, then consecutive
 * successes to close.
 */
export interface ComboBreakerPolicy {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** Consecutive successes after a trial that close it again. */
  successThreshold: number;
  /** How long an opened circuit stays open before a trial is allowed. */
  openMs: number;
}

export const DEFAULT_COMBO_BREAKER: ComboBreakerPolicy = {
  failureThreshold: 3,
  successThreshold: 2,
  openMs: 180_000,
};

/** Effective breaker policy for one combo, falling back per field to the defaults above. */
export function comboBreakerPolicy(combo: {
  breakerFailureThreshold?: number;
  breakerSuccessThreshold?: number;
  breakerOpenMs?: number;
} | undefined): ComboBreakerPolicy {
  return {
    failureThreshold: combo?.breakerFailureThreshold ?? DEFAULT_COMBO_BREAKER.failureThreshold,
    successThreshold: combo?.breakerSuccessThreshold ?? DEFAULT_COMBO_BREAKER.successThreshold,
    openMs: combo?.breakerOpenMs ?? DEFAULT_COMBO_BREAKER.openMs,
  };
}

/** Per-target consecutive outcomes. A circuit is open while its cooldown is running. */
interface TargetCircuit {
  failures: number;
  successes: number;
}

const targetCircuits = new Map<string, TargetCircuit>();

/**
 * Targets that were STUCK (first-byte deadline hit) recently, so the ladder puts them behind the
 * others instead of paying the same timeout on them first every single turn. Time-boxed rather
 * than counted: one stuck attempt defers the target for ten minutes, and a success clears it
 * immediately, so a provider that recovers is back in its price slot right away.
 */
const targetStuckAt = new Map<string, number>();
const TARGET_STUCK_DEFER_MS = 10 * 60_000;

export function comboTargetDeferred(comboId: string, target: Pick<OcxComboTarget, "provider" | "model">, now = Date.now()): boolean {
  const at = targetStuckAt.get(cooldownMapKey(comboId, target));
  return at !== undefined && now - at < TARGET_STUCK_DEFER_MS;
}

const DEFAULT_COOLDOWN_MS = 60_000;
/**
 * Failures this proxy produced itself, not verdicts from the provider.
 *
 * A local fence (main-profile maintenance/drain, credentials we refused to read) says nothing
 * about the upstream account, so counting it as capacity used to park the official provider on the
 * hour-scale ladder for an hour while the account was demonstrably serving direct traffic. Local
 * fences still fail over and still cool the target; they just never escalate the provider ladder.
 */
function isLocalFenceMessage(message: string | undefined): boolean {
  const text = message ?? "";
  return /opencodex local .*maintenance is active|native-main profile|main profile (?:maintenance|drain)/i.test(text);
}
/**
 * Ceiling for a target cooldown, INCLUDING a tripped breaker's open window.
 *
 * Short on purpose: a relay recovers on its own, and the tiered picker already keeps a tripped
 * row out of the healthy set, so a long lock would only delay the recovery the operator asked
 * for ("use it the moment it works again").
 */
const MAX_COOLDOWN_MS = 2 * 60_000;

/**
 * Provider-level capacity hold ladder, in milliseconds: 10min, then 1h, 3h, 6h, 12h, 24h flat.
 *
 * A capacity / risk-control verdict is not a transient blip -- the account is throttled or flagged
 * and it recovers on the operator's side, not ours. Cooling the combo TARGET for a minute (the
 * usual cooldown) would walk the same provider again on the next request, so the whole PROVIDER is
 * parked instead, for longer each time it repeats, and a success clears it.
 *
 * The first rung is deliberately short: the account's own capacity window turned over in minutes
 * on 2026-09-19 (direct traffic succeeded minutes after a park) while an hour-long first rung kept
 * the working channel out of every combo. Escalation is unchanged -- a provider that still fails
 * after a rung expires advances through the operator's original 1h/3h/6h/12h/24h steps.
 */
const CAPACITY_HOLD_LADDER_MS = [10, 60, 180, 360, 720, 1440].map(minutes => minutes * 60_000);

interface ProviderCapacityHold {
  until: number;
  escalations: number;
  reason: string;
  /** `capacity` holds survive a success; `failures` holds are released once the provider answers. */
  kind?: "capacity" | "failures";
  /** Last capacity verdict seen, used to decay the escalation rung after a long quiet period. */
  lastHitAt?: number;
  /** Set while a half-open trial is in flight: the row stays skipped until it answers. */
  probing?: boolean;
  /** When the current expiry was last probed, so one expiry is probed exactly once. */
  lastProbeAt?: number;
  /** Failed background re-checks in this streak (relay holds stop probing at RELAY_PROBE_MAX). */
  probes?: number;
}

const providerCapacityHolds = new Map<string, ProviderCapacityHold>();

/**
 * Repeated-failure trips, shared by EVERY combo that targets the provider.
 *
 * Per-(combo, target) cooldowns make each ladder learn the same lesson separately: four codex
 * combos each had to trip the same broken channel before any of them stopped walking it. This
 * ledger is provider-scoped instead, so the first ladder that discovers a dead channel parks it
 * for all of them -- and the hold clears on the first success, so a recovered provider is back
 * immediately. Deliberately SHORT compared with the official-OpenAI ladder: a relay channel
 * usually recovers on its own, and 15 minutes is enough for its upstream to settle.
 */
const providerFailureTimes = new Map<string, number[]>();
const PROVIDER_FAILURE_WINDOW_MS = 15 * 60_000;
const PROVIDER_FAILURE_LIMIT = 3;
/**
 * How long a relay stays demoted after it tripped the shared failure ledger.
 *
 * Deliberately short: the hold is a "step aside for a moment", not a sentence. Background
 * retries (below) keep checking the channel and the first success restores it immediately.
 */
const PROVIDER_FAILURE_HOLD_MS = 90_000;
/** Background re-checks per hold: five tries, then leave the row demoted until it is used again. */
const RELAY_PROBE_MAX = 5;
const RELAY_PROBE_MIN_INTERVAL_MS = 30_000;
const RELAY_PROBE_GIVE_UP_HOLD_MS = 5 * 60_000;

/** Record one failed attempt for the provider; returns true when that trips a shared hold. */
export function noteProviderFailure(provider: string, now = Date.now()): boolean {
  const times = (providerFailureTimes.get(provider) ?? []).filter(at => now - at < PROVIDER_FAILURE_WINDOW_MS);
  times.push(now);
  providerFailureTimes.set(provider, times);
  if (times.length < PROVIDER_FAILURE_LIMIT) return false;
  const existing = providerCapacityHolds.get(provider);
  const until = now + PROVIDER_FAILURE_HOLD_MS;
  if (existing && existing.until >= until) return true;
  providerCapacityHolds.set(provider, {
    until,
    escalations: (existing?.escalations ?? 0) + 1,
    reason: `repeated failures (${times.length} in ${Math.round(PROVIDER_FAILURE_WINDOW_MS / 60000)}min)`,
    kind: "failures",
  });
  return true;
}

/** Consecutive capacity verdicts, per provider; cleared by the first success from that provider. */
const providerCapacityStreaks = new Map<string, number>();

export function isProviderCapacityHeld(provider: string, now = Date.now()): boolean {
  const hold = providerCapacityHolds.get(provider);
  if (!hold) return false;
  // A trial in flight keeps the row skipped: the whole point of the probe is that the operator
  // never sees the failure it is looking for.
  return hold.until > now || hold.probing === true;
}

/**
 * Which kind of provider hold is active, for callers that must rank it.
 *
 * `capacity` is the official-OpenAI hour-scale ladder (never walked before anything else),
 * `failures` is the short relay hold that only demotes the row.
 */
export function providerHoldKind(provider: string, now = Date.now()): "capacity" | "failures" | undefined {
  const hold = providerCapacityHolds.get(provider);
  if (!hold || (hold.until <= now && hold.probing !== true)) return undefined;
  return hold.kind === "failures" ? "failures" : "capacity";
}

/**
 * Claim the one probe an expired hold is allowed, or return false when there is nothing to probe.
 *
 * Called from the combo path, so a probe happens exactly when a request would otherwise have hit
 * the just-expired hold -- once per expiry, not on a timer. At the first rung that is one tiny
 * request per hour, far below anything an upstream reads as abuse; higher rungs are probed
 * proportionally less often.
 */
export function claimProviderProbe(provider: string, now = Date.now()): boolean {
  const hold = providerCapacityHolds.get(provider);
  if (!hold || hold.probing === true) return false;
  if (hold.kind === "capacity") {
    // The official ladder probes exactly once per expiry, and only after that quiet hour (or
    // three, or twelve) has actually elapsed. That patience is the point of the ladder.
    if (hold.until > now) return false;
    if ((hold.lastProbeAt ?? 0) >= hold.until) return false;
    hold.probing = true;
    hold.lastProbeAt = now;
    return true;
  }
  // Relay hold: keep checking WHILE it is demoted -- a bounded number of tries, spaced out -- so
  // a channel that recovers is back in its price slot within seconds instead of waiting for the
  // hold to expire. The first success clears the hold outright (finishProviderProbe).
  if ((hold.probes ?? 0) >= RELAY_PROBE_MAX) return false;
  if (now - (hold.lastProbeAt ?? 0) < RELAY_PROBE_MIN_INTERVAL_MS) return false;
  hold.probing = true;
  hold.lastProbeAt = now;
  return true;
}

/**
 * Outcome of a half-open trial: success re-admits the provider immediately, failure advances the
 * escalation rung so a still-overloaded provider is parked for longer, not retried as often.
 */
export function finishProviderProbe(provider: string, ok: boolean, now = Date.now()): void {
  const hold = providerCapacityHolds.get(provider);
  if (!hold) return;
  hold.probing = false;
  if (ok) {
    providerCapacityHolds.delete(provider);
    providerCapacityStreaks.delete(provider);
    providerCapacityHits.delete(provider);
    return;
  }
  // Relay rows only ever carry the short shared-failure hold. Escalating one here walked the
  // hour-scale ladder (1h -> 3h -> 6h -> 12h -> 24h) onto channels whose upstreams recover on
  // their own -- that ladder is the official-OpenAI policy and nobody else's. Re-arm the
  // short hold instead, counting this failed background retry; after RELAY_PROBE_MAX of them the
  // row stays demoted for a while and stops probing until a real request produces a new verdict.
  if (hold.kind !== "capacity") {
    const probes = (hold.probes ?? 0) + 1;
    providerCapacityHolds.set(provider, {
      ...hold,
      until: now + (probes >= RELAY_PROBE_MAX ? RELAY_PROBE_GIVE_UP_HOLD_MS : PROVIDER_FAILURE_HOLD_MS),
      probing: false,
      probes,
      lastHitAt: now,
    });
    return;
  }
  holdProviderForCapacity(provider, "half-open probe failed", now);
}

export function providerCapacityHold(provider: string, now = Date.now()): ProviderCapacityHold | undefined {
  const hold = providerCapacityHolds.get(provider);
  return hold && hold.until > now ? hold : undefined;
}

/** Park a provider after a capacity verdict and return the hold it now carries. */
export function holdProviderForCapacity(provider: string, reason: string, now = Date.now()): ProviderCapacityHold {
  const previous = providerCapacityHolds.get(provider);
  // A verdict that arrives while the row is ALREADY parked is a retry hitting the same rail, not a
  // new escalation. The ladder exists to buy the account quiet time (1h -> 3h -> 6h -> 12h -> 24h),
  // and it must only advance when a FRESH attempt fails after that quiet -- the half-open probe
  // does exactly that, because it runs on the expired hold. Counting request-level retries here
  // walked the whole ladder to 24h inside one minute of client retries.
  if (previous && previous.until > now) {
    // Still parked: record the activity so the "a quiet day resets the ladder" rule does not fire
    // while the row is provably still failing, but keep the rung and its expiry exactly as they
    // were. Only an elapsed hold followed by a failed trial advances this ladder.
    const activity: ProviderCapacityHold = { ...previous, lastHitAt: now };
    providerCapacityHolds.set(provider, activity);
    return activity;
  }
  const quiet = previous?.lastHitAt !== undefined && now - previous.lastHitAt > CAPACITY_RUNG_RESET_MS;
  const streak = (quiet ? 0 : providerCapacityStreaks.get(provider) ?? 0) + 1;
  providerCapacityStreaks.set(provider, streak);
  const holdMs = CAPACITY_HOLD_LADDER_MS[Math.min(streak, CAPACITY_HOLD_LADDER_MS.length) - 1]!;
  const hold: ProviderCapacityHold = { until: now + holdMs, escalations: streak, reason, kind: "capacity", lastHitAt: now };
  providerCapacityHolds.set(provider, hold);
  return hold;
}

/** A capacity rung decays after a full quiet day, so a recovered account starts at one hour again. */
const CAPACITY_RUNG_RESET_MS = 24 * 60 * 60 * 1000;

/** Capacity verdicts counted as "multiple" before the rung is used up. */
const CAPACITY_HIT_WINDOW_MS = 30 * 60_000;
const CAPACITY_HIT_LIMIT = 2;

const providerCapacityHits = new Map<string, number[]>();

/**
 * Count a capacity verdict and trip the hold ladder once the provider produced several of them.
 *
 * Counting is windowed on purpose: the official account fails INTERMITTENTLY (a success between
 * two overloads is common), so requiring consecutive failures means it never parks and the
 * operator keeps seeing the overload error every other request. Two verdicts inside half an hour
 * is the signal to give the account a rest.
 */
export function noteProviderCapacityVerdict(provider: string, reason: string, now = Date.now()): ProviderCapacityHold | null {
  const hits = (providerCapacityHits.get(provider) ?? []).filter(at => now - at < CAPACITY_HIT_WINDOW_MS);
  hits.push(now);
  providerCapacityHits.set(provider, hits);
  if (hits.length < CAPACITY_HIT_LIMIT) return null;
  return holdProviderForCapacity(provider, reason, now);
}

export function noteProviderSuccess(provider: string): void {
  // A success clears the RELAY failure ledger -- that provider is back in use -- but it must NOT
  // clear an official-provider capacity hold: an account that alternates success and overload
  // would never stay parked, so every other request would surface the overload again. The hold
  // expires on its own, and the next verdict re-trips at the next rung.
  const hold = providerCapacityHolds.get(provider);
  if (!hold || hold.kind !== "capacity") providerCapacityHolds.delete(provider);
  providerFailureTimes.delete(provider);
}

/**
 * Does this failure read as capacity / risk control rather than a bad request?
 *
 * Covers the relay spellings (`capacity`, `capacity_exceeded`, `at capacity`), OpenAI's overload
 * wording, and the rate-limit family that a flagged account returns.
 */
export function isCapacityVerdict(status: number | undefined, code: string | null | undefined, message: string | undefined): boolean {
  const normalizedCode = String(code ?? "").trim().toLowerCase();
  if (["capacity", "capacity_exceeded", "capacity_reached", "at_capacity", "insufficient_capacity"].includes(normalizedCode)) {
    return true;
  }
  const text = String(message ?? "").toLowerCase();
  if (/\bcapacity\b|at capacity|overloaded|over capacity|满载|容量不足|风控/.test(text)) return true;
  return status === 429 && /rate limit|quota|limit/i.test(text);
}
/** Short cooldown for request-rate 429s (for example provider code 1302) that omit Retry-After. */
export const COMBO_REQUEST_RATE_COOLDOWN_MS = 5_000;

const QUOTA_LIMIT_CODES = new Set([
  "1308",
  "1310",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "insufficient_quota",
]);
const TRANSIENT_REQUEST_RATE_CODES = new Set(["1302", "1305"]);
const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const RFC850_DATE_RE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const ASCTIME_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i;
const HTTP_MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Map<`${comboId}\0${provider/model}`, TargetCooldown> */
const targetCooldowns = new Map<string, TargetCooldown>();
let lastReconciledGeneration = 0;
let liveComboTargets = new Set<string>();

function cooldownMapKey(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
): string {
  return `${comboId}\0${targetKey(target)}`;
}

function parseUtcDateParts(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = HTTP_MONTH_INDEX[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second
    ? timestamp
    : undefined;
}

function parseHttpDate(value: string, now: number): number | undefined {
  const imf = IMF_FIXDATE_RE.exec(value);
  if (imf) {
    return parseUtcDateParts(
      Number(imf[3]), imf[2]!, Number(imf[1]),
      Number(imf[4]), Number(imf[5]), Number(imf[6]),
    );
  }
  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    const current = new Date(now);
    const currentYear = current.getUTCFullYear();
    const month = HTTP_MONTH_INDEX[rfc850[2]!.toLowerCase()];
    if (month === undefined) return undefined;
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[3]);
    const yearDelta = year - currentYear;
    const candidateTimeOfYear = Date.UTC(
      2000, month, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
    const currentTimeOfYear = Date.UTC(
      2000, current.getUTCMonth(), current.getUTCDate(),
      current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    );
    if (yearDelta < -50 || (yearDelta === -50 && candidateTimeOfYear < currentTimeOfYear)) {
      year += 100;
    } else if (yearDelta > 50 || (yearDelta === 50 && candidateTimeOfYear > currentTimeOfYear)) {
      year -= 100;
    }
    return parseUtcDateParts(
      year, rfc850[2]!, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
  }
  const asctime = ASCTIME_DATE_RE.exec(value);
  if (!asctime) return undefined;
  return parseUtcDateParts(
    Number(asctime[6]), asctime[1]!, Number(asctime[2]),
    Number(asctime[3]), Number(asctime[4]), Number(asctime[5]),
  );
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
  options?: { preserveImmediate?: boolean; preserveServerDelay?: boolean },
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  // A local wait ceiling must not make an explicit upstream reset expire early.
  // Keep legacy bounded parsing for other callers. The opt-in stores a timestamp;
  // the combo picker still independently limits how long a live request waits.
  const maximum = options?.preserveServerDelay === true
    ? Number.MAX_SAFE_INTEGER - Math.max(0, now)
    : MAX_COOLDOWN_MS;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (
      Number.isFinite(seconds)
      && (seconds > 0 || (options?.preserveImmediate && seconds === 0))
    ) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), maximum);
    }
  }
  const timestamp = parseHttpDate(text, now);
  if (timestamp === undefined) return undefined;
  const delay = timestamp - now;
  if (delay > 0) return Math.min(delay, maximum);
  return options?.preserveImmediate ? 1 : undefined;
}

export function isComboTargetInCooldown(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): boolean {
  const key = cooldownMapKey(comboId, target);
  const entry = targetCooldowns.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    targetCooldowns.delete(key);
    return false;
  }
  return true;
}

/**
 * Whether this target's hold is a TRIPPED BREAKER (consecutive failures past the threshold).
 *
 * The distinction matters to the picker: a single failure only demotes a row, while a tripped
 * breaker takes it out of the healthy tier until it is probed or the window expires.
 */
export function isComboTargetBreakerOpen(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): boolean {
  const entry = targetCooldowns.get(cooldownMapKey(comboId, target));
  return Boolean(entry && entry.breakerTripped === true && entry.cooldownUntil > now);
}

export function isTransientRequestRateLimit(input: {
  status?: number;
  code?: string | null;
  message?: string;
}): boolean {
  if (isProviderScopedQuotaCap(input.status, input.message ?? "", input.code)) return false;
  const code = (input.code ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (QUOTA_LIMIT_CODES.has(code)) return false;
  if (TRANSIENT_REQUEST_RATE_CODES.has(code)) return true;
  const text = (input.message ?? "").toLowerCase();
  if (
    text.includes("usage limit reached")
    || text.includes("insufficient_quota")
    || text.includes("quota exhausted")
  ) {
    return false;
  }
  return text.includes("rate limit reached for requests");
}

export function remainingComboCooldownMs(comboId: string, now = Date.now()): number | undefined {
  const prefix = `${comboId}\0`;
  let soonest: number | undefined;
  for (const [key, cooldown] of targetCooldowns) {
    if (!key.startsWith(prefix)) continue;
    const remaining = cooldown.cooldownUntil - now;
    if (remaining <= 0) {
      targetCooldowns.delete(key);
      continue;
    }
    if (soonest === undefined || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

export function comboCooldownRetryAfterSeconds(comboId: string, now = Date.now()): string | undefined {
  const remainingMs = remainingComboCooldownMs(comboId, now);
  if (remainingMs === undefined) return undefined;
  return String(Math.max(1, Math.ceil(remainingMs / 1000)));
}

export function coolComboTarget(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  options?: {
    retryAfter?: string | null;
    resetAt?: unknown | unknown[];
    now?: number;
    cooldownMs?: number;
    writerGeneration?: number;
    status?: number;
    code?: string | null;
    message?: string;
    breaker?: ComboBreakerPolicy;
    /**
     * True only for the OFFICIAL OpenAI forward row. Its capacity / overload verdicts come from
     * OpenAI's own risk control, which lasts hours, so they escalate through the hold ladder.
     * Every other provider gets plain failover + breaker: it recovers when it recovers.
     */
    capacityHoldLadder?: boolean;
  },
): void {
  const now = options?.now ?? Date.now();
  const writerGeneration = options?.writerGeneration ?? captureConfigGeneration();
  const ownerKey = `${comboId}::${targetKey(target)}`;
  if (writerGeneration < lastReconciledGeneration && !liveComboTargets.has(ownerKey)) return;
  // A server-provided Retry-After is authoritative, including an immediate `0` directive.
  // A quota reset is the next-most-specific signal (#3256); configured and default cooldowns
  // are only fallbacks when upstream supplied neither usable value.
  const serverDelayMs = parseRetryAfterMs(options?.retryAfter, now, {
    preserveImmediate: true,
    preserveServerDelay: true,
  });
  const cooldownMs = serverDelayMs
    ?? parseResetCooldownMs(options?.resetAt, now)
    ?? options?.cooldownMs
    ?? (isTransientRequestRateLimit({
      status: options?.status,
      code: options?.code,
      message: options?.message,
    }) ? COMBO_REQUEST_RATE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
  const circuitKey = cooldownMapKey(comboId, target);
  // A first-byte deadline (or an upstream gateway timeout) is the "this channel is stuck" shape:
  // remember it so the ladder stops putting it first on every turn.
  if (options?.status === 504 || String(options?.message ?? "").includes("first-byte timeout")) {
    targetStuckAt.set(circuitKey, now);
  }
  // One failure still moves on immediately (that is the ladder); the long hold starts only once
  // the same target has failed failureThreshold times in a row, and a success clears the count.
  const circuit = targetCircuits.get(circuitKey) ?? { failures: 0, successes: 0 };
  circuit.failures += 1;
  circuit.successes = 0;
  targetCircuits.set(circuitKey, circuit);
  const breaker = options?.breaker;
  const breakerTripped = Boolean(breaker && circuit.failures >= breaker.failureThreshold);
  const fallbackCooldownMs = serverDelayMs ?? Math.min(Math.max(cooldownMs, 1), MAX_COOLDOWN_MS);
  const holdMs = breakerTripped
    ? Math.max(fallbackCooldownMs, breaker?.openMs ?? 0)
    : fallbackCooldownMs;
  targetCooldowns.set(circuitKey, {
    cooldownUntil: now + Math.max(holdMs, 1),
    ...(breakerTripped ? { breakerTripped: true } : {}),
  });
  // Capacity / risk control parks the whole provider, not just this target: the verdict is about
  // the account, so every combo and model that targets it should stay away until it recovers.
  // The official OpenAI row is parked on ANY 5xx (plus an explicit capacity verdict at any
  // status): its soft risk control shows up as "overloaded" 5xx with no capacity word in it, and
  // the operator has asked for the hour-scale ladder rather than per-request retries. Every other
  // provider needs the explicit capacity signal and otherwise keeps plain failover + breaker.
  const parkWorthy = options?.capacityHoldLadder === true
    && !isLocalFenceMessage(options?.message)
    && (isCapacityVerdict(options?.status, options?.code, options?.message) || (options?.status ?? 0) >= 500);
  if (parkWorthy) {
    const hold = noteProviderCapacityVerdict(target.provider, String(options?.message ?? "capacity").slice(0, 120), now);
    if (hold) {
      console.warn(`[combo] ${comboId}: ${target.provider} parked ${Math.round((hold.until - now) / 60000)}min (capacity rung #${hold.escalations}, ${hold.reason})`);
    }
  } else if (((options?.status ?? 0) >= 500 || options?.status === 429)
    && !isLocalFenceMessage(options?.message)) {
    // Provider-side failures only: a 4xx that describes the request must not park a provider for
    // everyone. 5xx and rate limits are the shapes a dead or throttled channel shows.
    if (noteProviderFailure(target.provider, now)) {
      const hold = providerCapacityHolds.get(target.provider)!;
      console.warn(`[combo] ${comboId}: ${target.provider} parked ${Math.round((hold.until - now) / 60000)}min (shared failure hold #${hold.escalations})`);
    }
  }
  sweepExpiredOnWrite(now);
}

/**
 * Record a successful attempt.
 *
 * After a tripped circuit this counts trial wins and closes the circuit once `successThreshold`
 * of them land in a row (cc-switch's 恢复成功阈值); below the threshold a single success just
 * clears the failure count, because the provider was never actually held.
 */
export function noteComboTargetSuccess(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  breaker: ComboBreakerPolicy = DEFAULT_COMBO_BREAKER,
): void {
  const key = cooldownMapKey(comboId, target);
  const circuit = targetCircuits.get(key);
  targetStuckAt.delete(key);
  // A success is the strongest evidence available -- the row just answered -- so its demotion ends
  // right here: the next pick puts it back in its price slot ("cheaper one works again -> go
  // back to it"). The consecutive-failure counter that OPENS the breaker is tracked separately
  // below and still needs the breaker's success threshold to be considered fully reset.
  targetCooldowns.delete(key);
  if (!circuit) return;
  if (circuit.failures >= breaker.failureThreshold) {
    circuit.successes += 1;
    if (circuit.successes >= breaker.successThreshold) {
      circuit.failures = 0;
      circuit.successes = 0;
    }
    return;
  }
  circuit.failures = 0;
  circuit.successes = 0;
}

export function earliestComboCooldown(
  comboId: string,
  targets: Iterable<Pick<OcxComboTarget, "provider" | "model">>,
  now = Date.now(),
): { expiry: number; target: Pick<OcxComboTarget, "provider" | "model"> } | undefined {
  let earliest: { expiry: number; target: Pick<OcxComboTarget, "provider" | "model"> } | undefined;
  for (const target of targets) {
    const key = cooldownMapKey(comboId, target);
    const entry = targetCooldowns.get(key);
    if (!entry || entry.cooldownUntil <= now) continue;
    if (earliest === undefined || entry.cooldownUntil < earliest.expiry) {
      earliest = { expiry: entry.cooldownUntil, target };
    }
  }
  return earliest;
}

/** Public convenience wrapper returning only the earliest cooldown expiry. */
export function earliestComboCooldownExpiry(
  comboId: string,
  targets: Iterable<Pick<OcxComboTarget, "provider" | "model">>,
  now = Date.now(),
): number | undefined {
  return earliestComboCooldown(comboId, targets, now)?.expiry;
}

export function reconcileComboTargetCooldowns(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  liveComboTargets = new Set(context.comboTargets);
  lastReconciledGeneration = context.generation;
  return 0;
}

export function sweepExpiredComboTargetCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of targetCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    targetCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

export function clearComboTargetCooldowns(comboId?: string): void {
  if (comboId === undefined) {
    targetCooldowns.clear();
    liveComboTargets.clear();
    lastReconciledGeneration = 0;
    return;
  }
  const prefix = `${comboId}\0`;
  for (const key of targetCooldowns.keys()) {
    if (key.startsWith(prefix)) targetCooldowns.delete(key);
  }
}

export type ComboFailureDecision = "hop" | "stop";
export type ComboFailureCooldownScope = "none" | "target" | "provider";

function normalizedFailureCode(code?: string | null): string {
  return code?.trim().toLowerCase().replaceAll("-", "_") ?? "";
}

function isProviderScopedQuotaCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  const normalizedCode = normalizedFailureCode(code);
  const text = message.toLowerCase();
  if (
    status === 429
    && (normalizedCode === "gousagelimiterror" || text.includes("monthly usage limit reached"))
  ) {
    return true;
  }
  return text.includes("err_free_prompt_cap")
    || (text.includes("free tier") && text.includes("single request"));
}

/**
 * A free-tier cap the upstream evaluates PER REQUEST rather than per account window. These
 * needles used to reach only `isProviderScopedQuotaCap`, so a single oversized free-tier prompt
 * cooled the whole provider for every other combo — including the shorter requests that same
 * provider would still have served. `free_rate_limited` also left the provider-scoped predicate
 * for the same reason; it stays a hop signal, but stops recording provider-wide evidence.
 */
function isRequestLocalFreePromptCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400) return false;
  const text = message.toLowerCase();
  if (normalizedFailureCode(code) === "free_rate_limited") return true;
  if (text.includes("err_free_prompt_cap")) return true;
  return text.includes("free tier") && (text.includes("single request") || text.includes("prompt"));
}

/**
 * Failures that describe the SHAPE of this request rather than the health of the target.
 * Cooling anything for these is wrong twice over: the target is fine, and the next request
 * (shorter prompt, smaller tool catalog) would have succeeded against it.
 */
const REQUEST_SHAPE_FAILURE_CODES = new Set([
  "input_admission_refused",
  "context_length_exceeded",
  "tool_catalog_too_large",
  "cursor_root_envelope_limit",
  "target_incompatible",
]);

/** Credential/billing failures that every target sharing the provider inherits. */
const PROVIDER_SCOPED_FAILURE_CODES = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "subscription_required",
  "payment_required",
  "billing_error",
  "insufficient_balance",
]);

/**
 * Precise target-local request incompatibilities are request-local, not terminal for a combo.
 * Require a bounded, intact provider envelope; never infer compatibility from echoed prompt text.
 * Only OpenCodex's exact error wrapper may be unwrapped, with a fixed depth budget. Unknown or
 * conflicting codes fail closed. No fields are removed here and no same-target replay is added.
 * Image rejection requires `param: input` and an exact model-scoped prefix.
 */
function isRequestLocalTargetIncompatibility(status: number, message: string, code?: string | null): boolean {
  if (status !== 400 || message.length > 16_384) return false;
  const genericCodes = new Set(["", "invalid_request_error", "unsupported_parameter", "unsupported_value"]);
  if (!genericCodes.has(normalizedFailureCode(code))) return false;
  let text = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (text.startsWith("Provider error 400: ")) text = text.slice("Provider error 400: ".length);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    // A target can demand a different request SHAPE than the caller sent. The ChatGPT forward
    // backend answers a non-stream body with `{detail:"Stream must be set to true"}`, which says
    // nothing about the next combo target -- the relays accept the same body as-is. Hop instead of
    // stopping there, and (via comboFailureCooldownScope) do not cool a rung for a shape refusal.
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === "string" && /stream\s+must\s+be\s+set\s+to\s+true/i.test(detail)) return true;
    const error = (payload as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as Record<string, unknown>;
    if (e.code !== undefined && e.code !== null && typeof e.code !== "string") return false;
    const errorCode = normalizedFailureCode(typeof e.code === "string" ? e.code : undefined);
    if (!genericCodes.has(errorCode) || typeof e.message !== "string") return false;
    if (e.type !== "invalid_request_error" && e.type !== "upstream_error") return false;
    if (e.message.startsWith("Provider error 400: ") && e.param === undefined
      && (errorCode === "" || errorCode === "invalid_request_error")) {
      text = e.message;
      continue;
    }
    if (e.type !== "invalid_request_error") return false;
    if (e.message === "Unsupported parameter: user") {
      return (e.param === undefined || e.param === "user") && errorCode !== "unsupported_value";
    }
    if (errorCode === "unsupported_value"
      && (e.param === "reasoning.effort" || e.param === "reasoning_effort")
      && e.message.startsWith("Unsupported value:") && e.message.includes("not supported")) return true;
    if (e.code === null
      && e.param === "reasoning_effort"
      && /^Function tools with reasoning_effort are not supported for gpt-6-astra(?:-\d{4}-\d{2}-\d{2})? in \/v1\/chat\/completions\. To use function tools, use \/v1\/responses or set reasoning_effort to 'none'\.$/.test(e.message)) return true;
    return e.param === "input"
      && (errorCode === "" || errorCode === "invalid_request_error")
      && /^Model '[^']{1,256}' does not support image inputs\./.test(e.message);
  }
  return false;
}

/**
 * Codes a gateway uses when it declines a request field it cannot serve.
 *
 * Wider than the set {@link isRequestLocalTargetIncompatibility} accepts, by exactly one member:
 * Alibaba's gateway reports `invalid_parameter_error`. It is kept in its own set rather than
 * added to the shared one, because that set also governs the `user` parameter and image-input
 * branches and widening it there would admit shapes those branches were reasoned about without.
 */
const RESPONSE_FORMAT_REFUSAL_CODES = new Set([
  "",
  "invalid_request_error",
  "invalid_parameter_error",
  "unsupported_parameter",
  "unsupported_value",
]);

/**
 * Does this message say the target cannot PROVIDE `response_format`, rather than that the
 * request's `response_format` was malformed?
 *
 * That distinction is the whole point of #4903 and it is why neither obvious option was taken.
 * Hopping on every 400 would replay a genuinely malformed request against every remaining
 * target. Dropping `response_format` would silently change the output contract the caller
 * asked for, on a path whose entire purpose is a structured result.
 *
 * So both halves are required: the message must name the field, AND it must say the field is
 * unavailable or unsupported. "Invalid schema for response_format" names the field and claims
 * nothing about capability, so it stays terminal.
 *
 * `param` may be absent or explicitly null -- the reported gateway sends `param: null` -- but a
 * param naming a DIFFERENT field contradicts the message and fails closed.
 */
function namesResponseFormatIncapability(message: string, param: unknown): boolean {
  if (param !== undefined && param !== null && param !== "response_format") return false;
  const text = message.toLowerCase();
  if (!text.includes("response_format")) return false;
  return /(unavailable|not available|unsupported|not supported|does not support|doesn't support|cannot be used|is not enabled)/u
    .test(text);
}

/**
 * A `response_format` capability gap is target-local: this model cannot produce the requested
 * output shape, which says nothing about the next target in the combo.
 *
 * Reported against a shadow title-generation call, where a combo's first target rejects
 * `response_format` and the chain stops instead of trying the target behind it (#4903).
 *
 * The next target receives the SAME request, `response_format` included, so a target that can
 * honour the contract honours it and one that cannot is skipped in turn. Traversal stays finite
 * because combo excludes each attempted target and policy tries each candidate once.
 *
 * The envelope is bounded exactly like {@link isRequestLocalTargetIncompatibility}: an intact
 * provider JSON object, a depth budget, `type: "invalid_request_error"`, and a code from a
 * closed set. Nothing is inferred from echoed prompt text and no field is removed.
 */
function isResponseFormatCapabilityRefusal(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400 || message.length > 16_384) return false;
  if (!RESPONSE_FORMAT_REFUSAL_CODES.has(normalizedFailureCode(code))) return false;
  let text = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (text.startsWith("Provider error 400: ")) {
      text = text.slice("Provider error 400: ".length).trim();
    }
    // A chat gateway can report the refusal inside a single SSE frame, and the combo consumer
    // keeps the raw text when that frame stops the error object from being extracted -- which is
    // why the reported classification text reads `data: {"error":...}` and why the structured
    // code arrives undefined. Exactly one `data:` prefix is removed, and only when the body is
    // one line: this unwraps a single frame rather than parsing a stream, so a multi-event body
    // is left alone and still fails closed.
    if (text.startsWith("data:") && !text.includes("\n")) {
      text = text.slice("data:".length).trim();
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const error = (payload as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as Record<string, unknown>;
    if (e.code !== undefined && e.code !== null && typeof e.code !== "string") return false;
    if (typeof e.message !== "string") return false;
    // Our own wrapper, re-wrapped by a downstream hop. Peel it and look again, within budget.
    if (e.message.startsWith("Provider error 400: ") && e.param === undefined) {
      text = e.message;
      continue;
    }
    if (e.type !== "invalid_request_error") return false;
    const errorCode = normalizedFailureCode(typeof e.code === "string" ? e.code : undefined);
    if (!RESPONSE_FORMAT_REFUSAL_CODES.has(errorCode)) return false;
    return namesResponseFormatIncapability(e.message, e.param);
  }
  return false;
}

export function comboFailureCooldownScope(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureCooldownScope {
  const code = normalizedFailureCode(options?.code);
  // Request-shape refusals first: an oversized request must not cool a healthy target.
  // A native transport can surface a zero-output model overflow as a generic
  // upstream_server_error carrying precise context-window prose, so consult the bounded
  // message classifier too: that target is healthy, the turn was simply too large for it.
  if (
    status === 413
    || REQUEST_SHAPE_FAILURE_CODES.has(code)
    || isRequestLocalFreePromptCap(status, message, options?.code)
    || isProviderTargetContextOverflow(status, message, options?.code)
    || isDefiniteContextOverflow(status, message)
    || isRequestLocalTargetIncompatibility(status, message, options?.code)
    // A capability gap says the target is healthy and the request did not fit it, which is the
    // same reason every other entry here refuses to cool a target.
    || isResponseFormatCapabilityRefusal(status, message, options?.code)
  ) return "none";
  if (isProviderScopedQuotaCap(status, message, options?.code)) return "provider";
  // A rejected or unpaid credential is provider-wide evidence: every target that routes
  // through the same provider row carries the same key and will fail identically.
  if (status === 401 || status === 402 || status === 403) return "provider";
  if (PROVIDER_SCOPED_FAILURE_CODES.has(code)) return "provider";
  return "target";
}

function isModelLifecycleGone(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 410) return false;
  const normalizedCode = code?.trim().toLowerCase().replaceAll("-", "_");
  if ([
    "model_deprecated",
    "model_end_of_life",
    "model_eol",
    "model_not_found",
    "model_retired",
  ].includes(normalizedCode ?? "")) return true;
  const text = message.toLowerCase();
  return /\bmodel\b/.test(text) && (
    /\bend[ -]of[ -]life\b/.test(text)
    || /\bno longer available\b/.test(text)
    || /\b(?:deprecated|retired|retirement|sunset|decommissioned)\b/.test(text)
  );
}

function isProviderTargetContextOverflow(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400) return false;
  const normalizedCode = normalizedFailureCode(code);
  const text = message.toLowerCase();
  if (text.includes("invalid_request_prompt_too_long")) return true;
  return normalizedCode === "5059"
    && /\bprompt\s+\d+\s*>\s*\d+\s+maximum context length\b/i.test(message);
}

  /** A status can carry a verdict about the REQUEST; 401/403/429 speak about the credential. */
const CONTEXT_VERDICT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/** Phrases a provider emits when the input does not fit this model's context window. */
const DEFINITE_CONTEXT_OVERFLOW_PHRASES = [
  "exceeds the context window",
  "exceed the context window",
  "context window exceeded",
  "context length exceeded",
  "maximum context length",
  "maximum context window",
  "too many tokens",
];
const MAX_CONTEXT_OVERFLOW_ENVELOPES = 4;

function isDefiniteContextOverflowMessage(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized === "context_length_exceeded"
    || DEFINITE_CONTEXT_OVERFLOW_PHRASES.some(phrase => normalized.includes(phrase));
}

/** Unwrap bounded provider envelopes before reading the leaf message. */
function isDefiniteContextOverflow(status: number, message: string): boolean {
  if (!CONTEXT_VERDICT_STATUSES.has(status) && status < 500) return false;
  if (message.length > 16_384) return false;
  let text = message.trim();
  for (let unwrapped = 0; unwrapped <= MAX_CONTEXT_OVERFLOW_ENVELOPES; unwrapped += 1) {
    const providerPrefix = /^Provider error \d{3}:\s*/.exec(text);
    if (providerPrefix) text = text.slice(providerPrefix[0].length).trim();
    if (!text.startsWith("{")) return isDefiniteContextOverflowMessage(text);
    if (unwrapped === MAX_CONTEXT_OVERFLOW_ENVELOPES) return false;
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    const response = record.response && typeof record.response === "object" && !Array.isArray(record.response)
      ? record.response as Record<string, unknown>
      : undefined;
    const source = [record.error, response?.error, response?.last_error, record.last_error, record]
      .find((candidate): candidate is Record<string, unknown> =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && typeof (candidate as Record<string, unknown>).message === "string");
    if (!source) return false;
    text = (source.message as string).trim();
  }
  return false;
}

/** Narrow 400 capacity verdicts are target-local, not malformed requests. */
const TARGET_CAPACITY_CODES = new Set([
  "capacity",
  "capacity_exceeded",
  "capacity_reached",
  "at_capacity",
]);
function isTargetCapacityRejection(status: number, message: string, code?: string | null): boolean {
  const normalizedCode = normalizedFailureCode(code);
  if (TARGET_CAPACITY_CODES.has(normalizedCode)) return true;
  if (status !== 400) return false;
  return /^(?:provider error 400:\s*)?(?:capacity|at capacity|capacity reached|capacity exceeded)[.!]?$/i
    .test(message.trim());
}
function isTargetPayloadTooLarge(status: number, code?: string | null): boolean {
  if (status !== 413) return false;
  const normalizedCode = normalizedFailureCode(code);
  return normalizedCode !== "outbound_body_too_large"
    && normalizedCode !== "translation_buffer_limit";
}

export function comboFailureDecision(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureDecision {
  if (status === 499) return "stop";
  if (message.toLowerCase().includes("origin_rejected")) return "stop";
  // Structured form of the same hard refusal. The prose test above misses it when the origin
  // reports the code out of band, and every hop rule below -- including the context-overflow
  // one -- must stay subordinate to it.
  if (normalizedFailureCode(options?.code) === "origin_rejected") return "stop";
  // The origin may already be executing this turn (the Codex WebSocket relay sent the create
  // frame and never saw a response event). Hopping would send the same request to a second
  // target while the first may still be generating; the honest status goes to the client.
  if (isNonReplayableUpstreamCode(options?.code)) return "stop";
  // Cyber policy is a hard non-retryable refusal — honor structured code even when
  // classificationText was truncated before the JSON code field.
  if (isCyberPolicyCode(options?.code)) return "stop";
  // HTTP 410 is normally terminal. A model-specific lifecycle verdict is target-local,
  // however: another provider/model in the declared combo can still serve the request.
  // Require structured lifecycle code or explicit model+lifecycle prose so unrelated
  // application-level 410 responses remain fail-closed.
  if (isModelLifecycleGone(status, message, options?.code)) return "hop";
  const error = classifyError(status, "upstream_error", message);
  if (isCyberPolicyCode(error.code)) return "stop";
  if (isTargetCapacityRejection(status, message, options?.code)) return "hop";
  if (isTargetPayloadTooLarge(status, options?.code)) return "hop";
  // A provider can expose its own target hard cap with a non-semantic vendor code
  // (for example 5059 + invalid_request_prompt_too_long). That is evidence that this
  // target is too small, not that every later combo target is incapable of serving it.
  if (isProviderTargetContextOverflow(status, message, options?.code)) return "hop";
  // A definite context-window refusal is target-local inside a heterogeneous combo: this model
  // cannot hold the turn, but a later target may have a larger window. Two boundaries keep this
  // safe. It is reached only after cancellation, structured origin/cyber refusals and
  // non-replayable post-send codes have already stopped. And it only ever classifies a failure
  // the combo stream preflight already proved emitted no output: `comboStreamPayloadCommitsOutput`
  // commits the child on any text, tool call or unknown event, and only a zero-output terminal
  // becomes a failure response at all, so a turn whose text the client already saw is never
  // reclassified here.
  if (isDefiniteContextOverflow(status, message)) return "hop";
  // A local input-admission refusal (#1524) says "this candidate cannot fit the request",
  // not "the request is impossible": the next candidate may have a larger context window.
  //
  // This MUST be tested before the generic stop list below. Our own refusal message says
  // "context window" -- that is what it refuses on -- and the classifier remaps that phrase,
  // so checking the stop list first swallowed the signal and ended the chain. An UPSTREAM
  // `context_length_exceeded` carries no admission code and still falls through to stop.
  //
  // Matched on the STRUCTURED code only, which classifyError now preserves for our own
  // refusal. A raw substring test would additionally let any upstream override a terminal
  // verdict by echoing the token in prose we do not control.
  //
  // Precise about what this is NOT: an upstream can still SET this code deliberately, since
  // both extractors read the upstream error object. That is bounded rather than dangerous --
  // an upstream already controls other hop signals (429, 5xx), and traversal is finite: policy
  // tries each candidate once via `tried`, and combo excludes each attempted target. So this is
  // structured-code-only, not provably local.
  if (options?.code === "input_admission_refused" || error.code === "input_admission_refused") {
    return "hop";
  }
  if (isProviderScopedQuotaCap(status, message, options?.code || error.code)) {
    return "hop";
  }
  // A model-scoped rejection is target-local: this provider does not serve THIS model, which
  // says nothing about the next combo target. Structured code only, plus the explicit prose
  // form upstreams emit when they carry no code, so an unrelated 400 stays terminal.
  const failureCode = normalizedFailureCode(options?.code || error.code);
  if (["model_not_found", "model_unavailable", "unsupported_model"].includes(failureCode)) {
    return "hop";
  }
  // `free_rate_limited` no longer routes through `isProviderScopedQuotaCap` (it is a
  // per-request cap, not provider-wide evidence), so keep its hop verdict explicit here.
  if (failureCode === "free_rate_limited") return "hop";
  if (isRequestLocalTargetIncompatibility(status, message, options?.code)) return "hop";
  // Must precede the generic `invalid_request_error` stop below, which is where this refusal
  // ended the chain: the gateway reports `type: "invalid_request_error"`, so the classifier
  // reaches that list and returns terminal before anything can ask whether the next target
  // could have served the request (#4903).
  if (isResponseFormatCapabilityRefusal(status, message, options?.code)) return "hop";
  if (["origin_rejected", "context_length_exceeded", "invalid_request_error"].includes(error.code ?? "")) {
    return "stop";
  }
  // 402 (payment required) and 425 (too early) are provider-state signals, not verdicts about
  // the request: another combo target can still serve it.
  if ([401, 402, 403, 404, 408, 425, 429].includes(status) || status >= 500) return "hop";
  if ([
    "permission_denied",
    "subscription_required",
    "invalid_api_key",
    "insufficient_quota",
    "payment_required",
    "billing_error",
    "insufficient_balance",
    "rate_limit_exceeded",
    "server_is_overloaded",
    "upstream_server_error",
  ].includes(error.code ?? "")) {
    return "hop";
  }
  return "stop";
}
