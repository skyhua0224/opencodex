import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import { CODEX_RESPONSES_HTTP_URL } from "./codex-ws-request";
import { CODEX_WS_ID_MAX_BYTES } from "./codex-ws-correlation";
import { CodexWsSession } from "./codex-ws-session";

export const CODEX_WS_POOL_MAX_SESSIONS = 32;
export const CODEX_WS_POOL_IDLE_MS = 30_000;
export const CODEX_WS_POOL_MAX_AGE_MS = 5 * 60_000;
/**
 * Cross-turn reuse windows -- the socket survives the end of the turn that opened it.
 *
 * Turns in one conversation are close together: measured 2026-09-25 over two working sessions, the
 * median gap between one turn's response and the next request is 11s (1762 turns) and 26s (993
 * turns), with the vast majority under a minute. The original 30s idle window therefore already
 * matched most gaps; these wider windows deliberately cover the slow half of them and trade a
 * longer-lived socket against a slightly higher chance of handing back a socket the origin has
 * since retired. That risk is bounded by {@link CODEX_WS_CROSS_TURN_FIRST_FRAME_MS}, which gives
 * up on a silent reused socket long before the shared prelude bound would.
 */
export const CODEX_WS_CROSS_TURN_IDLE_MS = 60_000;
export const CODEX_WS_CROSS_TURN_MAX_AGE_MS = 10 * 60_000;
/** Default deadline for the FIRST inbound frame on a reused socket. Fresh-socket first-frame p50 is ~1.2s. */
export const CODEX_WS_CROSS_TURN_FIRST_FRAME_MS = 8_000;
/**
 * Breaker on the experiment itself: a run of reused-socket failures retires cross-turn reuse for a
 * while and lets the per-turn lifecycle (the proven path) take over. The feature must not be able
 * to make a working lane worse than it was before it existed.
 */
const CROSS_TURN_BREAKER_WINDOW = 8;
const CROSS_TURN_BREAKER_MIN_SAMPLES = 4;
const CROSS_TURN_BREAKER_FAILURE_RATE = 0.5;
const CROSS_TURN_BREAKER_COOLDOWN_MS = 30 * 60_000;
/**
 * Headers that may differ between two requests that still belong to ONE socket.
 *
 * Their values are per request, per turn, or per attempt, and none of them says anything about which
 * lane the socket is: the socket keeps whichever value the handshake carried, and the frames that
 * follow are independent of it.
 *
 *  - `x-codex-turn-state` / `x-codex-turn-metadata`: the conversation's state token and the
 *    per-turn metadata blob. Both change every turn by construction.
 *  - `x-oai-attestation`: a FRESH attestation per attempt. Measured 2026-09-25 on a real
 *    conversation: two attempts of the same turn, same `x-client-request-id`, and the attestation
 *    tag differed (`d2249cca` -> `b7b18efd`). While it was part of the key, no two attempts could
 *    ever agree on a socket, so neither the same-turn resend nor a cross-turn reuse could find one.
 *    It is also why the identity had to outgrow its 4 KiB per-field bound: the value is ~4170 bytes.
 *  - `x-client-request-id`: the client's id for ONE request (the proxy generates its own per
 *    request for the sidecar calls it makes, which is the same contract).
 */
const MUTABLE_HEADERS = new Set([
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-oai-attestation",
  "x-client-request-id",
]);
/**
 * A header value the identity has to accept, and how it enters the key.
 *
 * The key is a digest, so a long field does not have to fit anywhere: it may be hashed instead of
 * carried. Measured 2026-09-25: the Codex client's x-oai-attestation header runs to ~4170 bytes, and
 * the 4 KiB per-field bound this pool inherited from the response-id validator rejected it — which is
 * why the pool never saw a real turn, only the operator's own probes. Values stay in the key raw
 * while they are small (the common case, and the one that must stay byte-stable), and are replaced
 * by a digest of (name, value) past the limit.
 */
const IDENTITY_FIELD_RAW_LIMIT_BYTES = 1024;
/** Total budget for the immutable field set, so the digest input is bounded no matter the caller. */
const IDENTITY_FIELDS_TOTAL_LIMIT_BYTES = 256 * 1024;
let processKey: Buffer | undefined;
let poolSequence = 0;

