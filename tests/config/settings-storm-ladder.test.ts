/**
 * /api/settings round-trip for the reset-storm coordinator and the capacity ladder.
 *
 * Both knobs are pure in-memory wiring keyed off config.json (loadConfig re-reads them on
 * every config load), so the PUT must persist the block, rewire the running process, and
 * survive a reload -- the whole point is that an operator change never needs a restart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { capacityLadderDelays, configureCapacityLadder } from "../../src/lib/capacity-ladder";
import { configureResetStorm, resetStorm } from "../../src/lib/reset-storm";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import type { OcxConfig } from "../../src/types";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let TEST_DIR = "";
const previousHome = process.env.OPENCODEX_HOME;
const readTestStartupHealth: NonNullable<ManagementApiDeps["getCachedStartupHealth"]> = async () => (
  startupHealthFixture()
);

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x", defaultModel: "gpt-test" },
    },
  };
}

function settingsRequest(config: OcxConfig, body?: unknown): Promise<Response | null> {
  const req = body === undefined
    ? new Request("http://127.0.0.1:10100/api/settings", { headers: { host: "127.0.0.1:10100" } })
    : new Request("http://127.0.0.1:10100/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", host: "127.0.0.1:10100" },
      body: JSON.stringify(body),
    });
  return handleManagementAPI(req, new URL(req.url), config, {
    getCachedStartupHealth: readTestStartupHealth,
  });
}

beforeEach(() => {
  invalidateStartupHealthCache();
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-settings-storm-ladder-"));
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  invalidateStartupHealthCache();
  // The ladder and the storm coordinator are process-global: leave them disarmed.
  configureCapacityLadder(undefined);
  configureResetStorm(undefined);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (TEST_DIR && existsSync(TEST_DIR)) {
    try { removeTreeWithRetry(TEST_DIR); } catch { /* Windows handle retention */ }
  }
});

describe("/api/settings resetStorm + capacityRetry", () => {
  test("an unconfigured install reports both blocks as null", async () => {
    const res = await settingsRequest(baseConfig());
    const body = await res!.json() as { resetStorm?: unknown; capacityRetry?: unknown };
    expect(body.resetStorm).toBeNull();
    expect(body.capacityRetry).toBeNull();
  });

  test("resetStorm persists, rewires live, and survives a reload", async () => {
    const config = baseConfig();
    saveConfig(config);
    const put = await settingsRequest(config, { resetStorm: { enabled: true } });
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({ ok: true, resetStorm: { enabled: true } });
    // The write persists the resolved block: every knob explicit, like a hand-written file.
    expect(config.resetStorm).toMatchObject({ enabled: true });
    expect(loadConfig().resetStorm).toMatchObject({ enabled: true });
    expect(resetStorm().config().enabled).toBe(true);
  });

  test("capacityRetry persists, rewires the running ladder, and survives a reload", async () => {
    const config = baseConfig();
    saveConfig(config);
    const ladder = { enabled: true, delaysMs: [5000, 12000] };
    const put = await settingsRequest(config, { capacityRetry: ladder });
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({ ok: true, capacityRetry: ladder });
    expect(capacityLadderDelays()).toEqual([5000, 12000]);
    expect(loadConfig().capacityRetry).toEqual(ladder);
  });

  test("null clears both keys and disarms the ladder", async () => {
    const config = baseConfig();
    saveConfig(config);
    const put = await settingsRequest(config, {
      resetStorm: { enabled: true },
      capacityRetry: { enabled: true, delaysMs: [5000] },
    });
    expect(put!.status).toBe(200);
    expect(capacityLadderDelays()).toEqual([5000]);
    const clear = await settingsRequest(config, { resetStorm: null, capacityRetry: null });
    expect(clear!.status).toBe(200);
    expect(await clear!.json()).toMatchObject({ ok: true, resetStorm: null, capacityRetry: null });
    expect(config.resetStorm).toBeUndefined();
    expect(config.capacityRetry).toBeUndefined();
    expect(resetStorm().config().enabled).toBe(false);
    expect(capacityLadderDelays()).toBeNull();
    expect(loadConfig().resetStorm).toBeUndefined();
    expect(loadConfig().capacityRetry).toBeUndefined();
  });

  test("malformed blocks are rejected and change nothing", async () => {
    const config = baseConfig();
    saveConfig(config);
    const slow = await settingsRequest(config, { capacityRetry: { enabled: true, delaysMs: [50] } });
    expect(slow!.status).toBe(400);
    const lanes = await settingsRequest(config, { resetStorm: { minLanes: 1 } });
    expect(lanes!.status).toBe(400);
    const unknownKey = await settingsRequest(config, { resetStorm: { enabled: true, nope: true } });
    expect(unknownKey!.status).toBe(400);
    expect(config.capacityRetry).toBeUndefined();
    expect(config.resetStorm).toBeUndefined();
    expect(capacityLadderDelays()).toBeNull();
    expect(loadConfig().capacityRetry).toBeUndefined();
    expect(loadConfig().resetStorm).toBeUndefined();
  });
});
