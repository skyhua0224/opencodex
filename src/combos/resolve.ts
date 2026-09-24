import type { OcxComboTarget, OcxConfig } from "../types";
import { getCachedProviderRoutingQuota, panelProviderDegraded, panelProviderHopeless } from "../providers/quota-routing-cache";
import type { ProviderQuota } from "../providers/quota-types";
import { sleepWithAbort } from "../lib/upstream-retry";
import {
  coolComboTarget,
  earliestComboCooldown,
  isComboTargetBreakerOpen,
  isComboTargetInCooldown,
  comboBreakerPolicy,
  comboTargetDeferred,
  isProviderCapacityHeld,
  providerHoldKind,
  noteProviderSuccess,
  noteComboTargetSuccess,
  type ComboFailureCooldownScope,
} from "./failover";
import { quotaResetRemainingMs } from "./reset-window";
import { getCombo, resolveComboId, targetKey } from "./types";
import type { NormalizedComboConfig, NormalizedComboTarget } from "./types";
import {
  captureConfigGeneration,
  type GenerationContext,
} from "../lib/state-store-sweeper";

export interface ComboPick {
  comboId: string;
  target: NormalizedComboTarget;
  targetIndex: number;
  attempted: string[];
  writerGeneration: number;
  /** Tier this pick came from: 0 healthy, 1 demoted, 2 held (the least-bad fallback). */
  rank?: number;
}

interface SelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Map<string, number>;
  successfulUses: Map<string, number>;
}

const selectionState = new Map<string, SelectionState>();
let lastReconciledGeneration = 0;
let liveComboTargets = new Set<string>();

function comboTargetOwnerKey(comboId: string, key: string): string {
  return `${comboId}::${key}`;
}

function mayCommitComboState(comboId: string, key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration
    || liveComboTargets.has(comboTargetOwnerKey(comboId, key));
}

export class UnknownComboError extends Error {
  constructor(readonly comboId: string) {
    super(`Unknown combo: ${comboId}`);
    this.name = "UnknownComboError";
  }
}

export class NoAvailableComboTargetsError extends Error {
  readonly code = "combo_unavailable";

  constructor(readonly comboId: string) {
    super(`No available targets for combo: ${comboId}`);
    this.name = "NoAvailableComboTargetsError";
  }
}

/**
 * The facts that make a target structurally unroutable: the provider is configured and enabled.
 * Everything the operator can recover from (quota, cooling, park, site verdict) is a preference,
 * not a structural fact — see `pickComboTarget`.
 */
function targetProviderIsRoutable(config: OcxConfig, target: OcxComboTarget): boolean {
  if (!Object.hasOwn(config.providers, target.provider)) return false;
  const provider = config.providers[target.provider];
  return Boolean(provider) && provider.disabled !== true;
}

/**
 * Panel/probe quota evidence says this provider has nothing left in the current window.
 *
 * A "skip", not a wall: the row steps aside while an alternative exists and is still tried once
 * when it is the only thing left, because a panel snapshot goes stale and a manual reset lands
 * between two exports.
 */
function targetProviderQuotaExhausted(config: OcxConfig, target: OcxComboTarget, now: number): boolean {
  const provider = config.providers[target.provider];
  if (!provider) return false;
  return cachedProviderQuotaIsExhausted(getCachedProviderRoutingQuota(target.provider, provider, now), now);
}

function targetProviderIsUsable(config: OcxConfig, target: OcxComboTarget, now: number): boolean {
  return targetProviderIsRoutable(config, target) && !targetProviderQuotaExhausted(config, target, now);
}

function quotaWindowExhausted(percent: number | undefined, resetAt: number | undefined, now: number): boolean {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 100) return false;
  return typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt > now;
}

export function cachedProviderQuotaIsExhausted(
  quota: ProviderQuota | null,
  now = Date.now(),
): boolean {
  if (!quota) return false;
  if (quotaWindowExhausted(quota.fiveHourPercent, quota.fiveHourResetAt, now)) return true;
  if (quotaWindowExhausted(quota.weeklyPercent, quota.weeklyResetAt, now)) return true;
  if (quotaWindowExhausted(quota.monthlyPercent, quota.monthlyResetAt, now)) return true;
  if (quota.customWindows?.some(window => quotaWindowExhausted(window.percent, window.resetAt, now))) return true;
  if (quota.creditsUsd?.unlimited !== true
      && typeof quota.creditsUsd?.percent === "number"
      && Number.isFinite(quota.creditsUsd.percent)
      && quota.creditsUsd.percent >= 100
      && quota.creditsUsd.remaining <= 0) return true;
  return false;
}

