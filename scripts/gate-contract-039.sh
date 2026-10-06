#!/usr/bin/env bash
set -euo pipefail

source_root="$(cd "$(dirname "$0")/.." && pwd)"
run_root="${1:?provide card run directory}"
node_bin="/Users/yzliu/.local/share/fnm/node-versions/v24.13.1/installation/bin"
export PATH="$node_bin:$PATH"
mkdir -p "$run_root"
if [ -d "$run_root/_evidence" ]; then
  archive="$run_root/archive-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$run_root/_evidence" "$archive"
  rm -f "$archive/hanaworlds-canvas-0.2.0.tgz"
fi
mkdir -p "$run_root/_evidence"
rm -rf "$run_root/run" "$run_root/npm-cache"
mkdir -p "$run_root/run/consumer" "$run_root/npm-cache"
cd "$source_root"
node --version > "$run_root/_evidence/environment.txt"
npm --version >> "$run_root/_evidence/environment.txt"
git rev-parse HEAD >> "$run_root/_evidence/environment.txt"
npm ci --ignore-scripts --no-audit --no-fund --cache "$run_root/npm-cache" \
  > "$run_root/_evidence/ci.log" 2>&1
npm run build > "$run_root/_evidence/build.log" 2>&1
npm test > "$run_root/_evidence/test.log" 2>&1
git diff --check > "$run_root/_evidence/diff-check.log" 2>&1
npm pack --ignore-scripts --json --cache "$run_root/npm-cache" --pack-destination "$run_root/_evidence" \
  > "$run_root/_evidence/pack.json"
canvas_tar="$run_root/_evidence/hanaworlds-canvas-0.2.0.tgz"
shasum -a 256 "$canvas_tar" > "$run_root/_evidence/package.sha256"
npm install --prefix "$run_root/run/consumer" --ignore-scripts --no-audit --no-fund \
  --cache "$run_root/npm-cache" "$canvas_tar" \
  > "$run_root/_evidence/consumer-install.log" 2>&1
node scripts/probe-contract-039.mjs "$run_root/run/consumer" \
  > "$run_root/_evidence/packed-probe.json" 2>&1
node -e "const p=require('./package-lock.json').packages['node_modules/hanaworlds-contracts']; console.log(JSON.stringify(p))" \
  > "$run_root/_evidence/contracts-lock.json"
rm -rf "$run_root/run" "$run_root/npm-cache" "$source_root/node_modules"
printf '%s\n' 'run=removed' 'npm-cache=removed' 'source-node_modules=removed' \
  'actual-tarball=retained' 'evidence=retained' > "$run_root/_evidence/cleanup.txt"
printf '%s\n' 'COMPONENT_SELF_CHECK_OK' > "$run_root/_evidence/result.txt"
