import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextPrincipalIdOf, type DataPlaneAdmission } from "../auth-cors";
import { atomicWriteFile } from "../../config/atomic-write";
import { getConfigDir } from "../../config/paths";
import { sessionLaneIdFromRequest } from "../request-log-conversation";

const SELECTION_MODEL_MAX_LENGTH = 512;
const SELECTION_TTL_MS = 24 * 60 * 60_000;
const SELECTION_MAX_ENTRIES = 2_048;
const SELECTION_STATE_FILE = "conversation-model-selections.json";
const SELECTION_STATE_VERSION = 1;

export interface ConversationSelection {
  model: string;
  lastSeenAt: number;
}

/**
 * Codex can issue an automatic compaction request with the previous model after the user has
 * already selected another one. A compact-only handoff route cannot distinguish that transition:
 * it keeps sending the thread to the last model that compacted successfully. Remember the model
 * from the lane's latest ordinary request, which is the selection the user just made.
 */
const conversationSelections = new Map<string, ConversationSelection>();

function selectionStatePath(): string {
  return join(getConfigDir(), SELECTION_STATE_FILE);
}

function loadConversationSelections(): void {
  try {
    const raw = JSON.parse(readFileSync(selectionStatePath(), "utf8")) as {
      version?: unknown;
      selections?: unknown;
    };
    if (raw.version !== SELECTION_STATE_VERSION || !raw.selections || typeof raw.selections !== "object") return;
    const now = Date.now();
    for (const [key, value] of Object.entries(raw.selections as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { model?: unknown; lastSeenAt?: unknown };
      if (typeof entry.model !== "string" || entry.model.length === 0 || entry.model.length > SELECTION_MODEL_MAX_LENGTH) continue;
      if (typeof entry.lastSeenAt !== "number" || !Number.isFinite(entry.lastSeenAt) || now - entry.lastSeenAt > SELECTION_TTL_MS) continue;
      conversationSelections.set(key, { model: entry.model, lastSeenAt: entry.lastSeenAt });
    }
    prune(now);
  } catch {
    // Missing or malformed state is equivalent to an empty selection map.
  }
}

function persistConversationSelections(now: number): void {
  const selections: Record<string, ConversationSelection> = {};
  for (const [key, entry] of conversationSelections) {
    if (now - entry.lastSeenAt <= SELECTION_TTL_MS) selections[key] = entry;
  }
  try {
    atomicWriteFile(selectionStatePath(), JSON.stringify({
      version: SELECTION_STATE_VERSION,
      selections,
    }, null, 2) + "\n");
  } catch {
    // Disk persistence is best-effort; the live process still has the selection.
  }
}

export function clearConversationSelectionsForTests(): void {
  conversationSelections.clear();
}

function selectionKey(headers: Headers, admission: DataPlaneAdmission | undefined): string | null {
  const lane = sessionLaneIdFromRequest(headers);
  if (!lane || !admission) return null;
  // The local Codex desktop uses the loopback data plane and has no auth principal.
  // Give it a stable local principal so its thread-level model selection is remembered.
  const principal =
    contextPrincipalIdOf(admission) ??
    (admission.kind === "loopback" ? "loopback-local" : null);
  return principal ? `${principal}\u0000${lane}` : null;
}

function prune(now: number): void {
  for (const [key, entry] of conversationSelections) {
    if (now - entry.lastSeenAt > SELECTION_TTL_MS) conversationSelections.delete(key);
  }
  while (conversationSelections.size > SELECTION_MAX_ENTRIES) {
    const oldest = conversationSelections.keys().next().value;
    if (typeof oldest !== "string") return;
    conversationSelections.delete(oldest);
  }
}

loadConversationSelections();

export function rememberConversationSelection(
  headers: Headers,
  admission: DataPlaneAdmission | undefined,
  model: string,
  now = Date.now(),
): void {
  const key = selectionKey(headers, admission);
  if (!key || !model.trim() || model.length > SELECTION_MODEL_MAX_LENGTH) return;
  prune(now);
  conversationSelections.delete(key);
  conversationSelections.set(key, { model, lastSeenAt: now });
  prune(now);
  persistConversationSelections(now);
}

export function recallConversationSelection(
  headers: Headers,
  admission: DataPlaneAdmission | undefined,
  now = Date.now(),
): string | undefined {
  const entry = peekConversationSelection(headers, admission, now);
  if (!entry) return undefined;
  const key = selectionKey(headers, admission);
  if (!key) return undefined;
  conversationSelections.delete(key);
  conversationSelections.set(key, { ...entry, lastSeenAt: now });
  persistConversationSelections(now);
  return entry.model;
}

export function peekConversationSelection(
  headers: Headers,
  admission: DataPlaneAdmission | undefined,
  now = Date.now(),
): ConversationSelection | undefined {
  const key = selectionKey(headers, admission);
  if (!key) return undefined;
  prune(now);
  const entry = conversationSelections.get(key);
  if (!entry) return undefined;
  return entry;
}
