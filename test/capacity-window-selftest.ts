/**
 * Self-test for the provider-scoped capacity window (2026-10-12).
 *
 * One open window used to cost every request in it the full ladder (5 sends, 100-409s).
 * The window module is the shared memory that trims the ladder to one short rung while the
 * provider is provably shedding, and restores the full ladder four minutes after the last
 * ladder-exhausted failure.
 *
 * Run: bun test/capacity-window-selftest.ts
 */
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const {
  noteProviderCapacityShed,
  capacityWindowActive,
  clearCapacityWindowsForTests,
} = await import(PKG + "/providers/capacity-window.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const T0 = 1_800_000_000_000;

// One failure is not a window; two are (2026-10-13: the shelf fails in clusters spread over
// several minutes, and the old three-in-four-minutes rule never activated on the observed
// sequence 10:30:35 / 10:30:37 / 10:36:16 / 10:39:04).
clearCapacityWindowsForTests();
noteProviderCapacityShed("openai", T0);
check("one shed failure does not open the window", !capacityWindowActive("openai", T0 + 500));
noteProviderCapacityShed("openai", T0 + 1_000);
check("two shed failures open the window", capacityWindowActive("openai", T0 + 2_000));

// The judgement is per provider: a sibling never inherits the window.
check("sibling provider is unaffected", !capacityWindowActive("ciii-codex", T0 + 4_000));

// A failure inside the window keeps it open (rolling refresh)...
noteProviderCapacityShed("openai", T0 + 200_000);
check("a later failure refreshes the window", capacityWindowActive("openai", T0 + 230_000));

// ...and eight quiet minutes close it, restoring the full ladder.
check("window ages out after eight quiet minutes", !capacityWindowActive("openai", T0 + 200_000 + 8 * 60_000 + 1_000));
check("and stays closed", !capacityWindowActive("openai", T0 + 200_000 + 10 * 60_000));

// Fresh failures after the quiet period open it again.
noteProviderCapacityShed("openai", T0 + 900_000);
noteProviderCapacityShed("openai", T0 + 901_000);
check("the window can reopen", capacityWindowActive("openai", T0 + 903_000));

// An unmatched provider name is never active.
check("unknown provider is not active", !capacityWindowActive("nobody", T0 + 903_000));
check("undefined provider is not active", !capacityWindowActive(undefined, T0 + 903_000));

console.log(failures === 0 ? "ALL CAPACITY WINDOW CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
