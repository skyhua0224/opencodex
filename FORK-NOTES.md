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

### 9. The intelligence probe, run with sub2api's parameters (2026-09-25)

`tools/pelican-probe.py` asks the two questions ranxi2001/sub2api ships, with its prompt text, its
answer contract, its reasoning effort (`high`), its expected answer and its grading rules, so the
numbers are comparable with theirs:

- **candy** -- the built-in text question (three flavours, two shapes, "least number of candies that
  guarantees a differently-shaped apple and peach pair"), answer must be a bare integer, expected
  **21**, graded by a judge model on a DIFFERENT channel with their default grading prompt and the
  same JSON verdict contract (`correct|incorrect|unknown`);
- **pelican** -- `SVG 绘制一个鹈鹕骑自行车的 2D 动画` plus their delivery contract; their automated
  criterion is only "is there an HTML/SVG document", so the probe also saves the HTML, extracts the
  SVG and rasterises a frame, because the real comparison is human.

Each attempt appends one row to `~/.opencodex/intelligence-probe.jsonl` (status, verdict, reason,
first-content time, total time, the answer text, and the channel), so a probe round can be lined up
against capacity windows, tier attestations and latency rows.

**First run, 2026-09-25 15:10-15:17.** The ground truth was verified independently first: an
exhaustive check over every possible hand gives **21** (take 9 round and 12 star) as the minimum, and
every other 21-split fails.

| channel / model | candy (expected 21) | pelican |
| --- | --- | --- |
| `gpt-6-sol` (official) | **29** -- incorrect | valid HTML, 13.8 KB, first frame 79 s, total 249 s |
| `gpt-6-luna` (official) | **29** -- incorrect | valid HTML, 12.7 KB, first frame 113 s, total 274 s |
| `gpt-6-astra` (official) | **29** -- incorrect | valid HTML, 13.8 KB, first frame 25 s, total 104 s |
| `combo/gpt-6-sol` | **29** -- incorrect (routed to the same lane) | not run |
| `ciii-codex/*`, `ciii-codex-luke/*` | 502 `Upstream authentication failed` | not run |
| `lucen-*` (006/008/dynamic/fast/012/014/017/025) | 403 `SUBSCRIPTION_NOT_FOUND` | not run |
| `portal/*` | 403 `SUBSCRIPTION_NOT_FOUND` | not run |

Three official models, one wrong answer each, on a question whose answer is verifiable: that is the
kind of signal a quality gate acts on, and it is the first functional (not proxy-metric) evidence
this fork has produced. It is also only ONE question -- a screen, not a verdict. The honest reading
is "the official lane answered a discriminating question wrong today", not "the model is degraded by
X%". A round worth trusting needs several questions with verified answers, repeats, and the results
plotted against the capacity/tier timeline; the probe exists so that is a command, not a project.

Visually the three pelican renders differ the way a quality gate would want to see: `astra` drew the
cleanest composition (crest, helmet, red frame, hills), `sol` a decent coastal scene whose legs are
thin noodles, and `luna` the weakest anatomy (body and legs melting into the bike frame). All three
pass sub2api's automated HTML check, which is exactly why its showcase is human-reviewed.

### 10. The quality gate, and the four watchers around it (2026-09-25)

**The gate: a wrong answer now costs a channel its turn.** `src/providers/quality-holds.ts` reads
`~/.opencodex/quality-holds.json`, written by `tools/pelican-probe.py --apply`, and
`pickComboTarget` demotes a held provider (rank 1, "steps aside while an honest row exists") --
never a hard exclusion, because "no targets" is worse than a wrong-but-alive lane. The policy is
one-sided on purpose, and is the same one a quality gate has to be to be safe:

- only a CLEAR wrong answer creates a hold (HTTP 200, a real answer, judge verdict `incorrect`);
- transport errors, auth failures, unanswered requests and `unknown` change nothing -- neither a
  hold nor a release;
- a hold is released by the probe alone, after a round in which EVERY question on that provider
  passed; hand-editing the file works too, and holds past 48 h are ignored as a safety bound.

Live, 2026-09-25 16:20: the official `gpt-6-sol` answered `29个` to candy-21 (expected 21) and got
both other questions right; the round summary read `asked=3 correct=2 wrong=1 -> held`, and
`ocx-tiers --quality` showed `openai ... HELD 30min: candy-21: answered 29个, expected 21`. First
round this deployment has where a quality verdict actually moved routing.

**The bank.** `pelican-probe.py --kind bank` asks six questions whose answers were each verified
independently before entering the file: candy-21 (exhaustive search over every hand: 9 round + 12
star is minimal, and every other 21-split fails), socks-4 and balls-7 (exhaustive multiset
searches), calendar-friday (`datetime`: 2026-09-25 and 2026-12-25 are both Fridays, 91 days = 13
weeks), clock-7p5 (hour hand 97.5°, minute 90°) and code-55 (executed). Exact-digit matches need no
judge; everything else is graded by a model on a DIFFERENT provider.

**On demand, not on a loop.** The probe runs when asked, not every half hour. A 30-minute timer was
tried and removed after a day's numbers: 112 rounds, 400 questions, of which 195 answered 403 (dead
subscriptions) and 101 answered 502 (a broken lane) -- 74% of the traffic carried no information at
all, and the rounds that did carry a verdict were asking channels whose state the operator can see
from `ocx-tiers --quality` in one command. The units are kept in `tools/ocx-probe.{service,timer}`
as opt-in templates for anyone who wants a schedule; here a round is one command
(`systemctl --user start ocx-probe.service`, or the probe invocation directly), and holds expire on
their own when nothing refreshes them.

