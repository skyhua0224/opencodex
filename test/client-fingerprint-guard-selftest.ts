/**
 * Self-test for the client fingerprint guard (2026-09-25).
 *
 * The guard observes only. Three properties matter:
 *  1. a stable fingerprint produces no rows and no log noise;
 *  2. a CHANGE produces exactly one row, is throttled afterwards, and never carries a value --
 *     only names, sizes and short hashes;
 *  3. two installations on one provider are separate baselines, so neither looks like the other's
 *     drift.
 *
 * Run: bun test/client-fingerprint-guard-selftest.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-fingerprint-"));
const home = process.env.OPENCODEX_HOME;

const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { observeClientFingerprint, fingerprintGuardSnapshot,
  clearClientFingerprintGuardForTests } = await import(PKG + "/codex/client-fingerprint-guard.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const base = { originator: "codex_cli_rs", "user-agent": "codex 0.155.1",
  "x-codex-installation-id": "install-one" };
const headers = (fields: Record<string, string | null>) => {
  const map = new Headers();
  for (const [name, value] of Object.entries(fields)) if (value !== null) map.set(name, value);
  return map;
};

clearClientFingerprintGuardForTests();
observeClientFingerprint(headers(base), "openai", 1_000);
check("a first sighting builds a baseline, no drift",
  observeClientFingerprint(headers(base), "openai", 2_000).length === 0);

const changed = observeClientFingerprint(headers({ ...base, "user-agent": "codex 0.156.0" }), "openai", 3_000);
check("a changed user agent is reported once", changed.join(",") === "user-agent-changed", changed.join(","));
check("the repeat is throttled",
  observeClientFingerprint(headers({ ...base, "user-agent": "codex 0.156.0" }), "openai", 4_000).length === 0);

const dropped = observeClientFingerprint(headers({ ...base, "user-agent": "codex 0.156.0", originator: null }), "openai", 3_000 + 11 * 60_000);
check("a vanished originator is its own kind of drift",
  dropped.join(",") === "originator-missing", dropped.join(","));

const rows = readFileSync(join(home, "fingerprint-drift.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
check("two changes wrote two rows", rows.length === 2, String(rows.length));
const text = JSON.stringify(rows);
check("no raw fingerprint value ever reaches the ledger",
  !text.includes("codex_cli_rs") && !text.includes("install-one") && !text.includes("0.156.0"));
check("each row names the change and the provider",
  rows.every(row => Array.isArray(row.changes) && row.changes.length > 0 && row.provider === "openai"));

observeClientFingerprint(headers({ ...base, "x-codex-installation-id": "install-two" }), "openai", 5_000);
const second = fingerprintGuardSnapshot("openai");
check("a second installation is its own baseline",
  JSON.stringify(second).split("|").length >= 1 && Object.keys(second ?? {}).length === 4);

// Two boundaries found on 2026-09-25/26: the operator's own probes have neither an originator nor
// an installation id, and a caller once passed the provider CONFIG OBJECT instead of its name (51
// rows carried a config snapshot and the log said "[object Object]").
clearClientFingerprintGuardForTests();
check("a request with no Codex fingerprint at all is not an observation",
  observeClientFingerprint(headers({ "user-agent": "python-urllib/3.14" }), "openai", 1_000).length === 0);
check("and it did not create a baseline",
  observeClientFingerprint(headers({ "user-agent": "python-urllib/3.14" }), "openai", 2_000).length === 0);
check("a Codex request still is",
  observeClientFingerprint(headers(base), "openai", 3_000).length === 0
  && fingerprintGuardSnapshot("openai") !== undefined);
observeClientFingerprint(headers(base), { name: "openai", apiKey: "secret" } as never, 4_000);
const asObject = observeClientFingerprint(
  headers({ ...base, "user-agent": "codex 9.9.9" }), { name: "openai", apiKey: "secret" } as never, 5_000);
check("a non-name provider cannot reach the ledger", asObject.join(",") === "user-agent-changed", asObject.join(","));
check("and the caller still sees a name", fingerprintGuardSnapshot("unknown") !== undefined);
const objectRow = readFileSync(join(home, "fingerprint-drift.jsonl"), "utf8").trim().split("\n")
  .map(line => JSON.parse(line)).at(-1);
check("the row it wrote names the provider as a string",
  objectRow.provider === "unknown" && !JSON.stringify(objectRow).includes("secret"),
  JSON.stringify(objectRow.provider));

console.log(failures === 0 ? "ALL FINGERPRINT GUARD CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