/**
 * Why a catalog row is offered but cannot currently serve a request (#1711).
 *
 * Only one reason exists today. It is a string rather than a boolean so a later cause — a
 * cooldown, a revoked key — can be told apart by a consumer that already reads the field.
 */
export type QuotaInactiveReason = "no_credit";

/**
 * `"no_credit"` when every USABLE target of a catalog row has positive exhaustion evidence
 * (#1711), otherwise undefined.
 *
 * This reuses the credential-scoped evidence and exhaustion rules used by runtime selection.
 * Display-only account, model-group and service windows cannot mark a whole provider inactive.
 *
 * Three rules carry the correctness, all inherited rather than restated:
 *
 * - A target the operator has removed or disabled is not usable and is not evidence either way;
 *   it drops out before the vote. If nothing is left, the row is unavailable for an operator
 *   reason rather than a quota one, so this returns undefined.
 * - The canonical ChatGPT forward provider is exempt. Native account selection owns model-scoped
 *   quota, and a provider-level summary cannot veto it.
 * - A stale cache is NOT exhaustion. `getCachedProviderRoutingQuota` returns null past its 30-minute
 *   window, and a null reading ends the vote rather than counting as evidence, so an unprobed
 *   provider is never marked inactive.
 *
 * "Every" is the bar on purpose: one target that can still serve makes the row serviceable, which
 * is exactly what the combo loop concludes at request time.
 */
export function quotaInactiveReason(
  config: OcxConfig,
  targets: readonly { provider: string }[],
  now = Date.now(),
): QuotaInactiveReason | undefined {
  const usable = targets.filter(target => {
    if (!Object.hasOwn(config.providers, target.provider)) return false;
    const provider = config.providers[target.provider];
    return !!provider && provider.disabled !== true;
  });
  if (usable.length === 0) return undefined;
  for (const target of usable) {
    const provider = config.providers[target.provider]!;
    const quota = getCachedProviderRoutingQuota(target.provider, provider, now);
    if (!quota || !cachedProviderQuotaIsExhausted(quota, now)) return undefined;
  }
  return "no_credit";
}

function smoothWeightedIndex(
  targets: NormalizedComboTarget[],
  state: SelectionState,
  eligible: (target: NormalizedComboTarget) => boolean,
): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    if (!eligible(target)) continue;
    const key = targetKey(target);
    const score = (state.currentWeights.get(key) ?? 0) + target.weight;
    state.currentWeights.set(key, score);
    total += target.weight;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best >= 0) {
    const key = targetKey(targets[best]!);
    state.currentWeights.set(key, (state.currentWeights.get(key) ?? 0) - total);
  }
  return best;
}

/**
 * Select the eligible target whose earliest known quota reset is nearest.
 *
 * Only reads the last successfully cached provider-quota snapshot; it never
 * triggers an upstream quota probe. When no target has fresh reset data,
 * every remaining value is Infinity and configured order becomes the
 * fallback. Targets with elapsed or stale reset timestamps are treated as
 * unknown (Infinity).
 */
function resetWindowIndex(
  config: OcxConfig,
  targets: NormalizedComboTarget[],
  eligible: (target: NormalizedComboTarget) => boolean,
  now = Date.now(),
): number {
  let selected = -1;
  let smallestRemaining = Number.POSITIVE_INFINITY;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    if (!eligible(target)) continue;
    const remaining = quotaResetRemainingMs(
      getCachedProviderRoutingQuota(target.provider, config.providers[target.provider], now), now,
    );
    // Strict comparison deliberately retains configured order for ties,
    // including the no-snapshot fallback where every value is Infinity.
    if (selected < 0 || remaining < smallestRemaining) {
      selected = index;
      smallestRemaining = remaining;
    }
  }
  return selected;
}

