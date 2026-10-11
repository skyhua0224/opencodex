import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reclaimProxyForServiceRestart, waitForReplacementProxy } from "../../src/service/orchestration";
import { repoPath } from "../helpers/repo-root";

/**
 * `ocx service restart` reported a successful restart while the process it was supposed to
 * replace kept the port.
 *
 * The mechanism was a swallowed refusal, not a missing check. The restart path ended the Task
 * Scheduler task and its cmd/wscript wrappers, then asked the leftover child to stop through
 * the management API — and a proxy under a respawnable wrapper refuses exactly that request
 * (`respawnable_service`) because an API client cannot end the task. The refusal was logged as
 * a warning, `repairService` rewrote the assets and started the task again, and `/healthz` was
 * answered by the same pid the command set out to replace: the wrapper's child never exited, so
 * the Codex clients kept talking to the old process. The port probe could not tell the two
 * apart, because both are this home's proxy on the same port.
 *
 * These cases pin the two halves of the fix: reclaim the child with the identity-checked direct
 * kill, and refuse to call the restart done unless a DIFFERENT pid is serving afterwards.
 */

function reclaimHarness(overrides: {
  tracked?: number | null;
  live?: { pid: number | null } | null;
  alivePids?: number[];
  unverified?: boolean;
} = {}) {
  const killed: number[] = [];
  const clearedPids: number[] = [];
  const clearedPorts: number[] = [];
  const alive = new Set(overrides.alivePids ?? [4242, 777]);
  const deps = {
    readTrackedPid: () => overrides.tracked ?? null,
    verifyTracked: (pid: number | null | undefined) =>
      (overrides.unverified || typeof pid !== "number" ? null : pid),
    isAlive: (pid: number) => alive.has(pid),
    kill: (pid: number) => {
      killed.push(pid);
      // A real killProxy proves the exit before it returns; mirror that here so a test cannot
      // pass on a reclaim that only claimed to have killed something.
      alive.delete(pid);
    },
    clearPid: (pid: number) => { clearedPids.push(pid); },
    clearPort: (pid: number) => { clearedPorts.push(pid); },
    findLive: async () => (overrides.live === undefined ? { pid: 4242 } : overrides.live),
  };
  return { deps, killed, clearedPids, clearedPorts };
}

describe("service restart reclaims the process it replaces", () => {
  test("the serving pid is killed directly and its records cleared", async () => {
    const h = reclaimHarness();
    const outcome = await reclaimProxyForServiceRestart(h.deps);

    expect(outcome).toEqual({ previousPid: 4242, reclaimedPid: 4242 });
    expect(h.killed).toEqual([4242]);
    expect(h.clearedPids).toEqual([4242]);
    expect(h.clearedPorts).toEqual([4242]);
  });

  test("an orphaned child found only by identity probe is still reclaimed", async () => {
    // The wrapper can respawn its child after a stop that already removed the pid file, so the
    // tracked record is not the only place a survivor can come from.
    const h = reclaimHarness({ tracked: null, live: { pid: 777 } });
    const outcome = await reclaimProxyForServiceRestart(h.deps);

    expect(outcome).toEqual({ previousPid: 777, reclaimedPid: 777 });
    expect(h.killed).toEqual([777]);
  });

  test("a pid that fails identity verification is never killed", async () => {
    // Reusing a recorded pid is how a restart kills an unrelated process. The stop path already
    // refuses to act on an unverified pid; the reclaim must not be a softer door to the same
    // mistake, and it must not silently claim it replaced anything either.
    const h = reclaimHarness({ tracked: 4242, live: { pid: null }, unverified: true });
    const outcome = await reclaimProxyForServiceRestart(h.deps);

    expect(h.killed).toEqual([]);
    expect(outcome).toEqual({ previousPid: null, reclaimedPid: null });
  });

  test("a dead tracked pid clears its stale records without killing anything", async () => {
    const h = reclaimHarness({ tracked: 5150, live: null, alivePids: [] });
    const outcome = await reclaimProxyForServiceRestart(h.deps);

    expect(h.killed).toEqual([]);
    expect(h.clearedPids).toEqual([5150]);
    expect(outcome.reclaimedPid).toBeNull();
  });
});