/** Hashed turn label, so a reuse can be classified without holding a turn id in memory. */
function turnToken(account: string, thread: string, turn: string): string {
  return digest(["turn", account, thread, turn]);
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "off", "no"].includes(normalized);
}

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 250 && parsed <= 600_000 ? Math.floor(parsed) : fallback;
}

const crossTurnOutcomes: boolean[] = [];
let crossTurnBreakerUntil = 0;
let crossTurnTrips = 0;
let crossTurnReuses = 0;

/**
 * True while a socket may be handed to the NEXT turn of the same conversation.
 *
 * OFF unless the operator asks for it (`OCX_WS_CROSS_TURN_REUSE=1`), and off while the breaker is
 * open. Measured 2026-09-25: on a day when the official origin was answering in 17-76s, the
 * first-frame deadline below could not tell a retired socket from a slow origin, so it abandoned
 * sockets that would have answered and added 8s + 5s to those turns. The per-turn lifecycle never
 * has to make that call, which is why this stays an experiment rather than a default.
 *
 * The check is read per call, so both switches take effect on the next turn without a restart.
 */
export function codexWsCrossTurnReuseEnabled(): boolean {
  return envFlag("OCX_WS_CROSS_TURN_REUSE", false) && Date.now() >= crossTurnBreakerUntil;
}

export function codexWsCrossTurnFirstFrameMs(): number {
  return envMs("OCX_WS_CROSS_TURN_FIRST_FRAME_MS", CODEX_WS_CROSS_TURN_FIRST_FRAME_MS);
}

export interface CodexWsCrossTurnStats {
  /** Cross-turn reuse is currently allowed. */
  enabled: boolean;
  /** Operator switch only, ignoring the breaker. */
  configured: boolean;
  /** Epoch ms the breaker reopens reuse; 0 when it has never tripped. */
  breakerUntil: number;
  attempts: number;
  failures: number;
  reuses: number;
  trips: number;
}

export function codexWsCrossTurnStats(): CodexWsCrossTurnStats {
  return {
    enabled: codexWsCrossTurnReuseEnabled(),
    configured: envFlag("OCX_WS_CROSS_TURN_REUSE", false),
    breakerUntil: crossTurnBreakerUntil,
    attempts: crossTurnOutcomes.length,
    failures: crossTurnOutcomes.filter(ok => !ok).length,
    reuses: crossTurnReuses,
    trips: crossTurnTrips,
  };
}

/** Test seam: forget the breaker history. */
export function resetCodexWsCrossTurnState(): void {
  crossTurnOutcomes.length = 0;
  crossTurnBreakerUntil = 0;
  crossTurnTrips = 0;
  crossTurnReuses = 0;
}

function wsReuseLedgerPath(): string {
  return join(getConfigDir(), "ws-reuse.jsonl");
}

/**
 * Diagnostic only: `OCX_WS_REUSE_DEBUG=1` records why one identity keys the way it does.
 *
 * The reuse key is a digest over the outgoing headers, so a per-turn header splits it invisibly.
 * This line names every header the key still depends on, with its VALUE hashed: enough to see which
 * field moved between two turns of one conversation, and never enough to read one.
 */
function noteIdentityDebug(entry: Record<string, unknown>): void {
  if (process.env.OCX_WS_REUSE_DEBUG !== "1") return;
  noteWsReuse({ event: "identity", ...entry });
}

