/**
 * Provider quality holds: the one input that says "this channel serves WRONG ANSWERS".
 *
 * Everything else in the router ranks channels by availability -- quota, capacity, breaker,
 * latency. None of those can see a channel that answers happily and incorrectly, which is exactly
 * what a risk-controlled or downgraded relay does (measured 2026-09-25: the official gpt-6 family
 * answered 29 to a question whose minimum is provably 21, on five fresh sessions in a row).
 *
 * The verdict is produced OUTSIDE this process by `tools/pelican-probe.py --apply`, which asks
 * questions with independently verified answers and grades the answers with a judge model on a
 * DIFFERENT channel. The contract between the two sides is one small file,
 * \`~/.opencodex/quality-holds.json\`, so the probe needs no management API and the proxy needs no
 * probe logic:
 *
 *   { "version": 1, "holds": { "<provider>": { "until": epochMs, "since": epochMs,
 *       "model": "gpt-5.6-sol", "reason": "candy: answered 29, expected 21", "failedRounds": 1 } } }
 *
 * The policy is deliberately one-sided, and mirrors what a quality gate has to be to be safe:
 * only a CLEAR wrong answer creates a hold; transport errors, auth failures, unanswered requests
 * and "unknown" verdicts never do, and never clear one either. A hold is removed by the probe
 * alone, after a round in which every question on that provider passed.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";

const QUALITY_HOLDS_FILE = "quality-holds.json";
/** Re-read budget: the probe writes at most once per round, so 30s costs nothing on the hot path. */
const QUALITY_HOLDS_TTL_MS = 30_000;
/** A hold that outlives this was written by hand or by a bug; ignoring it fails safe. */
const MAX_HOLD_SPAN_MS = 48 * 60 * 60_000;

export interface ProviderQualityHold {
  /** Epoch ms after which the hold no longer applies. */
  until: number;
  /** Epoch ms of the first hold in the current streak. */
  since: number;
  /** The model that was asked when the wrong answer came back. */
  model?: string;
  /** Content-free summary of what was wrong, for logs and reports. */
  reason?: string;
  /** Consecutive rounds with a clear wrong answer. */
  failedRounds?: number;
}

let cached: { readAt: number; mtimeMs: number; holds: Map<string, ProviderQualityHold> } | undefined;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseHold(value: unknown, now: number): ProviderQualityHold | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isFiniteNumber(raw.until) || !isFiniteNumber(raw.since)) return null;
  if (raw.until <= now || raw.until - now > MAX_HOLD_SPAN_MS) return null;
  const hold: ProviderQualityHold = { until: raw.until, since: raw.since };
  if (typeof raw.model === "string" && raw.model.length > 0 && raw.model.length <= 128) hold.model = raw.model;
  if (typeof raw.reason === "string" && raw.reason.length > 0 && raw.reason.length <= 512) hold.reason = raw.reason;
  if (isFiniteNumber(raw.failedRounds) && raw.failedRounds >= 0) {
    hold.failedRounds = Math.floor(raw.failedRounds);
  }
  return hold;
}

function holds(now: number): Map<string, ProviderQualityHold> {
  const path = join(getConfigDir(), QUALITY_HOLDS_FILE);
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = 0; }
  if (cached && cached.mtimeMs === mtimeMs && now - cached.readAt < QUALITY_HOLDS_TTL_MS) {
    return cached.holds;
  }
  const map = new Map<string, ProviderQualityHold>();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; holds?: unknown };
    if (parsed.version === 1 && parsed.holds !== null && typeof parsed.holds === "object"
      && !Array.isArray(parsed.holds)) {
      for (const [provider, entry] of Object.entries(parsed.holds as Record<string, unknown>)) {
        if (provider.length === 0 || provider.length > 128) continue;
        const hold = parseHold(entry, now);
        if (hold) map.set(provider, hold);
      }
    }
  } catch {
    /* absent or malformed means "nothing held"; the probe rewrites the whole file each round */
  }
  cached = { readAt: now, mtimeMs, holds: map };
  return map;
}

/** The active hold on a provider, or undefined. Never throws, never probes, never blocks. */
export function providerQualityHold(name: string, now = Date.now()): ProviderQualityHold | undefined {
  const hold = holds(now).get(name);
  return hold !== undefined && hold.until > now ? hold : undefined;
}

/** Routing-facing predicate: true while this provider's answers cannot be trusted. */
export function providerQualityHeld(name: string, now = Date.now()): boolean {
  return providerQualityHold(name, now) !== undefined;
}

/** Test seam: forget the file cache so a rewritten fixture is read back. */
export function clearQualityHoldCacheForTests(): void {
  cached = undefined;
}
