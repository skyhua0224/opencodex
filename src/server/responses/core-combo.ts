import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeclaredReasoningEffort } from "../../reasoning-effort";
import { recordAttemptRequestedEffort } from "../request-log";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  deriveRequestExecutionBudget,
  isRequestExecutionBudget,
} from "../../lib/request-execution-budget";
import type {
  RequestExecutionBudgetPolicy,
  RequestExecutionBudget,
} from "../../lib/request-execution-budget";
import type { OcxConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import type { HandleResponsesOptions, ResponsesDispatchers, ConsumedComboFailure } from "./core-options";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { getConfigDir } from "../../config/paths";
import {
  claimProviderProbe,
  getCombo,
  comboRequestHasImageInput,
  pickComboTargetWithWait,
  pickComboTarget,
  targetKey,
  concreteComboRequestBody,
  comboDefaultEffort,
  isComboTargetInCooldown,
  noteComboSuccess,
  noteProviderCapacityVerdict,
  finishProviderProbe,
  earliestComboCooldownExpiry,
  comboTargetDeferred,
  isProviderCapacityHeld,
  comboFailureDecision,
  advanceComboAfterFailure,
  comboFailureCooldownScope,
  comboCooldownRetryAfterSeconds,
} from "../../combos";
import { cachedProviderQuotaIsExhausted } from "../../combos/resolve";
import { getCachedProviderRoutingQuota, panelProviderHopeless } from "../../providers/quota-routing-cache";
import { sleepWithAbort } from "../../lib/upstream-retry";
import { formatErrorResponse } from "../../bridge";
import {
  expandPreviousResponseInput,
  previousResponseReplayFailure,
  previousResponseProviderState,
} from "../../responses/state";
import { hasUnreadableEncryptedAgentTask } from "./encrypted-payload";
import { routeConcreteModel, comboRouteDecisionTrace } from "../../router";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import type { AgentTaskRecoveryFailureReason } from "./agent-task-recovery";
import {
  agentTaskRecoveryConfig,
  discardEncryptedAgentTaskRecovery,
  recoverEncryptedAgentTaskWithResult,
} from "./agent-task-recovery";
import { isThreadSpawnRequest, supportedLadderFor } from "../effort-policy";
import {
  clientCancelledResponse,
  comboUnavailable,
  comboUnavailableResponse,
  targetIncompatibleResponse,
  unreadableEncryptedAgentTaskResponse,
} from "./core-errors";
import {
  buildComboChildHeaders,
  createChildPassthroughCallbackGate,
  consumeComboFailure,
} from "./core-combo-failure";
import {
  linkRequestSessionLane,
  reasoningReplayConversationIdFromResponsesRequest,
  sessionIdHeaderFromRequest,
  sessionLaneIdFromRequest,
} from "../request-log-conversation";
import type { CodexAuthContext } from "../../codex/auth-context";
import type { ResponsesTerminalStatus } from "../../bridge";
import { beginRequestAttempt, sealRequestAttemptIdentity, finishRequestAttempt } from "../request-log";
import { forgetComboForLane, rememberComboForLane } from "./combo-session-recall";
import { runTurnAdapterSseResponses } from "./core-lifetime";
import {
  isNativePassthroughSseResponse,
  isEagerRelaySseResponse,
  markNativePassthroughSseResponse,
  markEagerRelaySseResponse,
} from "../relay";
import { preflightComboStreamResponse } from "./combo-stream-preflight";
import { streamingContextOverflowResponse, jsonContextOverflowResponse } from "./context-overflow";
import { mandatoryResponsesReasoningReplayUnavailable } from "./core-replay";
import {
  COMBO_DEGENERATE_CODE,
  guardComboDegenerateOutput,
  markComboTargetDegenerate,
  noteComboToolRoundTrip,
} from "./combo-degenerate-output";

/** Channel-shaped failure statuses: the row could not serve, but the request itself was fine. */
const COMBO_CHANNEL_FAILURE_STATUSES = new Set([0, 401, 402, 403, 404, 408, 409, 410, 425, 429]);

/**
 * One honest line about why the whole ladder ran out, or undefined when the TURN was the problem.
 *
 * The ladder used to hand the client the LAST attempt's error, usually a dead cheap relay's 403 or
 * 429, while the official row's first-byte timeout sat unmentioned one line above it. Codex answers
 * a 429 by retrying until it reports its own "exceeded retry limit", so the operator learns nothing.
 * This summary is produced only when EVERY attempt failed for a channel-shaped reason; a
 * request-shaped failure (400/413/422, context overflow) still surfaces untouched, because that one
 * describes the turn rather than the fleet.
 */
function summarizeLadderExhaustion(
  attempts: readonly { provider: string; status: number }[],
): string | undefined {
  if (attempts.length === 0) return undefined;
  for (const attempt of attempts) {
    if (attempt.status >= 500) continue;
    if (COMBO_CHANNEL_FAILURE_STATUSES.has(attempt.status)) continue;
    return undefined;
  }
  const grouped = new Map<string, number>();
  for (const attempt of attempts) {
    const key = `${attempt.provider} ${attempt.status === 0 ? "no-response" : attempt.status}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  const parts = [...grouped.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([key, count]) => (count > 1 ? `${key} x${count}` : key));
  return `${attempts.length} attempt(s): ${parts.join(", ")}`;
}

/** How long one combo target may wait for its first upstream byte. */
const COMBO_ATTEMPT_FIRST_BYTE_TIMEOUT_MS = 90_000;
/** Wall-clock budget for the whole ordered combo ladder. */
const COMBO_LADDER_TOTAL_BUDGET_MS = 75_000;
/** Do not start a new target when the remaining ladder slice is too small to be useful. */
const COMBO_MIN_ATTEMPT_MS = 15_000;
/** Same-site limiter verdicts in one ladder pass before sibling rows are skipped. */
const COMBO_SITE_LIMIT_HITS = 3;
const COMBO_LIMITED_PASS_WAIT_MAX_MS = 10_000;
/** A later retry pass is deliberately disabled; the client can retry against a fresh ladder. */
const COMBO_LIMITED_RETRY_PASSES = 0;
/**
 * How many rows a ladder may walk past a replay refusal in one request. A refusal means "this
 * send died ambiguously", which is true of the row that answered it and silent about every other
 * row, so walking on is the honest reading. It is bounded because each hop is a real send: a
 * relay that resets every time must not cost sixteen sends per turn.
 */
const COMBO_REFUSAL_HOPS = 2;
const COMBO_LIMITED_RETRY_DEADLINE_MS = 45_000;

/**
 * Probe a parked provider after its hold expires. The request uses the real local proxy path so
 * a recovered provider is re-admitted without making the next user turn pay for discovery.
 */
function probeProviderInBackground(provider: string, model: string, apiKey: string | undefined): void {
  let port = 0;
  try {
    const record = JSON.parse(readFileSync(join(getConfigDir(), "runtime-port.json"), "utf8")) as { port?: unknown };
    if (typeof record.port === "number" && Number.isFinite(record.port)) port = record.port;
  } catch { /* the probe is best effort */ }
  if (!port || !apiKey) {
    finishProviderProbe(provider, false);
    return;
  }
  const body = JSON.stringify({
    model: `${provider}/${model}`,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    max_output_tokens: 16,
    stream: true,
    store: false,
  });
  void fetch(`http://127.0.0.1:${String(port)}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.timeout(30_000),
  }).then(async response => {
    const ok = response.ok;
    try { await response.body?.cancel(); } catch { /* best effort */ }
    console.warn(`[combo] half-open probe ${provider}: HTTP ${response.status} -> ${ok ? "re-admitted" : "staying parked"}`);
    finishProviderProbe(provider, ok);
  }).catch(() => {
    console.warn(`[combo] half-open probe ${provider}: request failed -> staying parked`);
    finishProviderProbe(provider, false);
  });
}

