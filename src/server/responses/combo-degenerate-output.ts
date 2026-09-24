/**
 * Degenerate-output guard for combo children: the 复读 half of the ladder's failover story.
 *
 * Two shapes are caught, both observed in real relay sessions:
 *
 * 1. WITHIN one response -- the upstream repeats the same sentence, the same paragraph, or the
 *    same tool call over and over. Measured on the first 4KB of client-visible text: repeat ratio
 *    of normalized segments, the longest segment that recurs, and a zlib ratio over the window.
 *    A tool call whose signature repeats inside one response counts too.
 * 2. ACROSS turns -- every turn paraphrases the same short preamble and re-issues the identical
 *    tool call, whose result does not change either ("我先检查…" + `pwd`, twelve turns in a row).
 *    That is invisible to any single-response inspection, so the proxy keeps a small per-lane
 *    ledger of the last tool round trip (signature + result digest) and trips when the SAME pair
 *    repeats three times.
 *
 * The action is the relay-shaped one the operator asked for: never disable the channel, just
 * demote the target + provider for a short window and let the existing half-open probe bring it
 * back the moment it answers normally again. A trigger mid-stream ends the turn with an explicit
 * `response.failed` frame, because a stream that already produced client-visible output can no
 * longer be replayed on the next target.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { coolComboTarget, comboBreakerPolicy, noteProviderFailure } from "../../combos/failover";
import type { ComboBreakerPolicy } from "../../combos/failover";
import { createSseInspector } from "../relay";

/** Stable code the client sees when a stream is cut for degenerating. */
export const COMBO_DEGENERATE_CODE = "degenerate_output";

/** How long a degenerating target steps aside. Short on purpose: one good answer clears it. */
export const COMBO_DEGENERATE_COOLDOWN_MS = 2 * 60_000;

/** Client-visible text inspected before the within-response verdict is settled. */
export const COMBO_DEGENERATE_TEXT_BUDGET_BYTES = 4_096;
/** Frames inspected before call-signature watching gives up, independent of the text budget. */
const COMBO_DEGENERATE_WATCH_BUDGET_BYTES = 262_144;
/** Segments shorter than this are noise (table cells, list markers) and are not compared. */
const SEGMENT_MIN_CHARS = 16;
/** The "same paragraph appears N times" rule from the design; long segments only. */
const LONG_SEGMENT_CHARS = 40;
const LONG_SEGMENT_REPEATS = 3;
/**
 * The observed relay loops repeat SENTENCES (30-40 normalized chars), not paragraphs, so a second
 * tier covers them: still three copies, just a shorter unit. Table rows survive this because a
 * repeated row is nearly always the same SHORT cell text, filtered by {@link SEGMENT_MIN_CHARS}.
 */
const MEDIUM_SEGMENT_CHARS = 24;
const MEDIUM_SEGMENT_REPEATS = 3;
const SEGMENT_REPEAT_RATIO = 0.6;
const SEGMENT_REPEAT_MIN_SEGMENTS = 6;
const ZLIB_RATIO = 8;
const ZLIB_MIN_BYTES = 1_536;
/** Identical tool calls inside ONE response before it counts as a loop. */
const CALL_SIGNATURE_REPEATS = 3;
/** Identical call+result round trips across turns before the lane ledger trips. */
const ROUND_TRIP_REPEATS = 3;
/** Per-response signature books stay tiny: a degenerate turn repeats two or three calls, not 40. */
const SIGNATURE_WINDOW = 8;
const CALL_ARGUMENT_CAP_CHARS = 2_048;
/** Lane ledger bounds, mirroring the sticky-lane recall module. */
const LANE_LEDGER_CAPACITY = 512;
const LANE_LEDGER_TTL_MS = 30 * 60_000;
/** Tool results are digested, never retained; only this prefix is read at all. */
const ROUND_TRIP_DIGEST_BYTES = 8_192;

const SEGMENT_SPLIT = /[\n\r。！？!?；;]+/;
const WHITESPACE = /[\s\uFE0F]+/g;

export interface ComboDegenerateTarget {
  provider: string;
  model: string;
}

