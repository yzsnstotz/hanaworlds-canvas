#!/usr/bin/env bash
set -euo pipefail

source_root="$(cd "$(dirname "$0")/.." && pwd)"
run_root="${1:?provide card run directory}"
adapter_tar="${2:?provide fixed current Adapter tarball}"
export PATH="/Users/yzliu/.local/share/fnm/node-versions/v24.13.1/installation/bin:$PATH"
mkdir -p "$run_root"
if [ -d "$run_root/_evidence" ]; then
  archive="$run_root/archive-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$run_root/_evidence" "$archive"
  rm -f "$archive/hanaworlds-canvas-0.2.0.tgz"
fi
rm -rf "$run_root/run" "$run_root/npm-cache"
mkdir -p "$run_root/_evidence" "$run_root/run/adapter" "$run_root/run/consumer" "$run_root/npm-cache"
cd "$source_root"
node --version > "$run_root/_evidence/environment.txt"
npm --version >> "$run_root/_evidence/environment.txt"
git rev-parse HEAD >> "$run_root/_evidence/environment.txt"
shasum -a 256 "$adapter_tar" > "$run_root/_evidence/adapter-package.sha256"
test "$(shasum -a 256 "$adapter_tar" | cut -d ' ' -f1)" = \
  ec057c06d1e84600f246f921f673e0cce1cb94916ddcb2d86a28127724acd43a
tar -xzf "$adapter_tar" -C "$run_root/run/adapter"
node --input-type=module -e '
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[1];
const { PAYLOAD_VERSION } = await import(pathToFileURL(join(root, "src/version.mjs")).href);
const { payloadDigest } = await import(pathToFileURL(join(root, "src/local-worlds.mjs")).href);
const digest = await payloadDigest();
assert.equal(PAYLOAD_VERSION, "0.2.7");
assert.equal(digest, "fdf68248d774ba06a649aa50e4ead8c69290cee6ea99bf06fd549a35a832276f");
console.log(JSON.stringify({payloadVersion: PAYLOAD_VERSION, payloadDigest: digest}));
' "$run_root/run/adapter/package" > "$run_root/_evidence/adapter-payload.json"
npm ci --ignore-scripts --no-audit --no-fund --cache "$run_root/npm-cache" > "$run_root/_evidence/ci.log" 2>&1
npm run build > "$run_root/_evidence/build.log" 2>&1
node --test test/payload-current.test.mjs > "$run_root/_evidence/payload-test.log" 2>&1
node --test --test-name-pattern='v4 world bind|public selection' test/v4.test.mjs test/world-context.test.mjs > "$run_root/_evidence/affected-existing.log" 2>&1
git diff --check > "$run_root/_evidence/diff-check.log" 2>&1
npm pack --ignore-scripts --json --cache "$run_root/npm-cache" --pack-destination "$run_root/_evidence" > "$run_root/_evidence/pack.json"
canvas_tar="$run_root/_evidence/hanaworlds-canvas-0.2.0.tgz"
shasum -a 256 "$canvas_tar" > "$run_root/_evidence/canvas-package.sha256"
npm install --prefix "$run_root/run/consumer" --ignore-scripts --no-audit --no-fund --cache "$run_root/npm-cache" "$canvas_tar" > "$run_root/_evidence/consumer-install.log" 2>&1
node scripts/probe-payload-current.mjs "$run_root/run/consumer" > "$run_root/_evidence/packed-probe.json" 2>&1
rm -rf "$run_root/run" "$run_root/npm-cache" "$source_root/node_modules"
printf '%s\n' 'run=removed' 'npm-cache=removed' 'source-node_modules=removed' 'actual-tarball=retained' 'evidence=retained' > "$run_root/_evidence/cleanup.txt"
printf '%s\n' 'COMPONENT_SELF_CHECK_OK' > "$run_root/_evidence/result.txt"