**Health score.** `ocx-tiers --health` blends, per provider, the error rate (healthy at 1%, dead at
10%) and the p90 first-output time (fast at 1.5 s, stuck at 15 s) into one 0-100 score from
`usage.jsonl`. First reading: `deepseek 81, zai 76, openai 55` -- the official lane's score is
carried by a 13.5 s p90, not by its 0.8% error rate.

**Fingerprint drift.** `src/codex/client-fingerprint-guard.ts` watches the four headers upstream can
grade service by (originator, user agent, installation id, subagent marker) and appends one row per
CHANGE to `~/.opencodex/fingerprint-drift.jsonl` -- names, sizes and 12-char hashes only, never a
value. A Codex update or a relay that rewrites headers now leaves a suspect list instead of silence.

**Restriction verdicts.** `noteThreadRestrictionVerdict` recognises the texts that are about the
CLIENT rather than the load ("This account only allows Codex official clients", policy/abuse blocks)
and re-rolls that conversation's routing identity on the FIRST verdict with a 30-minute hold -- no
six-verdict threshold to wait for, because the origin did not say "busy", it said "not you".
`sessionVerdictSummary` reports both verdict kinds so a slow conversation can be told apart from a
blocked one.

**Adding an account** (the one lever that changes who actually serves you): `ocx login codex` adds
a ChatGPT login, `ocx account <sub>` manages the pool, and a second subscription should be its own
provider row so quota, capacity and quality state stay per-subscription.

### 11. When the origin closes the WebSocket lane itself (2026-09-26)

**What happened.** At ~07:00 every canonical WebSocket dial started completing the upgrade,
receiving exactly two control frames, and then being closed by the origin with **1011** and no
response event:

```
codex websocket closed before a Responses terminal event (close 1011)
  [cause=no-response-event request=2718111B sent=yes frames=2 control=2 relayed=0 first-frame=1054ms elapsed=1070ms]
```

It hit both of the operator's working conversations and a three-question probe on a fresh session
identically, so it was account/lane-scoped rather than conversation-scoped. The cost is what made it
look like a freeze: every turn spent the whole capacity ladder re-dialling (5+12+25+45s of waits)
and then failed anyway -- 97-106s per turn, with the client retrying on top. Nothing in the logs said
"the lane is refused"; each line was an ordinary replayable 502.

**Why the existing protection did not catch it.** The capacity ladder treats a pre-content close as
worth re-dialling, which it is for a shed turn. The per-thread demotion needs six OVERLOAD verdicts,
and a 1011 close carries none of that text. So the lane was re-dialled forever.

**What was done.**

1. Immediate relief: `provider.openai.upstreamWebsocket = false` (a switch the code already
   documents for exactly this) moves the first-party lane to HTTP/SSE. Verified live: turns went
   from 502-after-100s to 200 in 13-17s, and a probe question answered in 6.5s.
2. `src/server/responses/codex-ws-lane.ts`: a lane-level breaker. A close counts as a refusal when
   it has an abnormal code (1011/1012/1013/1014), no relayed event, and at most three upstream
   frames -- the control-only shape. Three refusals inside ten minutes (and no WS success in the
   last five) put the lane on HTTP for 10 minutes; further trips escalate to 30 and 60 minutes, and
   a real WS response clears the window and resets the escalation. The hold is persisted in
   `~/.opencodex/ws-lane.json`, every trip writes `~/.opencodex/ws-lane.jsonl`, and
   `clearCodexWsLaneHold()` is the operator override.
