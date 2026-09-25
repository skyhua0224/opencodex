import { OPENAI_API_RESPONSES_URL } from "./native-response-control";
import { isInjectionRequest } from "./native-injection-protocol";
import type { NativeResponseControl } from "./native-response-control";
// Upstream WebSocket transport for the ChatGPT Codex backend.
//
// Why this exists: the Codex backend serves the responses_websockets path from
// a measurably faster queue than the plain SSE POST path. Measured 2026-08-12
// KST (same account, same payload, strictly sequential): gpt-5.6-luna TTFT p50
// ~1.0s over WS vs ~3.9s over SSE. Codex CLI itself defaults to the WS
// transport; opencodex previously always POSTed SSE, which is where its extra
// 2-3s of TTFT came from.
//
// The wrapper only swaps the transport. It dials wss:// with the same headers,
// sends the JSON body as a single `response.create` frame, and re-encodes the
// returned event frames as an SSE byte stream, so every downstream consumer
// (passthrough relay, adapter parsers, usage sniffing) is unchanged.

import { compareBunVersions } from "../../lib/bun-stream-caps";
import { resolveProxyRoute, socks5ProxyFromEnv } from "../../lib/proxy-env";
import type { CodexWsQuotaObserver } from "./codex-ws-metadata";
import { CODEX_RESPONSES_HTTP_URL, CODEX_RESPONSES_WS_URL, prepareCodexHttpInit, prepareCodexWsRequest } from "./codex-ws-request";
import { codexWsExchange } from "./codex-ws-exchange";
import { CodexWsSession } from "./codex-ws-session";
import { codexWsPool, codexWsReuseIdentity } from "./codex-ws-pool";
import { codexWsLaneDisabled } from "./codex-ws-lane";
import { codexWsCreateFrameExceedsLimit } from "./codex-ws-wire";
import { conversationKeyFromHeaders, threadTransportDemotedToHttp } from "../ws-thread-transport";
import { normalizeLogConversationId } from "../request-log-conversation";
export { CODEX_WS_LIVENESS_PING_INTERVAL_MS, CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS, MAX_CODEX_WS_FRAME_BYTES, MAX_CODEX_WS_QUEUE_BYTES,
  MAX_CODEX_WS_CREATE_FRAME_BYTES, CODEX_WS_CREATE_FRAME_LIMIT_BYTES, codexWsCreateFrameExceedsLimit,
  isCodexWsQuotaObservedResponse, isCodexWsUpstreamResponse } from "./codex-ws-wire";
export const MIN_BOUNDED_CODEX_WS_BUN_VERSION = "1.4.0";

/**
 * Dial URL for a first-party Responses endpoint. The canonical ChatGPT backend
 * keeps its constant; the api.openai.com Responses endpoint swaps https for wss
 * on the same path. No other upstream may enter the WebSocket lane.
 */
function wsUpstreamUrlFor(httpUrl: string): string {
  if (httpUrl === CODEX_RESPONSES_HTTP_URL) return CODEX_RESPONSES_WS_URL;
  if (httpUrl === OPENAI_API_RESPONSES_URL) return httpUrl.replace(/^http(s?):/, "ws$1:");
  throw new Error("unsupported Codex WebSocket upstream");
}
export type BunRuntimeIdentity = {
  version: string;
  versionWithSha: string;
};

export type BunRuntimeGateInput = string | BunRuntimeIdentity;

export function currentBunRuntimeIdentity(): BunRuntimeIdentity {
  return {
    version: Bun.version,
    versionWithSha: Bun.version_with_sha,
  };
}

function boundedRelayVersion(input: BunRuntimeGateInput): string | null {
  if (typeof input === "string") return input.trim() || null;
  const numericVersion = input.version.trim();
  const numericMatch = /^(\d+\.\d+\.\d+)$/.exec(numericVersion);
  const detailedMatch = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\([0-9a-fA-F]+\)$/.exec(
    input.versionWithSha.trim(),
  );
  if (!numericMatch || !detailedMatch) return null;
  const detailedNumeric = /^(\d+\.\d+\.\d+)/.exec(detailedMatch[1])?.[1];
  return detailedNumeric === numericMatch[1] ? detailedMatch[1] : null;
}

/**
 * Bun 1.3.14 does not propagate a stalled HTTP response socket back to a JS
 * ReadableStream producer on Windows. A real raw-TCP slow-client probe drained
 * the entire upstream despite the eager relay queue; Bun 1.4.0-canary.1 stopped
 * below one MiB. Prereleases still fail closed; release builds before 1.4.0
 * fall back to HTTP SSE.
 */
export function bunSupportsBoundedCodexWsRelay(
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
): boolean {
  const version = boundedRelayVersion(runtime);
  if (!version) return false;
  if (/^\d+\.\d+\.\d+-/.test(version.trim())) return false;
  const comparison = compareBunVersions(version, MIN_BOUNDED_CODEX_WS_BUN_VERSION);
  return comparison !== null && comparison >= 0;
}

