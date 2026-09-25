/**
 * Self-test for the quality hold: the one router input that saw the CONTENT.
 *
 *  1. the file contract: a valid hold holds, an expired one does not, an absurd one is ignored,
 *     a malformed file never throws;
 *  2. the routing consequence: a held provider loses its turn to a clean sibling, but a combo
 *     whose ONLY row is held still answers -- a quality hold is a demotion, never "no targets";
 *  3. the cache: rewriting the file is picked up without a restart.
 *
 * Run: bun test/quality-holds-selftest.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-quality-"));
const home = process.env.OPENCODEX_HOME;

const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { providerQualityHeld, providerQualityHold, clearQualityHoldCacheForTests } =
  await import(PKG + "/providers/quality-holds.ts");
const { pickComboTarget, clearComboSelectionStateForTests } = await import(PKG + "/combos/resolve.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const now = Date.now();
function writeHolds(holds: unknown): void {
  clearQualityHoldCacheForTests();
  writeFileSync(join(home, "quality-holds.json"), JSON.stringify({ version: 1, holds }, null, 2));
}

writeHolds({
  "held-relay": { until: now + 3_600_000, since: now - 60_000, model: "gpt-5.6-sol",
    reason: "candy-21: answered 29, expected 21", failedRounds: 1 },
  "expired-relay": { until: now - 1_000, since: now - 7_200_000 },
  "absurd-relay": { until: now + 100 * 3_600_000, since: now },
});
check("a fresh hold holds its provider", providerQualityHeld("held-relay"));
check("the hold carries its evidence", providerQualityHold("held-relay")?.reason?.includes("candy-21") === true);
check("an expired hold does not", providerQualityHeld("expired-relay") === false);
check("a hold past the safety span is ignored", providerQualityHeld("absurd-relay") === false);
check("an unknown provider is not held", providerQualityHeld("clean-relay") === false);

writeHolds({ "held-relay": { until: "tomorrow", since: "yesterday" } });
check("a malformed hold is ignored, not thrown", providerQualityHeld("held-relay") === false);

writeHolds({ "held-relay": { until: now + 3_600_000, since: now - 60_000 } });
check("a rewritten file is read back without a restart", providerQualityHeld("held-relay"));

const config = {
  providers: {
    "held-relay": { name: "held", baseUrl: "https://held.example", adapter: "openai-responses" },
    "clean-relay": { name: "clean", baseUrl: "https://clean.example", adapter: "openai-responses" },
  },
  combos: {
    both: { targets: [{ provider: "held-relay", model: "m" }, { provider: "clean-relay", model: "m" }] },
    only: { targets: [{ provider: "held-relay", model: "m" }] },
  },
} as never;

clearComboSelectionStateForTests?.();
const both = pickComboTarget(config, "both", { now });
check("a held row loses its turn to a clean sibling", both?.target.provider === "clean-relay",
  "picked " + String(both?.target.provider));
const only = pickComboTarget(config, "only", { now });
check("a combo whose only row is held still answers", only?.target.provider === "held-relay",
  "picked " + String(only?.target.provider));

console.log(failures === 0 ? "ALL QUALITY HOLD CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
