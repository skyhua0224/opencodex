/**
 * The one 507 shape the capacity lane may absorb: the origin's own retry-buffer overflow.
 *
 * Measured 2026-10-11 13:24 (+08): a 490k-token turn was answered 507 "exceeded request
 * buffer limit while retrying upstream" in 10.3s, and the client's immediate resend of the
 * same turn succeeded. Every other 507 keeps its storage-class exclusion and its body.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchWithTransientRetry } from "../../src/lib/upstream-retry";

const OVERFLOW_BODY = JSON.stringify({ error: { message: "exceeded request buffer limit while retrying upstream" } });
const PLAIN_BODY = JSON.stringify({ error: { message: "insufficient storage" } });

function status507(body: string): Response {
  return new Response(body, { status: 507, headers: { "content-type": "application/json" } });
}

function okResponse(): Response {
  return new Response("ok", { status: 200 });
}

function mockDoFetch(results: Array<Response | Error>): { calls: number[]; doFetch: () => Promise<Response> } {
  const state = { calls: [] as number[], i: 0 };
  const doFetch = async (): Promise<Response> => {
    state.calls.push(state.i);
    const next = results[state.i++] ?? results[results.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls: state.calls, doFetch };
}

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

describe("507 origin retry-buffer overflow", () => {
  test("absorbs the overflow verdict on the capacity lane and resends", async () => {
    silenceWarn();
    const { calls, doFetch } = mockDoFetch([status507(OVERFLOW_BODY), okResponse()]);
    const res = await fetchWithTransientRetry(doFetch, {
      attempts: 1,
      retryCapacityDeferralsMs: [1],
      label: "507-overflow",
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("a plain 507 keeps its storage-class exclusion and its body", async () => {
    silenceWarn();
    const { calls, doFetch } = mockDoFetch([status507(PLAIN_BODY), okResponse()]);
    const res = await fetchWithTransientRetry(doFetch, {
      attempts: 1,
      retryCapacityDeferralsMs: [1],
      label: "507-plain",
    });
    expect(res.status).toBe(507);
    expect(calls).toHaveLength(1);
    expect(await res.text()).toBe(PLAIN_BODY);
  });

  test("spends at most the operator rungs on the overflow, then hands the answer back", async () => {
    silenceWarn();
    const { calls, doFetch } = mockDoFetch([status507(OVERFLOW_BODY), status507(OVERFLOW_BODY), status507(OVERFLOW_BODY)]);
    const res = await fetchWithTransientRetry(doFetch, {
      attempts: 1,
      retryCapacityDeferralsMs: [1, 1],
      label: "507-rungs",
    });
    expect(res.status).toBe(507);
    expect(calls).toHaveLength(3);
    expect(await res.text()).toBe(OVERFLOW_BODY);
  });

  test("without a capacity ladder a 507 is returned untouched", async () => {
    silenceWarn();
    const { calls, doFetch } = mockDoFetch([status507(OVERFLOW_BODY), okResponse()]);
    const res = await fetchWithTransientRetry(doFetch, {
      attempts: 2,
      label: "507-no-ladder",
    });
    expect(res.status).toBe(507);
    expect(calls).toHaveLength(1);
    expect(await res.text()).toBe(OVERFLOW_BODY);
  });
});
