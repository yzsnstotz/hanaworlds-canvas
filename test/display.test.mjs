import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { CanvasV5, CanvasStore } = await import(process.env.CANVAS_ENTRY ?? new URL('../src/index.mjs', import.meta.url).href);

test('display is an immutable, session-bound read of durable current objects and recorded history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-display-fixture-'));
  try {
    const store = await CanvasStore.open(directory);
    const localContext = { connectionRef: 'connection-1', connectionIncarnationRef: 'incarnation-1',
      worldRef: 'world-1', selectionRevision: 'selection-1' };
    // Explicit fixture records, never used as live app content.
    await store.commit(state => {
      state.sessions['session-1'] = { activeWorldRef: 'world-1', localContext };
      state.objects['world-1'] = { 'object-1': { objectRef: 'object-1', worldRef: 'world-1',
        displayName: 'Fixture house', creationSequence: 0, status: 'READY' } };
      state.footprints['world-1'] = { 'object-1': { positions: [[1, 2, 3], [2, 2, 3]],
        footprintRevision: 'footprint-1', provenance: 'CANVAS_REGISTERED' } };
      state.history['object-1'] = [
        { transactionId: 'new-build', originTransactionId: null, affectedObjectRefs: ['object-1'], status: 'VERIFIED' },
        { transactionId: 'new-undo', originTransactionId: 'new-build', affectedObjectRefs: ['object-1'], status: 'VERIFIED' },
        { transactionId: 'old-build', originTransactionId: null, affectedObjectRefs: ['object-1'], status: 'VERIFIED' }];
      for (const [id,mode,count,time] of [['new-build','REGION',9,'2026-10-07T08:00:00.000Z'],['new-undo','REGION',9,'2026-10-07T08:01:00.000Z']])
        state.transactions[id] = { objectRef: 'object-1', worldRef: 'world-1',
          displayMetadata: { committedAt: time, mode, affectedCells: count } };
      state.transactions['old-build'] = { objectRef: 'object-1', worldRef: 'world-1' };
    });
    const canvas = new CanvasV5({ store });
    assert.equal(typeof canvas.readObjectsHistory, 'function', 'read-only Canvas display API is missing');
    const before = await readFile(join(directory, 'canvas-v7.json'));
    const view = await canvas.readObjectsHistory('session-1');
    assert.equal(view.state, 'READY');
    assert.deepEqual(view.objects[0].bounds, { min: [1,2,3], max: [2,2,3], size: [2,1,1] });
    assert.equal(view.objects[0].occupiedCells, 2);
    assert.equal(view.history[0].affectedCells, 9, 'history count is its recorded commit, not current footprint');
    assert.equal(view.history[0].status, 'UNDONE');
    assert.equal(view.history[1].status, 'UNDONE');
    assert.equal(view.history[2].committedAt, null, 'do not backfill old timestamps');
    assert.equal(view.history[2].mode, null);
    assert.equal(view.history[2].affectedCells, null);
    assert.equal((await canvas.readObjectsHistory(null)).state, 'NO_SESSION');
    assert.equal((await canvas.readObjectsHistory('other-session')).state, 'NO_WORLD');
    view.objects[0].bounds.min[0] = 999;
    assert.equal((await canvas.readObjectsHistory('session-1')).objects[0].bounds.min[0], 1);
    assert.deepEqual(await readFile(join(directory, 'canvas-v7.json')), before, 'panel read must not commit/replay or mutate durable data');
    const reopened = new CanvasV5({ store: await CanvasStore.open(directory) });
    assert.deepEqual(await reopened.readObjectsHistory('session-1'), await canvas.readObjectsHistory('session-1'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
