import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const assets = join(homedir(), '.cache', 'hanaworlds-runs', 'F-CANVAS-OBJECTS-HISTORY-01', 'objects-web', 'assets');
await mkdir(assets, { recursive: true });
await build({ entryPoints: ['src/objects-web.jsx'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(assets, 'objects.js') });
await copyFile('src/objects-web.css', join(assets, 'objects.css'));
console.log(`Canvas web assets: ${assets}`);
