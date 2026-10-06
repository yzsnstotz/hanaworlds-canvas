#!/bin/sh
# Canvas 0.4.0 region gate: region v1 commit / rollback / compressed snapshot /
# reopen + whole-region Undo plus the unchanged cell path, from an exact clean
# commit, on source and on the actual packed tar. Adapter is an explicit fixture.
# Usage: sh scripts/gate-region-undo-040.sh <canvas-commit> <new-evidence-dir>
set -eu

commit=$1
out=$2
contracts_tar=/Users/yzliu/.cache/hanaworlds-runs/S1-CONTRACT-LOCAL-WORLD-01/material-sources-20261007/_evidence/final/hanaworlds-contracts-0.4.2.tgz
contracts_sha=c3528a4fc3f0cdf94245c4d2d8b1cfa5d28db96d1cd00ae74737bdbdfcd26ec6
old_canvas_tar=/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-LOCAL-WORLD-01/image-contracts-042/_evidence/gate-651d9dbc/hanaworlds-canvas-0.3.3.tgz
old_canvas_sha=c23b94f5f30b0c3350c3d2316f36a87dcacd4cbdba5706a766a239f99f4cecea
repo=$(cd "$(dirname "$0")/.." && pwd)
node_run() { npx --yes node@24.13.1 "$@"; }
tests="test/local-world.test.mjs test/region-undo.test.mjs"

test ! -e "$out"
mkdir -p "$out"
work=$(mktemp -d "${TMPDIR:-/tmp}/canvas-gate-040.XXXXXX")
trap 'rm -rf "$work"' EXIT
log() { printf '%s\n' "$*" | tee -a "$out/gate.log"; }

test -z "$(git -C "$repo" status --porcelain)"
test "$(git -C "$repo" rev-parse "$commit^{commit}")" = "$(git -C "$repo" rev-parse HEAD)"
log "canvas commit $commit (clean)"
printf '%s  %s\n' "$contracts_sha" "$contracts_tar" | shasum -a 256 -c - >> "$out/gate.log"
printf '%s  %s\n' "$old_canvas_sha" "$old_canvas_tar" | shasum -a 256 -c - >> "$out/gate.log"

# 1. exact commit -> fresh source tree, lockfile install, build, tests
mkdir "$work/src"
git -C "$repo" archive "$commit" | tar -x -C "$work/src"
(cd "$work/src" && npx --yes --package=node@24.13.1 -c 'npm ci --ignore-scripts --no-audit --no-fund') > "$out/source-npm-ci.log" 2>&1
(cd "$work/src" && npx --yes --package=node@24.13.1 -c 'npm run build') > "$out/source-build.log" 2>&1
(cd "$work/src" && node_run --test $tests) > "$out/source-test.log" 2>&1
log "source build+test PASS: $(grep -E '^ℹ (pass|fail) ' "$out/source-test.log" | tr '\n' ' ')"

# 2. pinned Contracts resolved from lockfile == actual 0.4.2 tar bytes
mkdir "$work/ctar"
tar -xzf "$contracts_tar" -C "$work/ctar"
(cd "$work/ctar/package" && find . -type f ! -name package.json | sort) > "$work/cfiles"
while read -r f; do cmp "$work/ctar/package/$f" "$work/src/node_modules/hanaworlds-contracts/$f"; done < "$work/cfiles"
log "installed contracts == c3528a4f tar: $(wc -l < "$work/cfiles" | tr -d ' ') files identical (package.json rewritten by npm)"

# 3. actual pack, isolated install, installed-package tests
(cd "$work/src" && npm pack --pack-destination "$out" --json) > "$out/pack.json"
tarball="$out/hanaworlds-canvas-0.4.0.tgz"
shasum -a 256 "$tarball" > "$out/sha256.txt"
mkdir -p "$work/rt/test"
npm install --prefix "$work/rt" --ignore-scripts --no-audit --no-fund "$tarball" > "$out/packed-install.log" 2>&1
for f in src/index.mjs src/local-v5.mjs src/store-v5.mjs src/region-v1.mjs; do
  cmp "$work/src/$f" "$work/rt/node_modules/hanaworlds-canvas/$f"; done
for t in $tests; do
  sed "s#'../src/index.mjs'#'hanaworlds-canvas'#" "$work/src/$t" > "$work/rt/$t"; done
(cd "$work/rt" && node_run --test $tests) > "$out/packed-runtime-test.log" 2>&1
log "packed 0.4.0 install+test PASS: $(grep -E '^ℹ (pass|fail) ' "$out/packed-runtime-test.log" | tr '\n' ' ')"

# 4. previous 0.3.3 tar with the region test: must fail (no region transaction)
mkdir -p "$work/old/test"
npm install --prefix "$work/old" --ignore-scripts --no-audit --no-fund "$old_canvas_tar" > "$out/old-033-install.log" 2>&1
cp "$work/rt/test/region-undo.test.mjs" "$work/old/test/"
if (cd "$work/old" && node_run --test test/region-undo.test.mjs) > "$out/old-033-red.log" 2>&1; then
  log "old 0.3.3 unexpectedly passed"; exit 1; fi
grep -q "CanvasRegionV1" "$out/old-033-red.log"
log "old 0.3.3 red on region test (expected: no CanvasRegionV1)"

# 5. public export difference 0.3.3 -> 0.4.0 (cell canvas/v5 surface must stay)
cat > "$work/surface.mjs" <<'JS'
const canvas = await import('hanaworlds-canvas');
console.log(JSON.stringify({ canvasExports: Object.keys(canvas).sort() }));
JS
cp "$work/surface.mjs" "$work/rt/surface.mjs"; cp "$work/surface.mjs" "$work/old/surface.mjs"
(cd "$work/rt" && node_run surface.mjs) > "$out/surface-040.json"
(cd "$work/old" && node_run surface.mjs) > "$out/surface-033.json"
node_run -e '
const fs = require("node:fs");
const [a, b] = process.argv.slice(1).map(f => JSON.parse(fs.readFileSync(f)).canvasExports);
const removed = a.filter(x => !b.includes(x)), added = b.filter(x => !a.includes(x));
console.log(JSON.stringify({ removed, added }));
if (removed.length) process.exit(1);
' "$out/surface-033.json" "$out/surface-040.json" > "$out/surface-diff.json"
log "surface diff: $(cat "$out/surface-diff.json")"
log "gate exit 0"
