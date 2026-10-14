import { afterEach, describe, expect, test } from "bun:test";
import {
  createResetStormCoordinator,
  replaceResetStormCoordinatorForTests,
  resetStorm,
  type ResetStormConfig,
} from "../../src/lib/reset-storm";
import { fetchWithResetRetry } from "../../src/lib/upstream-retry";

function fixedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => { current += ms; },
  };
}

function resetError(): Error {
  return Object.assign(new Error("socket connection was closed unexpectedly"), { code: "ECONNRESET" });
}

function coordinatorWith(partial: Partial<ResetStormConfig>, now?: () => number) {
  return createResetStormCoordinator({ config: { enabled: true, ...partial }, now });
}

describe("reset storm detection", () => {
  test("a storm needs resets from DISTINCT lanes inside the window", () => {
    const clock = fixedClock();
    const coordinator = coordinatorWith({ minLanes: 3, detectionWindowMs: 10_000, stormWindowMs: 45_000 }, clock.now);
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-a");
    clock.advance(100);
    coordinator.recordReset("chatgpt.com", "lane-a");
    expect(coordinator.stormActive("chatgpt.com")).toBe(false);
    coordinator.recordReset("chatgpt.com", "lane-b");
    expect(coordinator.stormActive("chatgpt.com")).toBe(false);
    coordinator.recordReset("chatgpt.com", "lane-c");
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
  });

  test("resets older than the detection window are not evidence", () => {
    const clock = fixedClock();
    const coordinator = coordinatorWith({ minLanes: 3, detectionWindowMs: 10_000, stormWindowMs: 45_000 }, clock.now);
    coordinator.recordReset("chatgpt.com", "lane-a");
    clock.advance(11_000);
    coordinator.recordReset("chatgpt.com", "lane-b");
    clock.advance(500);
    coordinator.recordReset("chatgpt.com", "lane-c");
    expect(coordinator.stormActive("chatgpt.com")).toBe(false);
  });

  test("an active storm extends on fresh resets but never past the hard cap", () => {
    const clock = fixedClock();
    const coordinator = coordinatorWith({
      minLanes: 3, detectionWindowMs: 10_000, stormWindowMs: 45_000, maxStormWindowMs: 120_000,
    }, clock.now);
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
    // Extensions land while the storm is still live; each fresh reset buys one window
    // from NOW, capped by the hard window measured from the first declaration.
    clock.advance(30_000);
    coordinator.recordReset("chatgpt.com", "lane-a");
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
    clock.advance(30_000);
    coordinator.recordReset("chatgpt.com", "lane-b");
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
    clock.advance(30_000);
    coordinator.recordReset("chatgpt.com", "lane-c");
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
    clock.advance(25_000);
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
    clock.advance(10_000);
    expect(coordinator.stormActive("chatgpt.com")).toBe(false);
  });

  test("a successful send lifts the storm and re-arms detection", () => {
    const clock = fixedClock();
    const coordinator = coordinatorWith({ minLanes: 3, detectionWindowMs: 10_000, stormWindowMs: 45_000 }, clock.now);
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
    coordinator.noteSendSuccess("chatgpt.com");
    expect(coordinator.stormActive("chatgpt.com")).toBe(false);
    coordinator.recordReset("chatgpt.com", "lane-a");
    expect(coordinator.stormActive("chatgpt.com")).toBe(false);
  });

  test("scopes coordinate independently", () => {
    const coordinator = coordinatorWith({ minLanes: 3, detectionWindowMs: 10_000, stormWindowMs: 45_000 });
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    expect(coordinator.stormActive("chatgpt.com")).toBe(true);
    expect(coordinator.stormActive("api.z.ai")).toBe(false);
  });
});

