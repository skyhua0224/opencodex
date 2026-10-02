#!/usr/bin/env bash
# Pack one fork release, with the GUI inside it.
#
# The dashboard lives in gui/dist, which the repository does not track: a tarball packed without
# building it first installs fine and then answers /healthz with dashboard.available=false, which is
# exactly what shipped in 2.69.0-skyhua.3 (90 gui/dist files in the .1 tarball, 0 in the .3 one).
# This script builds when the build is missing, so packing cannot silently forget it.
#
# Usage: tools/fork-release-pack.sh [outdir]   (default /tmp/ocx-pack)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-/tmp/ocx-pack}"
cd "$root"

version="$(node -p "require('./package.json').version")"
echo "packing fork release $version into $out"

if [ ! -f gui/dist/index.html ]; then
  echo "gui/dist is missing - building the dashboard first"
  ( cd gui && bun install --frozen-lockfile && bun run build )
fi
test -f gui/dist/index.html || { echo "gui/dist/index.html still missing; refusing to pack" >&2; exit 1; }

mkdir -p "$out"
npm pack --pack-destination "$out"
mv -f "$out"/bitkyc08-opencodex-"$version".tgz "$out"/opencodex-"$version".tgz

# Match on the captured listing rather than piping into grep -q: under pipefail a grep that exits
# early sends SIGPIPE to tar and the pipeline reports failure even when the match succeeded.
listing="$(tar -tzf "$out"/opencodex-"$version".tgz)"
case "$listing" in
  *"package/gui/dist/index.html"*) ;;
  *) echo "the tarball has no dashboard; refusing to hand it out" >&2; exit 1 ;;
esac
echo "dashboard files in the tarball: $(printf '%s\n' "$listing" | grep -c 'package/gui/dist/')"

# A second copy under a version-free name, so the README can hand readers ONE command:
#   npm install -g https://github.com/skyhua0224/opencodex/releases/latest/download/opencodex-skyhua.tgz
# `releases/latest/download/<name>` resolves the newest non-prerelease that carries that name, so
# the alias has to be attached to every cut -- a release that ships only the versioned asset leaves
# that command 404ing against the previous one. The versioned asset stays authoritative: it is what
# `ocx update` reads, and its bytes are the ones this file just verified.
cp -f "$out"/opencodex-"$version".tgz "$out"/opencodex-skyhua.tgz
cmp -s "$out"/opencodex-skyhua.tgz "$out"/opencodex-"$version".tgz \
  || { echo "the alias copy does not match the packed tarball; refusing to hand it out" >&2; exit 1; }

echo
echo "asset:   $out/opencodex-$version.tgz"
echo "sha256:  $(shasum -a 256 "$out"/opencodex-"$version".tgz | cut -d' ' -f1)"
echo "alias:   $out/opencodex-skyhua.tgz (same bytes; the version-free install URL)"
echo "attach:  gh release create v$version -R skyhua0224/opencodex --latest \\"
echo "           --title \"v$version - ...\" --notes-file /tmp/notes.md \\"
echo "           $out/opencodex-$version.tgz $out/opencodex-skyhua.tgz"
echo
echo "README install line:"
echo "  npm install -g https://github.com/skyhua0224/opencodex/releases/latest/download/opencodex-skyhua.tgz"
