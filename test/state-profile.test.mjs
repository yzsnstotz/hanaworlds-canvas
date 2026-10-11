import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expectedWrittenRecord, withDerivedReadback } from '../src/state-profile.mjs';
import { openUndoFixtureWorld } from './support/undo-fixture-world.mjs';
import { createUndoExample } from './support/undo-example.mjs';
import { openUndoHost, undoWorldFile } from './support/undo-host.mjs';

const profile = { profileVersion: 'state-profile/v3', derivedFields: ['engineDerived'],
  preservedFields: ['opaquePreserved'], clearedFields: ['opaqueCleared'] };
const record = state => ({ position: [0, 0, 0], geometryProfile: 'voxel-grid/v1', materialRef: 'opaque:one', orientation: 0, state });
const projection = r => ({ worldRef: 'world', coveredPositions: [r.position], records: [r], stateProfile: profile });

test('write rules preserve only declared fields and take derived presence or absence from readback', () => {
  const before = record({ engineDerived: 15, opaquePreserved: { marker: 'saved' }, opaqueCleared: 1, undeclared: 2 });
  const effect = { ...before, materialRef: 'opaque:two' };
  const written = expectedWrittenRecord(before, effect, record({ engineDerived: 238 }), profile);
  assert.deepEqual(written.state, { engineDerived: 238, opaquePreserved: { marker: 'saved' } });
  assert.equal(written.materialRef, 'opaque:two');
  assert.deepEqual(expectedWrittenRecord(before, effect, record({}), profile).state, { opaquePreserved: { marker: 'saved' } });
});

test('restore and history ignore only declared derived differences, checking preserved, cleared and undeclared saved state', () => {
  const saved = record({ engineDerived: 15, opaquePreserved: { marker: 'saved' }, opaqueCleared: 1, undeclared: 2 });
  const current = record({ ...saved.state, engineDerived: 223 });
  assert.deepEqual(withDerivedReadback(projection(saved), projection(current)), projection(current));
  for (const field of ['opaquePreserved', 'opaqueCleared', 'undeclared']) {
    const changed = record({ ...current.state, [field]: 'external-edit' });
    assert.notDeepEqual(withDerivedReadback(projection(saved), projection(changed)), projection(changed));
  }
  const absent = record({ ...saved.state }); delete absent.state.engineDerived;
  assert.deepEqual(withDerivedReadback(projection(saved), projection(absent)), projection(absent));
  const reoriented = { ...current, orientation: 1 };
  assert.notDeepEqual(withDerivedReadback(projection(saved), projection(reoriented)), projection(reoriented));
});

async function seeded(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-state-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = undoWorldFile(directory);
  await openUndoFixtureWorld(file, { create: true });
  const raw = JSON.parse(await readFile(file, 'utf8'));
  for (const position of [[4, 2, 4], [5, 2, 4], [8, 2, 8], [9, 2, 8], [10, 2, 8]])
    raw.nodes[position.join(',')] = { position, geometryProfile: 'voxel-grid/v1', materialRef: 'fixture:soil', orientation: 0,
      state: { metadata: { marker: 'saved' }, inventory: {}, timer: null } };
  await writeFile(file, JSON.stringify(raw));
  return { directory, world: await openUndoFixtureWorld(file) };
}

test('cell Apply, Undo and Redo accept recomputed derived values while preserving metadata (isolated contract peer)', async t => {
  const { directory, world } = await seeded(t);
  let light = 15;
  world.deriveState = state => ({ ...state, light });
  const call = world.adapter.call.bind(world.adapter);
  world.adapter.call = (operation, request) => {
    if (operation === 'ApplyCompiledTransaction') light = 238;
    if (operation === 'ApplyHistoryTransaction') light += 1;
    return call(operation, request);
  };
  await createUndoExample(directory, { world });
  const host = await openUndoHost(directory, { world });
  const ref = (await host.readView()).entries[1].objectRef;
  light = 223; // Real-engine localization showed this drift; the peer remains a fixture.
  const undone = await host.perform(ref, 'undo');
  assert.equal(undone.status, 'VERIFIED', JSON.stringify(undone));
  world.deriveState = state => ({ ...state, light, metadata: { marker: 'external-edit' } });
  assert.equal((await host.perform(ref, 'redo')).error.code, 'REDO_CONFLICT');
  world.deriveState = state => ({ ...state, light });
  assert.equal((await host.perform(ref, 'redo')).status, 'VERIFIED');
  assert.ok(world.readCells([[8, 2, 8], [9, 2, 8], [10, 2, 8]]).every(cell => cell.state.metadata.marker === 'saved'));
  assert.equal(Object.keys(host.canvas.store.snapshot.pending).length, 0);
  // The same derived allowance must not hide an external edit of preserved state.
  world.deriveState = state => ({ ...state, light, metadata: { marker: 'external-edit' } });
  const writes = world.calls.filter(row => row.operation === 'ApplyHistoryTransaction').length;
  assert.equal((await host.perform(ref, 'undo')).error.code, 'READBACK_MISMATCH');
  assert.equal(world.calls.filter(row => row.operation === 'ApplyHistoryTransaction').length, writes);
});

test('cell rollback verifies a saved image with recomputed lighting and preserved metadata', async t => {
  const { directory, world } = await seeded(t);
  let light = 15, corrupt = false;
  world.deriveState = state => ({ ...state, light, ...(corrupt ? { metadata: { marker: 'wrong' } } : {}) });
  const call = world.adapter.call.bind(world.adapter);
  world.adapter.call = (operation, request) => {
    if (operation === 'ApplyCompiledTransaction') { light = 238; corrupt = true; }
    if (operation === 'RestoreTransaction') { light = 223; corrupt = false; }
    return call(operation, request);
  };
  const example = await createUndoExample(directory, { world });
  const commits = example.trace.filter(row => row.operation === 'ApplyRecoverableCommit');
  assert.ok(commits.every(row => row.response.result.status === 'ROLLED_BACK'));
  const host = await openUndoHost(directory, { world });
  assert.deepEqual(host.canvas.store.snapshot.pending, {});
  assert.deepEqual(host.canvas.store.snapshot.history, {});
  assert.ok(world.readCells([[8, 2, 8], [9, 2, 8], [10, 2, 8]]).every(cell =>
    cell.materialRef === 'fixture:soil' && cell.state.metadata.marker === 'saved' && cell.state.light === 223));
});