describe("reset storm stagger", () => {
  test("zero outside a storm, lane-stable and bounded inside one", () => {
    const coordinator = coordinatorWith({ minLanes: 3, staggerSpreadMs: 15_000 });
    expect(coordinator.replacementStaggerMs("chatgpt.com", "lane-a")).toBe(0);
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    const first = coordinator.replacementStaggerMs("chatgpt.com", "lane-a");
    expect(first).toBe(coordinator.replacementStaggerMs("chatgpt.com", "lane-a"));
    expect(first).toBeLessThan(15_000);
    expect(coordinator.replacementStaggerMs("chatgpt.com", "lane-b"))
      .toBe(coordinator.replacementStaggerMs("chatgpt.com", "lane-b"));
  });
});

describe("reset storm replacement gate", () => {
  test("no storm: sends are ungated", async () => {
    const coordinator = coordinatorWith({ minLanes: 3 });
    expect(await coordinator.acquireReplacementSlot("chatgpt.com")).toBeNull();
  });

  test("during a storm at most maxConcurrent slots exist and the queue is FIFO", async () => {
    const coordinator = coordinatorWith({
      minLanes: 3, maxConcurrentReplacements: 2, stormWindowMs: 60_000, queueDeadlineMs: 10_000,
    });
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    const grants: string[] = [];
    let live = 0;
    let peak = 0;
    const acquire = async (lane: string): Promise<void> => {
      const gate = await coordinator.acquireReplacementSlot("chatgpt.com");
      expect(gate).not.toBe("defer");
      if (gate === null || gate === "defer") return;
      live += 1;
      peak = Math.max(peak, live);
      grants.push(lane);
      await new Promise(resolve => setTimeout(resolve, 20));
      live -= 1;
      gate.release();
    };
    const lanes = ["lane-a", "lane-b", "lane-c", "lane-d", "lane-e"];
    const running = lanes.map(lane => acquire(lane));
    await Promise.all(running);
    expect(peak).toBeLessThanOrEqual(2);
    expect(grants.length).toBe(5);
  });

  test("a queue wait past the deadline defers without a slot", async () => {
    const coordinator = coordinatorWith({
      minLanes: 3, maxConcurrentReplacements: 1, stormWindowMs: 60_000, queueDeadlineMs: 80,
    });
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    const first = await coordinator.acquireReplacementSlot("chatgpt.com");
    expect(first).not.toBe("defer");
    expect(first).not.toBeNull();
    const deferred = await coordinator.acquireReplacementSlot("chatgpt.com");
    expect(deferred).toBe("defer");
    first?.release();
  });

  test("an abort while queued defers without a slot", async () => {
    const coordinator = coordinatorWith({
      minLanes: 3, maxConcurrentReplacements: 1, stormWindowMs: 60_000, queueDeadlineMs: 60_000,
    });
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    const first = await coordinator.acquireReplacementSlot("chatgpt.com");
    expect(first).not.toBe("defer");
    const controller = new AbortController();
    const queued = coordinator.acquireReplacementSlot("chatgpt.com", controller.signal);
    controller.abort();
    expect(await queued).toBe("defer");
    first?.release();
  });

  test("a success while queued ungates the waiters", async () => {
    const coordinator = coordinatorWith({
      minLanes: 3, maxConcurrentReplacements: 1, stormWindowMs: 60_000, queueDeadlineMs: 60_000,
    });
    coordinator.recordReset("chatgpt.com", "lane-a");
    coordinator.recordReset("chatgpt.com", "lane-b");
    coordinator.recordReset("chatgpt.com", "lane-c");
    const first = await coordinator.acquireReplacementSlot("chatgpt.com");
    expect(first).not.toBe("defer");
    const queued = coordinator.acquireReplacementSlot("chatgpt.com");
    coordinator.noteSendSuccess("chatgpt.com");
    expect(await queued).toBeNull();
    first?.release();
  });
});

