/**
 * Read-only observation of the "turn state" signal family.
 *
 * Context: the mechanism described for ChatGPT's chat backend pairs a non-standard HTTP 292
 * response (carrying `current_turn_state`) with a 312 "revoke" signal, and third-party tooling
 * injects that state into later requests so routing does not degrade. Nothing in this proxy
 * depends on it, and NOTHING HERE CHANGES A REQUEST OR A RESPONSE: this module only records what
 * the proxy already sees, so the operator can decide whether the mechanism exists on their own
 * route before any injection is attempted.
 *
 * Hits land in `OPENCODEX_HOME/turn-state-signals.jsonl` (one JSON line per event) plus one
 * throttled warning in the service log, so a hit is visible without enabling debug logging. The
 * body scan reads at most the first {@link MAX_SNIFF_BYTES} of a response and never retains it.
 */
import { appendFile, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";

/** Substrings that identify the mechanism in a header value or a body. */
export const TURN_STATE_MARKERS: readonly string[] = ["current_turn_state", "turn_state"];

/** The two documented signal statuses, kept separate from "any unusual 2xx" for the report. */
export const TURN_STATE_STATUS_CODES: readonly number[] = [292, 312];

/** Ordinary 2xx statuses that need no attention. */
const ORDINARY_SUCCESS = new Set([200, 201, 202, 203, 204, 205, 206]);

/** Response bytes inspected per turn. The markers are small JSON fields near the front. */
export const MAX_SNIFF_BYTES = 64 * 1024;
/** Request bodies larger than this are checked for top-level keys only, never serialized. */
const MAX_REQUEST_SERIALIZE_BYTES = 256 * 1024;
/** One warning per kind per minute is enough to notice a hit in the service log. */
const WARN_THROTTLE_MS = 60_000;
/** Log rotation ceiling; the observer must never grow without bound. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export interface TurnStateWhere {
  provider?: string | undefined;
  model?: string | undefined;
  comboId?: string | undefined;
  url?: string | undefined;
  /** "request" | "response" -- which side of the proxy produced the observation. */
  direction?: "request" | "response" | undefined;
  /** Which wire carried it: "http" for the plain Responses relay, "codex-ws" for the WebSocket one. */
  transport?: string | undefined;
}

const warnAtByKind = new Map<string, number>();
/** Appends between rotation checks; the stat call itself is cheap but not free. */
const ROTATE_CHECK_EVERY = 512;
let appendsSinceRotateCheck = 0;

/**
 * Emergency off switch. The observer is read-only, but an operator debugging an unrelated issue
 * should not have to reason about an extra JSONL file: `OCX_TURN_STATE_OBSERVER=0` disables every
 * recording path without touching the relay.
 */
function observerEnabled(): boolean {
  return process.env["OCX_TURN_STATE_OBSERVER"] !== "0";
}

function signalsLogPath(): string {
  return join(getConfigDir(), "turn-state-signals.jsonl");
}

/** Path of the observation log, for report tooling and tests. */
export function turnStateSignalsPath(): string {
  return signalsLogPath();
}

