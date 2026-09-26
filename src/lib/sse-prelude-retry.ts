/**
 * Retry a capacity decline that arrives INSIDE an already-200 SSE body.
 *
 * The WebSocket lane holds its prelude, so a decline that arrives after `response.created` is still
 * a pre-commit event and the attempt can be re-dialled. The SSE lane had no such hold: the backend
 * answered 200, emitted the prelude, then sent "Our servers are currently overloaded" as a stream
 * event, and that event went straight into the client (measured 2026-09-24 14:15-15:49: four such
 * turns, `transportPhase: terminal_sse`, `sendCount: 1`, nothing retryable left).
 *
 * This wrapper sits between the upstream body and the delivery layer, so it can do what the
 * delivery layer cannot: see the decline before the client does, throw that attempt away, and splice
 * the NEXT attempt's frames into the same body. The client never sees the declined attempt at all --
 * not its prelude, not the error -- and the response head it already received stays valid.
 *
 * Safety: only frames that carry no content are ever held, and a decline is only retried while
 * nothing has been forwarded. Once any content frame is out, a resend would generate a second answer
 * for the same turn, so the decline is passed through and the client's own retry owns the outcome.
 */

const DEFAULT_HOLD_MS = 25_000;

export interface SsePreludeDeclineRetryOptions {
  /** Waits before each resend, indexed by rung; its length is the resend budget. */
  delaysMs: readonly number[];
  /** Perform one more physical send. Null when the caller has no rung left to spend. */
  resend: (rung: number) => Promise<Response | null>;
  /** How long prelude frames may be held before they are released unconditionally. */
  holdMs?: number;
  /** Host label for logs. */
  label?: string;
  /** Abort while waiting between resends. */
  signal?: AbortSignal;
  /**
   * Wrap a body whose content-type is not `text/event-stream`.
   *
   * The caller opts in when it knows this endpoint speaks the Responses event protocol, because a
   * decline that arrives with a wrong or missing content-type is the one shape this wrapper used to
   * pass straight through: measured 2026-09-26 09:28/09:38, two native gpt-6-sol turns were shed
   * with "Our servers are currently overloaded", recorded `terminal_sse` + `sendCount: 1`, and
   * this wrapper never logged a line -- it had returned the response unchanged on the content-type
   * check. Only content-free frames are ever held, so widening the check cannot hide an answer.
   */
  acceptAnyContentType?: boolean;
}

const PRELUDE_TYPES: ReadonlySet<string> = new Set(["response.created", "response.in_progress"]);

/**
 * Whether a frame carries something the user can see, which is what makes a resend impossible.
 *
 * The first version counted every non-prelude frame, so a shed that arrived after
 * `response.output_item.added` was refused with "content already delivered" even though the client
 * had no text at all: measured 2026-09-26 10:01:04, a 24.5s turn ended 503 with no first output and
 * the wrapper logged exactly that. Structural frames are now HELD like the prelude, so a decline
 * that follows them is still pre-delivery and the attempt can be re-dialled; the held frames are
 * flushed in order the moment real content arrives, so a healthy turn is unchanged apart from a few
 * milliseconds of ordering.
 *
 * Anything unrecognised counts as content: a frame this module cannot classify must never be
 * thrown away on a guess.
 */
function isContentFrame(frameText: string, type: string | undefined): boolean {
  if (type === undefined) return true;
  if (type.endsWith(".delta") || type.endsWith(".done")) return true;
  if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") return true;
  if (type === "error") return true;
  // Structural frames (output_item.added, content_part.added, reasoning part markers, ...) are
  // holdable; everything else in the response.* namespace is treated as payload-bearing.
  return !(type.startsWith("response.") || type.startsWith("codex."));
}

function decodeFrame(frame: Uint8Array): string {
  return new TextDecoder().decode(frame);
}

