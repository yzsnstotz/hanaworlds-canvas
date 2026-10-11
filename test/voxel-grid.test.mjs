import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestValue, validateCanvasEvent } from 'hanaworlds-contracts';
import { createUndoExample } from './support/undo-example.mjs';
import { openUndoHost } from './support/undo-host.mjs';
import { undoSessionRef, undoWorldRef } from './support/undo-fixture-world.mjs';

const D = (kind, value) => digestValue(kind, value).sha256;

test('the published notification example uses the C-canvas event fields', async () => {
  const example = JSON.parse(await readFile(new URL('../fixtures/affected-object-notification.json', import.meta.url)));
  assert.equal(validateCanvasEvent('AffectedObjectNotificationRequired', example).receipt.result.decisionKind,
    'BLOCK_AND_NOTIFY');
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-voxel-grid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createUndoExample(directory);
  const host = await openUndoHost(directory);
  const events = [];
  host.canvas.emitEvent = event => events.push(event);
  const localContext = host.canvas.current(undoSessionRef).localContext;
  const operations = { contractVersion: 'operations/v4', buildDigest: 'b'.repeat(64),
    compilerRevision: 'voxel-grid-fixture', compilationConfigDigest: 'a'.repeat(64), worldRef: undoWorldRef,
    frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64), targetFactsDigest: 'd'.repeat(64),
    effects: [[4, 2, 4], [8, 2, 8]].map(position => ({ geometryProfile: 'voxel-grid/v1', position,
      materialRef: 'opaque:fixture', orientation: 0 })) };
  const request = { contractVersion: 'canvas/v7', sessionRef: undoSessionRef, worldRef: undoWorldRef,
    requestId: 'overlap-analysis', transactionId: 'overlap-transaction', localContext, operations,
    operationDigest: D('operations', operations), expectedRevision: await host.canvas.readWorldRevision(undoWorldRef),
    expectedRegistryRevision: host.canvas.store.snapshot.registryRevisions[undoWorldRef],
    expectedSelectionRevision: localContext.selectionRevision };
  return { ...host, events, request, directory };
}

