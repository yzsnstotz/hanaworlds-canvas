import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestValue, validateCanvasEvent } from 'hanaworlds-contracts';
import { createUndoExample } from './support/undo-example.mjs';
import { openUndoHost } from './support/undo-host.mjs';
import { undoSessionRef, undoWorldRef } from './support/undo-fixture-world.mjs';

// J3.S2: after a build the objects/history panel has one more record, Canvas emits the
// canvas/v7 TransactionVerified event, and Undo/Redo emit HistoryPositionChanged. Everything
// runs through Canvas's public operations against the isolated FIXTURE world.
const D = (kind, value) => digestValue(kind, value).sha256;

async function hostWithEvents(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-objects-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createUndoExample(directory);
  const host = await openUndoHost(directory);
  const events = [];
  host.canvas.emitEvent = event => { events.push(event); };
  return { host, events };
}

/** One per-cell build through the public canvas/v7 path a Workshop build uses. */
async function build(canvas, transactionId, materialRef, positions) {
  const actions = await canvas.readHistoryActions(undoSessionRef);
  const localContext = actions.localContext;
  const base = { contractVersion: 'canvas/v7', sessionRef: undoSessionRef, worldRef: undoWorldRef, localContext };
  const operations = { contractVersion: 'operations/v4', buildDigest: 'b'.repeat(64), compilerRevision: 'objects-test-brush-1',
    compilationConfigDigest: 'a'.repeat(64), worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64),
    targetFactsDigest: 'd'.repeat(64), effects: positions.map(position => ({ position, geometryProfile: 'voxel-grid/v1', materialRef, orientation: 1 })) };
  const operationDigest = D('operations', operations);
  const worldRevision = await canvas.readWorldRevision(undoWorldRef);
  const listed = (await canvas.call('ListObjects', { ...base, requestId: `${transactionId}-objects`, expectedRevision: null })).result;
  const analysis = (await canvas.call('AnalyzeAffectedObjects', { ...base, requestId: `${transactionId}-analysis`,
    transactionId, operations, operationDigest, expectedRevision: worldRevision,
    expectedRegistryRevision: listed.registryRevision, expectedSelectionRevision: localContext.selectionRevision })).result;
  const request = { ...base, requestId: transactionId, transactionId, operations, operationDigest,
    analysisDigest: D('affected-analysis', analysis), decisionRevision: null, expectedWorldRevision: worldRevision,
    expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED', regionInspectionBinding: null };
  return { request, response: await canvas.call('ApplyRecoverableCommit', request) };
}

/** Collects the panel's change feed until `count` notices or the signal aborts. */
function watch(canvas) {
  const controller = new AbortController(), notices = [];
  const done = (async () => {
    for await (const notice of canvas.watchObjectsHistory(undoSessionRef, controller.signal)) notices.push(notice);
  })();
  return { notices, stop: async () => { controller.abort(); await done; } };
}

test('a verified build adds one object and one history record, emits TransactionVerified and notifies the panel', async t => {
  const { host, events } = await hostWithEvents(t);
  const before = await host.canvas.readObjectsHistory(undoSessionRef);
  const feed = watch(host.canvas);
  await new Promise(resolve => setImmediate(resolve));
  const { request, response } = await build(host.canvas, 'objects-build-1', 'fixture:plank', [[20, 2, 20], [21, 2, 20]]);
  assert.equal(response.error, null, JSON.stringify(response.error));
  assert.equal(response.result.status, 'VERIFIED');

  const after = await host.canvas.readObjectsHistory(undoSessionRef);
  assert.equal(after.objects.length, before.objects.length + 1);
  assert.equal(after.history.length, before.history.length + 1);
  const row = after.history.find(entry => entry.transactionId === 'objects-build-1');
  assert.deepEqual([row.status, row.mode, row.affectedCells], ['COMMITTED', 'CELL', 2]);
  assert.ok(Date.parse(row.committedAt));
  // The expected image is the world source's: materialRef/orientation from the effect.
  const saved = host.canvas.store.snapshot.transactions['objects-build-1'];
  assert.deepEqual(saved.after.records.map(r => [r.materialRef, r.orientation]), [['fixture:plank', 1], ['fixture:plank', 1]]);

  assert.equal(events.length, 1);
  const [event] = events;
  assert.deepEqual(validateCanvasEvent('TransactionVerified', event), event);
  assert.deepEqual([event.event, event.operation, event.receipt.requestId], ['TransactionVerified', 'Readback', 'objects-build-1']);
  assert.deepEqual(event.receipt.result, response.result);
  assert.equal(saved.history.receiptDigest, D('receipt', event.receipt.result));

  // Exact replay returns the stored receipt and publishes nothing new.
  const replay = await host.canvas.call('ApplyRecoverableCommit', request);
  assert.deepEqual(replay, response);
  assert.equal(events.length, 1);
  await feed.stop();
  assert.ok(feed.notices.length >= 1, 'the panel is told about the new record');
  assert.equal(feed.notices.at(-1).worldRef, undoWorldRef);
  assert.equal(feed.notices.at(-1).registryRevision, host.canvas.store.snapshot.registryRevisions[undoWorldRef]);
});

test('Undo and Redo emit HistoryPositionChanged with their verified receipts; refusals emit nothing', async t => {
  const { host, events } = await hostWithEvents(t);
  const ref = (await host.readView()).entries[1].objectRef;
  const refused = await host.perform((await host.readView()).entries[0].objectRef, 'undo');
  assert.equal(refused.error.code, 'WORLD_CHANGED_SINCE');
  assert.equal(events.length, 0);

  const feed = watch(host.canvas);
  await new Promise(resolve => setImmediate(resolve));
  const undo = await host.perform(ref, 'undo');
  assert.equal(undo.status, 'VERIFIED');
  const redo = await host.perform(ref, 'redo');
  assert.equal(redo.status, 'VERIFIED');
  await feed.stop();
  assert.deepEqual(events.map(e => [e.event, e.operation, e.receipt.result.transactionId, e.receipt.result.status]),
    [['HistoryPositionChanged', 'Undo', undo.transactionId, 'VERIFIED'],
      ['HistoryPositionChanged', 'Redo', redo.transactionId, 'VERIFIED']]);
  for (const event of events) assert.deepEqual(validateCanvasEvent('HistoryPositionChanged', event), event);
  assert.ok(feed.notices.length >= 2, 'each move reaches the panel');

  // A replayed Redo answers from the store and emits nothing.
  await host.canvas.call('Redo', redo.request);
  assert.equal(events.length, 2);
});

test('an event consumer failure never fails or rolls back the verified commit', async t => {
  const { host } = await hostWithEvents(t);
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args[0]); });
  host.canvas.emitEvent = () => { throw new Error('consumer down'); };
  const { response } = await build(host.canvas, 'objects-build-2', 'fixture:plank', [[30, 2, 30]]);
  assert.equal(response.result.status, 'VERIFIED');
  assert.ok(host.canvas.store.snapshot.transactions['objects-build-2']);
  assert.deepEqual(host.canvas.store.snapshot.pending, {});
  assert.deepEqual(logged, ['Canvas event delivery failed']);
});
