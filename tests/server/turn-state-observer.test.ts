import { describe, expect, test } from "bun:test";
import { redactTurnStateObservation } from "../../src/server/turn-state-observer";

describe("turn-state observation redaction", () => {
  test("keeps only length and a stable digest", () => {
    const value = "opaque-state-token";
    const redacted = redactTurnStateObservation(value);

    expect(redacted).toMatch(/^\[redacted length=18 sha256=[0-9a-f]{16}\]$/);
    expect(redacted).not.toContain(value);
    expect(redacted).toBe(redactTurnStateObservation(value));
    expect(redactTurnStateObservation(`${value}!`)).not.toBe(redacted);
  });
});
