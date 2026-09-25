/**
 * The lane-level breaker for the ChatGPT Codex WebSocket transport.
 *
 * The per-thread machinery next door (ws-thread-transport) demotes ONE conversation when the
 * backend sheds it. This is the other case: the account's WebSocket lane itself is refused, and it
 * is refused for everything at once. Measured 2026-09-26 07:00: every canonical dial completed the
 * upgrade, received two control frames and was closed by the origin with 1011 and no response
 * event -- the user's two working conversations and a three-question probe on a fresh session all
 * failed the same way, while the same requests over HTTP/SSE answered normally (13-17s turns).
 *
 * Detecting that shape matters because of what a refusal costs: the capacity ladder re-dials on
 * every rung, so one turn spends 5+12+25+45 seconds of waits and then fails anyway (measured
 * 97-106s per turn). A client that retries sees a session that never produces a character.
 *
 * So: count control-only closes across conversations, and once the shape repeats, stop dialling the
 * lane at all -- the HTTP path takes over until the hold expires, at which point the lane is tried
 * again. Repeated trips escalate (10m -> 30m -> 1h), and a real WS turn clears the window, so a
 * recovered lane returns on its own. The operator switches stay where they are:
 * `provider.upstreamWebsocket: false` already closes the lane by configuration.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config/atomic-write";
import { join } from "node:path";
import { getConfigDir } from "../../config/paths";

/** How many control-only closes inside {@link WS_LANE_WINDOW_MS} mean "the lane is refused". */
const WS_LANE_REFUSAL_THRESHOLD = 3;
const WS_LANE_WINDOW_MS = 10 * 60_000;
/** Escalating holds; the last value repeats. */
const WS_LANE_HOLD_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000];
/** A turn that produced a real response this long ago means the lane is healthy again. */
const WS_LANE_SUCCESS_DECAY_MS = 5 * 60_000;
/** Close codes that mean "the origin refused this lane" rather than "this frame was wrong". */
const REFUSAL_CLOSE_CODES = new Set([1011, 1012, 1013, 1014]);

interface LaneState {
  /** Timestamps of control-only closes inside the current window. */
  refusals: number[];
  /** While now < this, requests must ride HTTP. */
  holdUntil: number;
  /** Escalation level reached so far (index into {@link WS_LANE_HOLD_MS}). */
  rung: number;
  lastSuccessAt: number;
  trips: number;
}

const state: LaneState = { refusals: [], holdUntil: 0, rung: 0, lastSuccessAt: 0, trips: 0 };
const WS_LANE_STATE_FILE = "ws-lane.json";
const WS_LANE_STATE_VERSION = 1;

function laneStatePath(): string {
  return join(getConfigDir(), WS_LANE_STATE_FILE);
}

function loadLaneState(): void {
  try {
    const raw = JSON.parse(readFileSync(laneStatePath(), "utf8")) as {
      version?: unknown; holdUntil?: unknown; rung?: unknown; trips?: unknown;
    };
    if (raw.version !== WS_LANE_STATE_VERSION) return;
    const now = Date.now();
    if (typeof raw.holdUntil === "number" && Number.isFinite(raw.holdUntil) && raw.holdUntil > now) {
      state.holdUntil = raw.holdUntil;
    }
    if (typeof raw.rung === "number" && Number.isInteger(raw.rung) && raw.rung >= 0) {
      state.rung = Math.min(raw.rung, WS_LANE_HOLD_MS.length - 1);
    }
    if (typeof raw.trips === "number" && Number.isInteger(raw.trips) && raw.trips >= 0) {
      state.trips = raw.trips;
    }
  } catch {
    /* absent or malformed state means "the lane is trusted" */
  }
}

function persistLaneState(): void {
  try {
    atomicWriteFile(laneStatePath(), JSON.stringify({
      version: WS_LANE_STATE_VERSION,
      holdUntil: state.holdUntil,
      rung: state.rung,
      trips: state.trips,
    }, null, 2) + "\n");
  } catch {
    /* the in-memory hold still applies for this process */
  }
}

loadLaneState();

