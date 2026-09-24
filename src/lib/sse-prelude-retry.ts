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
}

const PRELUDE_TYPES: ReadonlySet<string> = new Set(["response.created", "response.in_progress"]);
const DECLINE_TYPES: ReadonlySet<string> = new Set(["error", "response.failed"]);

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
  if (!response.body || !contentType.includes("text/event-stream")) return response;
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
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
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
            const decline = type !== undefined && DECLINE_TYPES.has(type) && isCapacityDecline(frameText);
            const prelude = type === undefined || PRELUDE_TYPES.has(type) || type.startsWith("codex.");
            if (decline && (!(!contentSeen) || rung >= options.delaysMs.length)) {
              console.warn(
                "[upstream-retry] sse decline seen but not retried ("
                + (contentSeen ? "content already delivered" : "no rung left")
                + (options.label ? ", " + options.label : "") + ")",
              );
            }
            if (!contentSeen && decline && rung < options.delaysMs.length) {
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
                // Only another STREAM may be spliced in: a non-ok answer (a refusal, a budget
                // error) has no frames to give the client, and its JSON body would land inside an
                // event stream. Fall back to the decline instead.
                const nextType = next?.headers.get("content-type") ?? "";
                if (!next?.body || !next.ok || !nextType.includes("text/event-stream")) {
                  throw new Error("no further stream attempt available");
                }
                reader = next.body.getReader();
                buffer = new Uint8Array(0);
              } catch (error) {
                // No rung left or the wait was aborted: hand the client the decline it was going to
                // get anyway rather than a broken stream.
                if (!released) flushHeld();
                emit(frameBytes);
                console.warn("[upstream-retry] sse prelude decline could not be retried: " + String(error));
                release();
                return;
              }
              break;   // re-read from the new attempt
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