function record(kind: string, detail: Record<string, unknown>, where: TurnStateWhere): void {
  if (!observerEnabled()) return;
  appendsSinceRotateCheck += 1;
  if (appendsSinceRotateCheck >= ROTATE_CHECK_EVERY) {
    appendsSinceRotateCheck = 0;
    // Keep the observation log bounded without a timer: rotate on write when it has grown.
    try {
      if (statSync(signalsLogPath()).size >= MAX_LOG_BYTES) {
        renameSync(signalsLogPath(), `${signalsLogPath()}.1`);
        console.warn("[turn-state] observation log rotated");
      }
    } catch {
      /* a missing or unreadable log simply means there is nothing to rotate */
    }
  }
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    kind,
    provider: where.provider,
    model: where.model,
    comboId: where.comboId,
    direction: where.direction,
    transport: where.transport,
    url: where.url,
    ...detail,
  })}\n`;
  // Fire-and-forget: an observation must never add latency or throw into a request path.
  appendFile(signalsLogPath(), line, "utf8", error => {
    if (!error) return;
    const now = Date.now();
    if (now - (warnAtByKind.get("write") ?? 0) < WARN_THROTTLE_MS) return;
    warnAtByKind.set("write", now);
    console.warn(`[turn-state] cannot append observation log: ${String(error).slice(0, 120)}`);
  });
  const now = Date.now();
  if (now - (warnAtByKind.get(kind) ?? 0) < WARN_THROTTLE_MS) return;
  warnAtByKind.set(kind, now);
  console.warn(`[turn-state] ${kind} observed: ${JSON.stringify(detail).slice(0, 300)}`);
}

function describe(value: string): string {
  return value.trim().slice(0, 240).replace(/\s+/g, " ");
}

/**
 * Header names spell the family with hyphens (`x-turn-state`) while bodies use underscores
 * (`current_turn_state`), so a header is matched on both spellings.
 */
function headerMentionsTurnState(name: string, value: string): boolean {
  const haystack = `${name.toLowerCase()} ${value.toLowerCase()}`;
  const underscored = haystack.replace(/-/g, "_");
  return TURN_STATE_MARKERS.some(marker => haystack.includes(marker) || underscored.includes(marker));
}

/**
 * Record an upstream status that belongs to the signal family, or any 2xx the proxy does not
 * recognise. A 292 would otherwise pass as an ordinary success (`Response.ok` covers 200-299).
 */
export function observeTurnStateUpstreamStatus(status: number, where: TurnStateWhere = {}): void {
  if (!observerEnabled()) return;
  if (TURN_STATE_STATUS_CODES.includes(status)) {
    record("status", { status }, where);
    return;
  }
  if (status >= 200 && status < 300 && !ORDINARY_SUCCESS.has(status)) {
    record("unusual-status", { status }, where);
  }
}

/** Record any response header whose name or value mentions the mechanism. */
export function observeTurnStateResponseHeaders(headers: Headers, where: TurnStateWhere = {}): void {
  if (!observerEnabled()) return;
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!headerMentionsTurnState(lower, value)) continue;
    record("response-header", { header: lower, value: describe(value) }, where);
  }
}

export interface TurnStateSniffer {
  feed(chunk: Uint8Array): void;
  finish(): void;
}

/**
 * Bounded pass-through scanner for one response body.
 *
 * Keeps a small carry-over of decoded text so a marker split across two network chunks is still
 * found, stops reading entirely after {@link MAX_SNIFF_BYTES}, and never stores the payload.
 */
export function createTurnStateSniffer(where: TurnStateWhere): TurnStateSniffer {
  const enabled = observerEnabled();
  const decoder = new TextDecoder();
  let inspectedBytes = 0;
  let carry = "";
  let done = false;
  let hits = 0;
  return {
    feed(chunk: Uint8Array): void {
      if (!enabled || done || hits > 0) return;
      inspectedBytes += chunk.byteLength;
      const text = carry + decoder.decode(chunk, { stream: true });
      carry = text.slice(-64);
      const haystack = text.toLowerCase();
      for (const marker of TURN_STATE_MARKERS) {
        const index = haystack.indexOf(marker);
        if (index < 0) continue;
        hits += 1;
        record("response-body", {
          marker,
          snippet: describe(text.slice(Math.max(0, index - 80), index + 200)),
          inspectedBytes,
        }, where);
        return;
      }
      if (inspectedBytes >= MAX_SNIFF_BYTES) done = true;
    },
    finish(): void {
      if (done || hits > 0) return;
      done = true;
      try {
        decoder.decode();
      } catch {
        /* a decoder that already failed needs no flush */
      }
    },
  };
}

/**
 * Record whether an inbound request already carries a turn-state field.
 *
 * The check is deliberately shallow: top-level keys plus the usual metadata bags, and a full-text
 * search only for bodies small enough to serialize cheaply. A client or an upstream kit that
 * starts injecting the field would show up here first.
 */
export function observeTurnStateRequestBody(
  body: unknown,
  headers: Headers | undefined,
  where: TurnStateWhere = { direction: "request" },
): void {
  if (!observerEnabled()) return;
  if (headers) {
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (!headerMentionsTurnState(lower, value)) continue;
      record("request-header", { header: lower, value: describe(value) }, where);
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const recordBody = body as Record<string, unknown>;
  let foundField = false;
  const bags: Array<[string, unknown]> = [
    ["body", recordBody],
    ["body.metadata", recordBody.metadata],
    ["body.client_metadata", recordBody.client_metadata],
    ["body.extra", recordBody.extra],
  ];
  for (const [label, bag] of bags) {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
      if (!TURN_STATE_MARKERS.some(marker => key.toLowerCase().includes(marker))) continue;
      foundField = true;
      record("request-field", {
        field: `${label}.${key}`,
        value: typeof value === "string" ? describe(value) : typeof value,
      }, where);
    }
  }
  // A field-level hit already names the location; the serialized sweep stays for the unusual
  // cases so one request never produces two records for the same evidence.
  if (foundField) return;
  // Cheap size gate: a long transcript would cost real milliseconds to serialize on every turn,
  // and a state field hidden inside one is not a shape this mechanism uses.
  const longTranscript = (value: unknown): boolean => Array.isArray(value) && value.length > 64;
  if (longTranscript(recordBody.input) || longTranscript(recordBody.messages)) return;
  // A field nested somewhere unusual still shows up if the body is small enough to serialize.
  try {
    const serialized = JSON.stringify(recordBody);
    if (serialized && serialized.length <= MAX_REQUEST_SERIALIZE_BYTES) {
      const haystack = serialized.toLowerCase();
      for (const marker of TURN_STATE_MARKERS) {
        const index = haystack.indexOf(marker);
        if (index < 0) continue;
        record("request-body", {
          marker,
          snippet: describe(serialized.slice(Math.max(0, index - 80), index + 200)),
        }, where);
        return;
      }
    }
  } catch {
    /* circular or non-serializable bodies are not this observer's problem */
  }
}

/** Best-effort rotation so the observation log cannot grow without bound. */
export function rotateTurnStateSignalsIfNeeded(sizeBytes: number, rename: (from: string, to: string) => void): boolean {
  if (sizeBytes < MAX_LOG_BYTES) return false;
  rename(signalsLogPath(), `${signalsLogPath()}.1`);
  return true;
}
