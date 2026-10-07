import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUndoExample } from '../scripts/undo-example.mjs';
import { openUndoHost, undoWorldFile } from '../scripts/undo-host.mjs';

const nodes = entry => entry.cells.map(cell => cell.nodeName);
const writes = host => host.world.calls.filter(call =>
  ['ApplyHistoryTransaction', 'ApplyCompiledTransaction', 'WriteRegion'].includes(call.operation)).length;

test('page actions undo and redo a cell entry through public Canvas transactions and survive reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-undo-redo-'));
  try {
    const produced = await createUndoExample(directory);
    assert.equal(produced.classification, 'REAL_RUNTIME + FIXTURE');
    await assert.rejects(() => createUndoExample(directory), /EXAMPLE_ALREADY_EXISTS/);
    let host = await openUndoHost(directory);
    let view = await host.readView();
    assert.equal(view.source, 'ISOLATED_DURABLE_FIXTURE');
    assert.deepEqual(view.entries.map(entry => [entry.mode, entry.state, entry.cells.length]),
      [['REGION', 'APPLIED', 4], ['CELL', 'APPLIED', 3]]);
    const cell = view.entries[1];
    assert.deepEqual(nodes(cell), ['fixture:brick', 'fixture:brick', 'fixture:brick']);
    assert.equal(cell.undo.available, true);
    assert.deepEqual(cell.redo, { available: false, reason: 'NOTHING_TO_REDO' });

    const undo = await host.perform(cell.objectRef, 'undo');
    assert.deepEqual([undo.operation, undo.status, undo.error], ['Undo', 'VERIFIED', null]);
    view = await host.readView();
    assert.equal(view.entries[1].state, 'UNDONE');
    assert.deepEqual(nodes(view.entries[1]), ['air', 'air', 'air']);
    assert.equal(view.entries[1].footprintCells, 0);
    assert.equal(view.entries[1].redo.available, true);
    assert.equal(view.entries[1].moves[0].status, 'UNDONE');

    const redo = await host.perform(cell.objectRef, 'redo');
    assert.deepEqual([redo.operation, redo.status, redo.error], ['Redo', 'VERIFIED', null]);
    view = await host.readView();
    assert.equal(view.entries[1].state, 'APPLIED');
    assert.deepEqual(nodes(view.entries[1]), ['fixture:brick', 'fixture:brick', 'fixture:brick']);
    assert.equal(view.entries[1].footprintCells, 3);
    assert.deepEqual(view.entries[1].moves.map(move => move.status), ['COMMITTED', 'UNDONE', 'COMMITTED']);
    const stored = host.canvas.store.snapshot.transactions[redo.transactionId];
    assert.equal(stored.direction, 'REDO');
    assert.ok(Date.parse(stored.displayMetadata.committedAt));

    // Exact replay of the same public request returns the stored result and never writes again;
    // the same request id with changed facts is refused by Canvas admission.
    const before = writes(host);
    const replay = await host.canvas.call('Redo', redo.request);
    assert.deepEqual([replay.result?.transactionId, replay.result?.status, replay.error], [redo.transactionId, 'VERIFIED', null]);
    const changed = await host.canvas.call('Redo', { ...redo.request, intentDigest: '7'.repeat(64) });
    assert.ok(changed.error, 'changed replay must be refused');
    assert.equal(writes(host), before);

    // Normal reopen: Canvas Store and the isolated world file agree; history keeps moving.
    host = await openUndoHost(directory);
    view = await host.readView();
    assert.equal(view.entries[1].state, 'APPLIED');
    assert.deepEqual(nodes(view.entries[1]), ['fixture:brick', 'fixture:brick', 'fixture:brick']);
    assert.equal((await host.perform(cell.objectRef, 'undo')).status, 'VERIFIED');
    assert.equal((await host.perform(cell.objectRef, 'redo')).status, 'VERIFIED');
    view = await host.readView();
    assert.deepEqual(view.entries[1].moves.map(move => move.status),
      ['COMMITTED', 'UNDONE', 'COMMITTED', 'UNDONE', 'COMMITTED']);
    assert.equal(view.entries[1].state, 'APPLIED');
    // The /objects projection keeps its published two-value status.
    const objectsView = await host.canvas.readObjectsHistory('undo-fixture-session');
    assert.ok(objectsView.history.every(row => ['COMMITTED', 'UNDONE'].includes(row.status)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('region entries undo as a whole, region Redo is named unavailable, and failures write nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-undo-region-'));
  try {
    await createUndoExample(directory);
    let host = await openUndoHost(directory);
    let view = await host.readView();
    const regionRef = view.entries[0].objectRef, cellRef = view.entries[1].objectRef;
    // An external edit in the fixture world: Redo must refuse without writing.
    const undone = await host.perform(cellRef, 'undo');
    assert.equal(undone.status, 'VERIFIED');
    // Canvas itself refuses to Undo an Undo row (that would clear a footprint twice).
    const head = host.canvas.store.snapshot.history[cellRef].at(-1);
    const undoOfUndo = await host.canvas.call('Undo', { ...undone.request, requestId: 'undo-of-undo',
      transactionId: 'undo-of-undo', historyTransactionId: undone.transactionId, expectedHistoryRevision: head.historyRevision,
      expectedWorldRevision: host.canvas.store.snapshot.transactions[undone.transactionId].receipt.observedWorldRevision,
      expectedObjectRevisions: { [cellRef]: host.canvas.store.snapshot.objects['undo-fixture-world'][cellRef].objectRevision } });
    assert.equal(undoOfUndo.error?.code, 'UNDO_CONFLICT');
    const file = undoWorldFile(directory);
    const world = JSON.parse(await readFile(file, 'utf8'));
    world.nodes['9,2,8'] = { position: [9, 2, 8], nodeName: 'fixture:external', param1: 0, param2: 0, metadata: {}, inventory: {}, timer: null };
    await writeFile(file, JSON.stringify(world), { mode: 0o600 });
    host = await openUndoHost(directory);
    const before = writes(host);
    const refused = await host.perform(cellRef, 'redo');
    assert.equal(refused.error?.code, 'REDO_CONFLICT');
    assert.equal(writes(host), before);
    view = await host.readView();
    assert.equal(view.entries[1].state, 'UNDONE');
    assert.deepEqual(nodes(view.entries[1]), ['air', 'fixture:external', 'air']);
    assert.deepEqual(Object.keys(host.canvas.store.snapshot.pending), []);

    const regionUndo = await host.perform(regionRef, 'undo');
    assert.deepEqual([regionUndo.operation, regionUndo.status, regionUndo.error], ['UndoRegionCommit', 'VERIFIED', null]);
    view = await host.readView();
    assert.equal(view.entries[0].state, 'UNDONE');
    assert.ok(nodes(view.entries[0]).every(name => name === 'air'));
    assert.deepEqual(view.entries[0].redo, { available: false, reason: 'REGION_REDO_NOT_IN_PROTOCOL' });
    assert.deepEqual(await host.perform(regionRef, 'redo'), { error: { code: 'REGION_REDO_NOT_IN_PROTOCOL' } });
    // The cell entry's Undo is now older than the latest world change; Canvas says so.
    assert.deepEqual(view.entries[1].redo, { available: false, reason: 'WORLD_CHANGED_SINCE' });
    assert.deepEqual(await host.perform('missing-object', 'undo'), { error: { code: 'OBJECT_NOT_FOUND' } });
    assert.deepEqual(await host.perform(cellRef, 'delete'), { error: { code: 'UNKNOWN_ACTION' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