export interface ComboDegenerateGuardContext {
  comboId: string;
  /** Breaker tuning of the combo that owns the target; defaults apply when omitted. */
  combo: {
    breakerFailureThreshold?: number;
    breakerSuccessThreshold?: number;
    breakerOpenMs?: number;
  } | undefined;
  target: ComboDegenerateTarget;
  /** Session lane: the attribution key the cross-turn ledger demotes from. */
  lane?: string | undefined;
  /** Escape hatch used by callers that already know the child is not a combo stream. */
  enabled?: boolean;
  /**
   * Called once, before the terminal frame is written, so the caller can record the cut as a
   * failure this proxy made on purpose. Cancelling the child otherwise reads as a client cancel
   * in the request log, which buries the only evidence of why the turn ended.
   */
  onVerdict?: (detail: string) => void;
}

function normalizeSegment(segment: string): string {
  return segment.replace(WHITESPACE, "");
}

function digestText(text: string): string {
  return createHash("sha1").update(text.slice(0, ROUND_TRIP_DIGEST_BYTES), "utf8").digest("hex");
}

/**
 * Repetition reading of one text window, or undefined while the window looks like real output.
 *
 * The three rules are deliberately ordered cheapest-first, and each returns a message that names
 * the metric so the warning line explains why a channel was demoted.
 */
function repetitionVerdict(window: string): string | undefined {
  const segments = window.split(SEGMENT_SPLIT)
    .map(normalizeSegment)
    .filter(segment => segment.length >= SEGMENT_MIN_CHARS);
  if (segments.length > 0) {
    const counts = new Map<string, number>();
    for (const segment of segments) counts.set(segment, (counts.get(segment) ?? 0) + 1);
    let longRepeat = 0;
    let mediumRepeat = 0;
    for (const [segment, count] of counts) {
      if (count <= Math.min(longRepeat, mediumRepeat)) continue;
      if (segment.length >= LONG_SEGMENT_CHARS && count > longRepeat) longRepeat = count;
      if (segment.length >= MEDIUM_SEGMENT_CHARS && count > mediumRepeat) mediumRepeat = count;
    }
    if (longRepeat >= LONG_SEGMENT_REPEATS) {
      return `the same long segment repeated ${longRepeat} times`;
    }
    if (mediumRepeat >= MEDIUM_SEGMENT_REPEATS) {
      return `the same segment repeated ${mediumRepeat} times`;
    }
    if (segments.length >= SEGMENT_REPEAT_MIN_SEGMENTS) {
      const ratio = 1 - counts.size / segments.length;
      if (ratio >= SEGMENT_REPEAT_RATIO) {
        return `repeat ratio ${(ratio * 100).toFixed(0)}% across ${segments.length} segments`;
      }
    }
  }
  const bytes = Buffer.byteLength(window, "utf8");
  if (bytes >= ZLIB_MIN_BYTES) {
    const compressed = deflateSync(Buffer.from(window, "utf8"), { level: 6 }).byteLength;
    if (compressed > 0) {
      const ratio = bytes / compressed;
      if (ratio >= ZLIB_RATIO) return `compression ratio ${ratio.toFixed(1)}x over ${bytes}B`;
    }
  }
  return undefined;
}

interface DegenerateStreamMonitor {
  feed(chunk: Uint8Array): void;
  /** True once a verdict has been reached and reported; further feeds are ignored. */
  readonly triggered: boolean;
  dispose(): void;
}

/**
 * Inspect one child stream for both shapes of degeneration.
 *
 * `onTrigger` runs exactly once, from inside `feed`, so the caller can cut the relay and record
 * the verdict. Everything here is bounded: the text window stops at 4KB, the signature books are
 * fixed-size, and feeding stops entirely after {@link COMBO_DEGENERATE_WATCH_BUDGET_BYTES}.
 */
