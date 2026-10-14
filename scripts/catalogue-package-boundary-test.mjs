// Additive test driver: all old normal-install/type/policy/runtime negatives run
// unchanged, then the same Catalogue business suite runs against that installed tgz.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.env.CANVAS_CATALOGUE_PACKAGE_EVIDENCE ?? join(root, '..', 'evidence', 'q282', 'package'));
assert.ok(evidence !== resolve(root) && !evidence.startsWith(resolve(root) + '/'));
await mkdir(evidence, { recursive: true });
const env = { ...process.env, CANVAS_BOUNDARY_EVIDENCE: evidence };
const baseline = spawnSync(process.execPath, ['scripts/test-package-boundary.mjs'], { cwd: root, env, encoding: 'utf8' });
await writeFile(join(evidence, 'baseline.log'), (baseline.stdout ?? '') + (baseline.stderr ?? ''));
assert.equal(baseline.status, 0, 'Original strict package boundary must pass first; see baseline.log');
const summary = JSON.parse(baseline.stdout.trim().split('\n').at(-1));
assert.equal(summary.result, 'PACKAGE_BOUNDARY_PASS');
const project = join(summary.directory, 'production');
const installed = await realpath(join(project, 'node_modules/hanaworlds-canvas'));
assert.ok(!installed.startsWith(resolve(root) + '/'));
await mkdir(join(project, 'test', 'fixtures', 'protocol'), { recursive: true });
await cp(join(root, 'test/fixtures/protocol/world-source-facts.json'), join(project, 'test/fixtures/protocol/world-source-facts.json'));
for (const file of ['catalogue-public-types.mts', 'config-handoff-types.mts']) {
  await writeFile(join(project, 'test', file), (await readFile(join(root, 'test', file), 'utf8'))
    .replace('../types/protocol/index.js', '../node_modules/hanaworlds-canvas/types/protocol/index.js'));
}
for (const [source, target] of [['catalogue-public.test.mjs', 'catalogue-suite.mjs'],
  ['config-supply-q284.test.mjs', 'config-q284-suite.mjs'], ['config-handoff.test.mjs', 'config-handoff-suite.mjs']]) {
const bundle = await build({ entryPoints: [join(root, 'test', source)],
  outfile: join(project, 'test', target), bundle: true, format: 'esm',
  platform: 'node', target: 'node24', metafile: true,
  external: ['canonicalize', 'icu', 'hanaworlds-canvas', 'hanaworlds-canvas/*', '@deepseek-ai/*'],
  plugins: [{ name: 'installed-canvas-only', setup(builder) {
    builder.onResolve({ filter: /src\/index\.mjs$/ }, () => ({ path: 'hanaworlds-canvas', external: true }));
  } }] });
assert.ok(!Object.keys(bundle.metafile.inputs).some(path => /src\/(local-v5|store-v5|world-facts-reader)\.mjs$/.test(path)),
  'The test harness cannot contain the Canvas implementation');
}
const result = spawnSync(process.execPath, ['--test', 'test/catalogue-suite.mjs', 'test/config-q284-suite.mjs', 'test/config-handoff-suite.mjs'], { cwd: project, encoding: 'utf8',
  env: { ...env, CANVAS_CATALOGUE_TEST_ROOT: join(summary.directory, 'catalogue-profiles'),
    CANVAS_CATALOGUE_TSC: join(root, 'node_modules/typescript/bin/tsc') } });
await writeFile(join(evidence, 'catalogue-installed.log'), (result.stdout ?? '') + (result.stderr ?? ''));
assert.equal(result.status, 0, 'Installed Catalogue business/types suite must pass; see catalogue-installed.log');
console.log(JSON.stringify({ result: 'CATALOGUE_PACKAGE_COMPONENT_PASS', installed, tgz: summary.tgz,
  originalBoundary: summary, classification: 'STRICT_TGZ_COMPONENT_WITH_FIXTURE_PEERS; NOT_REAL_HOST_WORLD_UI_OWNER' }));