export function pickComboTarget(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: NormalizedComboTarget) => boolean;
    now?: number;
    /**
     * Sticky choices, most recent first: targets this session lane already used, so the picker can
     * keep the conversation on a provider whose prompt cache it primed.
     */
    prefer?: Pick<OcxComboTarget, "provider" | "model"> | Array<Pick<OcxComboTarget, "provider" | "model">>;
    /**
     * Last-resort pass: let a capacity-parked official row compete as a DEMOTED row instead of
     * being unreachable. Only the combo ladder sets this, and only after its ordinary pass found
     * nothing -- a parked account is still left alone while any other channel can serve.
     */
    allowCapacityParked?: boolean;
  } = {},
): ComboPick | null {
  const writerGeneration = captureConfigGeneration();
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const excluded = new Set(options.exclude ?? []);
  const now = options.now ?? Date.now();
  /** Facts, not judgements: the provider is configured, the caller accepts it, it is not spent. */
  const routable = (target: NormalizedComboTarget): boolean =>
    targetProviderIsRoutable(config, target)
    && !excluded.has(targetKey(target))
    && (options.eligible?.(target) ?? true);
  /**
   * Three tiers, price order inside each. Only a TRIPPED breaker and the official OpenAI
   * capacity ladder take a row out of reach, and even those stay reachable as the least-bad
   * choice -- an operator asking for the next price step must never be answered "no targets"
   * while a configured channel exists. Everything else here is a demotion:
   *   0 healthy, 1 demoted (one-off cooldown, relay failure hold, site verdict, quota window,
   *   recently stuck), 2 held (tripped breaker, official capacity hold).
   */
  const rankOf = (target: NormalizedComboTarget): number => {
    if (!routable(target)) return -1;
    const hold = providerHoldKind(target.provider, now);
    // The official-OpenAI capacity lock is the operator's "leave this account alone" verdict:
    // it is a hard exclusion, never a last-resort step. Surfacing its rate-limit/overload error as
    // the ladder's final answer is what made a fully parked ladder look like a 429 storm, and
    // walking a risk-controlled account to save one failed turn is the trade the ladder refuses.
    if (hold === "capacity") return options.allowCapacityParked === true ? 1 : -1;
    if (isComboTargetBreakerOpen(comboId, target, now)) return 2;
    const demoted = hold === "failures"
      || isComboTargetInCooldown(comboId, target, now)
      || panelProviderHopeless(target.provider, now)
      || panelProviderDegraded(target.provider, now)
      || comboTargetDeferred(comboId, target, now)
      || targetProviderQuotaExhausted(config, target, now);
    return demoted ? 1 : 0;
  };
  /** Same name the strategy branches below have always used: everything that may be picked. */
  const eligible = (target: NormalizedComboTarget): boolean => rankOf(target) >= 0;

  let targetIndex = -1;
  if (combo.strategy === "round-robin") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map(), successfulUses: new Map() };
      selectionState.set(comboId, state);
    }
    if (state.activeKey) {
      targetIndex = combo.targets.findIndex(target => targetKey(target) === state.activeKey && eligible(target));
      if (targetIndex < 0) {
        delete state.activeKey;
        state.successes = 0;
      }
    }
    if (targetIndex < 0) {
      targetIndex = smoothWeightedIndex(combo.targets, state, eligible);
      if (targetIndex >= 0) {
        state.activeKey = targetKey(combo.targets[targetIndex]!);
        state.successes = 0;
      }
    }
  } else if (combo.strategy === "random") {
    // Weighted random selection happens independently for every request.
    const eligibleTargets = combo.targets
      .map((target, index) => ({ target, index }))
      .filter(({ target }) => eligible(target));
    if (eligibleTargets.length > 0) {
      const totalWeight = eligibleTargets.reduce((sum, entry) => sum + entry.target.weight, 0);
      let random = Math.random() * totalWeight;
      for (const entry of eligibleTargets) {
        random -= entry.target.weight;
        if (random <= 0) {
          targetIndex = entry.index;
          break;
        }
      }
      if (targetIndex < 0) targetIndex = eligibleTargets[eligibleTargets.length - 1]!.index;
    }
  } else if (combo.strategy === "least-used") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map(), successfulUses: new Map() };
      selectionState.set(comboId, state);
    }
    let fewestUses = Number.POSITIVE_INFINITY;
    for (let index = 0; index < combo.targets.length; index++) {
      const target = combo.targets[index]!;
      if (!eligible(target)) continue;
      const uses = state.successfulUses.get(targetKey(target)) ?? 0;
      if (targetIndex < 0 || uses < fewestUses) {
        targetIndex = index;
        fewestUses = uses;
      }
    }
  } else if (combo.strategy === "reset-window") {
    targetIndex = resetWindowIndex(config, combo.targets, eligible, now);
  } else {
    // The configured price order decides; only the SITE's own "hopeless" verdict removes a step
    // (ocxquota --export marks channels below the availability floor as exhausted).
    //
    // Demoting a merely-unhealthy provider was tried and reverted: it promoted the native
    // ChatGPT row ahead of the ladder, and a native 5xx is non-replayable (the relay may already
    // be generating that turn), so the combo stopped there instead of failing over. Order belongs
    // to the operator; unavailability is handled by exclusion windows and the per-attempt
    // first-byte timeout.
    // Price order, except that a target which was STUCK recently drops behind the others for a
    // while: paying the same first-byte timeout on it first, every turn, is what makes a ladder
    // feel frozen even when it would eventually progress.
    let bestIndex = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let index = 0; index < combo.targets.length; index++) {
      const target = combo.targets[index]!;
      const rank = rankOf(target);
      if (rank < 0 || rank >= bestRank) continue;
      bestIndex = index;
      bestRank = rank;
      if (rank === 0) break;
    }
    targetIndex = bestIndex;
  }

  if (targetIndex < 0) return null;
  const target = combo.targets[targetIndex]!;
  return {
    comboId,
    target,
    targetIndex,
    attempted: [...excluded, targetKey(target)],
    writerGeneration,
    rank: rankOf(target),
  };
}

