/** Process-local recall of the last completed combo response on an explicit session lane. */
import { getCombo, targetKey } from "../../combos/types";
import { captureConfigGeneration, type GenerationContext } from "../../lib/state-store-sweeper";
import type { OcxConfig, OcxComboTarget } from "../../types";

interface ComboRecallEntry {
  comboId: string;
  target: Pick<OcxComboTarget, "provider" | "model">;
  responseModel: string;
  at: number;
  /** UTF-8 size of responseModel, the only client-influenced field of unbounded length. */
  bytes: number;
  /** Recent warm targets, most recent first. */
  recent?: Array<Pick<OcxComboTarget, "provider" | "model"> & { at: number }>;
}

/** How long a target stays "warm" enough to prefer for the same lane. */
const RECENT_TARGET_TTL_MS = 20 * 60 * 1000;

const RECALL_CAPACITY = 256;
const RECALL_TTL_MS = 30 * 60 * 1000;
/**
 * A model id is provider-reported and arrives on the response, so nothing upstream of here
 * bounds its length. Lane keys are already SHA-256 digests, so the model string is the only
 * field that can grow, and 256 lanes alone do not bound the bytes they hold.
 */
const RECALL_MODEL_BYTES_MAX = 1024;
const RECALL_TOTAL_BYTES_MAX = 64 * 1024;
const recall = new Map<string, ComboRecallEntry>();
let recallBytes = 0;
let lastReconciledGeneration = 0;
let liveOwners: Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames"> | undefined;

/** Every removal path goes through here so the byte counter can never drift from the map. */
function deleteEntry(lane: string): boolean {
  const entry = recall.get(lane);
  if (!entry) return false;
  recall.delete(lane);
  recallBytes -= entry.bytes;
  return true;
}

/**
 * UTF-8 size of a remembered model id, or null when it is too large to retain.
 *
 * The code-unit test runs first and is the part that matters: a UTF-8 encoding is never smaller
 * than the code-unit count, so an oversized string is rejected without encoding it, and the
 * bound cannot be defeated by paying the allocation it exists to prevent.
 */
function boundedModelBytes(responseModel: string): number | null {
  if (responseModel.length > RECALL_MODEL_BYTES_MAX) return null;
  const bytes = Buffer.byteLength(responseModel, "utf8");
  return bytes > RECALL_MODEL_BYTES_MAX ? null : bytes;
}

function ownsEntry(context: Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames">, entry: ComboRecallEntry): boolean {
  return context.comboIds.has(entry.comboId)
    && context.providerNames.has(entry.target.provider)
    && context.comboTargets.has(`${entry.comboId}::${targetKey(entry.target)}`);
}

export function rememberComboForLane(
  lane: string | undefined,
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  responseModel: string,
  writerGeneration: number,
): void {
  if (!lane || !comboId || !responseModel.trim()) return;
  // Reject even a same-named recreated owner: its previous in-flight turn is obsolete.
  if (writerGeneration < Math.max(lastReconciledGeneration, captureConfigGeneration())) return;
  // An unretainable model id DECLINES the write; it must not clear the lane.
  const bytes = boundedModelBytes(responseModel);
  if (bytes === null) return;
  const entry: ComboRecallEntry = {
    comboId,
    target: { provider: target.provider, model: target.model },
    responseModel,
    at: Date.now(),
    bytes,
  };
  const previous = recall.get(lane);
  if (previous && previous.comboId === comboId) {
    const key = targetKey(entry.target);
    entry.recent = [
      ...(targetKey(previous.target) !== key ? [{ ...previous.target, at: previous.at }] : []),
      ...(previous.recent ?? []).filter(recent => targetKey(recent) !== key),
    ].slice(0, 3);
  }
  if (liveOwners && !ownsEntry(liveOwners, entry)) return;
  deleteEntry(lane);
  recall.set(lane, entry);
  recallBytes += bytes;
  // Insertion order is recency order, because every write re-inserts its lane at the back.
  // Evicting from the front therefore drops the least recently written lane, never this one:
  // a single entry is capped well below the aggregate budget, so it always fits.
  while (recall.size > RECALL_CAPACITY || recallBytes > RECALL_TOTAL_BYTES_MAX) {
    const oldest = recall.keys().next().value;
    if (oldest === undefined || oldest === lane) break;
    deleteEntry(oldest);
  }
}

