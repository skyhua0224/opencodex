/**
 * Response identity markers that live in a dependency-free module.
 *
 * These facts -- "the body is already in the client's protocol", "the client-side relay owns the
 * completion", "the adapter produced this stream itself" -- are read by layers far from the code
 * that sets them, and every layer that rebuilds a Response has to restate them. Keeping the
 * WeakSets here rather than in relay.ts / responses/core-lifetime.ts lets the shared marker carry
 * (and the SSE prelude wrapper, which sits in the earliest import chain) restate them without
 * pulling the relay and the request log into a cycle.
 *
 * The owning modules re-export these functions, so every existing import path still resolves.
 */

const nativePassthroughSseResponses = new WeakSet<Response>();
const eagerRelaySseResponses = new WeakSet<Response>();

export function markNativePassthroughSseResponse(response: Response): Response {
  nativePassthroughSseResponses.add(response);
  return response;
}

export function isNativePassthroughSseResponse(response: Response): boolean {
  return nativePassthroughSseResponses.has(response);
}

export function markEagerRelaySseResponse(response: Response): Response {
  eagerRelaySseResponses.add(response);
  return response;
}

/** Test-only path identity seam; runtime behavior must not branch on this marker. */
export function isEagerRelaySseResponse(response: Response): boolean {
  return eagerRelaySseResponses.has(response);
}

// runTurn adapters own an event queue and perform their combo preflight before bridging. A second
// byte-stream reader would reinterpret that transport's already-committed event boundary and can
// replay custom adapter work.
export const runTurnAdapterSseResponses = new WeakSet<Response>();

export function carrySseResponseMarkers(source: Response, rewrapped: Response): void {
  if (nativePassthroughSseResponses.has(source)) nativePassthroughSseResponses.add(rewrapped);
  if (eagerRelaySseResponses.has(source)) eagerRelaySseResponses.add(rewrapped);
  if (runTurnAdapterSseResponses.has(source)) runTurnAdapterSseResponses.add(rewrapped);
}
