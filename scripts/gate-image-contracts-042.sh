#!/bin/sh
# Canvas 0.3.3 image-assembly gate: Contracts 0.4.2 pin/handshake + affected
# normal path, from an exact clean commit, on source and on the actual packed tar.
# Usage: sh scripts/gate-image-contracts-042.sh <canvas-commit> <new-evidence-dir>
set -eu

commit=$1
out=$2
contracts_tar=/Users/yzliu/.cache/hanaworlds-runs/S1-CONTRACT-LOCAL-WORLD-01/material-sources-20261007/_evidence/final/hanaworlds-contracts-0.4.2.tgz
contracts_sha=c3528a4fc3f0cdf94245c4d2d8b1cfa5d28db96d1cd00ae74737bdbdfcd26ec6
old_canvas_tar=/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-LOCAL-WORLD-01/_evidence/final/hanaworlds-canvas-0.3.2.tgz
old_canvas_sha=794eed855b2d7695d919ac6137dd7b7ecb44d7cd86a896ce47234cb08675897a
repo=$(cd "$(dirname "$0")/.." && pwd)
node_run() { npx --yes node@24.13.1 "$@"; }

test ! -e "$out"
mkdir -p "$out"
work=$(mktemp -d "${TMPDIR:-/tmp}/canvas-gate-042.XXXXXX")
trap 'rm -rf "$work"' EXIT
log() { printf '%s\n' "$*" | tee -a "$out/gate.log"; }

test -z "$(git -C "$repo" status --porcelain)"
test "$(git -C "$repo" rev-parse "$commit^{commit}")" = "$(git -C "$repo" rev-parse HEAD)"
log "canvas commit $commit (clean)"
printf '%s  %s\n' "$contracts_sha" "$contracts_tar" | shasum -a 256 -c - >> "$out/gate.log"
printf '%s  %s\n' "$old_canvas_sha" "$old_canvas_tar" | shasum -a 256 -c - >> "$out/gate.log"

# 1. exact commit -> fresh source tree, lockfile install, build, affected test
mkdir "$work/src"
git -C "$repo" archive "$commit" | tar -x -C "$work/src"
(cd "$work/src" && npx --yes --package=node@24.13.1 -c 'npm ci --ignore-scripts --no-audit --no-fund') > "$out/source-npm-ci.log" 2>&1
(cd "$work/src" && npx --yes --package=node@24.13.1 -c 'npm run build') > "$out/source-build.log" 2>&1
(cd "$work/src" && node_run --test test/local-world.test.mjs) > "$out/source-test.log" 2>&1
log "source build+test PASS"

# 2. pinned Contracts resolved from lockfile == actual 0.4.2 tar bytes
mkdir "$work/ctar"
tar -xzf "$contracts_tar" -C "$work/ctar"
(cd "$work/ctar/package" && find . -type f ! -name package.json | sort) > "$work/cfiles"
while read -r f; do cmp "$work/ctar/package/$f" "$work/src/node_modules/hanaworlds-contracts/$f"; done < "$work/cfiles"
log "installed contracts == c3528a4f tar: $(wc -l < "$work/cfiles" | tr -d ' ') files identical (package.json rewritten by npm)"

# 3. actual pack, isolated install, installed-package test
(cd "$work/src" && npm pack --pack-destination "$out" --json) > "$out/pack.json"
tarball="$out/hanaworlds-canvas-0.3.3.tgz"
shasum -a 256 "$tarball" > "$out/sha256.txt"
mkdir -p "$work/rt/test"
npm install --prefix "$work/rt" --ignore-scripts --no-audit --no-fund "$tarball" > "$out/packed-install.log" 2>&1
for f in src/index.mjs src/local-v5.mjs src/store-v5.mjs; do cmp "$work/src/$f" "$work/rt/node_modules/hanaworlds-canvas/$f"; done
sed "s#'../src/index.mjs'#'hanaworlds-canvas'#" "$work/src/test/local-world.test.mjs" > "$work/rt/test/local-world.test.mjs"
node_run --test "$work/rt/test/local-world.test.mjs" > "$out/packed-runtime-test.log" 2>&1
log "packed 0.3.3 install+test PASS"

# 4. old fixed 0.3.2 tar (Contracts 0.4.0) with the same test: must fail the 0.4.2 handshake
mkdir -p "$work/old/test"
npm install --prefix "$work/old" --ignore-scripts --no-audit --no-fund "$old_canvas_tar" > "$out/old-032-install.log" 2>&1
cp "$work/rt/test/local-world.test.mjs" "$work/old/test/"
if node_run --test "$work/old/test/local-world.test.mjs" > "$out/old-032-red.log" 2>&1; then
  log "old 0.3.2 unexpectedly passed"; exit 1; fi
grep -q "hanaworlds-contracts@0.4.0" "$out/old-032-red.log"
log "old 0.3.2 rejected by 0.4.2 handshake assertion (expected red)"

# 5. public export / handshake / type-inventory difference 0.3.2 -> 0.3.3
cat > "$work/surface.mjs" <<'EOF'
const canvas = await import('hanaworlds-canvas');
const c = await import('hanaworlds-contracts');
console.log(JSON.stringify({ canvasExports: Object.keys(canvas).sort(),
  contractsVersion: c.version, handshake: c.contractHandshake,
  contractsExports: Object.keys(c).sort(), typeNames: [...c.schemaInventory].sort() }));
EOF
cp "$work/surface.mjs" "$work/rt/surface.mjs"; cp "$work/surface.mjs" "$work/old/surface.mjs"
(cd "$work/rt" && node_run surface.mjs) > "$out/surface-033.json"
(cd "$work/old" && node_run surface.mjs) > "$out/surface-032.json"
node_run -e '
const fs = require("node:fs");
const [a, b, src] = process.argv.slice(1);
const o = JSON.parse(fs.readFileSync(a)), n = JSON.parse(fs.readFileSync(b));
const imports = [...fs.readFileSync(src, "utf8").matchAll(/import \{([^}]*)\} from .hanaworlds-contracts./g)]
  .flatMap(m => m[1].split(",").map(s => s.trim()).filter(Boolean));
const missing = imports.filter(x => !n.contractsExports.includes(x));
const diff = (x, y) => y.filter(v => !x.includes(v));
const r = { canvasExportsSame: JSON.stringify(o.canvasExports) === JSON.stringify(n.canvasExports),
  canvasImportsFromContracts: imports, missingInNew: missing,
  contracts: [o.contractsVersion, n.contractsVersion],
  handshake: [o.handshake.contracts, n.handshake.contracts],
  wiresSame: JSON.stringify(o.handshake.wireVersions) === JSON.stringify(n.handshake.wireVersions),
  operationsSame: o.handshake.compiledOperationsVersion === n.handshake.compiledOperationsVersion,
  contractsExportsAdded: diff(o.contractsExports, n.contractsExports),
  contractsExportsRemoved: diff(n.contractsExports, o.contractsExports),
  typeNamesAdded: diff(o.typeNames, n.typeNames), typeNamesRemoved: diff(n.typeNames, o.typeNames),
  typeCounts: [o.typeNames.length, n.typeNames.length] };
console.log(JSON.stringify(r, null, 1));
if (!r.canvasExportsSame || missing.length || r.contractsExportsRemoved.length ||
  r.typeNamesRemoved.length || !r.wiresSame || !r.operationsSame) process.exit(1);
' "$out/surface-032.json" "$out/surface-033.json" "$work/src/src/local-v5.mjs" > "$out/surface-diff.json"
log "public surface diff OK: $(tr -d '\n ' < "$out/surface-diff.json" | cut -c1-200)"
log "GATE exit 0"