/** Evidence, not correctness: a full disk must never break a turn. */
function noteWsReuse(entry: Record<string, unknown>): void {
  try {
    const path = wsReuseLedgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch { /* evidence, not correctness */ }
}

export interface CodexWsCrossTurnDetail {
  /** Hashed conversation label: never a thread id, never a turn id. */
  scope?: string | undefined;
  reason?: string | undefined;
  firstFrameMs?: number | null | undefined;
  elapsedMs?: number | null | undefined;
  closeCode?: number | null | undefined;
}

/**
 * Record how one cross-turn reuse ended and, on a run of failures, open the breaker.
 *
 * Only reused sockets are reported here; the per-turn lifecycle stays exactly as it was.
 */
export function noteCodexWsCrossTurnResult(ok: boolean, detail: CodexWsCrossTurnDetail = {}): void {
  crossTurnOutcomes.push(ok);
  if (crossTurnOutcomes.length > CROSS_TURN_BREAKER_WINDOW) crossTurnOutcomes.shift();
  noteWsReuse({ event: ok ? "cross-turn-ok" : "cross-turn-fail", ...detail });
  if (ok) return;
  const attempts = crossTurnOutcomes.length;
  const failures = crossTurnOutcomes.filter(value => !value).length;
  if (attempts < CROSS_TURN_BREAKER_MIN_SAMPLES || failures / attempts <= CROSS_TURN_BREAKER_FAILURE_RATE) return;
  if (!codexWsCrossTurnReuseEnabled()) return;
  crossTurnBreakerUntil = Date.now() + CROSS_TURN_BREAKER_COOLDOWN_MS;
  crossTurnTrips += 1;
  noteWsReuse({ event: "cross-turn-breaker-open", attempts, failures,
    cooldownMin: Math.round(CROSS_TURN_BREAKER_COOLDOWN_MS / 60_000) });
  console.warn("[opencodex] ws pool: cross-turn reuse paused for "
    + Math.round(CROSS_TURN_BREAKER_COOLDOWN_MS / 60_000) + "min after " + failures + "/" + attempts
    + " reused sockets failed to serve their turn - back to one socket per turn");
}

export interface CodexWsReuseIdentity { key: string; scope: string; turn: string }
function value(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value) <= CODEX_WS_ID_MAX_BYTES;
}
/** Usable as an identity input: non-empty, printable, and of any length. */
function usableField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function digest(input: unknown): string {
  processKey ??= randomBytes(32);
  return createHmac("sha256", processKey).update(JSON.stringify(input)).digest("hex");
}

/** Identity comes from the selected outgoing request, never a model label or caller hint. */
export function codexWsReuseIdentity(url: string, headers: Record<string, string>, frameText: string, proxy?: string): CodexWsReuseIdentity | null {
  // Every refusal below is named for the debug ledger: "the pool never sees this traffic" is
  // otherwise indistinguishable from "the pool saw it and the key changed".
  const refuse = (reason: string): null => { noteIdentityDebug({ reason }); return null; };
  if (url !== CODEX_RESPONSES_HTTP_URL) return refuse("not-canonical");
  let body: unknown;
  try { body = JSON.parse(frameText); } catch { return refuse("unparsable-frame"); }
  if (!record(body) || !record(body.client_metadata)) return refuse("no-client-metadata");
  // Reuse complete HTTP creates only. Cache-dependent continuation, warmup and
  // named WS lanes need a different lifecycle/recovery contract.
  if (body.previous_response_id != null || Object.hasOwn(body, "stream_id")
    || Object.hasOwn(body, "generate") || body.background === true) return refuse("continuation-or-background");
  const metadata = body.client_metadata;
  const bodyThread = metadata.thread_id;
  const headerThread = headers["thread-id"];
  if (bodyThread !== undefined && !value(bodyThread)) return refuse("bad-body-thread");
  if (headerThread !== undefined && !value(headerThread)) return refuse("bad-header-thread");
  if (bodyThread !== undefined && headerThread !== undefined && bodyThread !== headerThread) return refuse("thread-mismatch");
  const thread = bodyThread ?? headerThread;
  const turn = metadata.turn_id;
  const account = headers["chatgpt-account-id"];
  const authorization = headers.authorization;
  if (![thread, turn, account, authorization, body.model].every(value)) return refuse("missing-identity-field");
  if (body.service_tier !== undefined && !value(body.service_tier)) return refuse("bad-service-tier");
  const immutable = Object.entries(headers).filter(([name]) => !MUTABLE_HEADERS.has(name)).sort(([a], [b]) => a.localeCompare(b));
  if (immutable.length > 128) return refuse("immutable-count:" + immutable.length);
  // Name and size only: a header value never reaches the debug ledger, not even hashed.
  const unusable = immutable.find(([, field]) => !usableField(field));
  if (unusable) {
    const bytes = Buffer.byteLength(unusable[1]);
    const control = /[\u0000-\u001f\u007f]/.test(unusable[1]);
    return refuse("immutable-value:" + unusable[0] + ":" + bytes + "b" + (control ? ":control" : ":empty"));
  }
  const immutableBytes = immutable.reduce((bytes, [name, field]) => bytes + Buffer.byteLength(name) + Buffer.byteLength(field), 0);
  if (immutableBytes > IDENTITY_FIELDS_TOTAL_LIMIT_BYTES) return refuse("immutable-bytes:" + immutableBytes);
  // The scope is the conversation the socket belongs to; the turn is the request that opened it.
  // Cross-turn reuse keys the scope WITHOUT the turn, so the next turn of the same conversation
  // finds the socket the previous one left idle. The turn stays in the identity either way: it is
  // what lets a reuse be classified as cross-turn, and it is what keeps the two lifecycles apart
  // when the feature is off or the breaker is open.
  const crossTurn = codexWsCrossTurnReuseEnabled();
  const scope = crossTurn ? digest([url, account, thread]) : digest([url, account, thread, turn]);
  const lite = metadata.ws_request_header_x_openai_internal_codex_responses_lite;
  if (lite !== undefined && lite !== "true" && lite !== "false") return refuse("bad-lite-flag");
  const identity = {
    scope,
    turn: turnToken(account, thread, turn),
    key: digest([scope, authorization, body.model, body.service_tier ?? null, lite ?? null,
      immutable.map(([name, field]) => [name,
        Buffer.byteLength(field) <= IDENTITY_FIELD_RAW_LIMIT_BYTES ? field : digest(["field", name, field])]),
      proxy ?? null]),
  };
  noteIdentityDebug({
    thread: scope.slice(0, 8),
    turn: identity.turn.slice(0, 8),
    key: identity.key.slice(0, 8),
    model: body.model,
    tier: body.service_tier ?? null,
    lite: lite ?? null,
    headers: Object.fromEntries(immutable.map(([name, field]) => [name, digest([name, field]).slice(0, 8)])),
  });
  return identity;
}

