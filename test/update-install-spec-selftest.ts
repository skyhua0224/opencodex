/**
 * Self-test for the transactional updater's install spec (2026-10-12).
 *
 * ocx update resolves its target from this fork's GitHub releases and stages the packed
 * tarball next to the live tree. The staging install used to hand npm
 * @bitkyc08/opencodex@<version> -- a spec the public registry has never carried -- so every
 * npm-managed update died with "npm error code ETARGET / notarget No matching version found
 * for @bitkyc08/opencodex@2.80.0-skyhua.3." after the proxy had already been stopped. The spec
 * must be the release tarball URL from the fork source module, and an unresolved target must
 * fail closed instead of falling back to the registry.
 *
 * Run: bun test/update-install-spec-selftest.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG = new URL("../src", import.meta.url).pathname.replace(new RegExp("/$"), "");
const { transactionalNpmUpdate } = await import(PKG + "/update/transactional-install.mjs");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "ocx-update-spec-"));
  const packageDir = join(root, "opencodex");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: "2.80.0-skyhua.3" }));
  return { root, packageDir };
}

const EXPECTED = "https://github.com/skyhua0224/opencodex/releases/download/v2.80.0-skyhua.4/opencodex-2.80.0-skyhua.4.tgz";

// A resolved version stages the fork release tarball, never a registry spec.
{
  const { root, packageDir } = makeTree();
  const calls: string[][] = [];
  const result = transactionalNpmUpdate({
    packageDir,
    pkgName: "@bitkyc08/opencodex",
    targetVersion: "2.80.0-skyhua.4",
    tag: "latest",
    runNpm: (args: string[]) => { calls.push(args); return { status: 1 }; },
    log: () => {},
  });
  const args = calls[0] ?? [];
  const spec = args[args.length - 1] ?? "";
  check("npm is handed the release tarball URL", spec === EXPECTED, spec || "(no args)");
  check("no registry spec appears in argv", !args.some(part => part.includes("@bitkyc08/opencodex@")));
  check("the injectable npm runner performed the staging call", calls.length === 1);
  check("a failing stage is reported with live untouched", result.ok === false && result.phase === "stage", JSON.stringify(result));
  rmSync(root, { recursive: true, force: true });
}

// An unresolved target fails closed before npm is invoked.
{
  const { root, packageDir } = makeTree();
  const calls: string[][] = [];
  const result = transactionalNpmUpdate({
    packageDir,
    pkgName: "@bitkyc08/opencodex",
    targetVersion: "latest",
    tag: "latest",
    runNpm: (args: string[]) => { calls.push(args); return { status: 0 }; },
    log: () => {},
  });
  check("unresolved target fails closed", result.ok === false && /registry/.test(result.error ?? ""), result.error ?? "");
  check("npm is never invoked for an unresolved target", calls.length === 0);
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "ALL UPDATE INSTALL-SPEC CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
