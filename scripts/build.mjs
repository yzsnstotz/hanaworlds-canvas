import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile('package.json'));
const installed = JSON.parse(await readFile('node_modules/hanaworlds-contracts/package.json'));
const lock = JSON.parse(await readFile('package-lock.json'));
const release = lock.packages['node_modules/hanaworlds-contracts'];
const entries = (await readdir('src')).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`);
entries.push('examples/native-facts-consumer.mjs');
const result = await build({ entryPoints: entries, outbase: '.', outdir: 'lib', outExtension: { '.js': '.mjs' },
  bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', metafile: true,
  chunkNames: 'chunks/[name]-[hash]', external: [...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies), 'react', '@deepseek-ai/*'],
  plugins: [{ name: 'installed-package-and-public-assets', setup(builder) {
    // Preserve version readback from the installed Canvas manifest, rather than freezing it.
    builder.onResolve({ filter: /^\.\.\/package\.json$/ }, () => ({ path: '../../package.json', external: true }));
    builder.onLoad({ filter: /\/examples\/native-facts-consumer\.mjs$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')).replaceAll("new URL('../fixtures/", "new URL('../../fixtures/"), loader: 'js' }));
  } }] });
// Remove only obsolete generated chunks, never candidates or other runtime directories.
for (const name of await readdir('lib/chunks')) {
  const path = `lib/chunks/${name}`;
  if (/^chunk-[A-Z0-9]+\.mjs$/.test(name) && !Object.hasOwn(result.metafile.outputs, path)) await unlink(path);
}
const client = spawnSync(process.execPath, ['scripts/build-display.mjs'], { stdio: 'inherit' });
if (client.status !== 0) process.exit(client.status ?? 1);
const inputs = {};
for (const path of Object.keys(result.metafile.inputs).sort()) inputs[path] = sha(await readFile(path));
const artifacts = {};
for (const path of [...Object.keys(result.metafile.outputs), 'lib/client.js'].sort()) artifacts[path] = sha(await readFile(path));
await mkdir('LICENSES', { recursive: true });
await writeFile('LICENSES/HANAWORLDS-CONTRACTS-MIT.txt', await readFile('node_modules/hanaworlds-contracts/LICENSE'));
await writeFile('LICENSES/HANAWORLDS-CONTRACTS-NOTICE.txt', await readFile('node_modules/hanaworlds-contracts/NOTICE'));
const source = { format: 'canvas-build-source/v1', supplier: {
  name: installed.name, version: installed.version, tag: manifest.devDependencies['hanaworlds-contracts'],
  resolved: release.resolved, revision: release.resolved.split('#')[1],
  packageSHA256: sha(await readFile('node_modules/hanaworlds-contracts/package.json')) },
  builder: { name: 'esbuild', version: JSON.parse(await readFile('node_modules/esbuild/package.json')).version },
  inputs, artifacts };
await writeFile('lib/build-source.json', JSON.stringify(source, null, 2) + '\n');
console.log(`BUILD_ARTIFACTS_PASS ${installed.version}: ${Object.keys(artifacts).length} artifacts`);
