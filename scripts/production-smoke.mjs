import assert from 'node:assert/strict';
import { readFile, realpath, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import * as canvas from 'hanaworlds-canvas';
import * as display from 'hanaworlds-canvas/display';
import * as consumer from 'hanaworlds-canvas/examples/native-facts-consumer.mjs';
const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('hanaworlds-contracts'), error => error.code === 'MODULE_NOT_FOUND');
const entry = await realpath(fileURLToPath(import.meta.resolve('hanaworlds-canvas')));
assert.ok(entry.startsWith(await realpath('node_modules') + '/'), 'entry must be installed, not development');
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.resolve('hanaworlds-canvas'))));
for (const [key, target] of Object.entries(manifest.exports)) {
  const specifier = key === '.' ? manifest.name : manifest.name + key.slice(1);
  if (typeof target === 'string' && target.endsWith('.json'))
    JSON.parse(await readFile(new URL(import.meta.resolve(specifier))));
  else if (key !== './client') await import(specifier);
}
assert.equal(new canvas.CanvasV5({ store: null }).status().version, manifest.version);
assert.equal(canvas.canvasProtocolHandshake.provenance.packageVersion, manifest.version);
assert.equal(canvas.Config.type, 'object');
const port = await consumer.createFixtureNativeFactsPort();
const facts = await port.readScopedState('local-connection', [[0, 1, 3]]);
assert.equal(consumer.validateNativeFactsScopedState(facts).worldRef, 'fixture-world');
assert.throws(() => consumer.validateNativeFactsScopedState({ cells: [] }), e => e.publicError?.code === 'SCHEMA_INVALID');
await assert.rejects(() => port.readScopedState('different', [[0, 1, 3]]), /NATIVE_FACTS_FIXTURE_ARGUMENT_MISMATCH/);
const missing = Object.fromEntries(Object.keys(facts.stateProfile).map(name => [name, { status: 'MISSING', reason: 'REQUIRED_FACT_UNKNOWN' }]));
assert.equal(canvas.assembleProfile('compilationConfig', missing, {}).status, 'SOURCE_MISSING');
const ctx = new Context();
try {
  const directory = join(process.cwd(), 'host-profile'); await mkdir(directory, { recursive: true });
  ctx.provide('dshHomePath', (...parts) => join(directory, ...parts));
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(canvas.default);
  const service = ctx.get('hanaworldsCanvasV5'); await service.ready;
  assert.equal(service.storageState, 'READY');
  assert.deepEqual(await service.readObjectsHistory(null), { state: 'NO_SESSION', worldRef: null, objects: [], history: [] });
  const reply = await service.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v7',
    sessionRef: 'absent-session', worldRef: 'fixture-world', requestId: 'absent' });
  assert.equal(reply.error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(reply.error.mutationState, 'NONE');
  assert.equal(reply.error.worldRef, 'fixture-world');
  assert.ok(ctx.get('hanaworldsCanvasDisplay'), 'normal Host entry registers its own display service');
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const invoke = (method, args) => gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method, args });
  assert.deepEqual(await invoke('read', { sessionRef: null }), { state: 'NO_SESSION', worldRef: null, objects: [], history: [] });
  assert.deepEqual(await invoke('actions', { sessionRef: null }), { state: 'NO_SESSION', worldRef: null, objects: [] });
  await assert.rejects(() => invoke('read', { sessionRef: {}, worldRef: 'extra-input' }));
  await assert.rejects(() => invoke('undo', { sessionRef: 'absent-session', objectRef: 'absent-object', historyTransactionId: 'absent-history' }));
  assert.equal(typeof display.CanvasDisplayService.prototype.read, 'function');
} finally { await ctx.fiber.dispose(); }
let factory;
vm.runInNewContext(await readFile(new URL(import.meta.resolve('hanaworlds-canvas/client')), 'utf8'), {
  window: { __ModuleLoader__: { load: entry => { factory = entry.factory; } } },
});
const client = factory(id => { assert.equal(id, 'react'); return require('react'); });
assert.equal(typeof client.apply, 'function');
console.log('PRODUCTION_CAPABILITIES_PASS: all public entries, schemas, Config, durable official Cordis Host, fail-closed session/world errors, native consumer, shared React client');
