/**
 * Account-level connection-reset storm coordination.
 *
 * chatgpt.com reclaims a whole account's idle long-lived connections at once. At the
 * reclaim moment every conversation's in-flight request dies together, and each lane
 * independently spends its own reset-replacement ladder against the same dying pool:
 * N lanes x N sends land inside the same few seconds, then nearly simultaneously settle
 * as replay refusals. The ladder is per-request by design; what no single request can
 * see is the storm. This module is that one shared view.
 *
 * It changes WHEN a replacement send happens, never WHETHER one is allowed. Verdicts
 * stay with the stage table: an ambiguous pre-header reset still refuses exactly as
 * before, a post-origin reset still refuses with its evidence, and the send budget is
 * still the only thing that authorizes a send. During a declared storm the coordinator
 * adds a lane-stable stagger before the paced wait and lets at most a few replacement
 * sends run at once; the first one that reaches response headers proves a live path and
 * lifts the storm for every queued lane. Nothing here persists, nothing here sees a
 * credential, and the scope key is the same origin label the retry warn log prints.
 */

/** Operator-tunable knobs. Every duration is milliseconds; every count is bounded. */
export interface ResetStormConfig {
  enabled: boolean;
  /** Resets from this many DISTINCT lanes inside the window declare a storm. */
  minLanes: number;
  /** Sliding window a reset stays evidence for the distinct-lane count. */
  detectionWindowMs: number;
  /** How long one declaration coordinates sends, extended by fresh resets. */
  stormWindowMs: number;
  /** Hard cap measured from the FIRST declaration, so a campaign cannot pin the gate. */
  maxStormWindowMs: number;
  /** Lane-stable extra wait spread added on top of the paced ladder during a storm. */
  staggerSpreadMs: number;
  /** Replacement sends one scope may have in flight at once during a storm. */
  maxConcurrentReplacements: number;
  /** Longest one lane may queue for a slot before it settles without sending. */
  queueDeadlineMs: number;
}

export const DEFAULT_RESET_STORM_CONFIG: Readonly<ResetStormConfig> = Object.freeze({
  // Opt-in like every other retry policy: the operator who configured the replacement
  // ladder decides whether its sends should also be storm-coordinated.
  enabled: false,
  minLanes: 3,
  detectionWindowMs: 10_000,
  stormWindowMs: 45_000,
  maxStormWindowMs: 180_000,
  staggerSpreadMs: 15_000,
  maxConcurrentReplacements: 2,
  queueDeadlineMs: 30_000,
});

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function resolveResetStormConfig(partial?: Partial<ResetStormConfig>): ResetStormConfig {
  const base = DEFAULT_RESET_STORM_CONFIG;
  const stormWindowMs = clampInt(partial?.stormWindowMs, 5_000, 300_000, base.stormWindowMs);
  return {
    enabled: partial?.enabled ?? base.enabled,
    minLanes: clampInt(partial?.minLanes, 2, 64, base.minLanes),
    detectionWindowMs: clampInt(partial?.detectionWindowMs, 1_000, 60_000, base.detectionWindowMs),
    stormWindowMs,
    maxStormWindowMs: Math.max(
      stormWindowMs,
      clampInt(partial?.maxStormWindowMs, 30_000, 900_000, base.maxStormWindowMs),
    ),
    staggerSpreadMs: clampInt(partial?.staggerSpreadMs, 0, 60_000, base.staggerSpreadMs),
    maxConcurrentReplacements: clampInt(
      partial?.maxConcurrentReplacements, 1, 16, base.maxConcurrentReplacements),
    queueDeadlineMs: clampInt(partial?.queueDeadlineMs, 250, 120_000, base.queueDeadlineMs),
  };
}

/** A granted replacement-send slot. Release exactly once, on every exit path. */
export interface ResetStormSlot {
  release(): void;
}

/**
 * null: no storm, send ungated. A slot: send under the gate, then release. "defer": the
 * queue deadline or an abort expired before a slot freed; the caller settles this leg
 * WITHOUT sending, exactly as an exhausted budget would have settled it.
 */
export type ResetStormGate = ResetStormSlot | "defer" | null;

interface ResetEvent {
  at: number;
  lane: string;
}

interface GateWaiter {
  resolve: (gate: ResetStormGate) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  onAbort: (() => void) | undefined;
  signal: AbortSignal | undefined;
  settled: boolean;
}

interface ScopeState {
  events: ResetEvent[];
  activeUntil: number | null;
  stormStartedAt: number | null;
  running: number;
  waiters: GateWaiter[];
}

export interface ResetStormCoordinator {
  recordReset(scope: string, lane: string): void;
  replacementStaggerMs(scope: string, lane: string): number;
  acquireReplacementSlot(scope: string, signal?: AbortSignal): Promise<ResetStormGate>;
  noteSendSuccess(scope: string): void;
  stormActive(scope: string): boolean;
  config(): ResetStormConfig;
  /** Live-reconfigures knobs in place; declared-storm state is kept. */
  configure(partial?: Partial<ResetStormConfig>): void;
}

