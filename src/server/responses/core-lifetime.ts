import type { TranslatorBudget } from "../../lib/translator-budget";
import {
  createTurnStateSniffer,
  observeTurnStateResponseHeaders,
  observeTurnStateUpstreamStatus,
  type TurnStateWhere,
} from "../turn-state-observer";
import { carryResponseMarkers } from "../../lib/response-markers";
import { runTurnAdapterSseResponses } from "../sse-response-markers";

export { runTurnAdapterSseResponses } from "../sse-response-markers";


// Whole-body policy for non-streaming upstream JSON responses (see the application/json
// branch of the passthrough return path). 32 MiB matches the continuation snapshot read
// bound and is far above any legitimate non-streaming completion, including base64 image
// payloads. The stall deadlines only govern the body transfer — generation time before
// the response headers is untouched. Generation after early/chunked headers but before
// the first body byte previously used the 30-second inactivity deadline; this call site
// gives it the full body deadline instead.
export const MAX_UPSTREAM_JSON_BODY_BYTES = 32 * 1024 * 1024;

export const UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS = 180_000;

export const UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS = 30_000;

export const UPSTREAM_JSON_BODY_READ_OPTIONS = {
  maxBytes: MAX_UPSTREAM_JSON_BODY_BYTES,
  totalTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS,
  inactivityTimeoutMs: UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS,
  firstByteTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS,
};




/**
 * The adapter answered with its own SSE body, already in the client's protocol.
 *
 * Owned here rather than in the shared marker carry so that this module and the carry do not
 * import each other; every wrapper in this file restates it alongside the rest.
 */
export function finalizeOwnedTranslatorBudget(response: Response, budget: TranslatorBudget, turnStateWhere?: TurnStateWhere): Response {
  if (!response.body) {
    budget.dispose();
    return response;
  }
  const reader = response.body.getReader();
  const turnStateSniffer = turnStateWhere ? createTurnStateSniffer(turnStateWhere) : undefined;
  if (turnStateWhere) {
    observeTurnStateUpstreamStatus(response.status, turnStateWhere);
    observeTurnStateResponseHeaders(response.headers, turnStateWhere);
  }
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    budget.dispose();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          try { turnStateSniffer?.finish(); } catch { /* observer never breaks the relay */ }
          finalize();
          controller.close();
        } else {
          try { turnStateSniffer?.feed(result.value); } catch { /* observer never breaks the relay */ }
          controller.enqueue(result.value);
        }
      } catch (error) {
        try { turnStateSniffer?.finish(); } catch { /* observer never breaks the relay */ }
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { turnStateSniffer?.finish(); } catch { /* observer never breaks the relay */ }
      try { await reader.cancel(reason); } finally { finalize(); }
    },
  });
  const finalizedResponse = carryResponseMarkers(response, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
  if (runTurnAdapterSseResponses.has(response)) runTurnAdapterSseResponses.add(finalizedResponse);
  return finalizedResponse;
}

/** Release a serving-account slot when the client body ends, errors or is cancelled. */
export function finalizeAccountLease(response: Response, release: () => void): Response {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  let done = false;
  const finish = () => { if (!done) { done = true; release(); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
  });
  const wrapped = carryResponseMarkers(response, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
  if (runTurnAdapterSseResponses.has(response)) runTurnAdapterSseResponses.add(wrapped);
  return wrapped;
}




export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
