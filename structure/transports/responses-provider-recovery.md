# Responses Provider Recovery Lanes

Provider-specific pre-output recovery on the Responses data plane: what one provider's
refusal shape may replay, and what stays a committed failure. The shared retry, replay and
failover contracts these lanes build on are in
[Responses Failover And Replay](responses-failover.md).

## Console upload rejection recovery

`src/providers/opencode-zen-rate-limit.ts` recognizes the complete Console upload-rejection envelope only at the effective HTTPS opencode.ai Zen/Go generation endpoint. A provider row name cannot authorize another destination. The two recovery loops in `src/server/responses/core.ts` wait 800 ms and replay the captured serialized request once; cancellation, nonreplayable responses, other errors and a second upload rejection keep their failure semantics. The recovery kind is persisted as `console-go-upload-retry` and has a localized Logs label.

## Grok Devin pre-output rate limits

For direct Grok Responses requests served by the Devin runTurn adapter,
`src/server/responses/run-turn-execution.ts` uses `preflightAdapterEvents` before creating the
streaming Response. A first-event 429 without a replay-unsafe heartbeat becomes an HTTP 429 JSON
error through the shared error formatter and client Retry-After resolver. The buffered first event
is replayed for every other outcome. The preflight is bounded by the configured stall timeout,
including any earlier OAuth failover preflight on this path. On expiry, its pending iterator read is
handed to SSE replay exactly once; timeout therefore starts a 200 SSE response. An opted-in Devin
cooldown heartbeat also starts SSE before its wait ends. Once SSE begins, the stream forwards safe
heartbeats and checks the first meaningful event: a pre-output 429 may rotate to an eligible OAuth
account and replay the unchanged request. Without an eligible account it remains an in-stream
failure, since HTTP status is already committed. Text, reasoning, and tool output commit the stream
and prevent later rotation. Buffered Responses turns ignore the cooldown-ready heartbeat during
preflight and apply the same HTTP 429 formatter to a final refusal after OAuth failover. Other
buffered results retain the original event list, including output preceding a late error. Combo
children ignore cooldown readiness during their own preflight, so a final 429 without output can
still move to the next combo target. Devin combo children bypass opted-in stated-reset waiting and
surface the pre-output 429 immediately, because the outer response cannot forward their wait
heartbeats while it is choosing a target. An earlier replay-unsafe heartbeat or meaningful output keeps
the failure on the current target.