function createDegenerateStreamMonitor(onTrigger: (detail: string) => void): DegenerateStreamMonitor {
  const textWindow: string[] = [];
  const reasoningWindow: string[] = [];
  let textBytes = 0;
  let reasoningBytes = 0;
  let textSettled = false;
  let reasoningSettled = false;
  let watchedBytes = 0;
  let triggered = false;
  let disposed = false;
  const recentSignatures: string[] = [];
  const callSignatures = new Map<string, string>();
  let pendingCallKey: string | undefined;

  const inspector = createSseInspector({
    onParsedPayload: payload => {
      if (disposed || triggered || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
      observe(payload as Record<string, unknown>);
    },
  });

  const fire = (detail: string): void => {
    if (triggered) return;
    triggered = true;
    onTrigger(detail);
  };

  const noteText = (kind: "text" | "reasoning", delta: unknown): void => {
    if (typeof delta !== "string" || delta.length === 0) return;
    const parts = kind === "text" ? textWindow : reasoningWindow;
    let bytes = kind === "text" ? textBytes : reasoningBytes;
    let settled = kind === "text" ? textSettled : reasoningSettled;
    if (settled) return;
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    if (bytes + deltaBytes > COMBO_DEGENERATE_TEXT_BUDGET_BYTES) {
      // Keep the window honest: only whole deltas enter, and the budget ends the analysis.
      settled = true;
      if (kind === "text") textSettled = true;
      else reasoningSettled = true;
      if (textSettled && reasoningSettled) return;
    }
    parts.push(delta);
    bytes += deltaBytes;
    if (kind === "text") textBytes = bytes;
    else reasoningBytes = bytes;
    const verdict = repetitionVerdict(parts.join(""));
    if (verdict) fire(kind === "text" ? verdict : `${verdict} (reasoning)`);
  };

  const noteCallSignature = (signature: string): void => {
    if (!signature) return;
    recentSignatures.push(signature);
    if (recentSignatures.length > SIGNATURE_WINDOW) recentSignatures.shift();
    let repeats = 0;
    for (let index = recentSignatures.length - 1; index >= 0; index -= 1) {
      if (recentSignatures[index] !== signature) break;
      repeats += 1;
    }
    if (repeats >= CALL_SIGNATURE_REPEATS) {
      fire(`the same tool call repeated ${repeats} times in one response`);
    }
  };

  const observe = (payload: Record<string, unknown>): void => {
    const type = typeof payload.type === "string" ? payload.type : "";
    switch (type) {
      case "response.output_text.delta":
        noteText("text", payload.delta);
        return;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        noteText("reasoning", payload.delta);
        return;
      case "response.output_item.added": {
        const item = payload.item;
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const record = item as Record<string, unknown>;
        const itemType = typeof record.type === "string" ? record.type : "";
        if (itemType !== "function_call" && itemType !== "custom_tool_call") return;
        const key = typeof record.id === "string" ? record.id
          : typeof record.call_id === "string" ? record.call_id
          : undefined;
        if (!key) return;
        pendingCallKey = key;
        callSignatures.set(key, signatureOf(record, ""));
        return;
      }
      case "response.function_call_arguments.delta": {
        const itemId = typeof payload.item_id === "string" ? payload.item_id : pendingCallKey;
        if (!itemId) return;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const current = callSignatures.get(itemId) ?? "";
        if (current.length < CALL_ARGUMENT_CAP_CHARS) {
          callSignatures.set(itemId, (current + delta).slice(0, CALL_ARGUMENT_CAP_CHARS));
        }
        return;
      }
      case "response.output_item.done": {
        const item = payload.item;
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const record = item as Record<string, unknown>;
        const itemType = typeof record.type === "string" ? record.type : "";
        if (itemType !== "function_call" && itemType !== "custom_tool_call") return;
        const key = typeof record.id === "string" ? record.id
          : typeof record.call_id === "string" ? record.call_id
          : pendingCallKey;
        const carried = key ? callSignatures.get(key) ?? "" : "";
        noteCallSignature(signatureOf(record, carried));
        return;
      }
      default:
        return;
    }
  };

  return {
    get triggered() {
      return triggered;
    },
    feed(chunk: Uint8Array) {
      if (disposed || triggered) return;
      watchedBytes += chunk.byteLength;
      if (watchedBytes > COMBO_DEGENERATE_WATCH_BUDGET_BYTES) {
        // Past the budget nothing new is learned: text analysis is settled and a call loop that
        // has not shown up by now is not what this guard is for.
        disposed = true;
        inspector.dispose();
        return;
      }
      try {
        inspector.feed(chunk);
      } catch {
        // Detection must never break the relay; a malformed frame just ends the analysis.
        disposed = true;
        try { inspector.dispose(); } catch { /* already disposed */ }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      inspector.dispose();
    },
  };
}

/** Signature of one finished call: ``namespace.name(serialized-arguments)``. */
function signatureOf(item: Record<string, unknown>, carriedArguments: string): string {
  const namespace = typeof item.namespace === "string" ? item.namespace : "";
  const name = typeof item.name === "string" ? item.name : "";
  const rawArguments = typeof item.arguments === "string" ? item.arguments
    : typeof item.input === "string" ? item.input
    : carriedArguments;
  const argumentsText = rawArguments.replace(/\s+/g, " ").slice(0, CALL_ARGUMENT_CAP_CHARS);
  return `${namespace ? `${namespace}.` : ""}${name}(${argumentsText})`;
}

/**
 * Demote one target that produced degenerate output.
 *
 * Reuses the relay-shaped policy -- a short cooling window plus the shared provider failure
 * ledger, which only trips after repeated verdicts -- so the channel is never disabled and the
 * next normal answer puts it straight back in its price slot. The official hour-scale ladder is
 * deliberately NOT reachable from here.
 */
export function markComboTargetDegenerate(
  comboId: string,
  combo: ComboDegenerateGuardContext["combo"],
  target: ComboDegenerateTarget,
  detail: string,
): void {
  const breaker: ComboBreakerPolicy = comboBreakerPolicy(combo);
  coolComboTarget(comboId, target, {
    cooldownMs: COMBO_DEGENERATE_COOLDOWN_MS,
    breaker,
    code: COMBO_DEGENERATE_CODE,
    message: `degenerate output: ${detail}`,
  });
  const parked = noteProviderFailure(target.provider);
  console.warn(
    `[combo] ${comboId}: ${target.provider}/${target.model} produced degenerate output (${detail});`
    + ` target cooled ${Math.round(COMBO_DEGENERATE_COOLDOWN_MS / 1000)}s`
    + (parked ? ", provider shared failure hold armed" : ""),
  );
}

const DEGENERATE_TERMINAL_FRAME = (() => {
  const error = {
    type: "upstream_error",
    code: COMBO_DEGENERATE_CODE,
    message:
      "Upstream produced degenerate repetitive output; the combo demoted this channel and will "
      + "continue on the next one. Retry the turn to fail over immediately.",
  };
  const payload = JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error, last_error: error },
  });
  return new TextEncoder().encode(`event: response.failed\n\ndata: ${payload}\n\ndata: [DONE]\n\n`);
})();

