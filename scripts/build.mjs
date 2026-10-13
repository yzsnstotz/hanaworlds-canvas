import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDisplay } from './build-display.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile('package.json'));
const protocolSource = JSON.parse(await readFile('scripts/protocol-source.json'));
for (const [path, digest] of Object.entries(protocolSource.files)) {
  if (sha(await readFile(path)) !== digest) throw new Error(`PROTOCOL_SOURCE_DRIFT:${path}`);
}
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
const client = await buildDisplay();
const inputs = {};
for (const path of [...new Set([...Object.keys(result.metafile.inputs), ...Object.keys(client.metafile.inputs), ...Object.keys(protocolSource.files), 'scripts/protocol-source.json'])].sort()) inputs[path] = sha(await readFile(path));
if (Object.keys(inputs).some(p => p.includes('node_modules/hanaworlds-contracts/') || p.includes('node_modules/cordis/'))) throw new Error('RETIRED_BUILD_INPUT');
const artifacts = {};
for (const path of [...Object.keys(result.metafile.outputs), 'lib/client.js'].sort()) artifacts[path] = sha(await readFile(path));
// Public declarations and fixture schemas are package resources, so record their exact bytes.
async function publicResources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await publicResources(path);
    else if (entry.isFile()) artifacts[path] = sha(await readFile(path));
    else throw new Error(`INVALID_PUBLIC_RESOURCE:${path}`);
  }
}
for (const directory of ['types', 'fixtures', 'LICENSES']) await publicResources(directory);
const source = { format: 'canvas-build-source/v2', supplier: {
  name: 'hanaworlds-canvas', documents: protocolSource.documents,
  protocolSourceSHA256: sha(await readFile('scripts/protocol-source.json')) },
  builder: { name: 'esbuild', version: JSON.parse(await readFile('node_modules/esbuild/package.json')).version },
  inputs, artifacts };
await writeFile('lib/build-source.json', JSON.stringify(source, null, 2) + '\n');
console.log(`BUILD_ARTIFACTS_PASS ${manifest.version}: ${Object.keys(artifacts).length} artifacts`);
