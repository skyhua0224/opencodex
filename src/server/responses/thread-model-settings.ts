import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config/atomic-write";
import { getConfigDir } from "../../config/paths";
import { resolveCodexHomeDir } from "../../codex/home";
import type { DataPlaneAdmission } from "../auth-cors";

const STATE_FILE = "thread-model-settings.json";
const STATE_VERSION = 1;
const MAX_SETTINGS = 8_192;
const MAX_SESSION_FILES = 32_768;
const REFRESH_INTERVAL_MS = 2_000;

interface ThreadModelSetting {
  model: string;
  lastSeenAt: number;
}

interface PersistedState {
  version?: unknown;
  settings?: unknown;
}

const settings = new Map<string, ThreadModelSetting>();
const fileStamps = new Map<string, string>();
let loaded = false;
let lastRefreshAt = 0;

function statePath(): string {
  return join(getConfigDir(), STATE_FILE);
}

function loadState(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as PersistedState;
    if (raw.version !== STATE_VERSION || !raw.settings || typeof raw.settings !== "object") return;
    for (const [threadId, value] of Object.entries(raw.settings as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const record = value as { model?: unknown; lastSeenAt?: unknown };
      if (typeof record.model !== "string" || record.model.length === 0 || record.model.length > 512) continue;
      if (typeof record.lastSeenAt !== "number" || !Number.isFinite(record.lastSeenAt)) continue;
      settings.set(threadId, { model: record.model, lastSeenAt: record.lastSeenAt });
    }
  } catch {
    // Missing or malformed state is treated as an empty index.
  }
}

function persistState(): void {
  const serialized: Record<string, ThreadModelSetting> = {};
  for (const [threadId, entry] of settings) serialized[threadId] = entry;
  try {
    atomicWriteFile(statePath(), JSON.stringify({ version: STATE_VERSION, settings: serialized }, null, 2) + "\n");
  } catch {
    // The in-memory index remains usable when the state directory is unavailable.
  }
}

function timestampOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Codex event timestamps are milliseconds; tolerate epoch seconds in older rollouts.
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function sessionFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_SESSION_FILES) {
    const dir = pending.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      if (files.length >= MAX_SESSION_FILES) break;
    }
  }
  return files;
}

/**
 * The normal bounded walk is enough for the recent settings index, but a long-lived Codex
 * thread can keep appending to an old rollout file after that file falls past the bound. The
 * caller knows the thread id from the request, so make a focused filename walk as well. This
 * keeps an old active thread from being pinned to the model it used weeks ago.
 */
function sessionFilesForThreadIds(root: string, threadIds: readonly string[]): string[] {
  const needles = threadIds
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (needles.length === 0) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")
        && needles.some(needle => entry.name.toLowerCase().includes(needle))) {
        files.push(path);
      }
    }
  }
  return files;
}

function readSettingsFromFile(path: string, fallbackTimestamp: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let changed = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes("thread_settings_applied")) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== "object") continue;
    const record = event as { type?: unknown; timestamp?: unknown; payload?: unknown };
    if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") continue;
    const payload = record.payload as { type?: unknown; thread_id?: unknown; thread_settings?: unknown };
    if (payload.type !== "thread_settings_applied" || !payload.thread_settings || typeof payload.thread_settings !== "object") continue;
    const thread = payload.thread_settings as { thread_id?: unknown; model?: unknown };
    const threadId = typeof payload.thread_id === "string"
      ? payload.thread_id
      : thread.thread_id;
    if (typeof threadId !== "string" || typeof thread.model !== "string") continue;
    const model = thread.model.trim();
    if (!model || model.length > 512) continue;
    const seenAt = timestampOf(record.timestamp, fallbackTimestamp);
    const previous = settings.get(threadId);
    if (!previous || seenAt >= previous.lastSeenAt) {
      settings.set(threadId, { model, lastSeenAt: seenAt });
      changed = true;
    }
  }
  return changed;
}

function refreshIndex(now: number, focusThreadIds: readonly string[] = []): void {
  loadState();
  if (now - lastRefreshAt < REFRESH_INTERVAL_MS) return;
  lastRefreshAt = now;
  let codexHome: string;
  try { codexHome = resolveCodexHomeDir(); } catch { return; }
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]
    .filter(path => existsSync(path));
  const seenFiles = new Set<string>();
  let changed = false;
  for (const root of roots) {
    for (const path of sessionFiles(root)) {
      seenFiles.add(path);
      let stamp: string;
      let fallbackTimestamp = now;
      try {
        const stat = statSync(path);
        stamp = `${stat.mtimeMs}:${stat.size}`;
        fallbackTimestamp = stat.mtimeMs;
      } catch {
        continue;
      }
      if (fileStamps.get(path) === stamp) continue;
      fileStamps.set(path, stamp);
      changed = readSettingsFromFile(path, fallbackTimestamp) || changed;
    }
    // An old but active rollout can be beyond MAX_SESSION_FILES. Always revisit the files whose
    // names identify the caller's thread, even when the broad walk did not include them.
    for (const path of sessionFilesForThreadIds(root, focusThreadIds)) {
      seenFiles.add(path);
      let stamp: string;
      let fallbackTimestamp = now;
      try {
        const stat = statSync(path);
        stamp = `${stat.mtimeMs}:${stat.size}`;
        fallbackTimestamp = stat.mtimeMs;
      } catch {
        continue;
      }
      if (fileStamps.get(path) === stamp) continue;
      fileStamps.set(path, stamp);
      changed = readSettingsFromFile(path, fallbackTimestamp) || changed;
    }
  }
  for (const path of fileStamps.keys()) {
    if (!seenFiles.has(path)) fileStamps.delete(path);
  }
  while (settings.size > MAX_SETTINGS) {
    const oldest = [...settings.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0]?.[0];
    if (!oldest) break;
    settings.delete(oldest);
    changed = true;
  }
  if (changed) persistState();
}

export function clearThreadModelSettingsForTests(): void {
  settings.clear();
  fileStamps.clear();
  loaded = false;
  lastRefreshAt = 0;
}

/** Resolve the latest model selected in a local Codex thread's settings events. */
export function threadModelSettingForRequest(
  headers: Headers,
  admission: DataPlaneAdmission | undefined,
  now = Date.now(),
): ThreadModelSetting | undefined {
  if (admission?.kind !== "loopback") return undefined;
  const threadIds = [
    headers.get("thread-id"),
    headers.get("x-codex-parent-thread-id"),
    headers.get("session_id"),
    headers.get("session-id"),
  ].map(value => value?.trim()).filter((value): value is string => !!value);
  refreshIndex(now, threadIds);
  for (const raw of threadIds) {
    const entry = settings.get(raw);
    if (entry) return entry;
  }
  return undefined;
}
