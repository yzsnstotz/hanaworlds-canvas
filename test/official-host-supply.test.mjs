import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const runRoot = fileURLToPath(new URL('../../', import.meta.url));
let directory, installation, profile;
async function command(binary, args, cwd, log, extra = {}) {
  const cache = join(runRoot, 'npm-cache');
  const child = spawn(binary, args, { cwd, env: { PATH: process.env.PATH, HOME: directory,
    TMPDIR: join(directory, 'temp'), CI: 'true', XDG_CONFIG_HOME: join(directory, 'config'),
    npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(directory, log), output);
  return { code, output };
}

let setup;
async function compose() {
  directory = await mkdtemp(join(runRoot, 'official-host-supply-'));
  installation = join(directory, 'installation'); profile = join(directory, 'profile');
  for (const name of ['installation', 'profile', 'temp', 'config', 'npm-cache', 'boundary'])
    await mkdir(join(directory, name));
  // Complete published official DSH dependency composition, rather than the
  // smaller Canvas development graph. The manager installs Canvas separately.
  const dependencies = { '@deepseek-ai/dsh': '0.2.1-alpha.2',
    '@deepseek-ai/cordis': '4.0.5-alpha.1', '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2',
    '@deepseek-ai/dsh-typert-registry': '0.2.1-alpha.2', '@deepseek-ai/dsh-api-gateway': '0.2.1-alpha.2',
    zod: '4.4.3', react: '18.3.1' };
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: 'canvas-official-host-test',
    private: true, type: 'module', dependencies }, null, 2));
  const bootstrap = await command('npm', ['install', '--no-audit', '--no-fund'], installation, 'official-install.log');
  assert.equal(bootstrap.code, 0, `Official supply SETUP failure (not behavior RED): ${directory}\n${bootstrap.output.slice(-3000)}`);
  // DSH belongs to the installation anchor, not to its plugin profile. The
  // profile explicitly supplies Canvas's public peers and Gateway test faces;
  // re-installing the application here would test its native build approvals.
  const profileDependencies = Object.fromEntries(Object.entries(dependencies).filter(([name]) => name !== '@deepseek-ai/dsh'));
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
const ready = () => setup ??= compose();

test('Canvas display public types compose with the official Host APIs without implicit any', async () => {
  const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--lib', 'ES2022,DOM,ESNext.Disposable', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'test/official-host-types.mts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, `Public declaration failure:\n${output}`);
});

test('Canvas installed through the full official installation manager compiles with official Host/Zod peers', async () => {
  await ready();
  await cp(new URL('./official-host-types.mts', import.meta.url), join(profile, 'public-types.mts'));
  const result = await command(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--lib', 'ES2022,DOM,ESNext.Disposable', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'public-types.mts'], profile, 'public-types.log');
  assert.equal(result.code, 0, `Public Canvas declaration failure: ${directory}\n${result.output}`);
});

test('manager-selected production Canvas keeps its official pins and runnable public panel ports', async () => {
  await ready();
  await cp(new URL('./support/official-host-runtime.mjs', import.meta.url), join(profile, 'runtime.mjs'));
  const result = await command(process.execPath, ['runtime.mjs'], profile, 'runtime.log');
  assert.equal(result.code, 0, `Installed Canvas runtime failure: ${directory}\n${result.output}`);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('hanaworlds-canvas'), 'Manager must select the bundle');
});