describe("fetchWithResetRetry storm coordination", () => {
  afterEach(() => {
    replaceResetStormCoordinatorForTests(null);
  });

  test("a herd of resetting lanes re-sends under the concurrency cap and recovers", async () => {
    const coordinator = coordinatorWith({
      minLanes: 3, detectionWindowMs: 60_000, stormWindowMs: 60_000, maxStormWindowMs: 60_000,
      staggerSpreadMs: 30, maxConcurrentReplacements: 2, queueDeadlineMs: 30_000,
    });
    replaceResetStormCoordinatorForTests(coordinator);
    coordinator.recordReset("upstream.test", "warm-a");
    coordinator.recordReset("upstream.test", "warm-b");
    coordinator.recordReset("upstream.test", "warm-c");

    const laneSends = new Map<string, number>();
    let replacementInFlight = 0;
    let replacementPeak = 0;
    let successfulSends = 0;
    const doFetchFor = (lane: string) => async (): Promise<Response> => {
      const ordinal = (laneSends.get(lane) ?? 0) + 1;
      laneSends.set(lane, ordinal);
      const isReplacement = ordinal >= 2;
      // Only sends under a still-active storm are gated; after the lift the remaining
      // lanes intentionally proceed ungated, so they must not count against the cap.
      const gated = isReplacement && coordinator.stormActive("upstream.test");
      if (gated) {
        replacementInFlight += 1;
        replacementPeak = Math.max(replacementPeak, replacementInFlight);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if (gated) replacementInFlight -= 1;
      successfulSends += 1;
      if (successfulSends <= 4) throw resetError();
      return new Response("ok", { status: 200 });
    };

    const lanes = Array.from({ length: 6 }, (_, index) => index);
    const outcomes = await Promise.all(lanes.map(lane =>
      fetchWithResetRetry(doFetchFor("lane-" + String(lane)), {
        label: "upstream.test",
        attempts: 6,
        stormLaneId: "lane-" + String(lane),
        claimAmbiguousResend: () => true,
      })));
    for (const response of outcomes) {
      expect(response.status).toBe(200);
    }
    // The FIRST send of every lane is never gated by design; the cap applies to the
    // replacement herd the storm actually coordinates.
    expect(replacementPeak).toBeLessThanOrEqual(2);
    expect(coordinator.stormActive("upstream.test")).toBe(false);
  });

  test("permanent resets with a tight queue deadline settle without hanging", async () => {
    const coordinator = coordinatorWith({
      minLanes: 3, detectionWindowMs: 60_000, stormWindowMs: 60_000, maxStormWindowMs: 60_000,
      staggerSpreadMs: 5, maxConcurrentReplacements: 2, queueDeadlineMs: 60,
    });
    replaceResetStormCoordinatorForTests(coordinator);
    coordinator.recordReset("upstream.test", "warm-a");
    coordinator.recordReset("upstream.test", "warm-b");
    coordinator.recordReset("upstream.test", "warm-c");

    const laneSends = new Map<string, number>();
    let replacementInFlight = 0;
    let replacementPeak = 0;
    const doFetchFor = (lane: string) => async (): Promise<Response> => {
      const ordinal = (laneSends.get(lane) ?? 0) + 1;
      laneSends.set(lane, ordinal);
      if (ordinal >= 2) {
        replacementInFlight += 1;
        replacementPeak = Math.max(replacementPeak, replacementInFlight);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
      if (ordinal >= 2) replacementInFlight -= 1;
      throw resetError();
    };

    const lanes = Array.from({ length: 6 }, (_, index) => index);
    const settled = await Promise.all(lanes.map(lane =>
      fetchWithResetRetry(doFetchFor("lane-" + String(lane)), {
        label: "upstream.test",
        attempts: 4,
        stormLaneId: "lane-" + String(lane),
        replaySafe: true,
      }).then(
        () => "response",
        () => "threw",
      )));
    expect(settled.every(outcome => outcome === "threw" || outcome === "response")).toBe(true);
    expect(replacementPeak).toBeLessThanOrEqual(2);
  });

  test("the process-wide default is inert until configured", async () => {
    expect(resetStorm().config().enabled).toBe(false);
    expect(await resetStorm().acquireReplacementSlot("chatgpt.com")).toBeNull();
  });
});
