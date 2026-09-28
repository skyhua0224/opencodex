/**
 * Resolve this fork's newest published release, for both runtimes the proxy ships on.
 *
 * Runs as a child process (node or bun) so the caller can stay synchronous, which is what the
 * launcher and the pre-flight checks are. Prints one JSON object on success and nothing at all
 * when the source cannot be read: a release lookup must never fail an update, it may only leave
 * one unavailable.
 *
 * Usage: <runtime> fork-release-worker.mjs <channel> [repo]
 */
const channel = process.argv[2] === "preview" ? "preview" : "latest";
const repo = process.argv[3] || "skyhua0224/opencodex";

function fail() {
  process.exit(0);
}

try {
  const response = await fetch("https://api.github.com/repos/" + repo + "/releases?per_page=30", {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "opencodex-fork-update",
      ...(process.env.GITHUB_TOKEN ? { authorization: "Bearer " + process.env.GITHUB_TOKEN } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail();
  const releases = await response.json();
  if (!Array.isArray(releases)) fail();
  const usable = releases.filter(entry => entry
    && typeof entry === "object"
    && entry.draft !== true
    && typeof entry.tag_name === "string"
    && (channel === "preview" || entry.prerelease !== true));
  const release = usable[0];
  if (!release) fail();
  const version = release.tag_name.replace(/^v/, "");
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const tarball = assets.find(asset => typeof asset?.name === "string" && asset.name.endsWith(".tgz"));
  process.stdout.write(JSON.stringify({
    version,
    tag: release.tag_name,
    notesUrl: typeof release.html_url === "string" ? release.html_url : undefined,
    tarballUrl: typeof tarball?.browser_download_url === "string" ? tarball.browser_download_url : undefined,
    digest: typeof tarball?.digest === "string" ? tarball.digest : undefined,
  }));
} catch {
  fail();
}
