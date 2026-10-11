/**
 * A 429 that answers the operator replacement must be absorbed, not settled as the refusal.
 *
 * Measured 2026-10-11 (+08): reset -> operator replacement -> upstream 429 settled as
 * "automatic replay was stopped" (five turns dead across two lanes). A 429 proves the
 * replacement never ran, so it rides the same paced ladder the caller passed for 429s;
 * every resend draws the operator replacement grant, and a drained grant (or a drained
 * ladder, or a Retry-After past the ceiling) settles as the refusal exactly as before.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  fetchWithResetRetry,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../src/lib/upstream-retry";

function resetErr(): Error {
  const err = new Error("The socket connection was closed unexpectedly.");
  (err as Error & { code: string }).code = "ECONNRESET";
  return err;
}

function status(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

function mockSend(results: Array<Response | Error>): { sends: number; send: () => Promise<Response> } {
  const state = { sends: 0, i: 0 };
  const send = async (): Promise<Response> => {
    state.sends += 1;
    const next = results[state.i++] ?? results[results.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { sends: state.sends, get send() { return send; }, sendFn: send } as { sends: number; send: () => Promise<Response> };
}

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

describe("operator replacement answered 429", () => {
  test("absorbed on the paced ladder; the turn completes when upstream recovers", async () => {
    silenceWarn();
    const state = { sends: 0, i: 0 };
    const results: Array<Response | Error> = [resetErr(), status(429, { "retry-after": "0" }), status(200)];
    let claims = 0;
    const res = await fetchWithResetRetry(async () => {
      state.sends += 1;
      const next = results[state.i++] ?? results[results.length - 1];
      if (next instanceof Error) throw next;
      return next;
    }, {
      attempts: 4,
      claimAmbiguousResend: () => { claims += 1; return claims <= 4; },
      retryRateLimitDeferralsMs: [5000],
      label: "replacement-429",
    });
    expect(res.status).toBe(200);
    expect(state.sends).toBe(3);
    expect(claims).toBe(2);
  });

  test("a drained grant settles the 429 as the replay refusal after the replacement", async () => {
    silenceWarn();
    const state = { sends: 0, i: 0 };
    const results: Array<Response | Error> = [resetErr(), status(429), status(200)];
    let claims = 0;
    const res = await fetchWithResetRetry(async () => {
      state.sends += 1;
      const next = results[state.i++] ?? results[results.length - 1];
      if (next instanceof Error) throw next;
      return next;
    }, {
      attempts: 4,
      claimAmbiguousResend: () => { claims += 1; return claims <= 1; },
      retryRateLimitDeferralsMs: [5000],
    });
    expect(res.status).toBe(429);
    expect(state.sends).toBe(2);
    expect(await res.text()).toContain(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
  });

  test("the ladder bounds the absorption; the refusal returns after the rungs", async () => {
    silenceWarn();
    const state = { sends: 0, i: 0 };
    const results: Array<Response | Error> = [resetErr(), status(429), status(429), status(429), status(429)];
    let claims = 0;
    const res = await fetchWithResetRetry(async () => {
      state.sends += 1;
      const next = results[state.i++] ?? results[results.length - 1];
      if (next instanceof Error) throw next;
      return next;
    }, {
      attempts: 5,
      claimAmbiguousResend: () => { claims += 1; return claims <= 4; },
      retryRateLimitDeferralsMs: [0, 0],
    });
    expect(res.status).toBe(429);
    expect(state.sends).toBe(4);
    expect(claims).toBe(3);
  });

  test("a Retry-After past the ceiling settles without another send", async () => {
    silenceWarn();
    const state = { sends: 0, i: 0 };
    const results: Array<Response | Error> = [resetErr(), status(429, { "retry-after": "120" })];
    const res = await fetchWithResetRetry(async () => {
      state.sends += 1;
      const next = results[state.i++] ?? results[results.length - 1];
      if (next instanceof Error) throw next;
      return next;
    }, {
      attempts: 4,
      claimAmbiguousResend: () => true,
      retryRateLimitDeferralsMs: [5000],
    });
    expect(res.status).toBe(429);
    expect(state.sends).toBe(2);
  });
});
