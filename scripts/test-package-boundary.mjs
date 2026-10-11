import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, realpath, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { inspectPackage } from './package-boundary.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = process.env.CANVAS_BOUNDARY_EVIDENCE ?? join(root, '.runtime/package-boundary');
await mkdir(evidenceRoot, { recursive: true });
const directory = await mkdtemp(join(evidenceRoot, 'run-'));
const config = join(directory, 'empty-config'); await mkdir(config);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: join(directory, 'temp'),
  XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(directory, 'state'), CI: 'true',
  npm_config_cache: process.env.npm_config_cache ?? join(process.env.HOME, '.cache/npm') };
await mkdir(env.TMPDIR);
function command(binary, args, cwd, name, extra = {}, expectSuccess = true) {
  const result = spawnSync(binary, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  // Persist complete command output without credentials (the child has only the env above).
  return { result, output, name, expectSuccess };
}
async function run(binary, args, cwd, name, extra = {}, success = true) {
  const call = command(binary, args, cwd, name, extra, success);
  await writeFile(join(directory, `${name}.log`), call.output);
  assert.equal(call.result.status === 0, success, `${name}: exit ${call.result.status}\n${call.output.slice(-5000)}`);
  return call.output;
}
const packOut = await run('npm', ['pack', '--json', '--pack-destination', directory], root, 'npm-pack',
  { CANVAS_BOUNDARY_PACK_CHILD: String(process.pid) });
const pack = JSON.parse(packOut.slice(packOut.indexOf('[\n'), packOut.lastIndexOf('\n]') + 2))[0];
const tgz = join(directory, pack.filename);
await run('tar', ['-xzf', tgz, '-C', directory], root, 'extract');
const packedRoot = join(directory, 'package');
const inventory = await inspectPackage(packedRoot);
const sha = value => createHash('sha256').update(value).digest('hex');
for (const [file, digest] of Object.entries(inventory.source.artifacts))
  assert.equal(sha(await readFile(join(packedRoot, file))), digest, `packed build drift: ${file}`);
const manifest = JSON.parse(await readFile(join(packedRoot, 'package.json')));
const negatives = [];
async function fault(name, mutate, pattern) {
  const dir = join(directory, `fault-${name}`); await mkdir(dir); await cp(packedRoot, join(dir, 'package'), { recursive: true });
  await mutate(join(dir, 'package'));
  await run('tar', ['-czf', join(dir, `${name}.tgz`), '-C', dir, 'package'], root, `pack-fault-${name}`);
  await assert.rejects(() => inspectPackage(join(dir, 'package')), pattern);
  negatives.push(name);
}
const entryFile = typeof manifest.exports['.'] === 'string' ? manifest.exports['.'] : manifest.exports['.'].import;
const append = (path, text) => async dir => writeFile(join(dir, path), (await readFile(join(dir, path), 'utf8')) + '\n' + text);
for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'])
  await fault(section, async dir => { const copy = structuredClone(manifest); copy[section] ??= {}; copy[section]['hanaworlds-contracts'] = manifest.devDependencies['hanaworlds-contracts']; await writeFile(join(dir, 'package.json'), JSON.stringify(copy)); }, /production contracts dependency/);
await fault('bare-value-import', append(entryFile, 'import "hanaworlds-contracts";'), /contracts runtime load/);
await fault('dynamic-import', append(entryFile, 'await import("hanaworlds-" + "contracts");'), /contracts runtime load/);
await fault('require', append(entryFile, 'require("hanaworlds-contracts");'), /contracts runtime load/);
await fault('resolve', append(entryFile, 'import.meta.resolve("hanaworlds-contracts/package.json");'), /contracts runtime load/);
await fault('package-import', async dir => { const copy = structuredClone(manifest); copy.imports = { '#contracts': manifest.devDependencies['hanaworlds-contracts'] }; await writeFile(join(dir, 'package.json'), JSON.stringify(copy)); }, /#contracts/);
await fault('hash-loader', append(entryFile, 'await import("#contracts");'), /contracts runtime load/);
await fault('external-resource', append(entryFile, 'new URL("file:///development/schema.json", import.meta.url);'), /external\/dynamic resource/);
await fault('aliased-create-require', append(entryFile, 'import {createRequire as cr} from "node:module"; export function contractsEscape(){const r=cr(import.meta.url);return r("hanaworlds-contracts");}'), /uninspectable dynamic loader|contracts runtime load/);
await fault('namespace-resource', append(entryFile, 'import * as fs from "node:fs/promises"; export function schemaEscape(){return fs.readFile("/development/contracts.schema.json", "utf8");}'), /resource read without package-relative URL/);
await fault('aliased-resource', append(entryFile, 'import {readFile as rf} from "node:fs/promises"; const path="/development/schema.json"; export function schemaEscape(){return rf(path);}'), /resource read without package-relative URL/);
await fault('environment-resource', append(entryFile, 'import * as fs from "node:fs/promises"; export function schemaEscape(){return fs.readFile(process.env.CONTRACT_SCHEMA,"utf8");}'), /resource read without package-relative URL/);
await fault('joined-resource', append(entryFile, 'import * as fs from "node:fs/promises"; export function schemaEscape(){const location=["/development","contracts.schema.json"].join("/");return fs.readFile(location,"utf8");}'), /resource read without package-relative URL/);
await fault('aliased-resolve' , append(entryFile, 'const lookup=import.meta.resolve; export function contractsEscape(){return lookup("hanaworlds-contracts");}'), /contracts runtime load/);
await fault('global-fetch', append(entryFile, 'export function schemaEscape(){return globalThis.fetch("https://development.invalid/schema.json");}'), /external resource fetch/);
await fault('computed-resource' , append(entryFile, 'await import(process.env.CONTRACT_ENTRY);'), /dynamic module\/resource/);
await fault('missing-local', append(entryFile, 'import "./unpacked.mjs";'), /missing packed file/);
await fault('schema-resource', async dir => { const p = join(dir, 'fixtures/native-facts-scoped-state.schema.json'); const schema = JSON.parse(await readFile(p)); schema.$ref = 'file:///development/contracts.schema.json'; await writeFile(p, JSON.stringify(schema)); }, /external schema/);
await fault('wrong-source', async dir => { const p = join(dir, 'lib/build-source.json'); const source = JSON.parse(await readFile(p)); source.supplier.revision = '0'.repeat(40); await writeFile(p, JSON.stringify(source)); }, /strictEqual|Expected values/);
const reachableChunk = inventory.files.find(p => p.startsWith('lib/chunks/') && inventory.edges[entryFile.replace('./', '')]?.includes(p));
assert.ok(reachableChunk);
await fault('omitted-bundle', async dir => unlink(join(dir, reachableChunk)), /missing packed file/);
await fault('install-hook', async dir => { const copy = structuredClone(manifest); copy.scripts.postinstall = 'node -e "process.exit(0)"';
  await writeFile(join(dir, 'package.json'), JSON.stringify(copy)); }, /unexpected production install hook/);
const buildNegative = join(directory, 'negative-build-policy'); await mkdir(buildNegative);
await writeFile(join(buildNegative, 'package.json'), JSON.stringify({ name: 'canvas-build-policy-negative', private: true,
  dependencies: { 'hanaworlds-canvas': `file:${join(directory, 'fault-install-hook/install-hook.tgz')}` } }));
const buildPolicyFailure = await run(process.execPath, [join(root, 'node_modules/pnpm/bin/pnpm.mjs'), 'install', '--prod'],
  buildNegative, 'negative-production-strict-builds', {}, false);
assert.match(buildPolicyFailure, /ERR_PNPM_IGNORED_BUILDS|unreviewed build scripts/i);
negatives.push('pnpm-strict-dependency-builds');
const negativeProject = join(directory, 'negative-production'); await mkdir(negativeProject);
await writeFile(join(negativeProject, 'package.json'), JSON.stringify({ name: 'canvas-exotic-negative', private: true,
  dependencies: { 'hanaworlds-canvas': `file:${join(directory, 'fault-dependencies/dependencies.tgz')}` } }));
const policyFailure = await run(process.execPath, [join(root, 'node_modules/pnpm/bin/pnpm.mjs'), 'install', '--prod'],
  negativeProject, 'negative-production-exotic', {}, false);
assert.match(policyFailure, /EXOTIC_SUBDEP|exotic.*subdep/i);
negatives.push('pnpm-exotic-subdependency');
const project = join(directory, 'production'); await mkdir(project);
await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'canvas-isolated-production-proof', private: true,
  type: 'module', dependencies: { 'hanaworlds-canvas': `file:${tgz}`,
    '@deepseek-ai/cordis': manifest.peerDependencies['@deepseek-ai/cordis'],
    '@deepseek-ai/dsh-typert-protocol': manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'],
    'zod': manifest.peerDependencies.zod, react: manifest.peerDependencies.react,
    '@deepseek-ai/dsh-typert-registry': manifest.devDependencies['@deepseek-ai/dsh-typert-registry'],
    '@deepseek-ai/dsh-api-gateway': manifest.devDependencies['@deepseek-ai/dsh-api-gateway'],
    canonicalize: manifest.dependencies.canonicalize, icu: manifest.dependencies.icu } }, null, 2));
