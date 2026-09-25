/**
 * What the origin actually served, and where the time went.
 *
 * Two jobs, both of them "the proxy should have said something" problems:
 *
 * 1. Attestation. Three things can change under a request without any error -- the origin reports a
 *    different model than the one asked for, it answers on a lower service tier than the one
 *    configured, or its safety buffer announces that it may serve the turn on a faster model. Every
 *    one of them used to leave no trace.
 * 2. Link and latency. Whether this lane ever sees the edge's routing cookies (the load balancer
 *    affinity pair), whether the client sends any, and how a turn's time splits between our own
 *    queueing, the origin's headers, the first content frame and the tail. A conversation that sits
 *    on a bad node for minutes is invisible without the first; "the proxy feels slow" is
 *    unattributable without the second.
 *
 * Nothing here rewrites a response or raises an error. Findings go to
 * `~/.opencodex/model-attestation.jsonl`, the cookie link of every guarded request to
 * `~/.opencodex/cookie-link.jsonl` (including the boring ones -- a ledger that only keeps positives
 * cannot answer "does this lane ever see them"), and slow turns to `~/.opencodex/latency.jsonl`.
 * Cookie VALUES are never written: only names, counts, and a short hash of the affinity pair, so a
 * reader can tell whether the pair is stable across requests without holding the token.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";

export type AttestationKind = "model-mismatch" | "tier-downgrade" | "safety-buffering";

export interface AttestationFinding {
  kind: AttestationKind;
  /** One line an operator can read without opening the ledger. */
  detail: string;
  /** What the origin said, when the finding is about a value it reported. */
  reported?: string;
}

export interface ResponseAttestationOptions {
  /** The model this proxy asked for. */
  requestedModel: string;
  /** The tier this proxy configured (fastMode / client service_tier), when there is one. */
  configuredTier?: string | undefined;
  provider?: string | undefined;
  /** Conversation key, so a finding can be pinned to the session it happened in. */
  lane?: string | undefined;
  /** Called for every finding, so the caller can also put it on the request log. */
  onFinding?: (finding: AttestationFinding) => void;
  /** Which transport carried this turn: the WebSocket lane has no HTTP headers at all. */
  transport?: "ws" | "http" | undefined;
  /** True when the client itself sent a Cookie header on this request. */
  clientSentCookie?: boolean | undefined;
  /** Timing marks the caller measured: function entry, and immediately before the upstream send. */
  timing?: { dispatchStartedAt: number; sendStartedAt: number } | undefined;
  /** A turn at or above this many milliseconds also gets a latency line. Default 20s. */
  slowTurnMs?: number | undefined;
}

const TIER_RANK: Readonly<Record<string, number>> = { flex: 0, auto: 1, default: 1, priority: 2, scale: 2, fast: 2 };

/** The edge's load-balancer affinity pair, by name only. */
const ROUTING_COOKIE_NAMES: readonly string[] = ["__cf" + "lb", "__oai" + "lb"];

function ledgerPath(): string {
  return join(getConfigDir(), "model-attestation.jsonl");
}

function cookieLedgerPath(): string {
  return join(getConfigDir(), "cookie-link.jsonl");
}

function latencyLedgerPath(): string {
  return join(getConfigDir(), "latency.jsonl");
}

function appendLine(path: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    /* evidence, not correctness: a full disk must not break a turn */
  }
}

function record(entry: Record<string, unknown>): void {
  appendLine(ledgerPath(), entry);
}

/** Compare two model ids the way a proxy must: exact after case folding and suffix trimming. */
function sameModel(requested: string, reported: string): boolean {
  const norm = (value: string) => value.trim().toLowerCase().replace(/-latest$/, "");
  return norm(requested) === norm(reported);
}

