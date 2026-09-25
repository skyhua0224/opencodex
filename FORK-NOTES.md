# skyhua's opencodex fork — hardening notes

A fork of **opencodex 2.63.0** (MIT, upstream: <https://github.com/lidge-jun/opencodex>) with a
set of hardening patches written against the ChatGPT Codex backend as it behaves in practice:
capacity verdicts that arrive *after* a request is accepted, relays that answer 429/403 in
provider-specific shapes, panel quota that only exists in a web console, and WebSocket lanes that
quietly degrade per conversation.

Everything below was measured on a live multi-provider setup in September 2026 and verified with
the self-tests in [`test/`](test/) (run them with `bun test/<name>.ts` from a clone).

## What this fork changes

### 1. Combo ladders stop failing the whole turn on one row's answer

- A ladder no longer stops when a single row refuses to replay an ambiguous reset; it walks on
  (bounded), because one relay's connection reset says nothing about the other fifteen rows.
- A capacity verdict parks **only the official OpenAI row** on an escalating hold
  (10m → 1h → 3h → 6h → 12h → 24h). Relays keep plain failover + a short breaker and recover on
  their own.
- Quota-exhausted sites are skipped rather than treated as walls, and resume the moment the panel
  reports them back.
- When every row fails for a channel-shaped reason the ladder answers `503 combo_unavailable` with
  `Retry-After` instead of handing the client a bare 429 (the Codex client answers a 429 by giving
  up on the turn).
- A degenerate-output breaker: repeated segments, repeated tool-call signatures and zlib ratio are
  measured on the first 4 KB of client-visible output; a row that loops is parked for two minutes
  instead of being disabled.

### 2. Capacity verdicts never reach the client on the official lane

The ChatGPT backend declines in several different ways, and each one used to surface as
"Selected model is at capacity. Please try a different model." Four layers now handle it:

| layer | when | file |
| --- | --- | --- |
| paced resend ladder 5s/12s/25s/45s | a 502/503/504 status on the canonical row | `src/lib/upstream-retry.ts` |
| WebSocket prelude hold + in-socket resend (1.5s/4s) | a decline after `response.created`, before content | `src/server/responses/codex-ws-exchange.ts` |
| replayable 503 for a declined create | the socket cannot be reused after a decline | `src/server/responses/codex-ws-wire.ts` |
| SSE prelude hold + splice retry | a 200 whose *body* carries the decline | `src/lib/sse-prelude-retry.ts` |

A decline after content has already been delivered is passed through untouched: a resend there
would generate a second answer for the same turn.

### 3. Transport behaviour per conversation

- `src/server/ws-thread-transport.ts` (new): a conversation that keeps collecting overload
  verdicts steps off the WebSocket lane for a while (threshold 6 verdicts / 10 min, escalating
  holds), and its **routing identity is re-rolled** — the client's `x-codex-window-id` and the
  server-issued `x-codex-turn-state` are dropped for that conversation for six hours (persisted, so
  a restart does not undo it). Nothing else about the request changes.
- `src/server/turn-state-observer.ts` (new): read-only observation of `x-codex-turn-state` in both
  directions, off with `OCX_TURN_STATE_OBSERVER=0`.

### 4. Provider quota that only exists in a web panel

- Panel-family quota (`/api/v1/subscriptions/active`, `/subscriptions/progress`, `/keys`) feeds the
  router: custom windows (a daily cap, or a daily window the panel resets itself) count as verdicts,
  epoch-seconds reset stamps are normalized, and `>= 100%` means exhausted.

### 5. Model catalog and management surface

- `gpt-6` family entries in `src/codex/data/upstream-models.json`.
- Provider fields that the management API can write: `retryOnReset`, transient-5xx policy,
  per-model reasoning efforts, context windows and input modalities.
- Combo management routes for the strategies above.

## Install

```bash
git clone <this repo> opencodex
cd opencodex
npm install -g .        # or: bun install -g .
ocx setup               # then: ocx start
```

## Relationship to upstream, and how to rebase

- This fork tracks upstream **2.63.0**. `patches/` contains the same change set as a patch file
  that applies to a pristine 2.63.0 tree (`patch -p1 < patches/opencodex-2.63.0-capacity-complete-20260924.patch`),
  which is the fastest way to carry the work forward onto a newer upstream release.
- Upstream is not affiliated with this fork; bug reports about the hardening work belong here, and
  anything about opencodex itself belongs upstream.
- License: MIT, unchanged, with the original copyright notice (see `LICENSE`).

### 6. Observability: what the origin actually served

- **Repetition guard for native sessions** (`guardNativeDegenerateOutput` in
  `src/server/responses/combo-degenerate-output.ts`). Until this existed only combo children were
  watched for degenerate output; a session calling a provider directly relayed the loop to the client
  until it gave up. The same monitor now wraps directly-routed streams: repeat ratio, longest repeated
  segment, zlib ratio and identical tool-call signatures are measured on client-visible text, and a
  verdict cuts the stream with `response.failed` / code `degenerate_output`. A native turn has no second
  row, so the failover is the client's retry; the verdict is also remembered per conversation
  (`takeLaneDegenerateVerdict`), so a combo serving that conversation afterwards demotes the row the
  loop came from.
- **Attestation** (`src/lib/response-attestation.ts`) records three things that never raise an error:
  the model the origin says it answered as (`response.model` / `openai-model`) against the one
  requested, the service tier it reports against the configured one, and the safety-buffer headers
  (`x-codex-safety-buffering-enabled` / `-faster-model`). Findings go to
  `~/.opencodex/model-attestation.jsonl` (one JSON object per line) plus one warning per request. The
  body is passed through byte for byte.
- **`ocx-tiers`** (`tools/ocx-tiers.py`) reads `usage.jsonl` and that ledger: configured-versus-served
  tier table, finding counts, streams cut for repetition, and `--findings` for the raw ledger.
- Both guards are wired once, in the passthrough lane's initial send (`applyResponseGuards` in
  `src/server/responses/passthrough-dispatch.ts`), and the degenerate half skips combo attempts, which
  have their own guard.