/** The `type` of an SSE frame, or undefined when it is not a JSON event we recognise. */
function frameType(text: string): string | undefined {
  const dataLine = text.split("\n").filter(line => line.startsWith("data:")).pop();
  if (!dataLine) return undefined;
  try {
    const parsed = JSON.parse(dataLine.slice(5).trim()) as { type?: unknown };
    return typeof parsed?.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

function isCapacityDecline(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("overloaded") || lower.includes("capacity") || lower.includes("server_is_overloaded");
}

/**
 * Whether one frame is a capacity decline about THIS turn rather than an answer that quotes it.
 *
 * The difference matters: a successful completion carries the assistant's own text, and this very
 * investigation's answers contain the word "overloaded". So a completed frame only counts when the
 * response it reports actually FAILED; error-shaped frames and unparsable frames count on the
 * capacity text alone, which is the shape the backend uses when it declines a turn.
 */
function isDeclineFrame(frameText: string, type: string | undefined): boolean {
  if (!isCapacityDecline(frameText)) return false;
  // A body with no event framing can be a whole JSON answer rather than a stream, and an answer is
  // allowed to contain these words (this investigation's own replies do). Without a frame type the
  // verdict must therefore be explicit, not merely mentioned.
  if (type === undefined) {
    return /"server_is_overloaded"|"type"\s*:\s*"error"|"status"\s*:\s*"failed"|"code"\s*:\s*"(?:server_is_overloaded|capacity)"/.test(frameText);
  }
  if (type === "error" || type === "response.failed") return true;
  if (type !== "response.completed") return false;
  const dataLine = frameText.split("\n").filter(line => line.startsWith("data:")).pop();
  if (!dataLine) return false;
  try {
    const parsed = JSON.parse(dataLine.slice(5).trim()) as { response?: { status?: unknown } };
    return parsed?.response?.status === "failed";
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error("aborted")); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function withSsePreludeDeclineRetry(
  response: Response,
  options: SsePreludeDeclineRetryOptions,
): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body) return response;
  if (!contentType.includes("text/event-stream") && options.acceptAnyContentType !== true) return response;
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  let reader = response.body.getReader();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = new Uint8Array(0);
      const held: Uint8Array[] = [];
      let released = false;
      let contentSeen = false;
      let rung = 0;
      const emit = (frame: Uint8Array) => {
        try { controller.enqueue(frame); } catch { /* the client is gone */ }
      };
      const flushHeld = () => {
        clearTimeout(flushTimer); flushTimer = undefined;
        released = true;
        for (const frame of held.splice(0, held.length)) emit(frame);
      };
      const release = () => { clearTimeout(flushTimer); flushTimer = undefined; try { controller.close(); } catch { /* already closed */ } };
      /**
       * Throw this attempt away and splice the next one in. Returns true when a stream replaced
       * the reader, so the caller re-reads; false when the decline has to be handed over instead.
       */
      const retryDecline = async (declinedFrame: Uint8Array | null): Promise<boolean> => {
        if (contentSeen || rung >= options.delaysMs.length) return false;
        const waitMs = options.delaysMs[rung]!;
        rung += 1;
        held.length = 0;
        console.warn(
          "[upstream-retry] sse prelude declined before any content"
          + (options.label ? " (" + options.label + ")" : "")
          + " - resending in " + waitMs + "ms (" + rung + "/" + options.delaysMs.length + ")",
        );
        try { await reader.cancel(); } catch { /* the declined body is going away anyway */ }
        try {
          await sleep(waitMs, options.signal);
          const next = await options.resend(rung);
          const nextType = next?.headers.get("content-type") ?? "";
          // Only another STREAM may be spliced in: a non-ok answer (a refusal, a budget error)
          // has no frames to give the client, and its JSON body would land inside an event stream.
          if (!next?.body || !next.ok
            || (!nextType.includes("text/event-stream") && options.acceptAnyContentType !== true)) {
            throw new Error("no further stream attempt available");
          }
          reader = next.body.getReader();
          buffer = new Uint8Array(0);
          return true;
        } catch (error) {
          // No rung left or the wait was aborted: hand the client the decline it was going to get
          // anyway rather than a broken stream.
          if (!released) flushHeld();
          if (declinedFrame) emit(declinedFrame);
          console.warn("[upstream-retry] sse prelude decline could not be retried: " + String(error));
          release();
          return false;
        }
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            // The decline may also be the LAST bytes: a frame with no trailing separator, or a
            // body that is one JSON object rather than an SSE stream. Without this check the
            // turn's overload verdict sat in the buffer and was released to the client unretried.
            if (!contentSeen && buffer.byteLength > 0) {
              const trailing = decodeFrame(buffer);
              if (isDeclineFrame(trailing, frameType(trailing))) {
                buffer = new Uint8Array(0);
                if (await retryDecline(null)) continue;
                return;
              }
              // Not a decline: this is the whole body (a non-streaming answer) or the tail of one,
              // and it has never been emitted because only frame-terminated text is. Dropping it
              // would turn "wrapped a body that is not an SSE stream" into a lost answer.
              buffer = new Uint8Array(0);
              if (!released && held.length > 0) flushHeld();
              emit(new TextEncoder().encode(trailing));
              release();
              return;
            }
            if (!released && held.length > 0) flushHeld();
            release();
            return;
          }
          if (!value) continue;
          const merged = new Uint8Array(buffer.byteLength + value.byteLength);
          merged.set(buffer); merged.set(value, buffer.byteLength);
          buffer = merged;
          for (;;) {
            const text = decodeFrame(buffer);
            // Both separators: SSE allows CRLF, and the canonical backend is free to use it. Frames
            // that never split would sit in the hold until its timer released them, which is exactly
            // how a decline would slip past this wrapper unretried (seen 2026-09-24 22:32).
            const lfOnly = text.indexOf("\n\n");
            const crlf = text.indexOf("\r\n\r\n");
            const boundary = crlf >= 0 && (lfOnly < 0 || crlf <= lfOnly) ? crlf : lfOnly;
            const separator = boundary === crlf && crlf >= 0 ? 4 : 2;
            if (boundary < 0) break;
            const frameText = text.slice(0, boundary + separator);
            const frameBytes = new TextEncoder().encode(frameText);
            buffer = buffer.slice(frameBytes.byteLength);
            const type = frameType(frameText);
            const decline = isDeclineFrame(frameText, type);
            // Holdable = nothing the user can see yet: the prelude, the backend's codex.* control
            // frames, and the structural frames that only describe a response being built.
            const prelude = type !== undefined
              && (PRELUDE_TYPES.has(type) || type.startsWith("codex.") || !isContentFrame(frameText, type));
            if (decline && (!(!contentSeen) || rung >= options.delaysMs.length)) {
              console.warn(
                "[upstream-retry] sse decline seen but not retried ("
                + (contentSeen ? "content already delivered" : "no rung left")
                + (options.label ? ", " + options.label : "") + ")",
              );
            }
            if (!contentSeen && decline && rung < options.delaysMs.length) {
              if (await retryDecline(frameBytes)) break;   // re-read from the new attempt
              return;
            }
            if (!contentSeen && prelude && !released) {
              held.push(frameBytes);
              flushTimer ??= setTimeout(flushHeld, holdMs);
              continue;
            }
            if (!contentSeen && !prelude) contentSeen = true;
            if (!released && held.length > 0) flushHeld();
            emit(frameBytes);
          }
        }
      } catch (error) {
        if (!released && held.length > 0) flushHeld();
        try { controller.error(error); } catch { /* already closed */ }
      }
    },
    cancel() { clearTimeout(flushTimer); void reader.cancel(); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
}
