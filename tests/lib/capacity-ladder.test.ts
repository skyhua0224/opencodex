import { describe, expect, test } from "bun:test";
import {
  capacityLadderDelays,
  configureCapacityLadder,
} from "../../src/lib/capacity-ladder";

describe("capacity ladder config", () => {
  test("absent or disabled config degrades to the built-in ladder", () => {
    configureCapacityLadder(undefined);
    expect(capacityLadderDelays()).toBeNull();
    configureCapacityLadder({ enabled: false, delaysMs: [60_000] });
    expect(capacityLadderDelays()).toBeNull();
    configureCapacityLadder({ enabled: true, delaysMs: [] });
    expect(capacityLadderDelays()).toBeNull();
  });

  test("an enabled ladder is cleaned, sorted ascending, and capped at eight rungs", () => {
    configureCapacityLadder({
      enabled: true,
      delaysMs: [120_000, 5_000, 75000.4, 45_000, 25_000, 12_000, 0.5, 900_000, 30_000],
    });
    const ladder = capacityLadderDelays();
    expect(ladder).not.toBeNull();
    expect(ladder?.length).toBe(8);
    // 0.5 clamps to the 1s floor, 900s clamps to the 600s ceiling, and the ninth rung
    // is dropped by the eight-rung cap.
    expect(ladder).toEqual([1_000, 5_000, 12_000, 25_000, 30_000, 45_000, 75_000, 120_000]);
  });

  test("the configured ladder reads back stable for the call sites", () => {
    configureCapacityLadder({ enabled: true, delaysMs: [75_000, 120_000] });
    expect(capacityLadderDelays()).toEqual([75_000, 120_000]);
    expect(capacityLadderDelays()).toEqual(capacityLadderDelays());
    configureCapacityLadder(undefined);
    expect(capacityLadderDelays()).toBeNull();
  });
});
