import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import canvasPlugin, { Config, STORE_ROOT } from 'hanaworlds-canvas';
import { CanvasDisplayService } from 'hanaworlds-canvas/display';

// Actual production package + official Host components; the home is isolated.
// No Adapter/world is fabricated here. Transaction/world regression coverage
// remains in the existing document-shaped peer tests.
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.resolve('hanaworlds-canvas'))));
assert.deepEqual(manifest.peerDependencies, { '@deepseek-ai/cordis': '4.0.5-alpha.1',
  '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2', react: '18.3.1', zod: '4.4.3' });
assert.equal(require('zod/package.json').version, '4.4.3');
assert.equal(require('@deepseek-ai/cordis/package.json').version, '4.0.5-alpha.1');
assert.equal(typeof CanvasDisplayService, 'function');
const home = join(process.cwd(), 'home'); await mkdir(home);
const ctx = new Context();
try {
  ctx.provide('dshHomePath', (...parts) => join(home, ...parts));
  await ctx.plugin(TypertRegistry);
  const fiber = ctx.plugin(canvasPlugin, { placement: { frontGapCells: 0, forwardSearchCells: 3 } });
  await fiber;
  const canvas = ctx.get('hanaworldsCanvasV5'); await canvas.ready;
  assert.equal(canvas.storageState, 'READY');
  assert.equal(canvas.store.directory, join(home, 'data', STORE_ROOT));
  assert.equal(canvas.placementConfig.frontGapCells, 0);
  assert.equal(canvas.placementConfig.forwardSearchCells, 3);
  assert.equal(Config.type, 'object');
  const region = ctx.get('hanaworldsCanvasRegionV1');
  assert.equal(region.protocolHandshake.protocols.find(p => p.protocol === 'canvas-region').major, 3);
  await region.describe(null);
  assert.ok(ctx.get('hanaworldsCanvasConfigSupply'));
  assert.ok(ctx.get('hanaworldsCompilerConfig'));
  assert.ok(ctx.get('hanaworldsCanvasDisplay'));
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const invoke = (method, args) => gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method, args });
  const before = structuredClone(canvas.store.snapshot);
  assert.deepEqual(await invoke('read', { sessionRef: null }), { state: 'NO_SESSION', worldRef: null, objects: [], history: [] });
  assert.deepEqual(await invoke('actions', { sessionRef: null }), { state: 'NO_SESSION', worldRef: null, objects: [] });
  for (const args of [{ sessionRef: {} }, { sessionRef: null, worldRef: 'forged' }])
    await assert.rejects(() => invoke('read', args));
  await assert.rejects(() => invoke('undo', { sessionRef: 'absent', objectRef: 'absent',
    historyTransactionId: 'absent', localContext: {} }));
  assert.deepEqual(canvas.store.snapshot, before, 'Unbound reads and strict rejections never write');
  const failedHome = join(process.cwd(), 'home-is-a-file');
  await writeFile(failedHome, 'This owned file cannot hold Canvas storage.\n');
  const failed = new Context();
  try {
    failed.provide('dshHomePath', (...parts) => join(failedHome, ...parts));
    await failed.plugin(TypertRegistry);
    await failed.plugin(canvasPlugin);
    const unavailable = failed.get('hanaworldsCanvasV5'); await unavailable.ready;
    assert.equal(unavailable.storageState, 'UNAVAILABLE');
    const failedGateway = new TypertGatewayService(failed,
      { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
    await assert.rejects(() => failedGateway.invoke({ namespace: 'hanaworldsCanvasDisplay',
      method: 'read', args: { sessionRef: 'absent' } }), error =>
      error.code === 'canvas/storage-unavailable' &&
      error.details.storageFailure.code === unavailable.storageFailure.code);
  } finally { await failed.fiber.dispose(); }
  console.log('INSTALLED_OFFICIAL_COMPONENT_RUNTIME_PASS; REAL_DESKTOP_UI_UNPROVEN');
} finally { await ctx.fiber.dispose(); }
