import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createOfficialHostLifecycle } from './support/official-host-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runRoot = fileURLToPath(new URL('../../', import.meta.url));
let directory, installation, profile, lifecycle;
const failures = [];
function rememberError(stage, error) {
  failures.push({ stage, error });
  lifecycle?.recordError(stage, error);
}
const observed = (stage, body) => async () => {
  try { await body(); } catch (error) { rememberError(stage, error); throw error; }
};
// File-suite hook: compose is shared by the installed types and runtime tests.
// Register before creating any resources; a per-test hook deletes too early.
after(async () => {
  if (setup) await setup.catch(() => {}); // Original setup failure remains in the tests/audit.
  if (!lifecycle) return;
  const audit = await lifecycle.finalize({ diagnostics: ['official-install.log', 'canvas-pack.log',
    'manager-install.log', 'public-types.log', 'runtime.log', 'installation-declarations.json',
    'installation/manager-result.json', 'installation/package.json', 'installation/package-lock.json',
    'profile/package.json', 'profile/pnpm-lock.yaml'] });
  assert.equal(audit.removed, true, 'The complete installation/profile root must disappear after this suite');
  assert.equal(audit.protectedUnchanged, true, 'Source/input/shared/link targets must survive');
  console.log(`OFFICIAL_HOST_SUPPLY_ARCHIVE ${audit.archive}`);
});
async function command(binary, args, cwd, log, extra = {}) {
  const cache = join(runRoot, 'npm-cache');
  return lifecycle.command(binary, args, cwd, log, { PATH: process.env.PATH, HOME: directory,
    TMPDIR: join(directory, 'temp'), CI: 'true', XDG_CONFIG_HOME: join(directory, 'config'),
    npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...extra });
}

