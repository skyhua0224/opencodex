import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearThreadTransportLedgerForTests,
  noteThreadUpstreamCut,
  shouldArmUpstreamCut,
  threadTransportDemotedToHttp,
  threadTransportDemotion,
} from "../../src/server/ws-thread-transport";

const originalOpenCodexHome = process.env.OPENCODEX_HOME;
let testHome = "";

afterEach(() => {
  clearThreadTransportLedgerForTests();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
});

describe("thread WebSocket transport demotion", () => {
  test("treats a mid-stream protocol-prelude close as a cut", () => {
    expect(shouldArmUpstreamCut(502, "mid_stream", undefined)).toBe(true);
    expect(shouldArmUpstreamCut(502, "protocol-prelude", undefined)).toBe(false);
    expect(shouldArmUpstreamCut(499, "mid_stream", undefined)).toBe(false);
  });

  test("demotes a thread to HTTP/SSE after two cuts", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-thread-transport-"));
    process.env.OPENCODEX_HOME = testHome;
    const thread = "thread-cut-recovery";
    noteThreadUpstreamCut(thread, { status: 502, midStream: true }, 1_000);
    expect(threadTransportDemotion(thread, 1_001)).toBeUndefined();

    noteThreadUpstreamCut(thread, { status: 502, midStream: true }, 2_000);
    expect(threadTransportDemotedToHttp(thread, 2_001)).toBe(true);
    expect(threadTransportDemotion(thread, 2_001)?.until).toBeGreaterThan(2_001);
  });
});