3. The config switch stays `false` on this deployment: a breaker-managed return to WS would cost
   one 100-second ladder per hold expiry until the origin recovers, which is worse than stable HTTP.
   Flip it back once the lane answers again; the breaker then covers the next outage automatically.

**Residual reading.** If HTTP ever starts refusing too, the account is the common factor and no
transport switch will save the turn -- at that point the levers are waiting out the block or serving
the turn from a second subscription (`ocx login codex`, one provider row per subscription).

### 12. Cutting a release

The fork tags as `v<upstream version>-skyhua.<n>`, so a reader can tell which upstream its patches
apply to. The current cut is **v2.63.0-skyhua.2**, cut from `855f636`; the first was
`v2.63.0-skyhua.1` from `ab845fe`.

The mechanics, in order:

```bash
git tag -a v2.63.0-skyhua.3 -m "skyhua hardening fork, based on opencodex 2.63.0 -- <what changed>"
git push origin v2.63.0-skyhua.3      # gitea-lan
git push github v2.63.0-skyhua.3      # github
gh release create v2.63.0-skyhua.3 -R skyhua0224/opencodex --latest   --title "..." --notes-file /tmp/notes.md
```

The notes are written from the commit log plus FORK-NOTES sections added since the previous tag, and
they lead with what was MEASURED (numbers, the shape of the failure) rather than with the diff.
Rewrite them for a reader who has not seen the sessions.

One asymmetry to remember: GitHub releases are scriptable through `gh`, and the tag alone reaches
Gitea over SSH, but the Gitea instance answers its API with "Only signed in user is allowed to call
APIs" -- its release object needs an admin token (`curl -H "Authorization: token <token>" ...` on
`/api/v1/repos/skyhua/opencodex/releases`) or a couple of clicks in its web UI from the tag page.

### 13. In-body capacity declines on the SSE lane (2026-09-26, second pass)

**The failure.** 09:28:44 and 09:38:26, the same conversation twice in ten minutes: the origin answered
`Our servers are currently overloaded. Please try again later.`, the client got 503, `sendCount: 1`,
`transportPhase: terminal_sse`, `failureStage: protocol-prelude`. Nothing retried it: the WS lane's hold
does not apply (this deployment rides HTTP), `withSsePreludeDeclineRetry` never logged a line, and the
capacity ladder only sees statuses, of which there were none -- the decline arrived inside a 200.

**Why the wrapper missed it.** Two reasons, one certain and one latent:

- it bailed on the content-type check (`text/event-stream`), returning the response untouched, while the
  relay went on to parse the body and record the terminal error -- which is exactly the "no log line"
  signature in the evidence;
- its frame loop only inspects text terminated by `

`/`

`, and at end-of-body it released
  the held prelude without ever looking at the trailing bytes, so a body that is one JSON object (or a
  final frame with no separator) was invisible to the decline check.

**What changed.**

- `acceptAnyContentType` (opt-in, passed by `upstream-retry` for the canonical lane) widens the gate:
  the caller knows the endpoint speaks the Responses event protocol, so a wrong or missing content-type
  must not hide a decline.
- `isDeclineFrame` recognises `error`/`response.failed` on the capacity text, a `response.completed`
  whose `response.status` is `failed`, and -- for bodies with no framing at all -- only an EXPLICIT
  refusal (`server_is_overloaded`, `"type":"error"`, `"status":"failed"`). A successful answer that
  merely mentions the words is delivered (the operator's own answers do), and that case is a test.
- The trailing bytes are examined before release, and when they are not a decline they are EMITTED:
  widening the content-type gate would otherwise have turned "wrapped a body that is not a stream" into
  a dropped answer (caught by the J case in the self-test, not in production).

**Identity.** The 6-hour routing re-roll for that conversation was already armed by the 09:28 verdict
(the persisted state proved the verdict path works for this shape); it did not stop the 09:38 shed, so
the operator arm was written for the same key as an additional, immediate lever.

**Fingerprint hygiene.** The guard's `provider` argument is a name; a config object reaching it had
written 52 rows carrying a provider config snapshot and a log line reading `[object Object]`. The call
site passes `route.providerName`, the module coerces anything else to `unknown`, requests with neither
an originator nor an installation id are not observations at all (the operator's probes arrive that
way), and the existing ledger was rewritten.

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
