import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import * as plugin from '../src/index.mjs';
import { undoConnection } from './support/undo-fixture-world.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';
import { guardRefusalError } from 'hanaworlds-contracts';

const runRoot = join(homedir(), '.cache/hana-world-runs/canvas-03');
const defaults = { frontGapCells: 2, forwardSearchCells: 16,
  lateralSearchCells: 8, verticalSearchCells: 4 };

test('management Config serializes editable, documented placement search fields', () => {
  assert.ok(plugin.Config, 'the plugin must export its management schema');
  assert.equal(plugin.default.Config, plugin.Config);
  assert.deepEqual(plugin.Config({}), { placement: defaults });
  const hydrated = new Schema(JSON.parse(JSON.stringify(plugin.Config)));
  assert.deepEqual(hydrated({ placement: { frontGapCells: 0 } }),
    { placement: { ...defaults, frontGapCells: 0 } });
  for (const [key, value] of Object.entries(defaults)) {
    const node = plugin.Config.dict.placement.dict[key];
    assert.equal(node.meta.default, value);
    assert.match(node.meta.description, /默认/);
    assert.match(node.meta.description, /范围/);
    assert.match(node.meta.description, /0/);
    assert.match(node.meta.description, /保存/);
    assert.notEqual(node.meta.disabled, true);
    for (const invalid of [-1, 0.5, '2', Infinity])
      assert.throws(() => plugin.Config({ placement: { [key]: invalid } }));
  }
});

test('Cordis saved config reaches existing worlds after reload and invalidates old inspections', async () => {
  await mkdir(runRoot, { recursive: true });
  const profile = await mkdtemp(join(runRoot, 'config-host-'));
  let observed;
  const adapter = { protocolHandshake: g3CellHandshake(), async call(operation, request) {
    const response = result => ({ contractVersion: 'world-adapter/v8',
      requestId: request.requestId, result, error: null });
    if (operation === 'ReadLocalConnection') return response(structuredClone(undoConnection));
    if (operation === 'DiscoverConnections') return response({ capabilityRevision: 'undo-fixture-cap-1',
      connections: [{ adapterId: 'hanaworlds-world-adapter',
        connectionRef: undoConnection.connectionRef, worldRef: undoConnection.worldRef,
        displayName: 'Config fixture', capabilityRevision: 'undo-fixture-cap-1',
        payloadVersion: undoConnection.payloadVersion, readiness: 'READY',
        connectionIncarnationRef: undoConnection.connectionIncarnationRef }] });
    if (operation === 'InspectRegion') {
      observed = structuredClone(request.placementSettings);
      const guardRefusal = { guard: 'CELL_PROTECTION', stage: 'INSPECT_REGION', finding: 'PROTECTED_CELL' };
      return { ...response(null), guardRefusal, error: guardRefusalError(guardRefusal) };
    }
    throw new Error(`unexpected fixture call: ${operation}`);
  } };
  const ctx = new Context();
  ctx.provide('dshHomePath', (...parts) => join(profile, ...parts));
  ctx.provide('hanaworldsWorldAdapterV6', adapter);
  ctx.provide('hanaworldsWorkshopV3', fixtureSessions());
  let fiber;
  try {
    fiber = ctx.plugin(plugin.default, {});
    await fiber;
    let canvas = ctx.get('hanaworldsCanvasV5');
    await canvas.ready;
    const base = { contractVersion: 'canvas/v7', sessionRef: 'config-session', worldRef: undoConnection.worldRef };
    const unbound = await canvas.call('ReadWorldSelectionContext', { ...base, requestId: 'context' });
    const selected = await canvas.call('SelectWorldConnection', { ...base, requestId: 'select',
      connectionRef: undoConnection.connectionRef,
      connectionIncarnationRef: undoConnection.connectionIncarnationRef,
      expectedRevision: unbound.result.selection.sessionRevision, expectedContext: null });
    assert.equal(selected.error, null);
    const inspect = { ...base, requestId: 'inspect', localContext: selected.result.localContext,
      anchor: { kind: 'CURRENT_VIEW', invocationId: 'config-view' },
      footprint: { geometryProfile: 'voxel-grid/v1', widthCells: 1, depthCells: 1, heightCells: 1 } };
    await canvas.call('InspectPlacementRegion', inspect);
    assert.deepEqual(observed, { ...defaults, settingsRevision: 'placement-0' });
    await canvas.store.commit(state => {
      state.placementInspections['old-inspection'] = { worldRef: base.worldRef };
      state.replay['old-placement'] = { response: { result: { outcome: 'PLACEMENT_CHOICE_REQUIRED',
        choice: { placementSettings: observed } } } };
    });
    await fiber.dispose();
    const changed = { frontGapCells: 0, forwardSearchCells: 3,
      lateralSearchCells: 0, verticalSearchCells: 0 };
    fiber = ctx.plugin(plugin.default, { placement: changed });
    await fiber;
    canvas = ctx.get('hanaworldsCanvasV5');
    await canvas.ready;
    await canvas.call('InspectPlacementRegion', inspect);
    assert.deepEqual({ ...observed, settingsRevision: undefined }, { ...changed, settingsRevision: undefined });
    assert.notEqual(observed.settingsRevision, 'placement-0');
    assert.equal(canvas.store.snapshot.placementInspections['old-inspection'], undefined);
    assert.equal(canvas.store.snapshot.replay['old-placement'], undefined);
    const revision = observed.settingsRevision;
    await fiber.dispose();
    fiber = ctx.plugin(plugin.default, { placement: changed });
    await fiber;
    canvas = ctx.get('hanaworldsCanvasV5');
    await canvas.ready;
    assert.equal(canvas.store.snapshot.placementSettings[base.worldRef].settingsRevision, revision);
  } finally {
    if (fiber) await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
