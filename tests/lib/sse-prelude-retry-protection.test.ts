/**
 * The screening gate's "not now" rides the same prelude-decline ladder as an overload.
 *
 * Measured 2026-10-11 15:40-15:43 (+08): a 200 SSE held the prelude ~29s and then errored with
 * "response protection is unavailable" -- nothing had run, but the matcher only knew the
 * overload wording, so every turn landed on the client as a synthetic 502 with sendCount 1.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { withSsePreludeDeclineRetry } from "../../src/lib/sse-prelude-retry";

const PRELUDE = 'data: {"type":"response.created"}\n\n';
const PROTECTION_ERROR = 'data: {"type":"error","code":"screening_unavailable","message":"response protection is unavailable"}\n\n';
const DELTA = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';
const OK_DONE = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
const encoder = new TextEncoder();

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

describe("sse prelude decline: screening-gate verdict", () => {
  test("a protection decline before any content is absorbed and the turn re-dialled", async () => {
    silenceWarn();
    let sends = 0;
    const wrapped = withSsePreludeDeclineRetry(sseResponse([PRELUDE, PROTECTION_ERROR]), {
      delaysMs: [1],
      resend: async () => {
        sends += 1;
        return sseResponse([PRELUDE, OK_DONE]);
      },
      acceptAnyContentType: true,
      label: "protection",
    });
    const out = await wrapped.text();
    expect(sends).toBe(1);
    expect(out).toContain("response.completed");
    expect(out).not.toContain("response protection is unavailable");
  });

  test("an unframed protection refusal (whole-JSON body) is retried once", async () => {
    silenceWarn();
    let sends = 0;
    const declined = new Response('{"error":{"message":"response protection is unavailable"}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const wrapped = withSsePreludeDeclineRetry(declined, {
      delaysMs: [1],
      resend: async () => {
        sends += 1;
        return sseResponse([OK_DONE]);
      },
      acceptAnyContentType: true,
    });
    const out = await wrapped.text();
    expect(sends).toBe(1);
    expect(out).toContain("response.completed");
  });

  test("a protection error after real content is delivered, never retried", async () => {
    silenceWarn();
    let sends = 0;
    const wrapped = withSsePreludeDeclineRetry(sseResponse([PRELUDE, DELTA, PROTECTION_ERROR]), {
      delaysMs: [1],
      resend: async () => {
        sends += 1;
        return sseResponse([OK_DONE]);
      },
      acceptAnyContentType: true,
    });
    const out = await wrapped.text();
    expect(sends).toBe(0);
    expect(out).toContain("response.output_text.delta");
    expect(out).toContain("response protection is unavailable");
  });
});