function comboFirstByteTimeoutResponse(provider: string, timeoutMs: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Combo target "${provider}" produced no first byte within ${timeoutMs}ms`,
        type: "upstream_timeout",
        code: "upstream_timeout",
      },
    }),
    { status: 504, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Sends one combo target may run on its own before the ladder moves on. A target is a whole
 * request as far as its own provider is concerned, so this is the guarded profile's base
 * allowance rather than a separate number to keep in sync.
 */
export const COMBO_TARGET_BASE_SENDS = CODEX_TEXT_GUARDED_BUDGET_POLICY.baseSendAllowance;


/**
 * A combo's execution policy is DECLARED by the combo, not inherited from the single-target
 * profile.
 *
 * `maxTargetTransitions: 1` and `maxAlternateTargetSends: 1` describe an account move, and
 * applying them to a combo would refuse the second hop of a three-target combo -- which is why
 * combo was left off `reserveDispatch` when the per-request split landed. The transitions a
 * combo may make are exactly the targets it declares minus the one it starts on. What stays
 * capped is the TOTAL: the first target's full ladder, one send for every further declared
 * target, and the one shared final-recovery reserve. A one-target combo reduces to the guarded
 * profile exactly, and a three-target combo whose every target fails hard reaches upstream six
 * times instead of the twelve #4546 measured.
 */
export function comboExecutionBudgetPolicy(declaredTargets: number): RequestExecutionBudgetPolicy {
  const targets = Math.max(1, Math.trunc(declaredTargets));
  const hops = targets - 1;
  const reserve = CODEX_TEXT_GUARDED_BUDGET_POLICY.finalRecoveryAllowance;
  const total = COMBO_TARGET_BASE_SENDS + hops + reserve;
  return {
    maxTotalModelSends: total,
    baseSendAllowance: total - reserve,
    finalRecoveryAllowance: reserve,
    maxAlternateTargetSends: Math.max(1, hops),
    maxTargetTransitions: Math.max(1, hops),
  };
}


/**
 * A budget scope that keeps its own recovery ledgers but spends the SAME request-wide counter.
 *
 * The sharing has to happen inside the factory. Redefining `used` as an accessor onto the parent
 * only shared what callers read from the outside: `remainingBaseSends`, the total check and the
 * reserve test all consult the factory's own private counter, which an overridden property
 * cannot reach. Each derived scope therefore admitted dispatches as though the request had spent
 * nothing, and the per-target holdback below -- expressed against `maxTotalModelSends` -- had
 * nothing to hold back from.
 *
 * `deriveRequestExecutionBudget` binds the scope to the parent's real ledger, including pending
 * externally-counted bookings and the durable-spend observer, all of which must travel together.
 * A pending booking is a send already counted in the total and waiting for its reporter, and the
 * observer books by watching that same counter move (#4707) -- so a scope that spent the counter
 * without carrying the observer would move it without booking, and this combo's child sends
 * would go missing from the spend ledger. The reserve, alternate-target and transition ledgers
 * stay per-scope on purpose: a combo target's account failover is its own recovery decision,
 * while the request total still bounds every target together.
 */
export function deriveSendBudgetScope(
  parent: RequestExecutionBudget,
  policy: RequestExecutionBudgetPolicy,
): RequestExecutionBudget {
  return deriveRequestExecutionBudget(parent, policy);
}


/**
 * The ladder one combo target may run, expressed as an allowance on the request-wide counter.
 *
 * `used + COMBO_TARGET_BASE_SENDS` gives this target its own ladder from wherever the request
 * already stands, and the clamp holds back one send for each target still declared after it: a
 * first target that 5xx-streaks must not eat the send the last declared target is entitled to.
 * That guarantee is the difference between a per-target policy and a shared pool the first
 * target drains.
 */
export function comboTargetSendBudget(
  comboScope: RequestExecutionBudget,
  targetsDeclaredAfterThisOne: number,
): RequestExecutionBudget {
  const policy = comboScope.policy;
  const heldForLaterTargets = Math.max(0, targetsDeclaredAfterThisOne);
  const ceiling = Math.max(1, policy.maxTotalModelSends - heldForLaterTargets);
  return deriveSendBudgetScope(comboScope, {
    maxTotalModelSends: policy.maxTotalModelSends,
    baseSendAllowance: Math.min(ceiling, comboScope.used + COMBO_TARGET_BASE_SENDS),
    finalRecoveryAllowance: policy.finalRecoveryAllowance,
    // Within one target the account-move shape is unchanged: three same-account sends plus one
    // alternate is the recovery live traffic depends on, and a combo does not widen it.
    maxAlternateTargetSends: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxAlternateTargetSends,
    maxTargetTransitions: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTargetTransitions,
  });
}


export async function executeComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
  requestDispatchers: ResponsesDispatchers,
): Promise<Response> {
  const requestedModel = typeof (rawBody as { model?: unknown } | null)?.model === "string"
    ? (rawBody as { model: string }).model
    : `combo/${comboId}`;
  Object.assign(logCtx, {
    requestedModel,
    model: requestedModel,
    provider: "combo",
    comboId,
  });
  const combo = getCombo(config, comboId);
  if (!combo) {
    return formatErrorResponse(404, "invalid_request_error", `Unknown combo: ${comboId}`);
  }
  // Probe parked providers from the request path, once per hold expiry. A probe is deliberately
  // fire-and-forget: it must never hold the user's ladder open or expose its response body.
  const probeModels = new Map<string, string>();
  for (const target of combo.targets) {
    if (!probeModels.has(target.provider)) probeModels.set(target.provider, target.model);
  }
  const probeKey = config.apiKeys?.[0]?.key;
  for (const [provider, model] of probeModels) {
    if (claimProviderProbe(provider)) probeProviderInBackground(provider, model, probeKey);
  }
  // The ladder's own scope, derived from what this combo DECLARES. It shares the request-wide
  // counter with the holder that arrived on options -- a combo child already inherited that
  // counter, but nothing read it as a limit across targets -- while its transition and
  // alternate-target ledgers come from the target list rather than from the single-target
  // account-move profile (#4546).
  const comboSendScope = isRequestExecutionBudget(options.sendBudget)
    ? deriveSendBudgetScope(options.sendBudget, comboExecutionBudgetPolicy(combo.targets.length))
    : undefined;
  // Expand previous_response_id before image policy and child dispatch so a
  // continuation that only references prior images still fails closed when
  // imageInput is disabled (and so targets see the full replayed input).
  const inboundClientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const body = expandPreviousResponseInput(rawBody, inboundClientThreadId);
  const replayFailure = previousResponseReplayFailure(body);
  if (replayFailure?.reason === "scope_mismatch") {
    console.warn("[opencodex] refusing continuation because the client task scope does not match replay state");
  }
  // Local replay failures require full client replay.
  if (replayFailure) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  // Missing state returns the original body without a failure marker. Reject
  // that unresolved continuation for image-disabled combos so a target cannot
  // resolve prior images out of band. A successful expansion yields a new
  // object (still carrying previous_response_id) and must not be treated as
  // unresolved — text-only stored continuations remain allowed.
  const requestedPreviousId = typeof (rawBody as { previous_response_id?: unknown } | null)?.previous_response_id === "string"
    ? (rawBody as { previous_response_id: string }).previous_response_id.trim()
    : "";
  const unresolvedPrevious = requestedPreviousId.length > 0 && body === rawBody;
  if (combo.imageInput === "disabled" && unresolvedPrevious) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  if (combo.imageInput === "disabled" && comboRequestHasImageInput(body)) {
    return formatErrorResponse(400, "invalid_request_error", `Combo "${comboId}" does not accept image input`);
  }
  const comboReplaySnapshot = {
    sourceBody: body,
    previousResponseInputExpanded: body !== rawBody
      && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string",
    providerContinuation: body !== rawBody && requestedPreviousId
      ? previousResponseProviderState(requestedPreviousId)
      : undefined,
    recoveredPlaintext: false,
  };
  // A repeated identical tool call/result across turns is a no-progress channel failure. Record
  // it before selecting the next target so the demotion affects this request immediately.
  const comboDegenerateLane = sessionLaneIdFromRequest(req.headers);
  const roundTripLoop = noteComboToolRoundTrip(comboDegenerateLane, body);
  if (roundTripLoop) {
    markComboTargetDegenerate(
      roundTripLoop.comboId,
      combo,
      roundTripLoop.target,
      `no-progress tool loop: ${roundTripLoop.signature} x${roundTripLoop.repeats} with identical results`,
    );
    forgetComboForLane(comboDegenerateLane, roundTripLoop.comboId);
  }
  const reasoningReplayConversationId = reasoningReplayConversationIdFromResponsesRequest({
    clientThreadId: inboundClientThreadId,
    threadIdHeader: req.headers.get("thread-id"),
    sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
  });
  const reasoningReplayEligible = (target: (typeof combo.targets)[number]): boolean => {
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      const unavailable = mandatoryResponsesReasoningReplayUnavailable({
        body,
        clientThreadId: reasoningReplayConversationId,
        providerName: route.providerName,
        provider: route.provider,
        adapterName: route.provider.adapter,
        modelId: route.modelId,
      });
      return !unavailable;
    } catch {
      // Routing failures are not evidence of replay incompatibility. Keep the target eligible so
      // the existing selection and dispatch path preserves its original routing failure surface.
      return true;
    }
  };
  const adoptFailedChildLog = (childLog: RequestLogContext): void => {
    // Attempts remain the complete physical history; the logical row mirrors the most recent
    // failed target so an exhausted combo still has useful top-level reasoning diagnostics.
    Object.assign(logCtx, childLog, {
      requestedModel,
      model: requestedModel,
      provider: "combo",
      comboId,
      routeDecision: logCtx.routeDecision,
      attempts: logCtx.attempts,
      activeAttempt: undefined,
      activeAttemptStartedAt: undefined,
    });
  };

  const unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (body as { input?: unknown } | undefined)?.input,
  );
  const canDecryptUnreadableAgentTask = (target: (typeof combo.targets)[number]): boolean => {
    const provider = config.providers[target.provider];
    if (!provider || provider.disabled === true) return false;
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      return isCanonicalOpenAiForwardProvider(route.provider);
    } catch {
      return false;
    }
  };
  let comboPayloadReadable = false;
  const payloadEligible = (target: (typeof combo.targets)[number]): boolean =>
    comboPayloadReadable || !unreadableEncryptedAgentTask || canDecryptUnreadableAgentTask(target);
  const targetEligible = (target: (typeof combo.targets)[number]): boolean =>
    payloadEligible(target) && reasoningReplayEligible(target);
  const onlyReplayIncompatibleTargetsRemain = (excluded: Iterable<string> = []): boolean => {
    const excludedKeys = new Set(excluded);
    const remaining = combo.targets.filter(target => {
      const provider = config.providers[target.provider];
      return provider?.disabled !== true
        && !excludedKeys.has(targetKey(target))
        && payloadEligible(target);
    });
    return remaining.length > 0 && remaining.every(target => !reasoningReplayEligible(target));
  };
  let encryptedTaskRecoveryAttempted = false;
  let recoveryFailureReason: AgentTaskRecoveryFailureReason | undefined;
  let storedPool401ReplayDispatched = false;
  const recoverUnreadableEncryptedTask = async (): Promise<boolean> => {
    if (encryptedTaskRecoveryAttempted) return false;
    encryptedTaskRecoveryAttempted = true;
    const recovery = agentTaskRecoveryConfig(config);
    if (
      (options.inboundWire ?? "responses") !== "responses"
      || !isThreadSpawnRequest(req.headers)
      || !recovery
      || options.comboAttempt
    ) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return false;
    }
    let recovered = false;
    try {
      const result = await recoverEncryptedAgentTaskWithResult(
        req,
        (body as { input?: unknown } | undefined)?.input,
        recovery,
        config,
        { parentThreadId: inboundClientThreadId, abortSignal: options.abortSignal },
      );
      recovered = result.recovered;
      recoveryFailureReason = result.recovered ? undefined : result.reason;
    } catch {
      recovered = false;
      recoveryFailureReason = undefined;
    }
    // Recovery has the same in-place input mutation contract as the direct routed path.
    if (
      !recovered
      || hasUnreadableEncryptedAgentTask((body as { input?: unknown } | undefined)?.input)
    ) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return false;
    }
    comboPayloadReadable = true;
    comboReplaySnapshot.recoveredPlaintext = true;
    return true;
  };
  const initialNow = Date.now();
  const comboStartedAt = Date.now();
  const comboProviderSiteKey = (baseUrl: string | undefined): string | undefined => {
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return undefined;
    try {
      return new URL(baseUrl).host.toLowerCase();
    } catch {
      return baseUrl.trim().toLowerCase();
    }
  };
  const siteRungCounts = new Map<string, number>();
  const limitingSiteHits = new Map<string, number>();
  const hotSites = new Set<string>();
  const quotaHoldSites = new Set<string>();
  let lastLimiterShape = false;
  let limitedRetryPasses = 0;
  let refusalHops = 0;
  const siteKeyOf = (providerName: string): string =>
    comboProviderSiteKey(config.providers[providerName]?.baseUrl) ?? providerName;
  const passEligible = (target: (typeof combo.targets)[number]): boolean =>
    targetEligible(target)
    && !hotSites.has(siteKeyOf(target.provider))
    && !quotaHoldSites.has(siteKeyOf(target.provider));
  const describeComboGates = (attempted: ReadonlySet<string>): string => {
    const now = Date.now();
    return combo.targets.map(target => {
      const reasons: string[] = [];
      const provider = config.providers[target.provider];
      if (!provider) reasons.push("unconfigured");
      else if (provider.disabled === true) reasons.push("disabled");
      else if (cachedProviderQuotaIsExhausted(
        getCachedProviderRoutingQuota(target.provider, provider, now), now,
      )) reasons.push("quota-exhausted");
      if (attempted.has(targetKey(target))) reasons.push("attempted");
      if (isComboTargetInCooldown(comboId, target, now)) reasons.push("cooldown");
      if (isProviderCapacityHeld(target.provider, now)) reasons.push("provider-parked");
      if (panelProviderHopeless(target.provider, now)) reasons.push("panel-hopeless");
      if (comboTargetDeferred(comboId, target, now)) reasons.push("stuck-deferred");
      if (hotSites.has(siteKeyOf(target.provider))) reasons.push("site-rate-limited");
      if (quotaHoldSites.has(siteKeyOf(target.provider))) reasons.push("site-quota-exhausted");
      if (!payloadEligible(target)) reasons.push("payload-ineligible");
      if (!reasoningReplayEligible(target)) reasons.push("replay-incompatible");
      return `${target.provider}${reasons.length > 0 ? `[${reasons.join("+")}]` : "[open]"}`;
    }).join(" ");
  };
  const pickWithWait = (pickOptions: {
    exclude?: Iterable<string>;
    eligible?: (target: NonNullable<typeof combo>["targets"][number]) => boolean;
    now?: number;
  }) => pickComboTargetWithWait(config, comboId, {
    ...pickOptions,
    waitForCooldownMs: combo.waitForCooldownMs,
    abortSignal: options.abortSignal,
  });
  const retryLadderAfterLimiterBackoff = async (): Promise<Awaited<ReturnType<typeof pickWithWait>> | undefined> => {
    if (!lastLimiterShape || limitedRetryPasses >= COMBO_LIMITED_RETRY_PASSES) return undefined;
    if (options.abortSignal?.aborted) return undefined;
    if (Date.now() - comboStartedAt > COMBO_LIMITED_RETRY_DEADLINE_MS) return undefined;
    const budgetLeftMs = (combo.ladderBudgetMs ?? COMBO_LADDER_TOTAL_BUDGET_MS)
      - (Date.now() - comboStartedAt);
    if (budgetLeftMs <= COMBO_MIN_ATTEMPT_MS) return undefined;
    const now = Date.now();
    const earliest = earliestComboCooldownExpiry(comboId, combo.targets, now);
    const delayMs = Math.min(
      earliest === undefined ? COMBO_MIN_ATTEMPT_MS : Math.max(earliest - now, 250),
      COMBO_LIMITED_PASS_WAIT_MAX_MS,
      Math.max(budgetLeftMs - COMBO_MIN_ATTEMPT_MS, 250),
    );
    console.warn(
      `[combo] ${comboId}: every target answered rate-limit/5xx; pausing ${delayMs}ms before retry pass ${limitedRetryPasses + 1}/${COMBO_LIMITED_RETRY_PASSES}`,
    );
    try {
      await sleepWithAbort(delayMs, options.abortSignal);
    } catch {
      return undefined;
    }
    if (options.abortSignal?.aborted) return undefined;
    limitedRetryPasses += 1;
    limitingSiteHits.clear();
    hotSites.clear();
    siteRungCounts.clear();
    return await pickWithWait({ eligible: passEligible, now: Date.now() });
  };
  let pick = await pickWithWait({
    eligible: targetEligible,
    now: initialNow,
  });

  if (unreadableEncryptedAgentTask && !pick) {
    pick = await pickWithWait({ now: initialNow });
    if (!pick) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return options.abortSignal?.aborted
        ? clientCancelledResponse()
        : comboUnavailable(comboId);
    }
    if (!(await recoverUnreadableEncryptedTask())) {
      return options.abortSignal?.aborted
        ? clientCancelledResponse()
        : unreadableEncryptedAgentTaskResponse(recoveryFailureReason);
    }
  }

  if (!pick) {
    if (onlyReplayIncompatibleTargetsRemain()) return targetIncompatibleResponse();
    return options.abortSignal?.aborted
      ? clientCancelledResponse()
      : comboUnavailable(comboId);
  }
  // One immutable combo selection trace, before any child dispatch; child
  // adoption below must never replace it with a concrete child route trace.
  logCtx.routeDecision = comboRouteDecisionTrace(config, comboId, pick, requestedModel);

  const originalReasoning = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { reasoning?: unknown }).reasoning
    : undefined;
  const originalRequestedEffortValue = originalReasoning && typeof originalReasoning === "object" && !Array.isArray(originalReasoning)
    ? (originalReasoning as { effort?: unknown }).effort
    : undefined;
  const originalRequestedEffort = typeof originalRequestedEffortValue === "string"
    && isDeclaredReasoningEffort(originalRequestedEffortValue)
    ? originalRequestedEffortValue
    : undefined;
  const restoreOriginalRequestedEffort = (childLog: RequestLogContext): void => {
    if (originalRequestedEffort === undefined) return;
    const normalizedRequestedEffort = childLog.requestedEffort;
    const transitionIndex = normalizedRequestedEffort?.indexOf("->") ?? -1;
    childLog.requestedEffort = transitionIndex >= 0
      ? `${originalRequestedEffort}${normalizedRequestedEffort!.slice(transitionIndex)}`
      : originalRequestedEffort;
    recordAttemptRequestedEffort(childLog);
  };

  let lastFailure: Response | null = null;
  // Dispatched targets, not attempted picks: it indexes the declared target list so the clamp
  // below can tell how many targets are still entitled to a send.
  let comboTargetsDispatched = 0;
  // The child log behind `lastFailure`. The natural end of the ladder adopts it inside the
  // no-more-targets branch; a budget refusal ends the ladder one iteration later, where that
  // iteration's own `childLog` is already out of scope.
  let lastFailedChildLog: RequestLogContext | undefined;
  // The exhausted-combo mapping below runs outside the loop, where `failure.upstreamCode`
  // is gone, so carry the loop's own classification decision instead of re-deriving a
  // weaker one from the status alone (#4149).
  let lastFailureClassifiesOverflow = false;
  let lastAttempted = new Set<string>();
  let ladderStopReason: "budget" | "no-eligible-target" | undefined;
  while (pick) {
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const ladderBudgetMs = combo.ladderBudgetMs ?? COMBO_LADDER_TOTAL_BUDGET_MS;
    if ((logCtx.attempts?.length ?? 0) > 0
      && ladderBudgetMs - (Date.now() - comboStartedAt) <= COMBO_MIN_ATTEMPT_MS) {
      ladderStopReason = "budget";
      break;
    }
    const selectedTarget = pick.target;
    const firstComboTarget = comboTargetsDispatched === 0;
    // The first target seeds the ledger's target identity and charges nothing; every later one
    // is a real transition, refused once the declared hops, the alternate-target ledger or the
    // request total are spent. `countedExternally` is required: the child charges its own
    // physical sends, and charging here as well would halve the cap without saying so.
    const hopDecision = comboSendScope?.reserveDispatch({
      sendClass: firstComboTarget ? "initial" : "combo-failover",
      targetKey: `${pick.target.provider}/${pick.target.model}`,
      countedExternally: true,
    });
    if (hopDecision && hopDecision.allowed) hopDecision.permit.use();
    else if (hopDecision && !firstComboTarget) {
      // Out of budget is not this target's failure. The established exhaustion contract is to
      // return the last real upstream answer with its status, headers and any quota body
      // intact rather than to mint a synthetic error, and a later target only exists because
      // an earlier one already recorded one.
      if (lastFailedChildLog) adoptFailedChildLog(lastFailedChildLog);
      break;
    }
    const targetSendBudget = comboSendScope
      ? comboTargetSendBudget(comboSendScope, combo.targets.length - 1 - comboTargetsDispatched)
      : options.sendBudget;
    comboTargetsDispatched += 1;
    const childLog: RequestLogContext = {
      model: pick.target.model,
      provider: pick.target.provider,
      ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
      ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    };
    const targetRoute = routeConcreteModel(config, `${pick.target.provider}/${pick.target.model}`);
    const childBody = concreteComboRequestBody(
      body,
      pick.target,
      comboDefaultEffort(config, comboId),
      supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
      combo.reasoningEffortMode,
      combo.defaultEffortMode,
    );
    const childHeaders = buildComboChildHeaders(req.headers);
    const childRequest = new Request(req.url, {
      method: req.method,
      headers: childHeaders,
      body: JSON.stringify(childBody),
    });
    linkRequestSessionLane(req, childRequest);
    let resolvedAuth: CodexAuthContext | undefined;
    let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
    const started = Date.now();
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      pick.target.provider,
      pick.target.model,
      config.providers[pick.target.provider]!.adapter,
    );
    childLog.activeAttempt = attempt;
    if (originalRequestedEffort !== undefined) {
      childLog.requestedEffort = originalRequestedEffort;
      recordAttemptRequestedEffort(childLog);
    }
    childLog.activeAttemptStartedAt = started;
    childLog.attempts = logCtx.attempts ??= [];
    childLog.attempts.push(attempt);
    let attemptRetained = false;
    const retainCancelledAttempt = (): void => {
      if (attemptRetained) return;
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
        childLog.accountLogLabel,
      );
      finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
      attemptRetained = true;
    };
    const completedTarget = { provider: pick.target.provider, model: pick.target.model };
    const writerGeneration = pick.writerGeneration;
    let consumedChildFailure: ConsumedComboFailure | undefined;
    const callbackGate = createChildPassthroughCallbackGate({
      ...options,
      onResponseComplete: model => {
        // The live config can change while the child is streaming. Never retain credentials.
        const currentCombo = getCombo(config, comboId);
        const provider = config.providers[completedTarget.provider];
        if (!options.compactionRoutingOverride && Object.hasOwn(config.providers, completedTarget.provider)
          && provider && provider.disabled !== true
          && currentCombo?.targets.some(target => targetKey(target) === targetKey(completedTarget))) {
          rememberComboForLane(sessionLaneIdFromRequest(req.headers), comboId, completedTarget, model, writerGeneration);
        }
        options.onResponseComplete?.(model);
      },
      onNativePassthroughTerminal: status => {
        // A committed stream can acquire terminal metadata after preflight copied
        // the child log. Publish it before the outer logger finalizes, but only
        // through the gate: discarded attempts must never affect the parent.
        // Undefined child fields must preserve metadata already inspected by WS.
        if (childLog.terminalHttpStatus !== undefined) logCtx.terminalHttpStatus = childLog.terminalHttpStatus;
        if (childLog.terminalIncompleteReason !== undefined) logCtx.terminalIncompleteReason = childLog.terminalIncompleteReason;
        if (childLog.terminalErrorCode !== undefined) logCtx.terminalErrorCode = childLog.terminalErrorCode;
        if (childLog.upstreamError !== undefined) logCtx.upstreamError = childLog.upstreamError;
        const terminalProvider = Object.hasOwn(config.providers, selectedTarget.provider)
          ? config.providers[selectedTarget.provider]
          : undefined;
        const terminalOverloaded = (childLog.terminalHttpStatus ?? 0) >= 500
          || /overload|capacity/i.test(childLog.upstreamError ?? "");
        if (terminalProvider && isCanonicalOpenAiForwardProvider(terminalProvider) && terminalOverloaded) {
          const hold = noteProviderCapacityVerdict(
            selectedTarget.provider,
            (childLog.upstreamError || "official provider overloaded").slice(0, 120),
            Date.now(),
          );
          if (hold) {
            console.warn(
              `[combo] ${comboId}: ${selectedTarget.provider} parked ${Math.round((hold.until - Date.now()) / 60000)}min (capacity rung #${hold.escalations}, committed forward stream)`,
            );
          }
        }
        options.onNativePassthroughTerminal?.(status);
      },
    });
    let response: Response;
    // The timeout owns only this child. The parent signal remains the cancellation authority for
    // the whole ladder, so a silent target can be abandoned without freezing later targets.
    const attemptAbort = new AbortController();
    const forwardParentAbort = (): void => attemptAbort.abort(options.abortSignal?.reason);
    if (options.abortSignal) {
      if (options.abortSignal.aborted) forwardParentAbort();
      else options.abortSignal.addEventListener("abort", forwardParentAbort, { once: true });
    }
    const ladderRemainingMs = Math.max(COMBO_MIN_ATTEMPT_MS, ladderBudgetMs - (Date.now() - comboStartedAt));
    const siteKey = comboProviderSiteKey(config.providers[selectedTarget.provider]?.baseUrl)
      ?? selectedTarget.provider;
    const siteRungsTried = siteRungCounts.get(siteKey) ?? 0;
    siteRungCounts.set(siteKey, siteRungsTried + 1);
    const siteDecayMs = siteRungsTried === 0
      ? Number.POSITIVE_INFINITY
      : siteRungsTried === 1
        ? Math.max(COMBO_MIN_ATTEMPT_MS, 25_000)
        : siteRungsTried <= 3
          ? Math.max(COMBO_MIN_ATTEMPT_MS, 12_000)
          : Math.max(COMBO_MIN_ATTEMPT_MS, 8_000);
    const firstByteDeadlineMs = Math.min(
      selectedTarget.firstByteTimeoutMs ?? combo.firstByteTimeoutMs ?? COMBO_ATTEMPT_FIRST_BYTE_TIMEOUT_MS,
      ladderRemainingMs,
      siteDecayMs,
    );
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    const firstByteDeadline = new Promise<"deadline">(resolve => {
      firstByteTimer = setTimeout(() => {
        attemptAbort.abort(new Error(
          `combo target ${selectedTarget.provider} produced no first byte within ${firstByteDeadlineMs}ms`,
        ));
        resolve("deadline");
      }, firstByteDeadlineMs);
    });
    try {
      const currentTargetProvider = pick.target.provider;
      const deferCodexResetDerivedCooldown = combo.strategy === "failover"
        && combo.targets.slice(pick.targetIndex + 1).some(target =>
          target.provider === currentTargetProvider
          && targetEligible(target)
          && !isComboTargetInCooldown(comboId, target),
        );
      const attemptOutcome = requestDispatchers.handleResponses(childRequest, config, childLog, {
        ...options,
        // After the spread: the child must run on THIS target's ladder, not on the holder the
        // parent arrived with.
        abortSignal: attemptAbort.signal,
        sendBudget: targetSendBudget,
        comboAttempt: true,
        comboReplaySnapshot,
        deferCodexResetDerivedCooldown,
        // Attempt-relative TTFT is recorded HERE (not via childLog.firstOutputMs — a later
        // Object.assign(logCtx, childLog) would overwrite the request-relative value).
        onFirstOutput: () => {
          if (attempt.firstOutputMs === undefined) {
            attempt.firstOutputMs = Math.max(0, Date.now() - started);
          }
          options.onFirstOutput?.();
        },
        onCodexAuthContextResolved: value => { resolvedAuth = value; },
        setTerminalOutcomeRecorder: value => { terminalRecorder = value; },
        onConsumedComboFailure: value => { consumedChildFailure = value; },
        onStoredPool401ReplayDispatched: () => { storedPool401ReplayDispatched = true; },
        onNativePassthroughTerminal: callbackGate.onTerminal,
        onNativePassthroughCancel: callbackGate.onCancel,
        onResponseComplete: callbackGate.onResponseComplete,
      }).then(
        value => ({ kind: "response" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const settled = await Promise.race([attemptOutcome, firstByteDeadline]);
      if (settled === "deadline") {
        callbackGate.discard();
        response = comboFirstByteTimeoutResponse(selectedTarget.provider, firstByteDeadlineMs);
        consumedChildFailure = {
          response,
          classificationText: `combo attempt first-byte timeout after ${firstByteDeadlineMs}ms`,
        };
      } else if (settled.kind === "error") {
        throw settled.error;
      } else {
        response = settled.value;
        restoreOriginalRequestedEffort(childLog);
      }
    } catch (error) {
      callbackGate.discard();
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
      throw error;
    } finally {
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer);
      options.abortSignal?.removeEventListener("abort", forwardParentAbort);
    }

    if (options.abortSignal?.aborted) {
      callbackGate.discard();
      retainCancelledAttempt();
      return clientCancelledResponse();
    }

    if (response.ok && (options.comboAttempt
      || isNativePassthroughSseResponse(response)
      || !runTurnAdapterSseResponses.has(response))) {
      const nativePassthrough = isNativePassthroughSseResponse(response);
      const eagerRelay = isEagerRelaySseResponse(response);
      let preflight;
      let zeroOutputTimedOut = false;
      const comboFailureFrame = (payload: unknown): boolean => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
        const type = (payload as { type?: unknown }).type;
        return type === "error" || type === "response.failed" || type === "response.incomplete";
      };
      try {
        preflight = await preflightComboStreamResponse(response, childLog, comboFailureFrame, {
          zeroOutputDeadlineAt: started + firstByteDeadlineMs,
          onZeroOutputDeadline: () => {
            zeroOutputTimedOut = true;
            return comboFirstByteTimeoutResponse(selectedTarget.provider, firstByteDeadlineMs);
          },
        });
      } catch (error) {
        callbackGate.discard();
        if (options.abortSignal?.aborted) {
          retainCancelledAttempt();
          return clientCancelledResponse();
        }
        finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
        throw error;
      }
      if (preflight.kind === "failed") {
        callbackGate.discard();
        terminalRecorder?.("failed", preflight.response.status);
        response = preflight.response;
        if (zeroOutputTimedOut) {
          consumedChildFailure = {
            response,
            classificationText: `combo attempt first-byte timeout: no output within ${firstByteDeadlineMs}ms`,
          };
        }
      } else {
        response = preflight.response;
        if (nativePassthrough) markNativePassthroughSseResponse(response);
        if (eagerRelay) markEagerRelaySseResponse(response);
      }
    }

    if (response.ok) {
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
        childLog.accountLogLabel,
      );
      attemptRetained = true;
      noteComboSuccess(comboId, combo, pick.target, pick.writerGeneration);
      Object.assign(logCtx, childLog, {
        requestedModel,
        model: requestedModel,
        provider: "combo",
        comboId,
        routeDecision: logCtx.routeDecision,
        attempts: logCtx.attempts,
        activeAttempt: attempt,
        activeAttemptStartedAt: started,
        resolvedModel: childLog.resolvedModel ?? childLog.model,
      });
      options.onCodexAuthContextResolved?.(resolvedAuth);
      options.setTerminalOutcomeRecorder?.(terminalRecorder);
      callbackGate.commit();
      const guardedResponse = guardComboDegenerateOutput(response, {
        comboId,
        combo,
        target: completedTarget,
        lane: comboDegenerateLane,
        onVerdict: detail => {
          logCtx.errorCode = COMBO_DEGENERATE_CODE;
          logCtx.terminalHttpStatus = 502;
          logCtx.upstreamError = `degenerate output: ${detail}`;
          callbackGate.onTerminal("failed");
          terminalRecorder?.("failed", 502);
        },
      });
      if (isNativePassthroughSseResponse(response)) markNativePassthroughSseResponse(guardedResponse);
      if (isEagerRelaySseResponse(response)) markEagerRelaySseResponse(guardedResponse);
      return guardedResponse;
    }

    callbackGate.discard();
    if (response.status === 499) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    let failure: ConsumedComboFailure;
    try {
      failure = consumedChildFailure
        ?? await consumeComboFailure(response, options.abortSignal);
    } catch (error) {
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
      throw error;
    }
    if (options.abortSignal?.aborted) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    sealRequestAttemptIdentity(
      attempt,
      childLog.provider,
      childLog.providerAdapter ?? attempt.adapter,
      childLog.accountLogLabel,
    );
    finishRequestAttempt(
      attempt,
      failure.response.status,
      Date.now() - started,
      failure.usage,
    );
    attemptRetained = true;
    lastFailure = failure.response;
    lastFailedChildLog = childLog;
    // A non-replayable failure (the answer to a spent ambiguous-reset replacement) may follow a
    // send that already ran the turn, so no later target may receive it, whatever its status says.
    const wsStage = attempt.codexWsStage;
    const acceptedThenSilent = wsStage?.sent === true && (wsStage.relayedEvents ?? 0) === 0;
    const forwardProvider = Object.hasOwn(config.providers, pick.target.provider)
      ? config.providers[pick.target.provider]
      : undefined;
    const officialForward = !!forwardProvider && isCanonicalOpenAiForwardProvider(forwardProvider);
    const silentOfficialFailure = officialForward && acceptedThenSilent && failure.response.status >= 500;
    if (silentOfficialFailure) forgetComboForLane(sessionLaneIdFromRequest(req.headers), comboId);
    // A replay refusal is a verdict on ONE row's send -- "this exchange died ambiguously and may
    // already have run" -- not on the fleet. Stopping the ladder on it is what handed the client a
    // bare 429: Codex answers 429 by NOT resending and reporting "exceeded retry limit, last
    // status: 429 Too Many Requests", so one relay reset ended a turn whose later rows were all
    // still available. The ladder keeps walking instead, bounded per request so a genuinely stuck
    // turn cannot lap the target list.
    if (failure.nonReplayable) refusalHops += 1;
    const baseDecision = failure.nonReplayable
      ? (refusalHops <= COMBO_REFUSAL_HOPS ? "hop" : "stop")
      : comboFailureDecision(failure.response.status, failure.classificationText, {
        code: failure.upstreamCode,
      });
    if (failure.nonReplayable && baseDecision === "hop") {
      console.warn(
        `[combo] ${comboId}: ${targetKey(pick.target)} refused a replay after an ambiguous reset; continuing the ladder (${refusalHops}/${COMBO_REFUSAL_HOPS})`,
      );
    }
    const failureDecision = !failure.nonReplayable && silentOfficialFailure && baseDecision === "stop"
      ? "hop"
      : baseDecision;
    const failureMessage = acceptedThenSilent && failure.response.status >= 500
      ? `capacity: forward target closed before its first event (${failure.classificationText || "no detail"})`
      : failure.classificationText;
    lastLimiterShape = failure.response.status === 408 || failure.response.status === 425
      || failure.response.status === 429 || failure.response.status >= 500
      || /capacity|overloaded/i.test(failureMessage);
    const failedSite = siteKeyOf(pick.target.provider);
    const providerLevelVerdict =
      (/usage_limit|insufficient_quota|insufficient_balance|套餐|weekly limit|weekly usage limit|subscription[_ ]?not[_ ]?found|no active subscription|subscription (?:is )?(?:missing|expired|inactive|unpaid)/i.test(failureMessage)
        && !/rate.?limit/i.test(failureMessage))
      || /upstream (?:access forbidden|authentication failed)|contact administrator/i.test(failureMessage);
    if (providerLevelVerdict) {
      if (!quotaHoldSites.has(failedSite)) {
        quotaHoldSites.add(failedSite);
        console.warn(
          `[combo] ${comboId}: ${failedSite} reports a provider-level verdict (${failureMessage.slice(0, 80)}); skipping its remaining rows`,
        );
      }
    }
    if (lastLimiterShape) {
      const hits = (limitingSiteHits.get(failedSite) ?? 0) + 1;
      limitingSiteHits.set(failedSite, hits);
      if (hits >= COMBO_SITE_LIMIT_HITS && !hotSites.has(failedSite)) {
        hotSites.add(failedSite);
        console.warn(
          `[combo] ${comboId}: ${failedSite} answered ${hits} limiter verdicts in this pass; skipping its remaining rows until the retry pass`,
        );
      }
    } else {
      limitingSiteHits.delete(failedSite);
    }
    const wantsStream = (rawBody as { stream?: unknown } | null)?.stream === true;
    // Local byte admission has its own diagnostic; do not relabel it as an upstream refusal.
    const classifyOverflow = failure.response.status === 413
      && (wantsStream || (failure.upstreamCode !== "outbound_body_too_large"
        && failure.upstreamCode !== "translation_buffer_limit"));
    lastFailureClassifiesOverflow = classifyOverflow;
    if (storedPool401ReplayDispatched) {
      if (failureDecision === "hop" && unreadableEncryptedAgentTask && !comboPayloadReadable) {
        const recoveredTarget = await pickWithWait({
          exclude: pick.attempted,
          eligible: target => {
            try {
              const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
              return route.codexAccountMode === undefined
                && !isCanonicalOpenAiForwardProvider(route.provider);
            } catch {
              return false;
            }
          },
        });
        if (options.abortSignal?.aborted) return clientCancelledResponse();
        if (recoveredTarget && await recoverUnreadableEncryptedTask()) {
          pick = recoveredTarget;
          continue;
        }
        if (options.abortSignal?.aborted) return clientCancelledResponse();
      }
      // Keep the spent Pool budget sticky even after a recovered routed child:
      // no later failure may reopen ordinary combo/native account hopping.
      adoptFailedChildLog(childLog);
      if (classifyOverflow && failureDecision === "stop") {
        return wantsStream
          ? streamingContextOverflowResponse(requestedModel, options.translatorBudget)
          : jsonContextOverflowResponse();
      }
      return lastFailure;
    }
    if (failureDecision === "stop") {
      adoptFailedChildLog(childLog);
      if (classifyOverflow) {
        return wantsStream
          ? streamingContextOverflowResponse(requestedModel, options.translatorBudget)
          : jsonContextOverflowResponse();
      }
      return lastFailure;
    }
    console.warn(
      `[combo] ${comboId}: ${targetKey(pick.target)} failed with ${failure.response.status} after ${Date.now() - started}ms`,
    );
    const failureNow = Date.now();
    const attemptedTargets = pick.attempted;
    lastAttempted = new Set(attemptedTargets);
    const nextPick = advanceComboAfterFailure(config, pick, {
      retryAfter: failure.retryAfter,
      resetAt: failure.resetAt,
      cooldownMs: combo.cooldownMs,
      now: failureNow,
      cooldownScope: comboFailureCooldownScope(failure.response.status, failure.classificationText, {
        code: failure.upstreamCode,
      }),
      eligible: passEligible,
      status: failure.response.status,
      code: failure.upstreamCode,
      message: failureMessage,
    });
    // Same target selector as the exclusionary pick below, minus `exclude`: the only
    // difference is deliberate and is the whole point of the single-target retry.
    const retryAfterCooldown = () =>
      pickWithWait({
        eligible: passEligible,
        now: failureNow,
      });
    if (nextPick) {
      pick = nextPick;
    } else {
      pick = await pickWithWait({
        exclude: pick.attempted,
        eligible: passEligible,
        now: failureNow,
      });
      // A single-target combo with waitForCooldownMs has no alternate target to fail over to,
      // but can recover if it waits for its brief cooldown. The initial attempt accumulated into
      // pick.attempted, so the first pickWithWait above excluded it. retryAfterCooldown below is
      // the same selector with `exclude` deliberately dropped, so the single cooled target
      // becomes eligible again once its cooldown expires.
      // Termination is double-guarded:
      // 1) comboSendScope?.reserveDispatch refuses a second failover hop via comboExecutionBudgetPolicy
      //    (maxAlternateTargetSends: 1 for a single declared target).
      // 2) comboTargetsDispatched <= 1 bounds it locally so the retry never loops or waits unnecessarily
      //    even if sendBudget scope is absent.
      if (
        !pick
        && combo.targets.length === 1
        && combo.waitForCooldownMs > 0
        && comboTargetsDispatched <= 1
        && !options.abortSignal?.aborted
      ) {
        pick = await retryAfterCooldown();
      }
    }
    if (!pick) {
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      if (onlyReplayIncompatibleTargetsRemain(attemptedTargets)) {
        adoptFailedChildLog(childLog);
        return targetIncompatibleResponse();
      }
      if (unreadableEncryptedAgentTask && !comboPayloadReadable) {
        const recoveredTarget = await pickWithWait({
          exclude: attemptedTargets,
          now: failureNow,
        });
        if (recoveredTarget && await recoverUnreadableEncryptedTask()) {
          pick = recoveredTarget;
          continue;
        }
      }
      // Waiting or recovery may have observed cancellation after the check above.
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      // Hot-site marks are a pass-local ordering hint, not a permanent ban. If the healthy tail
      // is empty, give the held-back rows one final chance before stopping the ladder.
      if (hotSites.size > 0) {
        const hotRetryPick = await pickWithWait({
          exclude: attemptedTargets,
          eligible: targetEligible,
          now: Date.now(),
        });
        if (hotRetryPick) {
          pick = hotRetryPick;
          continue;
        }
      }
      // A parked official row is normally skipped, but one last attempt is preferable to a
      // synthetic unavailable response when every other channel is gone.
      const parkedLastResort = pickComboTarget(config, comboId, {
        exclude: attemptedTargets,
        now: Date.now(),
        // `passEligible`, not the plain target eligibility: the last resort exists to reach a
        // capacity-PARKED row (official), never to resurrect rows this pass already skipped for a
        // provider-level verdict -- a relay with no subscription answers the same 403 every time,
        // and walking all sixteen of them as "last resorts" is what made the ladder crawl.
        eligible: passEligible,
        allowCapacityParked: true,
      });
      if (parkedLastResort) {
        console.warn(
          `[combo] ${comboId}: nothing else is eligible; trying the capacity-parked ${targetKey(parkedLastResort.target)} as a last resort`,
        );
        pick = parkedLastResort;
        continue;
      }
      const retryPick = await retryLadderAfterLimiterBackoff();
      if (retryPick) {
        pick = retryPick;
        continue;
      }
      ladderStopReason = "no-eligible-target";
      adoptFailedChildLog(childLog);
    }
  }
  if (
    lastFailure?.status === 413
    && lastFailureClassifiesOverflow
  ) {
    return (rawBody as { stream?: unknown } | null)?.stream === true
      ? streamingContextOverflowResponse(requestedModel, options.translatorBudget)
      : jsonContextOverflowResponse();
  }
  if (lastFailure) {
    console.warn(
      `[combo] ${comboId}: ladder stopped (${ladderStopReason ?? "exhausted"}) after ${logCtx.attempts?.length ?? 0} attempt(s), returning ${lastFailure.status}; gates: ${describeComboGates(lastAttempted)}`,
    );
    // A whole-fleet failure deserves one honest sentence instead of "last status: 429": the summary
    // names every channel that refused, and the 429-shaped ones stop driving the client's retry loop.
    const exhaustion = summarizeLadderExhaustion(logCtx.attempts ?? []);
    if (exhaustion) {
      console.warn(
        `[combo] ${comboId}: every channel failed for a channel-shaped reason (${exhaustion}); returning combo_unavailable`,
      );
      return comboUnavailableResponse(
        `No combo target could serve this turn - every channel failed (${exhaustion}).`,
        { retryAfter: comboCooldownRetryAfterSeconds(comboId) },
      );
    }
  }
  // Nothing above summarized this stop, and the answer still carries 429 -- the one status the
  // Codex client does not retry, so it reports "exceeded retry limit, last status: 429 Too Many
  // Requests" and the turn is lost even though the ladder had targets left. The ladder owns the
  // client contract, so it answers with its own 503: Codex resends, the refused row is cooling by
  // then, and the next row gets the turn.
  if (lastFailure && lastFailure.status === 429) {
    console.warn(
      `[combo] ${comboId}: ladder stopped (${ladderStopReason ?? "exhausted"}) on a 429 - answering combo_unavailable instead of a raw rate-limit`,
    );
    return comboUnavailableResponse(
      "No combo target could serve this turn - every remaining channel answered rate-limit or refused the send.",
      { retryAfter: comboCooldownRetryAfterSeconds(comboId) },
    );
  }
  return lastFailure!;
}
