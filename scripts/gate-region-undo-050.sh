#!/bin/sh
# Canvas 0.5.0 region gate: Contracts 0.5.0 canvas-region/v1 commit / rollback /
# compressed snapshot / reopen + whole-region Undo / protocol major, plus the
# unchanged cell path, from an exact clean commit, on source and on the actual
# packed tar. The Adapter region port is an explicit public-shape fixture.
# Usage: sh scripts/gate-region-undo-050.sh <canvas-commit> <new-evidence-dir>
set -eu

commit=$1
out=$2
contracts_tar=/Users/yzliu/.cache/hanaworlds-runs/S1-CONTRACT-REGION-V1-01/_evidence/final/hanaworlds-contracts-0.5.0.tgz
contracts_sha=7fb42f1eaaf4988730f6cf254faecb84bbbb1d84e293558b66727c470181b31e
old_canvas_tar=/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-REGION-UNDO-01/_evidence/gate-5ec5045/hanaworlds-canvas-0.4.0.tgz
old_canvas_sha=302babbe5b77b54215ddecf95dc560a43a7e23df629395b66a34019bedff0341
repo=$(cd "$(dirname "$0")/.." && pwd)
node_run() { npx --yes node@24.13.1 "$@"; }
tests="test/local-world.test.mjs test/region-undo.test.mjs"

test ! -e "$out"
mkdir -p "$out"
work=$(mktemp -d "${TMPDIR:-/tmp}/canvas-gate-050.XXXXXX")
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
log "installed contracts == 7fb42f1e tar: $(wc -l < "$work/cfiles" | tr -d ' ') files identical (package.json rewritten by npm)"

# 3. actual pack, isolated install, installed-package tests
(cd "$work/src" && npm pack --pack-destination "$out" --json) > "$out/pack.json"
tarball="$out/hanaworlds-canvas-0.5.0.tgz"
shasum -a 256 "$tarball" > "$out/sha256.txt"
mkdir -p "$work/rt/test"
npm install --prefix "$work/rt" --ignore-scripts --no-audit --no-fund "$tarball" > "$out/packed-install.log" 2>&1
for f in src/index.mjs src/local-v5.mjs src/store-v5.mjs src/region-v1.mjs; do
  cmp "$work/src/$f" "$work/rt/node_modules/hanaworlds-canvas/$f"; done
for t in $tests; do
  sed "s#'../src/index.mjs'#'hanaworlds-canvas'#" "$work/src/$t" > "$work/rt/$t"; done
(cd "$work/rt" && node_run --test $tests) > "$out/packed-runtime-test.log" 2>&1
log "packed 0.5.0 install+test PASS: $(grep -E '^ℹ (pass|fail) ' "$out/packed-runtime-test.log" | tr '\n' ' ')"

# 4. previous fixture-shape 0.4.0 tar with the region test: must fail (no contract region API)
mkdir -p "$work/old/test"
npm install --prefix "$work/old" --ignore-scripts --no-audit --no-fund "$old_canvas_tar" > "$out/old-040-install.log" 2>&1
cp "$work/rt/test/region-undo.test.mjs" "$work/old/test/"
if (cd "$work/old" && node_run --test test/region-undo.test.mjs) > "$out/old-040-red.log" 2>&1; then
  log "old 0.4.0 unexpectedly passed"; exit 1; fi
grep -q "canvasProtocolHandshake" "$out/old-040-red.log"
log "old 0.4.0 red on region test (expected: no canvasProtocolHandshake / contract region API)"

# 5. public export difference 0.4.0 -> 0.5.0 (cell canvas/v5 surface must stay)
cat > "$work/surface.mjs" <<'JS'
const canvas = await import('hanaworlds-canvas');
console.log(JSON.stringify({ canvasExports: Object.keys(canvas).sort() }));
JS
cp "$work/surface.mjs" "$work/rt/surface.mjs"; cp "$work/surface.mjs" "$work/old/surface.mjs"
(cd "$work/rt" && node_run surface.mjs) > "$out/surface-050.json"
(cd "$work/old" && node_run surface.mjs) > "$out/surface-040.json"
node_run -e '
const fs = require("node:fs");
const [a, b] = process.argv.slice(1).map(f => JSON.parse(fs.readFileSync(f)).canvasExports);
const removed = a.filter(x => !b.includes(x)), added = b.filter(x => !a.includes(x));
// The cell canvas/v5 surface and the region class must stay; 0.4.0 fixture-shape helpers go.
const kept = ["CanvasRegionV1", "CanvasStore", "CanvasV5", "apply", "default", "inject", "name"];
const missing = kept.filter(x => !b.includes(x));
console.log(JSON.stringify({ removed, added, missing }));
if (missing.length) process.exit(1);
' "$out/surface-040.json" "$out/surface-050.json" > "$out/surface-diff.json"
log "surface diff: $(cat "$out/surface-diff.json")"
log "gate exit 0"
