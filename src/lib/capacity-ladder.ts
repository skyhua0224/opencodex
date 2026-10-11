/**
 * Operator-extensible capacity-absorption ladder.
 *
 * The built-in capacity ladder (CAPACITY_RETRY_DELAYS_MS) paces four resends across
 * ~90s of waits, which covers the short shed windows measured on 2026-09-23. Longer
 * windows exist too: on 2026-10-10 the official backend weight-shed one account's
 * gpt-6.1-sol turns for most of three hours, and every terminal answer meant a parked
 * session waiting for a human to press Retry. An operator whose sessions must
 * self-heal through longer windows can extend the tail here; each extra rung is one
 * paced resend of the SAME turn, so a survived window finishes the task instead of
 * stopping it.
 *
 * Deliberately narrow: the override replaces the rung list only. Slow-shed skipping,
 * the slow-capacity extra send, budget accounting, and every verdict are the caller's
 * existing machinery, unchanged. Malformed config degrades to the built-in ladder.
 */

export interface CapacityRetryConfig {
  enabled?: boolean;
  /** Paced waits before each extra resend, milliseconds, applied in ascending order. */
  delaysMs?: number[];
}

const MAX_RUNGS = 8;

let configured: readonly number[] | null = null;

/**
 * The operator ladder, or null when it is disabled/malformed/absent -- null meaning
 * "use the built-in CAPACITY_RETRY_DELAYS_MS" at the call sites.
 */
export function capacityLadderDelays(): readonly number[] | null {
  return configured;
}

/** Cheap and idempotent: loadConfig() calls this on every config read. */
export function configureCapacityLadder(config?: CapacityRetryConfig | undefined): void {
  if (!config || config.enabled !== true || !Array.isArray(config.delaysMs)
    || config.delaysMs.length === 0) {
    configured = null;
    return;
  }
  const cleaned = config.delaysMs
    .filter(ms => Number.isFinite(ms))
    .map(ms => Math.min(600_000, Math.max(1_000, Math.round(ms))))
    .sort((a, b) => a - b);
  configured = cleaned.length > 0
    ? Object.freeze(cleaned.slice(0, MAX_RUNGS))
    : null;
}
