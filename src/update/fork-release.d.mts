import type { spawnSync } from "node:child_process";

/** Where this fork's updates come from; see fork-release.mjs. */
export declare const FORK_REPO: string;

export interface ForkRelease {
  version: string;
  tag: string;
  notesUrl?: string | undefined;
  tarballUrl?: string | undefined;
  digest?: string | undefined;
}

export interface ForkReleaseDeps {
  spawn?: typeof spawnSync;
  runtime?: string;
  timeoutMs?: number;
}

export declare function forkReleaseNotesUrl(): string;

export declare function forkReleaseAssetName(version: string): string;

export declare function forkInstallSpec(version: string, tag?: string): string;

export declare function forkReleaseWorkerArgs(channel: string): string[];

export declare function resolveForkRelease(
  channel: string,
  options?: ForkReleaseDeps,
): ForkRelease | null;
