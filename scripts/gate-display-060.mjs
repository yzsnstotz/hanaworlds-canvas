import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const [commit, evidenceArg] = process.argv.slice(2);
const root = process.cwd();
const run = '/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01';
const evidence = resolve(evidenceArg ?? '');
if (!commit || !evidence.startsWith(`${run}/_evidence/`) || existsSync(evidence)) throw new Error('Use a full clean commit and a new evidence directory under this card run.');
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Frozen source must be clean exact HEAD.');
mkdirSync(evidence, { recursive: true });
const scratch = join(run, `display-gate-${commit.slice(0, 8)}`);
if (existsSync(scratch)) throw new Error('Previous gate scratch must be archived/removed first.');
mkdirSync(scratch);
const source = join(scratch, 'source'); const packed = join(scratch, 'packed');
mkdirSync(source); mkdirSync(packed);
const sha = data => createHash('sha256').update(data).digest('hex');
const env = { ...process.env, PATH: `${resolve(process.execPath, '..')}:${process.env.PATH}`, TMPDIR: join(scratch, 'tmp') };
mkdirSync(env.TMPDIR);
const checks = [];
const check = (name, binary, args, cwd = source, extraEnv = {}) => {
  const result = spawnSync(binary, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const log = join(evidence, `${name}.log`); writeFileSync(log, output);
  checks.push({ name, binary, args, cwd, exitCode: result.status, sha256: sha(output), log });
  process.stdout.write(`${name}: exit ${result.status}\n${output.slice(-700)}\n`);
  if (result.status !== 0) throw new Error(`${name} failed`);
  return output;
};
const linkSdk = base => {
  const sdk = '/Applications/HanaWorlds.app/Contents/Resources/hanaworlds-dsh/node_modules';
  mkdirSync(join(base, 'node_modules', '@deepseek-ai'), { recursive: true });
  for (const name of ['cordis', 'dsh-typert-protocol', 'dsh-typert-registry', 'dsh-api-gateway'])
    symlinkSync(join(sdk, '@deepseek-ai', name), join(base, 'node_modules', '@deepseek-ai', name), 'dir');
  symlinkSync(join(sdk, 'zod'), join(base, 'node_modules', 'zod'), 'dir');
};
let success = false;
try {
  const archivePath = join(scratch, 'source.tar');
  execFileSync('git', ['archive', '--output', archivePath, commit, 'package.json',
    'package-lock.json', 'src', 'types', 'lib', 'test', 'scripts', 'fixtures', 'examples',
    'LICENSE', 'LICENSES', 'NOTICE', 'README.md', 'GADGET.md', 'cordis.patch.yml'], { cwd: root });
  execFileSync('tar', ['-xf', archivePath, '-C', source]);
  check('source-ci', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(scratch, 'cache')]);
  linkSdk(source);
  check('source-build', 'npm', ['run', 'build']);
  check('source-tests', 'npm', ['test']);
  check('source-dsh-gateway', 'npm', ['run', 'test:display:gateway']);
  const pack = JSON.parse(check('pack', 'npm', ['pack', '--json', '--pack-destination', evidence]))[0];
  const tar = join(evidence, pack.filename);
  writeFileSync(join(packed, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  check('packed-install', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(scratch, 'cache'), tar], packed);
  linkSdk(packed);
  const installed = join(packed, 'node_modules', 'hanaworlds-canvas');
  const closure = pack.files.map(({ path }) => {
    const built = readFileSync(join(source, path)); const bytes = readFileSync(join(installed, path));
    if (!built.equals(bytes)) throw new Error(`Packed bytes differ: ${path}`);
    return { path, length: bytes.length, sha256: sha(bytes) };
  });
  const frozenClient = execFileSync('git', ['show', `${commit}:lib/client.js`], { cwd: root });
  if (!frozenClient.equals(readFileSync(join(installed, 'lib/client.js')))) throw new Error('Frozen client differs from rebuilt/installed bytes.');
  check('packed-tests', process.execPath, ['--test', 'test/local-world.test.mjs', 'test/region-undo.test.mjs', 'test/display.test.mjs', 'test/display-remote.test.mjs'], source,
    { CANVAS_ENTRY: join(installed, 'src/index.mjs'), CANVAS_DISPLAY_ENTRY: join(installed, 'src/display-host.mjs') });
  let registration;
  vm.runInNewContext(readFileSync(join(installed, 'lib/client.js'), 'utf8'), { window: { __ModuleLoader__: { load: value => { if (registration) throw new Error('Duplicate client registration'); registration = value; } } } });
  const client = registration.factory(createRequire(join(source, 'package.json')));
  if (registration.id !== 'hanaworlds-canvas' || client.name !== 'hanaworlds-canvas-objects-history' || typeof client.apply !== 'function') throw new Error('Pack client entry is invalid.');
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({ frozenSource: commit, branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version,
    npm: execFileSync('npm', ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(), tar, tarSha256: sha(readFileSync(tar)), tarBytes: readFileSync(tar).length,
    sourceAndPackedBytes: closure, checks, clientRegistration: registration.id, clientPanel: client.name,
    real: 'CORDIS + CANVAS + FS_STORE + DSH_REGISTRY/GATEWAY', fixture: 'ADAPTER/WORLD + DISPLAY_SEED + HOST_PATH', productUi: 'NOT_RUN', ownerAccepted: false }, null, 2) + '\n');
  success = true;
} finally {
  writeFileSync(join(evidence, 'gate-outcome.json'), JSON.stringify({ success, checks, scratchRemoved: true }, null, 2) + '\n');
  rmSync(scratch, { recursive: true, force: true });
}