/** FNV-1a: lane-stable, order-independent, no dependencies. */
function laneSpreadOffset(lane: string, spread: number): number {
  if (spread <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < lane.length; index++) {
    hash ^= lane.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % spread;
}

const MAX_TRACKED_RESETS = 512;

export function createResetStormCoordinator(overrides?: {
  config?: Partial<ResetStormConfig>;
  now?: () => number;
}): ResetStormCoordinator {
  let config = resolveResetStormConfig(overrides?.config);
  const clock = overrides?.now ?? ((): number => Date.now());
  const scopes = new Map<string, ScopeState>();

  function scopeState(scope: string): ScopeState {
    let state = scopes.get(scope);
    if (state === undefined) {
      state = { events: [], activeUntil: null, stormStartedAt: null, running: 0, waiters: [] };
      scopes.set(scope, state);
    }
    return state;
  }

  function isActive(state: ScopeState, at: number): boolean {
    return state.activeUntil !== null && state.activeUntil > at;
  }

  function pruneEvents(state: ScopeState, at: number): void {
    const horizon = Math.max(config.detectionWindowMs, config.stormWindowMs) * 2;
    state.events = state.events.filter(event => at - event.at <= horizon);
    if (state.events.length > MAX_TRACKED_RESETS) {
      state.events = state.events.slice(state.events.length - MAX_TRACKED_RESETS);
    }
  }

  function detachWaiter(state: ScopeState, waiter: GateWaiter): void {
    const index = state.waiters.indexOf(waiter);
    if (index >= 0) state.waiters.splice(index, 1);
  }

  function settle(state: ScopeState, waiter: GateWaiter, gate: ResetStormGate): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    detachWaiter(state, waiter);
    waiter.resolve(gate);
  }

  function promote(scope: string, state: ScopeState): void {
    while (state.running < config.maxConcurrentReplacements && state.waiters.length > 0) {
      const waiter = state.waiters[0];
      if (waiter === undefined) break;
      if (!isActive(state, clock())) {
        settle(state, waiter, null);
        continue;
      }
      state.running += 1;
      settle(state, waiter, {
        release(): void {
          state.running = Math.max(0, state.running - 1);
          promote(scope, state);
        },
      });
    }
  }

  return {
    config(): ResetStormConfig {
      return config;
    },

    configure(partial?: Partial<ResetStormConfig>): void {
      config = resolveResetStormConfig({ ...config, ...partial });
    },

    recordReset(scope: string, lane: string): void {
      if (!config.enabled) return;
      const at = clock();
      const state = scopeState(scope);
      pruneEvents(state, at);
      state.events.push({ at, lane });
      if (isActive(state, at)) {
        const extended = Math.min(
          (state.stormStartedAt ?? at) + config.maxStormWindowMs,
          at + config.stormWindowMs,
        );
        state.activeUntil = Math.max(state.activeUntil ?? 0, extended);
        return;
      }
      const recentLanes = new Set(
        state.events
          .filter(event => event.at >= at - config.detectionWindowMs)
          .map(event => event.lane),
      );
      if (recentLanes.size >= config.minLanes) {
        state.activeUntil = at + config.stormWindowMs;
        state.stormStartedAt = at;
        console.warn(
          "[reset-storm] declared scope=" + (scope || "upstream")
          + " lanes=" + recentLanes.size
          + " window=" + config.stormWindowMs + "ms",
        );
      }
    },

    replacementStaggerMs(scope: string, lane: string): number {
      if (!config.enabled || config.staggerSpreadMs <= 0) return 0;
      const state = scopes.get(scope);
      if (state === undefined || !isActive(state, clock())) return 0;
      return laneSpreadOffset(lane, config.staggerSpreadMs);
    },

    acquireReplacementSlot(scope: string, signal?: AbortSignal): Promise<ResetStormGate> {
      if (!config.enabled) return Promise.resolve(null);
      const state = scopeState(scope);
      if (!isActive(state, clock())) return Promise.resolve(null);
      return new Promise(resolve => {
        const waiter: GateWaiter = {
          resolve, timer: undefined, onAbort: undefined, signal: undefined, settled: false,
        };
        if (signal !== undefined && signal.aborted) {
          settle(state, waiter, "defer");
          return;
        }
        waiter.timer = setTimeout(() => settle(state, waiter, "defer"), config.queueDeadlineMs);
        if (signal !== undefined) {
          waiter.signal = signal;
          waiter.onAbort = (): void => settle(state, waiter, "defer");
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        state.waiters.push(waiter);
        promote(scope, state);
      });
    },

    noteSendSuccess(scope: string): void {
      if (!config.enabled) return;
      const state = scopes.get(scope);
      if (state === undefined || !isActive(state, clock())) return;
      const lasted = clock() - (state.stormStartedAt ?? clock());
      state.activeUntil = null;
      state.stormStartedAt = null;
      state.events = [];
      console.warn(
        "[reset-storm] lifted scope=" + (scope || "upstream")
        + " after=" + lasted + "ms",
      );
      // The lift is unconditional for the queue: a live path exists, so every waiting
      // lane sends ungated instead of waiting on its predecessor's slot release.
      const queued = state.waiters.splice(0, state.waiters.length);
      for (const waiter of queued) settle(state, waiter, null);
    },

    stormActive(scope: string): boolean {
      const state = scopes.get(scope);
      return state !== undefined && isActive(state, clock());
    },
  };
}

/** Process-wide coordinator. Configured from config.json at load; state is in-memory only. */
const globalCoordinator = createResetStormCoordinator();
let activeCoordinator: ResetStormCoordinator = globalCoordinator;

export function resetStorm(): ResetStormCoordinator {
  return activeCoordinator;
}

/** Cheap and idempotent: loadConfig() calls this on every config read. */
export function configureResetStorm(partial?: Partial<ResetStormConfig> | undefined): void {
  globalCoordinator.configure(partial);
}

/**
 * Test seam: swap the process-wide coordinator wholesale. Pass null to restore the
 * production instance configured by {@link configureResetStorm}.
 */
export function replaceResetStormCoordinatorForTests(coordinator: ResetStormCoordinator | null): void {
  activeCoordinator = coordinator ?? globalCoordinator;
}