interface Entry {
  identity: CodexWsReuseIdentity;
  session: CodexWsSession;
  createdAt: number;
  idleAt: number;
  retired: boolean;
  /** True when the socket was opened while cross-turn reuse was on, so it uses the wider windows. */
  crossTurn: boolean;
}
interface PoolOptions {
  now?: () => number;
  maxSessions?: number;
  idleMs?: number;
  maxAgeMs?: number;
  crossTurnIdleMs?: number;
  crossTurnMaxAgeMs?: number;
}

/** Bounded retained sockets only. Busy/capacity misses keep the existing one-shot path. */
export class CodexWsPool {
  private readonly entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  private detachShutdown?: () => void;
  private readonly hookKey = `codex-upstream-ws-pool-${++poolSequence}`;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private readonly maxAgeMs: number;
  private readonly crossTurnIdleMs: number;
  private readonly crossTurnMaxAgeMs: number;
  constructor(options: PoolOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? CODEX_WS_POOL_MAX_SESSIONS;
    this.idleMs = options.idleMs ?? CODEX_WS_POOL_IDLE_MS;
    this.maxAgeMs = options.maxAgeMs ?? CODEX_WS_POOL_MAX_AGE_MS;
    this.crossTurnIdleMs = options.crossTurnIdleMs ?? CODEX_WS_CROSS_TURN_IDLE_MS;
    this.crossTurnMaxAgeMs = options.crossTurnMaxAgeMs ?? CODEX_WS_CROSS_TURN_MAX_AGE_MS;
  }

  /**
   * Retention windows follow the entry, not the pool: a socket opened for one turn keeps the
   * per-turn windows unless cross-turn reuse was on when it was opened. Flipping the feature (or
   * tripping its breaker) therefore never changes the lifetime of sockets that already exist.
   */
  private windows(entry: Pick<Entry, "crossTurn">): { idleMs: number; maxAgeMs: number } {
    return entry.crossTurn
      ? { idleMs: this.crossTurnIdleMs, maxAgeMs: this.crossTurnMaxAgeMs }
      : { idleMs: this.idleMs, maxAgeMs: this.maxAgeMs };
  }

