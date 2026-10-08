import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('lib', { recursive: true });
await build({ entryPoints: ['src/client.jsx'], bundle: true, format: 'cjs', platform: 'browser',
  target: 'es2022', preserveSymlinks: true, external: ['react'], outfile: 'lib/client.js',
  banner: { js: 'window.__ModuleLoader__.load({id:"hanaworlds-canvas",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' } });
