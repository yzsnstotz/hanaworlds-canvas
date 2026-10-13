import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function buildDisplay() {
await mkdir('lib', { recursive: true });
return build({ entryPoints: ['src/client.jsx'], bundle: true, format: 'cjs', platform: 'browser',
  target: 'es2022', preserveSymlinks: true, metafile: true, external: ['react'], outfile: 'lib/client.js',
  banner: { js: 'window.__ModuleLoader__.load({id:"hanaworlds-canvas",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' } });

}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await buildDisplay();
