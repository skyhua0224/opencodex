/**
 * Where this fork's updates come from.
 *
 * The package keeps upstream's install machinery (npm/pnpm/bun, ownership detection, the stop
 * -then-install transaction), but NOT upstream's source: asking the public registry for
 * `@bitkyc08/opencodex` would install the official build over this fork, which is exactly the
 * failure this module exists to prevent. The source is therefore this repository's own GitHub
 * releases, and the install spec is the packed tarball attached to one.
 *
 * `OCX_UPDATE_REPO` points the lookup at another repository (a private mirror, say), and
 * `OCX_UPDATE_SPEC` replaces the install spec outright with a `{version}`/`{tag}` template —
 * the hook for publishing under an npm scope later without touching code.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FORK_REPO = process.env.OCX_UPDATE_REPO?.trim() || "skyhua0224/opencodex";

export function forkReleaseNotesUrl() {
  return `https://github.com/${FORK_REPO}/releases/latest`;
}

/** Name of the packed tarball this fork attaches to every release. */
export function forkReleaseAssetName(version) {
  return `opencodex-${version}.tgz`;
}

/** The install spec a package manager is handed for one resolved version. */
export function forkInstallSpec(version, tag) {
  const template = process.env.OCX_UPDATE_SPEC?.trim();
  if (template) {
    return template.replaceAll("{version}", version).replaceAll("{tag}", tag ?? `v${version}`);
  }
  return `https://github.com/${FORK_REPO}/releases/download/${tag ?? `v${version}`}/${forkReleaseAssetName(version)}`;
}

/**
 * The newest released version on a channel, or null when the source cannot be read.
 *
 * Synchronous on purpose: it is called from the launcher and from pre-flight checks that run
 * before the proxy is stopped, and from the notification cache on the CLI's cold path. The fetch
 * itself happens in a child of the same runtime, so it works under both node and bun without
 * pulling a network client into either.
 */
export function resolveForkRelease(channel, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const runtime = options.runtime ?? process.execPath;
  let result;
  try {
    result = spawn(runtime, forkReleaseWorkerArgs(channel), {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 12_000,
      windowsHide: true,
      env: { ...process.env, OCX_UPDATE_WORKER: "1" },
    });
  } catch {
    return null;
  }
  if (!result || result.status !== 0 || typeof result.stdout !== "string") return null;
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.version === "string" && parsed.version.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** argv for a caller that spawns the lookup itself (the async background check). */
export function forkReleaseWorkerArgs(channel) {
  return [join(HERE, "fork-release-worker.mjs"), channel, FORK_REPO];
}
