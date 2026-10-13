import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export async function buildClientVerification(options = {}) {
  const output = resolve(options.output ?? options.outfile ?? resolve(root, '../evidence/client-verification/client.js'));
  const lib = resolve(root, 'lib');
  if (output === lib || output.startsWith(lib + sep))
    throw new Error('CANVAS_VERIFICATION_OUTPUT_IN_PUBLISHED_LIB');
  const examples = JSON.parse(await readFile(resolve(root, 'test/client-verification/canvas-examples.json'), 'utf8'));
  // Only button identities enter the observer bundle. No example requests,
  // responses, events, bindings or expected snapshots are bundled here.
  const cases = [
    ...examples.cases.flatMap(x => ['ok', 'reject'].map(mode => ({ id: x.id, mode }))),
    ...examples.events.flatMap(x => ['ok', 'reject', 'replay'].map(mode => ({ id: `event/${x.id}`, mode }))),
    ...examples.business.map(x => ({ id: `business/${x.id}`, mode: 'reject' })),
    ...examples.local.flatMap(x => ['ok', 'reject'].map(mode => ({ id: `local/${x.id}`, mode }))),
    ...['navigation', 'populated-history', 'undo-redo', 'configuration-reload', 'region', 'visible-error', 'unload']
      .map(id => ({ id: `ui/${id}`, mode: 'ok' })),
  ];
  await mkdir(dirname(output), { recursive: true });
  return build({ absWorkingDir: root, entryPoints: [fileURLToPath(new URL('./client.jsx', import.meta.url))],
    outfile: output, bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
    preserveSymlinks: true, metafile: true, external: ['react'],
    define: { __CANVAS_VERIFICATION_CASES__: JSON.stringify(cases) },
    banner: { js: 'window.__ModuleLoader__.load({id:"hanaworlds-canvas-client-verification",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
    footer: { js: 'return module.exports;}});' } });
}
// Bundle the own validation code because production lib/src intentionally does not
// expose src/protocol/local. The caller verifies these exact source inputs against
// the installed artifact's build-source manifest before installing this tool entry.
export async function buildHostVerification({ output } = {}) {
  output = resolve(output ?? resolve(root, '../evidence/client-verification/host.mjs'));
  if (output === resolve(root, 'lib') || output.startsWith(resolve(root, 'lib') + sep))
    throw new Error('CANVAS_VERIFICATION_OUTPUT_IN_PUBLISHED_LIB');
  await mkdir(dirname(output), { recursive: true });
  return build({ absWorkingDir: root, entryPoints: [fileURLToPath(new URL('./host.mjs', import.meta.url))],
    outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'node24',
    metafile: true, external: ['@deepseek-ai/*', 'react', 'zod'] });
}
export const buildVerificationClient = buildClientVerification;
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && ['--output', '--outfile'].includes(args[0])))
    throw new Error('Usage: node tools/client-verification/build.mjs [--output filename]');
  await buildClientVerification(args.length ? { output: args[1] } : {});
}
