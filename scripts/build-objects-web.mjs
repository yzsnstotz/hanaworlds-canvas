import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
// The shared Canvas host's assets live in this card's own run; the Objects run's
// earlier assets are left untouched as its evidence and rollback supply.
const assets = join(homedir(), '.cache', 'hanaworlds-runs', 'F-CANVAS-UNDO-01', 'undo-web', 'assets');
await mkdir(assets, { recursive: true, mode: 0o700 });
for (const [entry, out] of [['src/objects-web.jsx', 'objects.js'], ['src/undo-web.jsx', 'undo.js']])
  await build({ entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(assets, out) });
await copyFile('src/objects-web.css', join(assets, 'objects.css'));
await copyFile('src/undo-web.css', join(assets, 'undo.css'));
console.log(`Canvas web assets: ${assets}`);