/**
 * The target that last served this lane for this combo, so selection can stay put.
 *
 * An ordered ladder re-picks from the top on every turn: a conversation that had settled on
 * provider B returns to A the moment A's cooldown expires, which throws away the upstream prompt
 * cache and makes the model re-read the whole context on a cold account. Sticky selection keeps
 * the lane on one account until that account actually fails, and the successful failover
 * re-stamps this entry, so the session moves once and then stays there.
 */
export function recalledComboTargetForLane(
  lane: string | undefined,
  comboId: string,
): Pick<OcxComboTarget, "provider" | "model"> | undefined {
  if (!lane || !comboId) return undefined;
  const entry = recall.get(lane);
  if (!entry || entry.comboId !== comboId) return undefined;
  if (Date.now() - entry.at >= RECALL_TTL_MS) return undefined;
  return entry.target;
}

/**
 * Recent targets for this lane, most recent first, newest-target excluded at the caller's option.
 *
 * Ordered by recency so the picker can take the first one that is still eligible: the point is to
 * stay on a provider whose cache this conversation already primed.
 */
/**
 * Drop this lane's sticky target, so the next turn selects from the ladder again.
 *
 * Used when the sticky target fails in a way the ladder cannot replay past (a forward target that
 * accepted the turn and went silent): staying sticky on it would make every later turn start on
 * the same broken provider and end there. The next success re-stamps the entry elsewhere.
 */
export function forgetComboForLane(lane: string | undefined, comboId: string): void {
  if (!lane) return;
  const entry = recall.get(lane);
  if (entry && entry.comboId === comboId) deleteEntry(lane);
}

export function recalledComboTargetsForLane(
  lane: string | undefined,
  comboId: string,
): Array<Pick<OcxComboTarget, "provider" | "model">> {
  if (!lane || !comboId) return [];
  const entry = recall.get(lane);
  if (!entry || entry.comboId !== comboId) return [];
  const now = Date.now();
  const out: Array<Pick<OcxComboTarget, "provider" | "model">> = [];
  if (now - entry.at < RECENT_TARGET_TTL_MS) out.push(entry.target);
  for (const recent of entry.recent ?? []) {
    if (now - recent.at >= RECENT_TARGET_TTL_MS) continue;
    if (out.some(target => targetKey(target) === targetKey(recent))) continue;
    out.push({ provider: recent.provider, model: recent.model });
  }
  return out;
}

export function recallComboForLane(
  config: OcxConfig,
  lane: string | undefined,
  model: string,
): string | undefined {
  if (!lane || !model || model.includes("/")) return undefined;
  const entry = recall.get(lane);
  if (!entry) return undefined;
  const combo = getCombo(config, entry.comboId);
  const provider = config.providers[entry.target.provider];
  if (Date.now() - entry.at >= RECALL_TTL_MS
    || !Object.hasOwn(config.providers, entry.target.provider)
    || !provider || provider.disabled === true
    || !combo?.targets.some(target => targetKey(target) === targetKey(entry.target))) {
    deleteEntry(lane);
    return undefined;
  }
  return entry.responseModel === model ? entry.comboId : undefined;
}

/**
 * Periodic expiry. Without it a lane that is never read again and never touched by a config
 * reconciliation holds its entry for the life of the process: the existing TTL is only
 * evaluated on read or on generation change.
 */
export function sweepExpiredComboRecall(now: number): number {
  let removed = 0;
  for (const [lane, entry] of recall) {
    if (now - entry.at >= RECALL_TTL_MS && deleteEntry(lane)) removed += 1;
  }
  return removed;
}

export function reconcileComboRecall(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  lastReconciledGeneration = context.generation;
  liveOwners = {
    comboIds: new Set(context.comboIds),
    comboTargets: new Set(context.comboTargets),
    providerNames: new Set(context.providerNames),
  };
  let removed = 0;
  for (const [lane, entry] of recall) {
    if (!ownsEntry(context, entry) || Date.now() - entry.at >= RECALL_TTL_MS) {
      if (deleteEntry(lane)) removed += 1;
    }
  }
  return removed;
}

/** Test-only reset, alongside the combo rotation/cooldown resets. */
export function clearComboRecallForTests(): void {
  recall.clear();
  recallBytes = 0;
  lastReconciledGeneration = 0;
  liveOwners = undefined;
}