### 7. Link, latency and the pre-content close (2026-09-25)

- **A pre-content socket close is now replayable.** `failStream` in `src/server/responses/codex-ws-exchange.ts`
  used to settle every post-send pre-commit failure with the non-replayable marker, which meant a socket that
  died after the prelude but before any frame reached the client reported a failed turn. Because the prelude
  hold guarantees that an uncommitted response carries nothing the client has seen, that case now settles a
  resendable 502 and the capacity ladder re-dials. Steering sessions keep the conservative marker.
- **Cookie link.** `observeCookieLink` (`src/lib/response-attestation.ts`) writes one row per guarded request to
  `~/.opencodex/cookie-link.jsonl`: transport, whether the client sent a Cookie header, how many Set-Cookie
  headers came back, their names, and a 12-char hash of the load-balancer affinity pair when present. Values are
  never written. Measured on this deployment: 46 requests, **0 with the affinity pair, 0 where the client sent
  one, 0 Set-Cookie headers at all** -- so the cookie-routing lever some third-party gateways use is not
  available on this lane, and node placement stays with the load balancer.
- **Latency split.** `recordSlowTurn` writes turns at or above 20s to `~/.opencodex/latency.jsonl` with
  queueMs (our prep/admission before the send), headersMs (send -> upstream response), firstContentMs
  (send -> first content frame) and totalMs, plus one `[latency]` warning line.
- **`ocx-tiers`** gained `--links` and `--latency`, and its default view ends with a link/latency summary
  (including which lanes changed their affinity pair mid-conversation).

### 8. Cross-turn socket reuse, and the two bugs that hid it (2026-09-25)

The WebSocket lane has always pooled sockets, but the pool could only ever hand one back to a **resend
inside the same turn**: the reuse identity hashed the turn id, so the next turn of a conversation keyed a
different socket and the previous one just idled until it expired. Cross-turn reuse keys the same socket
for the rest of the conversation instead, which is as close as this relay gets to the "one long-lived
session" that third-party gateways advertise.

- **What changed.** `codexWsReuseIdentity` (`src/server/responses/codex-ws-pool.ts`) drops the turn from
  the scope and the key while cross-turn reuse is on, and emits a lease that says whether the socket came
  from an earlier turn. Idle/max-age windows for such a socket are 60 s / 10 min instead of 30 s / 5 min.