function framePayload(frame: string): Record<string, unknown> | undefined {
  const dataLine = frame.split("\n").filter(line => line.startsWith("data:")).pop();
  if (!dataLine) return undefined;
  try {
    const parsed = JSON.parse(dataLine.slice(5).trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function sseSplit(text: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = text;
  for (;;) {
    const lf = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    const boundary = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf;
    const width = boundary === crlf && crlf >= 0 ? 4 : 2;
    if (boundary < 0) return { frames, rest };
    frames.push(rest.slice(0, boundary + width));
    rest = rest.slice(boundary + width);
  }
}

/** Prelude frames carry no content: they describe the response that is about to start. */
function isPreludeFrame(payload: Record<string, unknown>): boolean {
  const type = typeof payload.type === "string" ? payload.type : "";
  return type === "response.created" || type === "response.in_progress" || type.startsWith("codex.");
}

function securityBufferFinding(headers: Headers): AttestationFinding | undefined {
  const enabled = (headers.get("x-codex-safety-buffering-enabled") ?? "").trim().toLowerCase();
  const faster = (headers.get("x-codex-safety-buffering-faster-model") ?? "").trim();
  if (enabled !== "true" && faster === "") return undefined;
  return {
    kind: "safety-buffering",
    detail: faster
      ? `origin announced a safety buffer that can serve this turn on ${faster}`
      : "origin announced a safety buffer for this turn",
    ...(faster ? { reported: faster } : {}),
  };
}

function tierFinding(configuredTier: string | undefined, reported: string): AttestationFinding | undefined {
  const configured = (configuredTier ?? "").trim().toLowerCase();
  const actual = reported.trim().toLowerCase();
  if (!configured || !actual) return undefined;
  const expected = TIER_RANK[configured];
  const served = TIER_RANK[actual];
  if (expected === undefined || served === undefined) return undefined;
  if (expected === TIER_RANK.auto) return served >= TIER_RANK.auto ? undefined : { kind: "tier-downgrade", detail: `configured auto was served as ${actual}`, reported: actual };
  if (served >= expected) return undefined;
  return { kind: "tier-downgrade", detail: `configured ${configured} was served as ${actual}`, reported: actual };
}

function report(options: ResponseAttestationOptions, finding: AttestationFinding): void {
  record({
    kind: finding.kind,
    provider: options.provider,
    lane: options.lane,
    requestedModel: options.requestedModel,
    configuredTier: options.configuredTier,
    reported: finding.reported,
    detail: finding.detail,
  });
  console.warn("[attestation] " + finding.kind + ": " + finding.detail
    + (options.provider ? " (provider " + options.provider : "")
    + (options.lane ? ", lane " + options.lane.slice(0, 8) : "")
    + (options.provider ? ")" : ""));
  try { options.onFinding?.(finding); } catch { /* observation must not break a turn */ }
}

/** Names only, plus a stable tag of the pair: values are session tokens and are never written. */
function cookieShape(setCookies: readonly string[]): { names: string[]; routing: string[]; pairTag?: string } {
  const names: string[] = [];
  const routing: string[] = [];
  const routingPairs: string[] = [];
  for (const raw of setCookies) {
    const name = raw.split("=", 1)[0]?.trim();
    if (!name) continue;
    names.push(name);
    if (!ROUTING_COOKIE_NAMES.includes(name)) continue;
    routing.push(name);
    const value = raw.slice(name.length + 1).split(";", 1)[0] ?? "";
    routingPairs.push(name + "=" + value);
  }
  const pairTag = routingPairs.length > 0
    ? createHash("sha1").update(routingPairs.slice().sort().join("|")).digest("hex").slice(0, 12)
    : undefined;
  return { names, routing, ...(pairTag ? { pairTag } : {}) };
}

/**
 * Record one request's link: what the client sent, what the origin handed back.
 *
 * Written for EVERY guarded request. The question this answers is "does this lane ever see the
 * affinity pair at all", and a ledger that keeps only the interesting rows cannot answer a question
 * about the absence of something.
 */
export function observeCookieLink(
  response: Response,
  options: { transport?: "ws" | "http" | undefined; clientSentCookie?: boolean | undefined; lane?: string | undefined; provider?: string | undefined; model?: string | undefined },
): void {
  const setCookies = typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
    : (response.headers.get("set-" + "cookie") ? [response.headers.get("set-" + "cookie") as string] : []);
  const shape = cookieShape(setCookies);
  appendLine(cookieLedgerPath(), {
    provider: options.provider,
    lane: options.lane,
    model: options.model,
    transport: options.transport,
    clientSentCookie: options.clientSentCookie === true,
    setCookieCount: setCookies.length,
    setCookieNames: shape.names.slice(0, 8),
    routingNames: shape.routing,
    pairTag: shape.pairTag,
  });
}

/** One line per slow turn: where the time went, in the caller's own marks. */
export function recordSlowTurn(entry: {
  provider?: string | undefined;
  lane?: string | undefined;
  model?: string | undefined;
  queueMs: number;
  headersMs: number;
  firstContentMs?: number | undefined;
  totalMs: number;
  outcome: string;
}): void {
  appendLine(latencyLedgerPath(), entry);
  console.warn("[latency] " + (entry.provider ?? "?") + "/" + (entry.model ?? "?")
    + " queue=" + entry.queueMs + "ms headers=" + entry.headersMs + "ms"
    + (entry.firstContentMs === undefined ? "" : " first=" + entry.firstContentMs + "ms")
    + " total=" + entry.totalMs + "ms (" + entry.outcome + ")"
    + (entry.lane ? " lane " + entry.lane.slice(0, 8) : ""));
}

/**
 * Wrap a Responses stream so everything the origin attests to is recorded once per request.
 *
 * Only SSE bodies are watched (a JSON body names its model differently and is not a turn), and the
 * bytes are passed through untouched: this is an observer, not a rewriter.
 */
export function withResponseAttestation(response: Response, options: ResponseAttestationOptions): Response {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const slowTurnMs = options.slowTurnMs ?? 20_000;
  const startedAt = options.timing?.sendStartedAt ?? Date.now();
  const queueMs = options.timing ? Math.max(0, options.timing.sendStartedAt - options.timing.dispatchStartedAt) : 0;
  const headersMs = Math.max(0, Date.now() - startedAt);
  observeCookieLink(response, {
    clientSentCookie: options.clientSentCookie,
    lane: options.lane,
    provider: options.provider,
    model: options.requestedModel,
    transport: options.transport,
  });
  const buffer = securityBufferFinding(response.headers);
  const headerModel = (response.headers.get("openai-model") ?? "").trim();
  if (!response.body || !contentType.includes("text/event-stream")) {
    if (buffer) report(options, buffer);
    if (headerModel && !sameModel(options.requestedModel, headerModel)) {
      report(options, { kind: "model-mismatch", detail: "asked for " + options.requestedModel + ", origin header says " + headerModel, reported: headerModel });
    }
    return response;
  }
  if (buffer) report(options, buffer);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let modelChecked = false;
  let tierChecked = false;
  let firstContentMs: number | undefined;
  let settled = false;
  const settle = (outcome: string): void => {
    if (settled) return;
    settled = true;
    const totalMs = Math.max(0, Date.now() - startedAt);
    if (totalMs < slowTurnMs && headersMs < slowTurnMs / 2) return;
    recordSlowTurn({
      provider: options.provider, lane: options.lane, model: options.requestedModel,
      queueMs, headersMs, firstContentMs, totalMs, outcome,
    });
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) {
          settle("completed");
          try { controller.close(); } catch { /* consumer already gone */ }
          return;
        }
        const chunk = next.value!;
        try { controller.enqueue(chunk); } catch (error) { throw error; }
        if (modelChecked && tierChecked && firstContentMs !== undefined) continue;
        pending += decoder.decode(chunk, { stream: true });
        const split = sseSplit(pending);
        pending = split.rest;
        for (const frame of split.frames) {
          const payload = framePayload(frame);
          if (!payload) continue;
          const responseRecord = payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
            ? payload.response as Record<string, unknown>
            : undefined;
          if (firstContentMs === undefined && !isPreludeFrame(payload)) {
            firstContentMs = Math.max(0, Date.now() - startedAt);
          }
          const reportedModel = typeof payload.model === "string" ? payload.model
            : typeof responseRecord?.model === "string" ? responseRecord.model as string : undefined;
          if (!modelChecked && reportedModel) {
            modelChecked = true;
            if (!sameModel(options.requestedModel, reportedModel)) {
              report(options, { kind: "model-mismatch", detail: "asked for " + options.requestedModel + ", origin answered as " + reportedModel, reported: reportedModel });
            }
          }
          const reportedTier = typeof payload.service_tier === "string" ? payload.service_tier
            : typeof responseRecord?.service_tier === "string" ? responseRecord.service_tier as string : undefined;
          if (!tierChecked && reportedTier) {
            tierChecked = true;
            const finding = tierFinding(options.configuredTier, reportedTier);
            if (finding) report(options, finding);
          }
        }
      }
    },
    cancel(reason) { settle("cancelled"); return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
}

/** Test seams: read back the ledgers a suite just wrote. */
export function attestationLedgerPath(): string { return ledgerPath(); }
export function cookieLinkLedgerPath(): string { return cookieLedgerPath(); }
export function latencyLedgerPathForTests(): string { return latencyLedgerPath(); }
