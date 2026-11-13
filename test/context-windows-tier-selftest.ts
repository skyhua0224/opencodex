/**
 * Self-test for context_windows tier arrays (2026-10-15).
 *
 * xAI's Build gateway reports a single context_window (the DEFAULT tier, 256k for grok-4.7)
 * next to a context_windows array listing the selectable tiers ([256000, 500000]). Reading
 * only the single value published 256k for a model xAI documents as a 500k window, and the
 * config-only-lowers clamp then made an operator-configured 500k unreachable.
 *
 * Run: bun test/context-windows-tier-selftest.ts
 */
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { contextWindowTierMax, catalogHintsFromModelsApiItem } = await import(PKG + "/codex/catalog/model-hints.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

// The helper itself.
check("the tier array's maximum wins", contextWindowTierMax([256000, 500000]) === 500000);
check("a single-tier array still resolves", contextWindowTierMax([256000]) === 256000);
check("sorts are irrelevant", contextWindowTierMax([500000, 256000]) === 500000);
check("invalid entries are filtered", contextWindowTierMax([0, -5, "x", null, 500000]) === 500000);
check("a missing array yields undefined", contextWindowTierMax(undefined) === undefined);
check("a non-array yields undefined", contextWindowTierMax(256000) === undefined);
check("an empty array yields undefined", contextWindowTierMax([]) === undefined);

// The gateway row: single default value PLUS the tier array -> the array's maximum is the window.
const gatewayRow = {
  id: "grok-4.7",
  context_window: 256000,
  context_windows: [256000, 500000],
} as never;
const hints = catalogHintsFromModelsApiItem("xai", gatewayRow);
check("the gateway row resolves to the 500k tier", hints.contextWindow === 500000, "got " + String(hints.contextWindow));

// A provider WITHOUT the array keeps its previous single-value resolution exactly.
const plainRow = { id: "some-model", context_window: 128000 } as never;
const plain = catalogHintsFromModelsApiItem("elsewhere", plainRow);
check("a row without the array is unchanged", plain.contextWindow === 128000, "got " + String(plain.contextWindow));

console.log(failures === 0 ? "ALL CONTEXT-WINDOW TIER CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