/** True when more relays can still see this child's bytes, so the guard must watch them. */
function guardableComboStream(response: Response): boolean {
  if (!response.body || response.bodyUsed) return false;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType === "" || contentType.includes("text/event-stream");
}

/**
 * Watch the child's client-bound stream and cut a turn that degenerates after it started.
 *
 * The guard sits AFTER the preflight: by this point output is committed, so a trigger can only
 * end the current turn with an explicit `response.failed` frame -- the ladder hops on the NEXT
 * request, with the offending channel already demoted.
 */
export function guardComboDegenerateOutput(
  response: Response,
  ctx: ComboDegenerateGuardContext,
): Response {
  if (ctx.enabled === false || !guardableComboStream(response)) return response;
  // Attribution for the cross-turn ledger: this lane's next loop verdict demotes THIS target.
  noteComboLaneServing(ctx.lane, ctx.comboId, ctx.target);
  const reader = response.body!.getReader();
  let finished = false;
  const monitor = createDegenerateStreamMonitor(detail => {
    markComboTargetDegenerate(ctx.comboId, ctx.combo, ctx.target, detail);
    ctx.onVerdict?.(detail);
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      for (;;) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          finished = true;
          monitor.dispose();
          try { controller.error(error); } catch { /* consumer already gone */ }
          return;
        }
        if (next.done) {
          finished = true;
          monitor.dispose();
          try { controller.close(); } catch { /* consumer already gone */ }
          return;
        }
        // Relay first, then judge: the client sees exactly the bytes the upstream sent, and a
        // verdict always arrives after at least the chunk that produced it.
        try {
          controller.enqueue(next.value);
        } catch (error) {
          finished = true;
          monitor.dispose();
          throw error;
        }
        monitor.feed(next.value);
        if (monitor.triggered) {
          finished = true;
          monitor.dispose();
          try { controller.enqueue(DEGENERATE_TERMINAL_FRAME); } catch { /* consumer already gone */ }
          try { controller.close(); } catch { /* consumer already gone */ }
          void reader.cancel("combo degenerate output").catch(() => undefined);
          return;
        }
      }
    },
    cancel(reason) {
      finished = true;
      monitor.dispose();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}


