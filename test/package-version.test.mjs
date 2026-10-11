import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('both public handshakes and status follow the installed package version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-package-version-'));
  try {
    // Isolated package copy simulates a release bump without changing this checkout.
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    manifest.version = '99.0.0-canvas-version-fixture';
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    await cp(new URL('../src', import.meta.url), join(directory, 'src'), { recursive: true });
    await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
    const { CanvasV5, CanvasRegionV1, canvasProtocolHandshake } = await import(
      pathToFileURL(join(directory, 'src/index.mjs')).href);
    const canvas = new CanvasV5({ store: null });
    const region = new CanvasRegionV1(canvas);
    assert.equal(canvas.protocolHandshake.provenance.packageVersion, manifest.version);
    assert.equal(region.protocolHandshake.provenance.packageVersion, manifest.version);
    assert.equal(canvasProtocolHandshake.provenance.packageVersion, manifest.version);
    assert.equal(canvas.status().version, manifest.version);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