- **Two guards, because a reused socket is a new failure mode.** A reused socket that answers the new turn
  with a verdict instead of a response settles a **replayable 502** (`codexWsReusedSocketFailure`) -- the
  caller's capacity ladder then re-dials a fresh socket, which is the lifecycle this lane is proven with.
  A reused socket that answers with **nothing** is abandoned inside 8 s (`CODEX_WS_CROSS_TURN_FIRST_FRAME_MS`)
  rather than waiting out the shared 90 s prelude bound; a fresh socket keeps the old patience.
- **A breaker on the experiment itself.** The last 8 reused-socket outcomes are tracked; 4 or more samples
  with more than half failing pauses cross-turn reuse for 30 min and the lane silently returns to one
  socket per turn. Cross-turn reuse is **off by default**: `OCX_WS_CROSS_TURN_REUSE=1` opts in, and
  `OCX_WS_CROSS_TURN_FIRST_FRAME_MS` moves the deadline.
- **Why it is off by default.** Measured the same day: while the official origin was taking 17-76 s to
  produce its first content (queueMs ~20 ms -- our side was idle), the 8 s first-frame deadline could not
  tell a socket the origin had retired from an origin that was merely slow, so it abandoned sockets that
  would have answered and cost those turns 8 s + the ladder's first rung. Setting the deadline above the
  origin's own latency would defeat its purpose, and the per-turn lifecycle never has to make the call.
  The layer that pays off unconditionally is the same-turn half: a retry now reuses the socket the
  previous attempt left behind.
- **Measured, before and after.** Controlled turns on one conversation reused the socket across 15 s and
  35 s of idle with a 327 ms / 252 ms first frame. Real Codex traffic did not reuse at all, and the two
  reasons are worth recording:
  1. The client's `x-oai-attestation` header is **~4170 bytes**, past the 4 KiB per-field bound the identity
     inherited from the response-id validator -- so every real turn was refused and dialled a one-shot
     socket. Long fields are now hashed into the key instead of rejected.
  2. The same attestation is **refreshed per attempt**: two attempts of one turn, identical
     `x-client-request-id`, and the attestation differed. A key that read it could never match twice, so
     `x-oai-attestation` and `x-client-request-id` are now per-request headers the identity ignores.
  After both fixes, real traffic reuses: a working conversation's retries went from a fresh dial each time
  to 6 of 8 attempts landing on the retained socket, with the previous turn's socket still in hand.
- **Evidence and switches.** `~/.opencodex/ws-reuse.jsonl` records every reuse, its idle/age, the outcome,
  and (with `OCX_WS_REUSE_DEBUG=1`) the identity's inputs and the pool's retention decisions -- header
  names only, values hashed, never raw. `usage.jsonl`'s per-attempt stage record gained a `crossTurn`
  flag, so `ocx-tiers --wsreuse` reports the three WebSocket lanes side by side: fresh, resend inside a
  turn, and cross-turn, each with its failure rate and its first-frame / first-output medians.

## Credential note (why GitHub push protection complains)

The file src/oauth/google-antigravity.ts ships the Antigravity desktop client public OAuth
identifiers, exactly as upstream publishes them (its own docstring says so, and both values are
overridable with GOOGLE_ANTIGRAVITY_CLIENT_ID / GOOGLE_ANTIGRAVITY_CLIENT_SECRET). GitHub push
protection flags the pattern anyway, because it matches a real Google client-id/secret shape. If
you mirror this fork on GitHub you will be asked to allow those two values once (repository
Security tab, Secret scanning, push protection, Allow), or you can strip the inline defaults and
require the env vars instead. Nothing else in this fork contains credentials.

## Caveats

- Some thresholds are tuned to what the official backend and the relays in front of it were doing
  during September 2026. They are all constants with a comment explaining the measurement behind
  them — treat them as starting points, not as physics.
- The prelude holds delay a client's first byte by up to 25 s **only** when the backend produces no
  content for that long; the moment anything content-shaped arrives the held frames are released.