test('overlap analysis durably blocks and notifies with exactly the affected objects; replay is quiet', async t => {
  const { canvas, events, request, world, directory } = await fixture(t);
  const before = world.readCells([[4, 2, 4], [8, 2, 8]]);
  const response = await canvas.call('AnalyzeAffectedObjects', request);
  assert.equal(response.error, null);
  const expectedRefs = Object.keys(canvas.store.snapshot.objects[undoWorldRef]).sort();
  assert.deepEqual(response.result.affectedObjectRefs, expectedRefs);
  assert.equal(events.length, 1);
  const event = validateCanvasEvent('AffectedObjectNotificationRequired', events[0]);
  assert.equal(event.receipt.result.decisionKind, 'BLOCK_AND_NOTIFY');
  assert.deepEqual(event.receipt.result.affectedObjectRefs, expectedRefs);
  assert.equal(event.receipt.result.analysisDigest, D('affected-analysis', response.result));
  assert.equal(event.receipt.result.transactionId, request.transactionId);
  assert.deepEqual((await canvas.call('AnalyzeAffectedObjects', request)), response);
  assert.equal(events.length, 1);
  const reopened = (await openUndoHost(directory)).canvas;
  assert.equal(JSON.stringify(await reopened.call('AnalyzeAffectedObjects', request)), JSON.stringify(response));
  assert.equal(JSON.stringify(reopened.store.snapshot.affectedDecisions[request.transactionId]),
    JSON.stringify(event.receipt.result));
  assert.deepEqual(world.readCells([[4, 2, 4], [8, 2, 8]]), before);
  const applied = await canvas.call('ApplyRecoverableCommit', { contractVersion: 'canvas/v7',
    sessionRef: undoSessionRef, worldRef: undoWorldRef, localContext: request.localContext,
    requestId: 'overlap-apply', transactionId: request.transactionId, operations: request.operations,
    operationDigest: request.operationDigest, analysisDigest: D('affected-analysis', response.result),
    decisionRevision: event.receipt.result.decisionRevision, expectedWorldRevision: request.expectedRevision,
    expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED', regionInspectionBinding: null });
  assert.equal(applied.error.code, 'OTHER_OBJECTS_AFFECTED');
  assert.deepEqual(world.readCells([[4, 2, 4], [8, 2, 8]]), before);
});

test('world source without voxel geometry refuses analysis before storing facts or notifying', async t => {
  const { canvas, events, request, world } = await fixture(t);
  const adapterCall = world.adapter.call;
  world.adapter.call = async (operation, body) => {
    const response = await adapterCall(operation, body);
    return operation === 'ReadLocalConnection' ? { ...response, result: { ...response.result,
      capabilities: { ...response.result.capabilities, worldGeometry: null } } } : response;
  };
  const before = structuredClone(canvas.store.snapshot);
  const response = await canvas.call('AnalyzeAffectedObjects', request);
  assert.equal(response.error.code, 'CAPABILITY_GAP');
  assert.equal(response.error.mutationState, 'NONE');
  assert.deepEqual(canvas.store.snapshot, before);
  assert.deepEqual(events, []);
});

test('placement forwards its explicit voxel geometry profile to the adapter', async t => {
  const { canvas, request, world } = await fixture(t);
  const adapterCall = world.adapter.call;
  let forwarded;
  world.adapter.call = async (operation, body) => {
    if (operation === 'InspectRegion') {
      forwarded = body;
      throw new Error('FIXTURE_INSPECTION_STOP');
    }
    return adapterCall(operation, body);
  };
  await canvas.call('InspectPlacementRegion', { contractVersion: 'canvas/v7', sessionRef: undoSessionRef,
    worldRef: undoWorldRef, requestId: 'profile-inspection', localContext: request.localContext,
    anchor: { kind: 'PICKED_POINT', pickRef: 'fixture-pick' },
    footprint: { geometryProfile: 'voxel-grid/v1', widthCells: 1, heightCells: 1, depthCells: 1 } });
  assert.equal(forwarded?.footprint.geometryProfile, 'voxel-grid/v1');
});

test('voxel-grid module refuses profiles before computing an overlap', async () => {
  const grid = await import('../src/voxel-grid.mjs');
  assert.throws(() => grid.affectedObjectRefs({ object: { positions: [[0, 0, 0]] } }, [[0, 0, 0]], 'mesh/v1'),
    error => error.publicError?.code === 'CAPABILITY_GAP');
  assert.deepEqual(grid.affectedObjectRefs({ z: { positions: [[0, 0, 0]] }, a: { positions: [[0, 0, 0]] },
    far: { positions: [[1, 0, 0]] } }, [[0, 0, 0]], 'voxel-grid/v1', 'z'), ['a']);
});

test('unsupported placement profile returns CAPABILITY_GAP without inspecting the world', async t => {
  const { canvas, request, world, events } = await fixture(t);
  const before = structuredClone(canvas.store.snapshot);
  world.calls.length = 0;
  const response = await canvas.call('InspectPlacementRegion', { contractVersion: 'canvas/v7',
    sessionRef: undoSessionRef, worldRef: undoWorldRef, requestId: 'unsupported-profile',
    localContext: request.localContext, anchor: { kind: 'PICKED_POINT', pickRef: 'fixture-pick' },
    footprint: { geometryProfile: 'mesh/v1', widthCells: 1, heightCells: 1, depthCells: 1 } });
  assert.equal(response.error.code, 'CAPABILITY_GAP');
  assert.equal(response.error.mutationState, 'NONE');
  assert.ok(!world.calls.some(row => row.operation === 'InspectRegion'));
  assert.deepEqual(canvas.store.snapshot, before);
  assert.deepEqual(events, []);
});

test('disjoint analysis publishes no affected-object notification', async t => {
  const { canvas, request, events } = await fixture(t);
  request.operations.effects = [{ ...request.operations.effects[0], position: [40, 2, 40] }];
  request.operationDigest = D('operations', request.operations);
  const response = await canvas.call('AnalyzeAffectedObjects', request);
  assert.deepEqual(response.result.affectedObjectRefs, []);
  assert.deepEqual(events, []);
});

test('an affected object already in the selection needs no notification', async t => {
  const { canvas, request, events } = await fixture(t);
  const objectRefs = Object.keys(canvas.store.snapshot.objects[undoWorldRef]).sort();
  const selected = await canvas.call('SetObjectSelection', { contractVersion: 'canvas/v7',
    sessionRef: undoSessionRef, worldRef: undoWorldRef, requestId: 'select-affected', objectRefs,
    expectedSelectionRevision: request.localContext.selectionRevision, localContext: request.localContext });
  assert.equal(selected.error, null);
  events.length = 0;
  request.localContext = canvas.current(undoSessionRef).localContext;
  request.expectedSelectionRevision = request.localContext.selectionRevision;
  const response = await canvas.call('AnalyzeAffectedObjects', request);
  assert.deepEqual(response.result.affectedObjectRefs, objectRefs);
  assert.deepEqual(events, []);
});

test('notification consumer failure keeps the durable analysis and block decision', async t => {
  const { canvas, request } = await fixture(t);
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args[0]));
  canvas.emitEvent = () => { throw new Error('fixture-consumer-down'); };
  const response = await canvas.call('AnalyzeAffectedObjects', request);
  assert.equal(response.error, null);
  assert.equal(canvas.store.snapshot.affectedDecisions[request.transactionId].decisionKind, 'BLOCK_AND_NOTIFY');
  assert.deepEqual(logged, ['Canvas event delivery failed']);
});

test('voxel footprints preserve negative coordinates, closed boxes and unspecified region cells', async () => {
  const { encodeRegionBlock } = await import('hanaworlds-contracts');
  const grid = await import('../src/voxel-grid.mjs');
  const block = encodeRegionBlock({ origin: [-2, -1, -3], size: [2, 1, 1],
    palette: [{ materialRef: 'opaque:material', orientation: 1 }], indices: [-1, 0] });
  assert.deepEqual(grid.regionPositions({ chunks: [{ block }] }), [[-1, -1, -3]]);
  assert.deepEqual(grid.boxCells({ min: [-2, -1, -3], max: [-1, -1, -3] }, 'voxel-grid/v1'),
    [[-2, -1, -3], [-1, -1, -3]]);
  assert.deepEqual(grid.footprintBounds([[-2, -1, -3], [-1, -1, -3]], 'voxel-grid/v1'),
    { min: [-2, -1, -3], max: [-1, -1, -3], size: [2, 1, 1] });
});