export function noteComboSuccess(
  comboId: string,
  combo: NormalizedComboConfig,
  target: NormalizedComboTarget,
  writerGeneration = captureConfigGeneration(),
): void {
  const key = targetKey(target);
  if (!mayCommitComboState(comboId, key, writerGeneration)) return;
  // The breaker closes on successes for every strategy, including the plain failover ladder that
  // the code below returns early from.
  noteComboTargetSuccess(comboId, target, comboBreakerPolicy(combo));
  noteProviderSuccess(target.provider);
  if (combo.strategy === "least-used") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map(), successfulUses: new Map() };
      selectionState.set(comboId, state);
    }
    state.successfulUses.set(key, (state.successfulUses.get(key) ?? 0) + 1);
    return;
  }
  if (combo.strategy !== "round-robin") return;
  const state = selectionState.get(comboId);
  if (!state || state.activeKey !== key) return;
  state.successes += 1;
  if (state.successes >= combo.stickyLimit) {
    delete state.activeKey;
    state.successes = 0;
  }
}

export function noteComboFailure(
  comboId: string,
  target: OcxComboTarget,
  writerGeneration = captureConfigGeneration(),
): void {
  if (!mayCommitComboState(comboId, targetKey(target), writerGeneration)) return;
  const state = selectionState.get(comboId);
  if (state?.activeKey === targetKey(target)) {
    delete state.activeKey;
    state.successes = 0;
  }
}

/**
 * Whether a provider's failures may escalate onto the hour-scale capacity ladder.
 *
 * Only the OFFICIAL OpenAI forward row qualifies: its capacity / overload verdicts are OpenAI's
 * own risk control and last for hours. A relay's verdict is transient, so a relay keeps plain
 * failover + breaker (the shared 15-minute failure hold) and recovers on its own.
 *
 * Shared with the half-open probe path in the responses handler so a failed probe can never walk
 * a relay up that ladder.
 */
export function providerUsesCapacityLadder(config: OcxConfig, provider: string): boolean {
  const row = Object.hasOwn(config.providers, provider) ? config.providers[provider] : undefined;
  return (row?.authMode ?? "key") === "forward"
    || String(row?.baseUrl ?? "").includes("chatgpt.com");
}

export function advanceComboAfterFailure(
  config: OcxConfig,
  pick: ComboPick,
  options: {
    retryAfter?: string | null;
    resetAt?: unknown | unknown[];
    now?: number;
    cooldownMs?: number;
    eligible?: (target: NormalizedComboTarget) => boolean;
    cooldownScope?: ComboFailureCooldownScope;
    status?: number;
    code?: string | null;
    message?: string;
  } = {},
): ComboPick | null {
  noteComboFailure(pick.comboId, pick.target, pick.writerGeneration);
  const combo = getCombo(config, pick.comboId);
  // "none" records no cooldown at all: the failure described the request, not the target, so
  // the target must stay immediately selectable for the next (differently shaped) request.
  if (options.cooldownScope !== "none") {
    const cooldownTargets = options.cooldownScope === "provider" && combo
      ? combo.targets.filter(target => target.provider === pick.target.provider)
      : [pick.target];
    // Only the OFFICIAL OpenAI row escalates into the hour-scale hold ladder: its capacity /
    // overload verdicts are OpenAI's own risk control and last for hours. A relay's capacity
    // verdict is transient, so it keeps plain failover + breaker and recovers on its own.
    const officialOpenAi = providerUsesCapacityLadder(config, pick.target.provider);
    for (const target of cooldownTargets) {
      coolComboTarget(pick.comboId, target, {
        ...options,
        breaker: comboBreakerPolicy(combo),
        capacityHoldLadder: officialOpenAi && target.provider === pick.target.provider,
        cooldownMs: options.cooldownMs ?? combo?.cooldownMs,
        writerGeneration: pick.writerGeneration,
      });
    }
  }
  return pickComboTarget(config, pick.comboId, {
    exclude: pick.attempted,
    now: options.now,
    eligible: target => !isComboTargetInCooldown(pick.comboId, target, options.now)
      && (options.eligible?.(target) ?? true),
  });
}

