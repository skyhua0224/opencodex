/**
 * Watches the client fingerprint this proxy forwards on the canonical OpenAI lane.
 *
 * Upstream can grade service by client identity -- the backend's own "This account only allows
 * Codex official clients" is the published version of that, and relays increasingly select their
 * Codex compatibility path by the same signals (originator, user agent, installation id). This
 * proxy forwards the caller's fingerprint verbatim and never fabricates one, so nothing here
 * rewrites a request. What was missing is the observation: a Codex app update, a changed
 * app-server, or a relay that rewrites headers all silently move the fingerprint, and a lane that
 * starts answering differently has no suspect list without it.
 *
 * The guard keeps a per-installation baseline in memory and appends one row per CHANGE to
 * ~/.opencodex/fingerprint-drift.jsonl -- names, sizes and short hashes only, never a value that
 * could identify an installation to a reader of the ledger.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";

const DRIFT_THROTTLE_MS = 10 * 60_000;

interface Fingerprint {
  originator: string | null;
  userAgent: string | null;
  installation: string | null;
  subagent: string | null;
}

interface BaselineEntry {
  fingerprint: Fingerprint;
  lastDriftAt: number;
  lastSignature: string;
}

const baselines = new Map<string, BaselineEntry>();

function tag(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return digest + ":" + Buffer.byteLength(value) + "b";
}

function read(headers: Headers): Fingerprint {
  return {
    originator: headers.get("originator"),
    userAgent: headers.get("user-agent"),
    installation: headers.get("x-codex-installation-id"),
    subagent: headers.get("x-openai-subagent"),
  };
}

function describe(fingerprint: Fingerprint): Record<string, string | null> {
  return {
    originator: tag(fingerprint.originator),
    userAgent: tag(fingerprint.userAgent),
    installation: tag(fingerprint.installation),
    subagent: tag(fingerprint.subagent),
  };
}

function changes(from: Fingerprint, to: Fingerprint): string[] {
  const out: string[] = [];
  if (from.originator !== to.originator) out.push(to.originator === null ? "originator-missing" : "originator-changed");
  if (from.userAgent !== to.userAgent) out.push(to.userAgent === null ? "user-agent-missing" : "user-agent-changed");
  if (from.installation !== to.installation) {
    out.push(to.installation === null ? "installation-id-missing" : "installation-id-changed");
  }
  if (from.subagent !== to.subagent) out.push(to.subagent === null ? "subagent-marker-missing" : "subagent-marker-changed");
  return out;
}

function ledgerPath(): string {
  return join(getConfigDir(), "fingerprint-drift.jsonl");
}

/**
 * Observation only: record the fingerprint of one canonical request and note any drift.
 *
 * Baselines key on the (hashed) installation id when present, so two installations that share a
 * provider are told apart and neither looks like the other's drift.
 */
export function observeClientFingerprint(headers: Headers, provider: string, now = Date.now()): string[] {
  const fingerprint = read(headers);
  const key = provider + "|" + (tag(fingerprint.installation) ?? "no-installation");
  const entry = baselines.get(key);
  const signature = JSON.stringify(describe(fingerprint));
  if (!entry) {
    // Seeded one throttle window in the past so the FIRST drift on a fresh baseline is reportable:
    // zero would mean "a drift just happened" and swallow the first ten minutes of evidence.
    baselines.set(key, { fingerprint, lastDriftAt: now - DRIFT_THROTTLE_MS, lastSignature: signature });
    return [];
  }
  const drift = changes(entry.fingerprint, fingerprint);
  if (drift.length === 0 || entry.lastSignature === signature || now - entry.lastDriftAt < DRIFT_THROTTLE_MS) {
    return [];
  }
  baselines.set(key, { fingerprint, lastDriftAt: now, lastSignature: signature });
  const row = { at: now, provider, changes: drift, from: describe(entry.fingerprint), to: describe(fingerprint) };
  try {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n");
  } catch {
    /* evidence, not correctness: a full disk must never break a turn */
  }
  const detail = drift.join(", ");
  console.warn("[opencodex] client fingerprint drifted on " + provider + ": " + detail);
  return drift;
}

/** The current baseline for one provider, for reports and tests. */
export function fingerprintGuardSnapshot(provider: string): Record<string, string | null> | undefined {
  for (const [key, entry] of baselines) {
    if (key.startsWith(provider + "|")) return describe(entry.fingerprint);
  }
  return undefined;
}

/** Test seam. */
export function clearClientFingerprintGuardForTests(): void {
  baselines.clear();
}