  acquire(identity: CodexWsReuseIdentity, url: string, headers: Record<string, string>, proxy?: string): CodexWsSession | null {
    this.sweep();
    for (const entry of this.entries.values()) {
      if (entry.identity.scope !== identity.scope || entry.identity.key === identity.key) continue;
      entry.retired = true;
      if (!entry.session.busy) this.remove(entry);
    }
    const existing = this.entries.get(identity.key);
    if (existing) {
      if (existing.retired || existing.session.busy) {
        noteIdentityDebug({ event: "pool-acquire", hit: false, scope: identity.scope.slice(0, 8),
          reason: existing.retired ? "retired" : "busy", size: this.entries.size });
        return null;
      }
      // Handing a socket to a later turn is the experiment: label it on the session so every
      // settle that follows can be attributed, and give the exchange a bounded window to hear
      // anything at all before it gives up and the ladder dials a fresh one.
      if (existing.identity.turn !== identity.turn) {
        crossTurnReuses += 1;
        const idleMs = Math.max(0, this.now() - existing.idleAt);
        const ageMs = Math.max(0, this.now() - existing.createdAt);
        existing.session.markCrossTurnReuse();
        noteWsReuse({ event: "cross-turn-reuse", scope: identity.scope.slice(0, 8), idleMs, ageMs });
      }
      if (existing.session.reserve()) {
        noteIdentityDebug({ event: "pool-acquire", hit: true, scope: identity.scope.slice(0, 8),
          sameTurn: existing.identity.turn === identity.turn, exchanges: existing.session.reused });
        this.arm();
        return existing.session;
      }
      noteIdentityDebug({ event: "pool-acquire", hit: false, scope: identity.scope.slice(0, 8),
        reason: "reserve-failed", size: this.entries.size });
      this.remove(existing);
    } else {
      noteIdentityDebug({ event: "pool-acquire", hit: false, scope: identity.scope.slice(0, 8),
        reason: "no-entry", size: this.entries.size });
    }
    if (this.entries.size >= this.maxSessions) {
      const oldest = [...this.entries.values()].filter(entry => !entry.session.busy).sort((a, b) => a.idleAt - b.idleAt)[0];
      if (!oldest) return null;
      this.remove(oldest);
    }
    const createdAt = this.now();
    const session = new CodexWsSession(url, headers, true, () => this.changed(entry), proxy);
    session.onLifecycle = event => noteIdentityDebug({ ...event, scope: identity.scope.slice(0, 8) });
    const entry: Entry = {
      identity, session, createdAt, idleAt: createdAt, retired: false,
      crossTurn: codexWsCrossTurnReuseEnabled(),
    };
    session.reserve();
    this.entries.set(identity.key, entry);
    this.detachShutdown ??= registerOptionalShutdownHook(this.hookKey, () => this.dispose());
    return session;
  }

  private changed(entry: Entry): void {
    if (this.entries.get(entry.identity.key) !== entry) return;
    if (entry.session.closed) this.entries.delete(entry.identity.key);
    else if (!entry.session.busy) {
      entry.idleAt = this.now();
      if (entry.retired || entry.idleAt - entry.createdAt >= this.windows(entry).maxAgeMs) this.remove(entry);
    }
    this.arm();
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.identity.key) === entry) this.entries.delete(entry.identity.key);
    entry.session.dispose(new Error("codex websocket retained session expired"));
    this.arm();
  }

  sweep(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      const { idleMs, maxAgeMs } = this.windows(entry);
      if (!entry.session.busy && (entry.session.closed || entry.retired
        || now - entry.idleAt >= idleMs || now - entry.createdAt >= maxAgeMs)) this.remove(entry);
    }
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.entries.size) {
      this.detachShutdown?.();
      this.detachShutdown = undefined;
      return;
    }
    let deadline = Infinity;
    for (const entry of this.entries.values()) if (!entry.session.busy) {
      const { idleMs, maxAgeMs } = this.windows(entry);
      deadline = Math.min(deadline, entry.idleAt + idleMs, entry.createdAt + maxAgeMs);
    }
    if (!Number.isFinite(deadline)) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.sweep(); }, Math.max(1, deadline - this.now()));
    this.timer.unref?.();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.detachShutdown?.();
    this.detachShutdown = undefined;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.session.dispose(new DOMException("codex websocket pool shutdown", "AbortError"));
  }

  snapshot(): { size: number; active: number; timer: boolean } {
    return { size: this.entries.size, active: [...this.entries.values()].filter(entry => entry.session.busy).length, timer: this.timer !== undefined };
  }
}

export const codexWsPool = new CodexWsPool();