/** Evidence, not correctness: a full disk must never break a turn. */
function noteEvidence(entry: Record<string, unknown>): void {
  try {
    const path = join(getConfigDir(), "ws-lane.jsonl");
    appendFileSync(path, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    /* evidence, not correctness */
  }
}

/**
 * True while this process must not dial the ChatGPT WebSocket lane.
 *
 * Read per request, so the hold takes effect on the next turn and expires on its own.
 */
export function codexWsLaneDisabled(now = Date.now()): boolean {
  return state.holdUntil > now;
}

/** The current hold, for reports and tests. */
export function codexWsLaneSnapshot(now = Date.now()): {
  disabled: boolean; holdUntil: number; rung: number; trips: number; refusals: number;
} {
  return {
    disabled: state.holdUntil > now,
    holdUntil: state.holdUntil,
    rung: state.rung,
    trips: state.trips,
    refusals: state.refusals.filter(at => now - at < WS_LANE_WINDOW_MS).length,
  };
}

/**
 * Record one socket that the origin closed without ever answering, and trip the lane when the
 * shape repeats.
 *
 * Callers pass what the exchange measured: a refusal is a close with an abnormal code, no relayed
 * event, and at most a handful of upstream frames (the control frames the backend sends before it
 * gives up). Ordinary turn failures -- a large frame, a mid-stream drop after content -- do not
 * match, and must not, because they are about the turn rather than the lane.
 */
export function noteCodexWsLaneRefusal(input: {
  closeCode?: number | null;
  relayedEvents: number;
  upstreamFrames: number;
  firstFrameMs?: number | null;
  elapsedMs?: number | null;
}, now = Date.now()): boolean {
  const code = input.closeCode ?? null;
  if (code === null || !REFUSAL_CLOSE_CODES.has(code)) return false;
  if (input.relayedEvents > 0 || input.upstreamFrames > 3) return false;
  // A lane that answered recently is healthy: this close is about the turn, not the transport.
  // Zero means "no success observed yet", so it must not read as "succeeded just now".
  if (state.lastSuccessAt > 0 && state.lastSuccessAt > now - WS_LANE_SUCCESS_DECAY_MS) return false;
  state.refusals.push(now);
  state.refusals = state.refusals.filter(at => now - at < WS_LANE_WINDOW_MS);
  if (state.refusals.length < WS_LANE_REFUSAL_THRESHOLD || state.holdUntil > now) return false;
  const hold = WS_LANE_HOLD_MS[Math.min(state.rung, WS_LANE_HOLD_MS.length - 1)]!;
  state.holdUntil = now + hold;
  state.rung = Math.min(state.rung + 1, WS_LANE_HOLD_MS.length - 1);
  state.refusals = [];
  state.trips += 1;
  persistLaneState();
  noteEvidence({
    event: "lane-hold", closeCode: code, holdMinutes: Math.round(hold / 60_000),
    rung: state.rung, trips: state.trips, firstFrameMs: input.firstFrameMs ?? null,
    elapsedMs: input.elapsedMs ?? null,
  });
  console.warn(
    "[codex-ws] the origin is closing this account's WebSocket lane without answering (close "
    + code + "); riding HTTP/SSE for " + Math.round(hold / 60_000) + "min and then trying again",
  );
  return true;
}

/** A turn that produced a response proves the lane works; clear the window. */
export function noteCodexWsLaneSuccess(now = Date.now()): void {
  state.lastSuccessAt = now;
  state.refusals = [];
  if (state.rung > 0) {
    // A recovered lane starts over at the first hold, so a transient outage does not leave the
    // next one parked for an hour.
    state.rung = 0;
    persistLaneState();
  }
}

/** Operator override: forget the hold and trust the lane again. */
export function clearCodexWsLaneHold(now = Date.now()): void {
  state.holdUntil = 0;
  state.refusals = [];
  state.rung = 0;
  persistLaneState();
  noteEvidence({ event: "lane-hold-cleared", clearedAt: now });
}

/** Test seam. */
export function resetCodexWsLaneForTests(): void {
  state.refusals = [];
  state.holdUntil = 0;
  state.rung = 0;
  state.lastSuccessAt = 0;
  state.trips = 0;
}