export async function pickComboTargetWithWait(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: NormalizedComboTarget) => boolean;
    waitForCooldownMs: number;
    abortSignal?: AbortSignal;
    now?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Sticky choice forwarded to the picker (see pickComboTarget). */
    prefer?: Pick<OcxComboTarget, "provider" | "model"> | Array<Pick<OcxComboTarget, "provider" | "model">>;
    /** Last-resort pass forwarded to the picker (see pickComboTarget). */
    allowCapacityParked?: boolean;
  },
): Promise<ComboPick | null> {
  const now = options.now ?? Date.now();
  const excluded = new Set(options.exclude ?? []);
  const customEligible = options.eligible;
  // The picker already tiers cooling rows behind healthy ones, so this only decides whether
  // WAITING buys a healthy slot. A demoted pick is a usable answer, never a reason to stall.
  const pick = pickComboTarget(config, comboId, {
    exclude: excluded,
    now,
    eligible: customEligible,
    prefer: options.prefer,
    allowCapacityParked: options.allowCapacityParked,
  });
  if (!pick || pick.rank === 0 || options.waitForCooldownMs <= 0 || options.abortSignal?.aborted) return pick;
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const waitingTargets = combo.targets.filter(target =>
    targetProviderIsUsable(config, target, now)
    && !excluded.has(targetKey(target))
    && isComboTargetInCooldown(comboId, target, now)
    && (customEligible?.(target) ?? true),
  );
  const earliest = earliestComboCooldown(comboId, waitingTargets, now);
  if (earliest === undefined) return pick;
  const delay = earliest.expiry - now;
  if (delay > options.waitForCooldownMs) return pick;
  // The expiry computation above is the single source of truth for the wait budget.
  // Its target preserves configured order for ties.
  const target = earliest.target;
  console.warn(
    `[combo] ${comboId}: all targets cooling, waiting ${delay}ms for ${targetKey(target)}`,
  );
  try {
    await (options.sleep ?? sleepWithAbort)(delay, options.abortSignal);
  } catch (error) {
    if (options.abortSignal?.aborted) return null;
    throw error;
  }
  if (options.abortSignal?.aborted) return null;
  // Management updates can delete or rename the combo while this request sleeps.
  if (!getCombo(config, comboId)) return null;
  return pickComboTarget(config, comboId, {
    exclude: excluded,
    now: now + delay,
    eligible: customEligible,
    allowCapacityParked: options.allowCapacityParked,
  });
}

export function reconcileComboRotationState(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const [comboId, state] of selectionState) {
    if (!context.comboIds.has(comboId)) {
      selectionState.delete(comboId);
      removed += 1;
      continue;
    }
    if (state.activeKey && !context.comboTargets.has(comboTargetOwnerKey(comboId, state.activeKey))) {
      delete state.activeKey;
      state.successes = 0;
      removed += 1;
    }
    for (const key of state.currentWeights.keys()) {
      if (context.comboTargets.has(comboTargetOwnerKey(comboId, key))) continue;
      state.currentWeights.delete(key);
      removed += 1;
    }
    for (const key of state.successfulUses.keys()) {
      if (context.comboTargets.has(comboTargetOwnerKey(comboId, key))) continue;
      state.successfulUses.delete(key);
      removed += 1;
    }
  }
  liveComboTargets = new Set(context.comboTargets);
  lastReconciledGeneration = context.generation;
  return removed;
}

export function clearComboSelectionState(comboId?: string): void {
  if (comboId === undefined) {
    selectionState.clear();
    liveComboTargets.clear();
    lastReconciledGeneration = 0;
    return;
  }
  selectionState.delete(comboId);
}

export function tryPickComboModel(config: OcxConfig, modelId: string): ComboPick | null {
  const comboId = resolveComboId(config, modelId);
  if (!comboId) return null;
  if (!getCombo(config, comboId)) throw new UnknownComboError(comboId);
  const picked = pickComboTarget(config, comboId);
  if (!picked) throw new NoAvailableComboTargetsError(comboId);
  return picked;
}