describe("restart replacement wait", () => {
  test("returns as soon as a different pid answers", async () => {
    let probes = 0;
    const pid = await waitForReplacementProxy(4242, {
      findProxy: async () => { probes += 1; return probes < 3 ? { pid: 4242 } : { pid: 4243 }; },
      now: () => 0,
      sleep: async () => {},
    });

    expect(pid).toBe(4243);
  });

  test("the same pid answering for the whole budget is not a replacement", async () => {
    // This is the exact false success the fix exists for: the old child keeps answering, so a
    // health-only check would call the restart done.
    let current = 0;
    const pid = await waitForReplacementProxy(4242, {
      findProxy: async () => ({ pid: 4242 }),
      now: () => current,
      sleep: async (ms: number) => { current += ms; },
      timeoutMs: 2000,
    });

    expect(pid).toBeNull();
  });

  test("a pidless listener never counts as the replacement", async () => {
    // A legacy /healthz body reports no pid. Accepting it would let a surviving old process be
    // certified as its own replacement, which is the bug wearing a different hat.
    let current = 0;
    const pid = await waitForReplacementProxy(4242, {
      findProxy: async () => ({ pid: null }),
      now: () => current,
      sleep: async (ms: number) => { current += ms; },
      timeoutMs: 1000,
    });

    expect(pid).toBeNull();
  });

  test("a probe failure is unknown, not a replacement", async () => {
    let current = 0;
    let probes = 0;
    const pid = await waitForReplacementProxy(4242, {
      findProxy: async () => {
        probes += 1;
        if (probes === 1) throw new Error("connection refused");
        return { pid: 9001 };
      },
      now: () => current,
      sleep: async (ms: number) => { current += ms; },
    });

    expect(pid).toBe(9001);
  });
});

describe("restart command wiring", () => {
  const cli = () => readFileSync(repoPath("src/service/cli.ts"), "utf-8");

  test("the restart path reclaims directly instead of asking the proxy to stop", async () => {
    const source = cli();
    const branch = source.slice(source.indexOf('if (command === "repair" || command === "restart")'), source.indexOf('// Non-install subcommands follow the backend'));

    expect(branch).toContain("reclaimProxyForServiceRestart()");
    // The management-API stop is what the respawnable wrapper refuses; keeping it here would
    // reinstate the warning-and-continue that left the old process serving.
    expect(branch).not.toContain("stopTrackedProxyForServiceCommand");
    // Task and launchers end first: killing the child while the wrapper's :loop still runs just
    // hands the port to its respawn a few seconds later.
    expect(branch.indexOf("stopWindows();")).toBeLessThan(branch.indexOf("reclaimProxyForServiceRestart()"));
    expect(branch.indexOf("killWindowsServiceWrapperProcesses();")).toBeLessThan(branch.indexOf("reclaimProxyForServiceRestart()"));
  });

  test("a restart that kept the old pid fails instead of printing success", async () => {
    const source = cli();
    const branch = source.slice(source.indexOf('if (command === "repair" || command === "restart")'), source.indexOf('// Non-install subcommands follow the backend'));

    expect(branch).toContain("await waitForReplacementProxy(previousPid");
    expect(branch.indexOf("await repairService({ verb });")).toBeLessThan(branch.indexOf("await waitForReplacementProxy(previousPid"));
    expect(branch).toContain("so the running process was not replaced");
    // The throw has to land in the branch that reports, not escape the command: the operator
    // needs the failure AND whether anything is answering the port.
    expect(branch.indexOf("await waitForReplacementProxy(previousPid")).toBeLessThan(branch.indexOf("repairError = error;"));
  });

  test("an unreadable Task Scheduler state refuses before anything is stopped", async () => {
    // '/end' on a task whose state cannot be read either misses the running instance or ends
    // someone else's registration; either way the reclaim that follows would be a guess.
    const source = cli();
    const branch = source.slice(source.indexOf('if (command === "repair" || command === "restart")'), source.indexOf('// Non-install subcommands follow the backend'));

    expect(branch).toContain('scheduler.status === "unknown"');
    expect(branch.indexOf('scheduler.status === "unknown"')).toBeLessThan(branch.indexOf("stopWindows();"));
  });
});