/**
 * The same repetition monitor, for a session that called a provider directly (no combo).
 *
 * A native turn has no second row to hop to, so the two halves of the combo response change shape:
 * the cut stays (stop paying for a loop), and the failover becomes the CLIENT's retry -- which is
 * what a fresh generation usually needs to break out of a loop. The verdict is announced on the
 * lane so a combo serving that conversation later demotes this target on its next pass, and the
 * caller records it on the request log through onVerdict.
 */
export interface NativeDegenerateGuardOptions {
  /** Conversation key, for the log line and the cross-turn attribution. */
  lane?: string | undefined;
  /** "provider/model", for the log line. */
  label?: string;
  /** Called once, before the terminal frame is written. */
  onVerdict?: (detail: string) => void;
}

function nativeTerminalFrame(label: string): Uint8Array {
  const error = {
    type: "upstream_error",
    code: COMBO_DEGENERATE_CODE,
    message: "The channel started repeating itself; this proxy cut the stream so the turn can be"
      + " retried instead of paying for the loop" + (label ? " (" + label + ")" : "") + ".",
  };
  const payload = JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error, last_error: error },
  });
  return new TextEncoder().encode("event: response.failed\n\ndata: " + payload + "\n\ndata: [DONE]\n\n");
}

export function guardNativeDegenerateOutput(
  response: Response,
  options: NativeDegenerateGuardOptions = {},
): Response {
  if (!guardableComboStream(response)) return response;
  const reader = response.body!.getReader();
  let finished = false;
  const monitor = createDegenerateStreamMonitor(detail => {
    // Attribution only: the ledger below decides which target a later combo pass demotes.
    if (options.lane) noteLaneDegenerate(options.lane, detail);
    console.warn(
      "[degenerate] " + (options.label ?? "native stream") + " repeated itself; cutting the stream"
      + (options.lane ? " (lane " + options.lane.slice(0, 8) + ")" : "") + ": " + detail,
    );
    options.onVerdict?.(detail);
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      for (;;) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          finished = true;
          monitor.dispose();
          try { controller.error(error); } catch { /* consumer already gone */ }
          return;
        }
        if (next.done) {
          finished = true;
          monitor.dispose();
          try { controller.close(); } catch { /* consumer already gone */ }
          return;
        }
        try {
          controller.enqueue(next.value);
        } catch (error) {
          finished = true;
          monitor.dispose();
          throw error;
        }
        monitor.feed(next.value);
        if (monitor.triggered) {
          finished = true;
          monitor.dispose();
          try { controller.enqueue(nativeTerminalFrame(options.label ?? "")); } catch { /* consumer already gone */ }
          try { controller.close(); } catch { /* consumer already gone */ }
          void reader.cancel("degenerate output").catch(() => undefined);
          return;
        }
      }
    },
    cancel(reason) {
      finished = true;
      monitor.dispose();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Lane key -> the target that was repeating, so a later combo pass can demote it. */
const laneDegenerate = new Map<string, { detail: string; at: number }>();

function noteLaneDegenerate(lane: string, detail: string): void {
  laneDegenerate.delete(lane);
  laneDegenerate.set(lane, { detail, at: Date.now() });
  while (laneDegenerate.size > LANE_LEDGER_CAPACITY) {
    const oldest = laneDegenerate.keys().next().value;
    if (oldest === undefined) break;
    laneDegenerate.delete(oldest);
  }
}

/**
 * The verdict a lane collected while being served natively, if it is still fresh.
 *
 * Read by the combo guard when the same conversation comes back through a combo: the row that just
 * served it natively is the row to demote, because that is where the loop came from.
 */
export function takeLaneDegenerateVerdict(lane: string | undefined, now = Date.now()): string | undefined {
  if (!lane) return undefined;
  const entry = laneDegenerate.get(lane);
  if (!entry) return undefined;
  laneDegenerate.delete(lane);
  return now - entry.at <= LANE_LEDGER_TTL_MS ? entry.detail : undefined;
}
interface LaneRoundTripEntry {
  signature: string;
  digest: string;
  repeats: number;
  /** Set once this streak has already demoted a target, so one loop cools once. */
  fired: boolean;
  at: number;
}

const laneRoundTrips = new Map<string, LaneRoundTripEntry>();

/**
 * Which target last served each lane. Recorded when a child stream starts rather than when it
 * completes, because the loop shape under detection is a turn that DOES complete -- the client
 * keeps sending the same tool call back.
 */
const laneServing = new Map<string, { comboId: string; target: ComboDegenerateTarget; at: number }>();

/** Remember which combo target is serving a lane, for cross-turn attribution. */
export function noteComboLaneServing(
  lane: string | undefined,
  comboId: string,
  target: ComboDegenerateTarget,
  now = Date.now(),
): void {
  if (!lane || !comboId) return;
  laneServing.delete(lane);
  laneServing.set(lane, { comboId, target: { provider: target.provider, model: target.model }, at: now });
  while (laneServing.size > LANE_LEDGER_CAPACITY) {
    const oldest = laneServing.keys().next().value;
    if (oldest === undefined) break;
    laneServing.delete(oldest);
  }
}

/**
 * The last tool round trip in an incoming request body, as (call signature, result digest).
 *
 * Walks the input tail backwards, pairing an output item with the call it answers. Returns
 * undefined for bodies with no tool history (first turn, compaction, plain text input).
 */
function lastToolRoundTrip(body: unknown): { signature: string; digest: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) return undefined;
  // Two passes: an output item answers a call that appears BEFORE it in the transcript, so the
  // backward walk below needs the call book already filled.
  const callsById = new Map<string, string>();
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const callId = typeof record.call_id === "string" ? record.call_id : undefined;
    if (!callId) continue;
    if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      callsById.set(callId, signatureOf(record, ""));
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "local_shell_call_output") {
      callsById.set(callId, callsById.get(callId) ?? "");
    }
  }
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type !== "function_call_output" && type !== "custom_tool_call_output" && type !== "local_shell_call_output") {
      continue;
    }
    const callId = typeof record.call_id === "string" ? record.call_id : undefined;
    const signature = callId ? callsById.get(callId) : undefined;
    if (!signature) continue;
    const output = typeof record.output === "string" ? record.output
      : JSON.stringify(record.output ?? record.result ?? "");
    return { signature, digest: digestText(output) };
  }
  return undefined;
}