const pnpm = join(root, 'node_modules/pnpm/bin/pnpm.mjs');
assert.equal((await run(process.execPath, [pnpm, '--version'], project, 'pnpm-version')).trim(), '11.28.5');
for (const policy of ['blockExoticSubdeps', 'strictDepBuilds', 'ignoreScripts'])
  await run(process.execPath, [pnpm, 'config', 'get', policy], project, `policy-${policy}`);
await run(process.execPath, [pnpm, 'install', '--prod'], project, 'pnpm-production-install');
await run(process.execPath, [pnpm, 'list', '--prod', '--depth', 'Infinity', '--json'], project, 'production-graph');
const graph = await readFile(join(directory, 'production-graph.log'), 'utf8');
assert.ok(!graph.includes('hanaworlds-contracts'), 'contracts in production resolution graph');
const lock = await readFile(join(project, 'pnpm-lock.yaml'), 'utf8');
assert.ok(!lock.includes('hanaworlds-contracts'), 'contracts in production lock');
await cp(join(root, 'scripts/production-smoke.mjs'), join(project, 'production-smoke.mjs'));
await run(process.execPath, ['production-smoke.mjs'], project, 'production-smoke');
// Peer fixtures and their development validators are embedded ONLY in this test harness.
// Canvas operations remain external and load the installed tgz; no development package/alias.
await build({ entryPoints: [join(root, 'test/undo-redo.test.mjs')], outfile: join(project, 'transaction-capabilities.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['canonicalize', 'icu', 'hanaworlds-canvas', 'hanaworlds-canvas/*'],
  plugins: [{ name: 'installed-canvas-only', setup(builder) {
    builder.onResolve({ filter: /src\/index\.mjs$/ }, () => ({ path: 'hanaworlds-canvas', external: true }));
  } }] });
await run(process.execPath, ['--test', 'transaction-capabilities.mjs'], project, 'production-transactions');
await build({ entryPoints: [join(root, 'test/packaged-errors.test.mjs')], outfile: join(project, 'public-error-capabilities.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node24',
  external: ['canonicalize', 'icu', 'hanaworlds-canvas', 'hanaworlds-canvas/*'] });
await run(process.execPath, ['--test', 'public-error-capabilities.mjs'], project, 'production-public-errors');
const installed = await realpath(join(project, 'node_modules/hanaworlds-canvas'));
const installedEntry = join(installed, entryFile);
const bytes = await readFile(installedEntry);
try {
  await writeFile(installedEntry, Buffer.concat([bytes, Buffer.from('\nimport "hanaworlds-contracts";\n')]));
  const failure = await run(process.execPath, ['production-smoke.mjs'], project, 'negative-runtime-value-load', {}, false);
  assert.match(failure, /ERR_MODULE_NOT_FOUND.*|Cannot find package 'hanaworlds-contracts'/);
} finally { await writeFile(installedEntry, bytes); }
const chunk = inventory.files.find(p => p.startsWith('lib/chunks/') && inventory.edges[entryFile.replace('./', '')]?.includes(p));
assert.ok(chunk, 'a reachable chunk must exist');
const chunkPath = join(installed, chunk), chunkBytes = await readFile(chunkPath);
try {
  await unlink(chunkPath);
  const failure = await run(process.execPath, ['production-smoke.mjs'], project, 'negative-runtime-omitted-bundle', {}, false);
  assert.match(failure, /ERR_MODULE_NOT_FOUND/);
} finally { await writeFile(chunkPath, chunkBytes); }
await run(process.execPath, ['production-smoke.mjs'], project, 'production-restored');
const summary = { result: 'PACKAGE_BOUNDARY_PASS', directory, tgz, artifactSHA256: sha(await readFile(tgz)),
  pnpm: '11.28.5', entries: inventory.entries, graph: 'production-graph.log', lock: 'production/pnpm-lock.yaml',
  negatives: [...negatives, 'runtime-value-load', 'runtime-omitted-bundle'], classification: 'PRODUCTION_INSTALL_AND_COMPONENT_RUNTIME_WITH_FIXTURE_PEERS; NOT_REAL_WORLD_UI_OWNER' };
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
