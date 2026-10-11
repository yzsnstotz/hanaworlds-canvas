import { spawnSync } from 'node:child_process';
function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['scripts/build.mjs']);
run(['scripts/verify-contracts.mjs']);
// Boundary validation itself packs with normal lifecycle scripts. The child prepack
// still rebuilds/verifies; only recursive boundary packing is suppressed in that child.
if (!process.env.CANVAS_BOUNDARY_PACK_CHILD) run(['scripts/test-package-boundary.mjs']);