export function shouldUseCodexWsUpstream(
  url: string,
  init?: RequestInit,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  upstreamWebsocketConfigured = false,
): boolean {
  if (!bunSupportsBoundedCodexWsRelay(runtime)) return false;
  if (socks5ProxyFromEnv()) return false;
  // Bun's client WebSocket API delivers only fully assembled messages and has
  // no enforceable inbound payload limit. Keep arbitrary provider endpoints on
  // bounded HTTP/SSE until the client can reject fragmented text and binary
  // messages during ingestion rather than after allocation. The first-party
  // api.openai.com lane still requires the operator opt-in.
  if (url !== CODEX_RESPONSES_HTTP_URL
    && !(upstreamWebsocketConfigured && url === OPENAI_API_RESPONSES_URL)) return false;
  // The lane-level breaker: the origin is closing every dial without answering, so stop spending a
  // capacity ladder (5+12+25+45s) per turn on it and ride HTTP until the hold expires. See
  // ./codex-ws-lane.ts for the measured shape this reacts to.
  if (url === CODEX_RESPONSES_HTTP_URL && codexWsLaneDisabled()) return false;
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  const body = init?.body;
  if (typeof body !== "string") return false;
  // Only root-level stream:true selects WS: JSON-mode calls keep the HTTP path
  // because the WS path only speaks the event protocol, and a nested
  // {"metadata":{"stream":true}} must not flip the transport. Parsing (not
  // substring matching) also keeps whitespace-formatted bodies routable.
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || (parsed as Record<string, unknown>).stream !== true) return false;
    // Per-thread demotion: a conversation the WS lane keeps shedding rides HTTP instead, while
    // every other conversation keeps the faster lane. See ../ws-thread-transport.ts.
    const candidates = codexWsThreadKeys(parsed as Record<string, unknown>, init);
    return !candidates.some(key => threadTransportDemotedToHttp(key));
  } catch {
    return false;
  }
}

/**
 * Every identity this request could be known by in the transport ledger.
 *
 * The ledger records verdicts under the proxy's own conversation id, which is derived (and hashed)
 * from the caller's headers; the Codex client also names the thread in `client_metadata.thread_id`.
 * Checking both spellings keeps the demotion attached to the conversation even when the two differ.
 */
function codexWsThreadKeys(
  parsed: Record<string, unknown>,
  init: RequestInit,
): string[] {
  const keys: string[] = [];
  const fromHeaders = conversationKeyFromHeaders(init.headers);
  if (fromHeaders) keys.push(fromHeaders);
  const metadata = parsed.client_metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const thread = (metadata as Record<string, unknown>).thread_id;
    if (typeof thread === "string" && thread.trim().length > 0) {
      const normalized = normalizeLogConversationId(thread);
      if (normalized && !keys.includes(normalized)) keys.push(normalized);
    }
  }
  return keys;
}

export function codexWsUpstreamFetch(
  url: string,
  init: RequestInit,
  sseFallback: typeof globalThis.fetch,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  onQuota?: CodexWsQuotaObserver,
  beforeDispatch?: (headers: Headers) => void,
  nativeControl?: NativeResponseControl,
  beforeContinuation?: () => Promise<void>,
): Promise<Response> {
  const prepared = prepareCodexWsRequest(url, init);
  if (!prepared) return sseFallback(url, prepareCodexHttpInit(url, init));
  init = prepared.httpInit;
  if ((url !== CODEX_RESPONSES_HTTP_URL && url !== OPENAI_API_RESPONSES_URL)
    || !bunSupportsBoundedCodexWsRelay(runtime)) {
    return sseFallback(url, init);
  }
  const signal = init.signal ?? undefined;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  }

  const { frameText, headers } = prepared;
  // Never infer backend support from a model name or enable controls on a gateway.
  const control = nativeControl?.kind === "injection"
    ? ((prepared.canonical || url === OPENAI_API_RESPONSES_URL) && isInjectionRequest(JSON.parse(frameText)) ? nativeControl : undefined)
    : prepared.canonical ? nativeControl : undefined;
  if (control?.kind === "injection" && url === OPENAI_API_RESPONSES_URL) {
    const beta = headers["openai-beta"];
    if (!beta?.split(",").some(value => value.trim() === "responses_multi_agent=v1")) {
      headers["openai-beta"] = beta ? `${beta}, responses_multi_agent=v1` : "responses_multi_agent=v1";
    }
  }


  // Decide before dialing. Once the socket is open the caller already holds a
  // streaming Response, so the oversized close can only be surfaced as a stream
  // error — and a resend at that point could double-generate. Measuring the
  // frame we are about to send keeps the whole failure mode unreachable.
  if (codexWsCreateFrameExceedsLimit(frameText)) {
    return sseFallback(url, init);
  }

  const wsUrl = wsUpstreamUrlFor(url);
  const proxyRoute = resolveProxyRoute(new URL(wsUrl));
  if (proxyRoute.kind === "fallback") return sseFallback(url, init);
  const proxy = proxyRoute.kind === "proxy" ? proxyRoute.proxy : undefined;
  // A genuine caller `originator` is already in these headers via the forward
  // set. Never fabricate one here: pool/forward traffic must not impersonate
  // Codex CLI, per the metadata-integrity contract. (The backend's fast lane
  // keys on WS + originator, so callers without the tag simply keep their own
  // provenance and scheduling.)

  // A local refusal is not a failed upgrade and must never enter the SSE fallback path.
  try {
    beforeDispatch?.(new Headers(headers));
  } catch (error) {
    return Promise.reject(error);
  }
  let session: CodexWsSession;
  try {
    // Steering keeps a private physical connection across successor responses; it
    // must never enter the idle-socket pool or move to a different credential.
    const identity = control ? null : codexWsReuseIdentity(url, headers, frameText, proxy);
    session = (identity ? codexWsPool.acquire(identity, wsUrl, headers, proxy) : null)
      ?? new CodexWsSession(wsUrl, headers, false, undefined, proxy);
    if (!session.busy && !session.reserve()) {
      session.dispose();
      return sseFallback(url, init);
    }
  } catch {
    return sseFallback(url, init);
  }
  return codexWsExchange({
    session, url, init, prepared, sseFallback, onQuota, beforeDispatch,
    nativeControl: control,
    beforeContinuation,
    bunVersion: typeof runtime === "string" ? runtime : runtime.version,
  });
}