let setup;
async function compose() {
  await mkdir(join(runRoot, 'npm-cache'), { recursive: true });
  lifecycle = await createOfficialHostLifecycle({ runRoot,
    archiveRoot: join(runRoot, 'evidence/q271/official-host-audits'),
    protectedPaths: ['src', 'types', 'fixtures', 'examples', 'scripts', 'package.json', 'package-lock.json',
      'cordis.patch.yml', 'test/official-host-types.mts', 'test/support/official-host-install.mjs',
      'test/support/official-host-runtime.mjs'].map(path => join(root, path)),
    sharedPaths: [root, join(runRoot, 'npm-cache')] });
  directory = lifecycle.directory;
  for (const { stage, error } of failures) lifecycle.recordError(stage, error);
  installation = join(directory, 'installation'); profile = join(directory, 'profile');
  for (const name of ['installation', 'profile', 'temp', 'config', 'npm-cache', 'boundary'])
    await mkdir(join(directory, name));
  // Complete published official DSH dependency composition, rather than the
  // smaller Canvas development graph. The manager installs Canvas separately.
  const dependencies = { '@deepseek-ai/dsh': '0.2.1-alpha.2',
    // This root's install-canvas.mjs directly imports the public operations
    // export. Declare the exact official DSH dependency; npm need not hoist
    // DSH's nested manager for another consumer's bare import.
    '@deepseek-ai/dsh-plugin-manager': '0.2.1-alpha.2',
    // Close the manager's public peer graph with the official Loader version
    // matching the unchanged Cordis alpha.1 peer, rather than a newer alpha.2.
    '@deepseek-ai/cordis-plugin-loader': '1.0.6-alpha.1',
    '@deepseek-ai/cordis': '4.0.5-alpha.1', '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2',
    '@deepseek-ai/dsh-typert-registry': '0.2.1-alpha.2', '@deepseek-ai/dsh-api-gateway': '0.2.1-alpha.2',
    zod: '4.4.3', react: '18.3.1' };
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: 'canvas-official-host-test',
    private: true, type: 'module', dependencies }, null, 2));
  const bootstrap = await command('npm', ['install', '--no-audit', '--no-fund'], installation, 'official-install.log');
  assert.equal(bootstrap.code, 0, `Official supply SETUP failure (not behavior RED): ${directory}\n${bootstrap.output.slice(-3000)}`);
  const dshManifest = JSON.parse(await readFile(join(installation, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  const managerManifest = JSON.parse(await readFile(join(installation, 'node_modules/@deepseek-ai/dsh-plugin-manager/package.json'), 'utf8'));
  const loaderManifest = JSON.parse(await readFile(join(installation, 'node_modules/@deepseek-ai/cordis-plugin-loader/package.json'), 'utf8'));
  assert.equal(dshManifest.dependencies['@deepseek-ai/dsh-plugin-manager'], dependencies['@deepseek-ai/dsh-plugin-manager'],
    'The declared direct manager version must equal the actual fixed official DSH manifest');
  assert.equal(managerManifest.version, dependencies['@deepseek-ai/dsh-plugin-manager']);
  assert.ok(managerManifest.exports['./operations'], 'The installed manager exposes the public operations entry');
  assert.equal(dshManifest.dependencies['@deepseek-ai/cordis-plugin-loader'], `~${dependencies['@deepseek-ai/cordis-plugin-loader']}`);
  assert.equal(managerManifest.peerDependencies['@deepseek-ai/cordis-plugin-loader'], `~${dependencies['@deepseek-ai/cordis-plugin-loader']}`);
  assert.equal(loaderManifest.version, dependencies['@deepseek-ai/cordis-plugin-loader']);
  assert.equal(loaderManifest.peerDependencies['@deepseek-ai/cordis'], `~${dependencies['@deepseek-ai/cordis']}`,
    'Normal Loader peer requirements must retain the fixed Cordis version');
  await writeFile(join(directory, 'installation-declarations.json'), JSON.stringify({ dependencies,
    officialDshVersion: dshManifest.version, officialManagerDependency: dshManifest.dependencies['@deepseek-ai/dsh-plugin-manager'],
    directManagerVersion: managerManifest.version, publicOperationsExport: managerManifest.exports['./operations'],
    loaderVersion: loaderManifest.version, loaderCordisPeer: loaderManifest.peerDependencies['@deepseek-ai/cordis'] }, null, 2));
  // DSH belongs to the installation anchor, not to its plugin profile. The
  // profile explicitly supplies Canvas's public peers and Gateway test faces;
  // re-installing the application here would test its native build approvals.
  const profileDependencies = Object.fromEntries(Object.entries(dependencies)
    .filter(([name]) => !['@deepseek-ai/dsh', '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/cordis-plugin-loader'].includes(name)));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'canvas-official-profile-test',
    private: true, type: 'module', dependencies: profileDependencies, dsh: { profile: { bundles: [] } } }, null, 2));
  const pack = await command('npm', ['pack', '--json', '--pack-destination', directory], root, 'canvas-pack.log',
    { CANVAS_BOUNDARY_EVIDENCE: join(directory, 'boundary') });
  assert.equal(pack.code, 0, `Canvas normal prepack failed: ${directory}\n${pack.output.slice(-3000)}`);
  const packed = JSON.parse(pack.output.slice(pack.output.indexOf('[\n'), pack.output.lastIndexOf('\n]') + 2))[0];
  await cp(new URL('./support/official-host-install.mjs', import.meta.url), join(installation, 'install-canvas.mjs'));
  const installed = await command(process.execPath, ['install-canvas.mjs', profile, join(directory, packed.filename),
    join(root, 'node_modules/pnpm/bin/pnpm.mjs')], installation, 'manager-install.log');
  assert.equal(installed.code, 0, `Official manager install failed: ${directory}\n${installed.output.slice(-3000)}`);
  console.log(`OFFICIAL_HOST_SUPPLY_EVIDENCE ${directory}`);
}
const ready = () => setup ??= compose().catch(error => { rememberError('setup', error); throw error; });

test('Canvas display public types compose with the official Host APIs without implicit any', observed('source-types', async () => {
  const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--lib', 'ES2022,DOM,ESNext.Disposable', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'test/official-host-types.mts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, `Public declaration failure:\n${output}`);
}));

test('Canvas installed through the full official installation manager compiles with official Host/Zod peers', observed('installed-types', async () => {
  await ready();
  await cp(new URL('./official-host-types.mts', import.meta.url), join(profile, 'public-types.mts'));
  const result = await command(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--lib', 'ES2022,DOM,ESNext.Disposable', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'public-types.mts'], profile, 'public-types.log');
  assert.equal(result.code, 0, `Public Canvas declaration failure: ${directory}\n${result.output}`);
}));

test('manager-selected production Canvas keeps its official pins and runnable public panel ports', observed('runtime', async () => {
  await ready();
  await cp(new URL('./support/official-host-runtime.mjs', import.meta.url), join(profile, 'runtime.mjs'));
  const result = await command(process.execPath, ['runtime.mjs'], profile, 'runtime.log');
  assert.equal(result.code, 0, `Installed Canvas runtime failure: ${directory}\n${result.output}`);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('hanaworlds-canvas'), 'Manager must select the bundle');
}));