/**
 * Feed one turn's tool round trip into the lane ledger.
 *
 * Returns the loop verdict exactly once per streak: the same call signature AND the same result
 * digest for {@link ROUND_TRIP_REPEATS} consecutive turns. A changed result (a poll that finally
 * saw progress) resets the streak, which is what keeps legitimate repeat calls from tripping it.
 */
export function noteComboToolRoundTrip(
  lane: string | undefined,
  body: unknown,
  now = Date.now(),
): { signature: string; repeats: number; comboId: string; target: ComboDegenerateTarget } | undefined {
  if (!lane) return undefined;
  const pair = lastToolRoundTrip(body);
  if (!pair) return undefined;
  const previous = laneRoundTrips.get(lane);
  if (previous && now - previous.at >= LANE_LEDGER_TTL_MS) laneRoundTrips.delete(lane);
  const entry: LaneRoundTripEntry = previous && now - previous.at < LANE_LEDGER_TTL_MS
    && previous.signature === pair.signature && previous.digest === pair.digest
    ? { ...previous, repeats: previous.repeats + 1, at: now }
    : { ...pair, repeats: 1, fired: false, at: now };
  laneRoundTrips.delete(lane);
  laneRoundTrips.set(lane, entry);
  while (laneRoundTrips.size > LANE_LEDGER_CAPACITY) {
    const oldest = laneRoundTrips.keys().next().value;
    if (oldest === undefined) break;
    laneRoundTrips.delete(oldest);
  }
  if (entry.repeats < ROUND_TRIP_REPEATS || entry.fired) return undefined;
  // No attribution, no verdict: without a serving target the caller cannot demote anything, and
  // consuming the streak here would throw away the only chance this loop gets to be demoted.
  const serving = laneServing.get(lane);
  if (!serving || now - serving.at >= LANE_LEDGER_TTL_MS) return undefined;
  entry.fired = true;
  return { signature: pair.signature, repeats: entry.repeats, comboId: serving.comboId, target: serving.target };
}

/** Test-only reset, alongside the combo rotation/cooldown resets. */
export function clearComboDegenerateLedgerForTests(): void {
  laneRoundTrips.clear();
  laneServing.clear();
}
