import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';
import { undoConnection } from './support/undo-fixture-world.mjs';
import { validateBoundResponse, validateResponse, placementSettingDescriptors } from 'hanaworlds-contracts';

const run = '/Users/yzliu/.cache/hana-world-runs/canvas-placement-settings-01';
const values = { frontGapCells: 0, forwardSearchCells: 3, lateralSearchCells: 1, verticalSearchCells: 0 };
async function fixture(t) {
  const directory = await mkdtemp(join(run, 'read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = fixtureSessions();
  const store = await CanvasStore.open(directory);
  const calls = [];
  const f = { sessions, store, directory, connection: structuredClone(undoConnection), hook: null };
  const adapter = { async call(operation, body) {
    calls.push(operation);
    if (f.hook) await f.hook(operation);
    const result = operation === 'ReadLocalConnection' ? structuredClone(f.connection) :
      operation === 'DiscoverConnections' ? { capabilityRevision: 'undo-fixture-cap-1', connections: [{
        adapterId: 'hanaworlds-world-adapter', connectionRef: undoConnection.connectionRef,
        worldRef: undoConnection.worldRef, displayName: 'Settings fixture',
        capabilityRevision: 'undo-fixture-cap-1', payloadVersion: undoConnection.payloadVersion,
        readiness: 'READY', connectionIncarnationRef: undoConnection.connectionIncarnationRef }] } :
      assert.fail(`forbidden adapter call ${operation}`);
    return { contractVersion: 'world-adapter/v8', requestId: body.requestId, result, error: null };
  } };
  f.canvas = new CanvasV5({ store, sessions, adapter, config: { placement: values } });
  const base = { contractVersion: 'canvas/v7', sessionRef: 'settings-session', worldRef: undoConnection.worldRef };
  const selected = await f.canvas.call('SelectWorldConnection', { ...base, requestId: 'select',
    expectedRevision: 'session-0', expectedContext: null, connectionRef: undoConnection.connectionRef,
    connectionIncarnationRef: undoConnection.connectionIncarnationRef });
  assert.equal(selected.error, null);
  f.request = { ...base, requestId: 'settings-read', localContext: selected.result.localContext };
  f.calls = calls; calls.length = 0;
  f.read = async (extra = {}) => {
    const body = { ...f.request, ...extra };
    const response = await f.canvas.call('ReadPlacementSettings', body);
    validateResponse('canvas/v7', 'ReadPlacementSettings', response);
    if (!body.localContext || body.worldRef === body.localContext.worldRef)
      validateBoundResponse('canvas/v7', 'ReadPlacementSettings', body, response);
    return response;
  };
  return f;
}
async function zeroChanges(f, action) {
  const before = JSON.stringify(f.store.snapshot);
  const disk = await readFile(join(f.directory, 'canvas-v7.json'));
  const files = await readdir(f.directory);
  let commits = 0;
  const original = f.store.commit.bind(f.store);
  f.store.commit = (...args) => { commits++; return original(...args); };
  await action();
  assert.equal(commits, 0);
  assert.equal(JSON.stringify(f.store.snapshot), before);
  assert.deepEqual(await readFile(join(f.directory, 'canvas-v7.json')), disk);
  assert.deepEqual(await readdir(f.directory), files);
  assert.ok(f.calls.every(op => op === 'ReadLocalConnection'));
}

test('public read returns effective configured values and revision; repeats do not persist or inspect', async t => {
  const f = await fixture(t);
  await zeroChanges(f, async () => {
    for (let i = 0; i < 2; i++) {
      const response = await f.read();
      assert.equal(response.error, null);
      assert.deepEqual(JSON.parse(JSON.stringify(response.result.placementSettings)), { ...values, settingsRevision: 'placement-0' });
      for (const row of placementSettingDescriptors)
        assert.notEqual(response.result.placementSettings[row.name.split('.').at(-1)], row.default);
    }
  });
});
test('unknown Session, unbound world, stale/cross-world/cross-session requests reject without changes', async t => {
  const f = await fixture(t);
  f.sessions.unknown.add('unknown');
  await zeroChanges(f, async () => {
    for (const [extra, code] of [
      [{ sessionRef: 'unknown', localContext: null }, 'SESSION_NOT_FOUND'],
      [{ sessionRef: 'unbound', localContext: null }, 'WORLD_NOT_BOUND'],
      [{ sessionRef: 'other-session' }, 'WORLD_NOT_BOUND'],
      [{ localContext: { ...f.request.localContext, selectionRevision: 'old' } }, 'CURRENT_WORLD_MISMATCH'],
      [{ worldRef: 'another-world' }, 'CURRENT_WORLD_MISMATCH'],
    ]) {
      const response = await f.read(extra);
      assert.equal(response.result, null); assert.equal(response.error.code, code);
    }
  });
});
test('missing, invalid and unsynchronized settings refuse instead of using defaults or writing', async t => {
  const f = await fixture(t);
  for (const settings of [undefined, {}, { ...values, settingsRevision: 'r', frontGapCells: 2 }]) {
    f.store.snapshot.placementSettings[f.request.worldRef] = settings;
    await zeroChanges(f, async () => assert.equal((await f.read()).error.code, 'CAPABILITY_UNAVAILABLE'));
  }
});
test('transport failure, changed live connection and identity revision reject with named errors', async t => {
  const f = await fixture(t);
  f.hook = () => { throw new Error('private transport detail'); };
  await zeroChanges(f, async () => assert.equal((await f.read()).error.code, 'READBACK_FAILED'));
  for (const value of [null, undefined]) {
    f.hook = () => { throw value; };
    await zeroChanges(f, async () => assert.equal((await f.read()).error.code, 'READBACK_FAILED'));
  }
  f.hook = null;
  f.connection.connectionIncarnationRef = 'reopened';
  await zeroChanges(f, async () => assert.equal((await f.read()).error.code, 'CURRENT_WORLD_MISMATCH'));
  f.connection = structuredClone(undoConnection);
  f.sessions.revisions[f.request.sessionRef] = 'identity-new';
  await zeroChanges(f, async () => assert.equal((await f.read()).error.code, 'CURRENT_WORLD_MISMATCH'));
});
test('selection/settings/session changes during async read reject and no read commits occur', async t => {
  for (const change of ['world', 'selection', 'connection', 'settings', 'config', 'identity', 'retired']) {
    const f = await fixture(t);
    f.hook = () => {
      const session = f.store.snapshot.sessions[f.request.sessionRef];
      if (change === 'world') session.activeWorldRef = 'other-world';
      if (change === 'selection') session.localContext.selectionRevision = 'new-selection';
      if (change === 'connection') f.store.snapshot.connections[f.request.sessionRef].payloadDigest = '2'.repeat(64);
      if (change === 'settings') f.store.snapshot.placementSettings[f.request.worldRef].settingsRevision = 'changed';
      if (change === 'config') f.canvas.placementConfig.forwardSearchCells = 5;
      if (change === 'identity') f.sessions.revisions[f.request.sessionRef] = 'new-session-revision';
      if (change === 'retired') f.store.snapshot.retiredSessions = { [f.request.sessionRef]: {} };
    };
    let commits = 0; f.store.commit = () => { commits++; assert.fail('read must not commit'); };
    const response = await f.read();
    assert.equal(response.result, null, change);
    assert.equal(response.error.code, change === 'retired' ? 'SESSION_NOT_FOUND' :
      ['settings', 'config'].includes(change) ? 'STALE_REVISION' : 'CURRENT_WORLD_MISMATCH', change);
    assert.equal(commits, 0);
  }
});

test('a concurrent public UnselectWorldConnection rejects the read without creating inspections/history/replay', async t => {
  const f = await fixture(t);
  // Unselect's published request does not carry localContext.
  f.hook = async () => {
    f.hook = null;
    const { localContext, ...base } = f.request;
    const result = await f.canvas.call('UnselectWorldConnection', { ...base,
      requestId: 'unselect-during-read', expectedRevision: localContext.selectionRevision,
      expectedContext: localContext });
    assert.equal(result.error, null);
  };
  const result = await f.read();
  assert.equal(result.error.code, 'CURRENT_WORLD_MISMATCH');
  assert.equal(result.result, null);
  for (const field of ['placementInspections', 'history', 'transactions'])
    assert.deepEqual(f.store.snapshot[field], {});
  assert.equal(Object.keys(f.store.snapshot.replay).length, 2, 'only select/unselect persisted replay');
});

test('missing Adapter and malformed live read reject by name, without changes', async t => {
  const f = await fixture(t);
  f.connection = {};
  await zeroChanges(f, async () => assert.equal((await f.read()).error.code, 'READBACK_FAILED'));
  f.canvas.adapter = null;
  await zeroChanges(f, async () => assert.equal((await f.read()).error.code, 'ADAPTER_UNAVAILABLE'));
});

test('Session changes or deletion during final connection await are rejected', async t => {
  for (const deleted of [false, true]) {
    const f = await fixture(t);
    let reads = 0;
    f.hook = () => {
      if (++reads !== 2) return;
      if (deleted) f.sessions.unknown.add(f.request.sessionRef);
      else f.sessions.revisions[f.request.sessionRef] = 'new-identity-after-last-connection';
    };
    await zeroChanges(f, async () => {
      const result = await f.read();
      assert.equal(result.result, null);
      assert.equal(result.error.code, deleted ? 'SESSION_NOT_FOUND' : 'CURRENT_WORLD_MISMATCH');
    });
  }
});
