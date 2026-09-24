/**
 * Record what the origin actually served, so a silent substitution stops being invisible.
 *
 * Three things can change under a request without any error: the origin reports a different model
 * than the one asked for, it answers on a lower service tier than the one configured, or its
 * safety buffer announces that it moved the turn to a faster model. None of them raise an error,
 * and until this module existed none of them left a trace either -- the tier only reached
 * usage.jsonl (for cost), the safety hint was forwarded to the client and dropped, and a model
 * mismatch was never looked at.
 *
 * Findings go to `~/.opencodex/model-attestation.jsonl` (one JSON object per line, append-only) plus
 * a single warning line per request. The ledger is what `ocx-tiers` reads; the warning is what an
 * operator watching the log notices. Nothing here changes a response: the body is passed through
 * byte for byte, and a mismatch never rewrites the model the client asked for.
 */
import { appendFileSync, mkdirSync } from "node:fs";
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
}

const TIER_RANK: Readonly<Record<string, number>> = { flex: 0, auto: 1, default: 1, priority: 2, scale: 2, fast: 2 };

function ledgerPath(): string {
  return join(getConfigDir(), "model-attestation.jsonl");
}

function record(entry: Record<string, unknown>): void {
  try {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    /* the ledger is evidence, not correctness: a full disk must not break a turn */
  }
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
  // `auto` is a request for "you decide", so anything at or above default satisfies it.
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
  console.warn(`[attestation] ${finding.kind}: ${finding.detail}`
    + (options.provider ? ` (provider ${options.provider}` : "")
    + (options.lane ? `, lane ${options.lane.slice(0, 8)}` : "")
    + (options.provider ? ")" : ""));
  try { options.onFinding?.(finding); } catch { /* observation must not break a turn */ }
}

/**
 * Wrap a Responses stream so everything the origin ATTESTS to is recorded once per request.
 *
 * Only SSE bodies are watched (a JSON body names its model differently and is not a turn), and the
 * bytes are passed through untouched: this is an observer, not a rewriter.
 */
export function withResponseAttestation(response: Response, options: ResponseAttestationOptions): Response {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const buffer = securityBufferFinding(response.headers);
  const headerModel = (response.headers.get("openai-model") ?? "").trim();
  if (!response.body || !contentType.includes("text/event-stream")) {
    if (buffer) report(options, buffer);
    if (headerModel && !sameModel(options.requestedModel, headerModel)) {
      report(options, { kind: "model-mismatch", detail: `asked for ${options.requestedModel}, origin header says ${headerModel}`, reported: headerModel });
    }
    return response;
  }
  if (buffer) report(options, buffer);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let modelChecked = false;
  let tierChecked = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) {
          try { controller.close(); } catch { /* consumer already gone */ }
          return;
        }
        const chunk = next.value!;
        try { controller.enqueue(chunk); } catch (error) { throw error; }
        if (modelChecked && tierChecked) continue;
        pending += decoder.decode(chunk, { stream: true });
        const split = sseSplit(pending);
        pending = split.rest;
        for (const frame of split.frames) {
          const payload = framePayload(frame);
          if (!payload) continue;
          const responseRecord = payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
            ? payload.response as Record<string, unknown>
            : undefined;
          const reportedModel = typeof payload.model === "string" ? payload.model
            : typeof responseRecord?.model === "string" ? responseRecord.model as string : undefined;
          if (!modelChecked && reportedModel) {
            modelChecked = true;
            if (!sameModel(options.requestedModel, reportedModel)) {
              report(options, { kind: "model-mismatch", detail: `asked for ${options.requestedModel}, origin answered as ${reportedModel}`, reported: reportedModel });
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
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
}

/** Test seam: read back the ledger a suite just wrote. */
export function attestationLedgerPath(): string {
  return ledgerPath();
}
