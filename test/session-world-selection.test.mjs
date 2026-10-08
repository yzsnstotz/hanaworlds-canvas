import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJSON } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';
import { createUndoExample } from '../scripts/undo-example.mjs';
import { openUndoHost } from '../scripts/undo-host.mjs';
import { undoSessionRef, undoWorldRef } from '../scripts/undo-fixture-world.mjs';

/*
 * Canvas is the only Session↔World selection authority (canvas/v5
 * ReadWorldSelectionContext / SelectWorldConnection / SwitchWorldConnection);
 * selectionRevision is generated here only. FIXTURE: the Adapter below is an
 * in-memory contracts-shaped peer with two live connections (world A, world B); it is
 * not the real Adapter and proves nothing about real multi-connection support.
 */
// Store values are null-prototype objects; compare canonical JSON.
const same = (a, b, message) => assert.equal(canonicalJSON(a), canonicalJSON(b), message);
const stateProfile = { profileVersion: 'state-profile/v2',
  nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
  inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
const readback = (connectionRef, worldRef, incarnation) => ({ connectionRef,
  connectionIncarnationRef: incarnation, worldRef, payloadVersion: 'local-world/v1',
  payloadDigest: '1'.repeat(64),
  capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef,
    engineBounds: { min: [-64, -64, -64], max: [64, 64, 64] }, limits: [],
    recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    sessionDeleteSupported: true, imageMediaTypes: [], model: null } });

function fixtureAdapter() {
  const live = { 'conn-a': { worldRef: 'world-a', incarnation: 'open-a-1' },
    'conn-b': { worldRef: 'world-b', incarnation: 'open-b-1' } };
  const adapter = { live, calls: [], protocolHandshake: g3CellHandshake(),
    async call(operation, request) {
      adapter.calls.push(operation);
      const respond = result => ({ contractVersion: 'world-adapter/v6',
        requestId: request.requestId, result, error: null });
      if (operation === 'DiscoverConnections') return respond({ capabilityRevision: 'cap-1',
        connections: Object.entries(live).map(([connectionRef, row]) => ({
          adapterId: 'hanaworlds-world-adapter', connectionRef, worldRef: row.worldRef,
          displayName: `Fixture ${row.worldRef}`, capabilityRevision: 'cap-1',
          payloadVersion: 'local-world/v1', readiness: 'READY',
          connectionIncarnationRef: row.incarnation })) });
      if (operation === 'ReadLocalConnection') {
        const row = live[request.connectionRef];
        return respond(readback(request.connectionRef, row.worldRef, row.incarnation));
      }
      throw new Error(`unexpected v6 operation ${operation}`);
    } };
  return adapter;
}
const base = sessionRef => ({ contractVersion: 'canvas/v5', sessionRef });
async function boot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-session-world-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = fixtureAdapter();
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter });
  let n = 0;
  const call = (operation, sessionRef, body) => canvas.call(operation,
    { ...base(sessionRef), requestId: `${operation}-${++n}`, ...body });
  const read = async (sessionRef, worldRef) => {
    const response = await call('ReadWorldSelectionContext', sessionRef, { worldRef });
    assert.equal(response.error, null, JSON.stringify(response.error));
    return response.result.selection;
  };
  const select = async (sessionRef, connectionRef, worldRef) => {
    const before = await read(sessionRef, worldRef);
    assert.equal(before.status, 'UNBOUND');
    const response = await call('SelectWorldConnection', sessionRef, { worldRef, connectionRef,
      connectionIncarnationRef: adapter.live[connectionRef].incarnation,
      expectedRevision: before.sessionRevision, expectedContext: null });
    assert.equal(response.error, null, JSON.stringify(response.error));
    return response.result;
  };
  const switchRequest = (context, toConnectionRef, toWorldRef, extra = {}) => ({
    worldRef: context.activeWorldRef, fromWorldRef: context.activeWorldRef, toConnectionRef,
    toWorldRef, expectedRevision: context.selectionRevision,
    expectedContext: context.localContext, ...extra });
  return { canvas, adapter, call, read, select, switchRequest, directory };
}

test('owner A: S1 and S2 share A; S1 switches A→B→A while S2 stays on A, unchanged', async t => {
  const f = await boot(t);
  const s1 = await f.select('S1', 'conn-a', 'world-a');
  const s2 = await f.select('S2', 'conn-a', 'world-a');
  assert.equal(s1.localContext.connectionIncarnationRef, 'open-a-1');
  assert.equal(s2.localContext.connectionIncarnationRef, 'open-a-1');
  assert.notEqual(s1.selectionRevision, s2.selectionRevision);

  const toB = await f.call('SwitchWorldConnection', 'S1', f.switchRequest(s1, 'conn-b', 'world-b'));
  assert.equal(toB.error, null, JSON.stringify(toB.error));
  assert.equal(toB.result.currentSession, 'S1');
  assert.equal(toB.result.activeWorldRef, 'world-b');
  assert.deepEqual(toB.result.orderedSelectedObjectRefs, []);
  same(toB.result.localContext, { connectionRef: 'conn-b',
    connectionIncarnationRef: 'open-b-1', worldRef: 'world-b',
    selectionRevision: toB.result.selectionRevision });
  assert.notEqual(toB.result.selectionRevision, s1.selectionRevision);
  assert.notEqual(toB.result.sessionRevision, s1.sessionRevision);
  same((await f.read('S2', 'world-a')).context, s2);
  // ReadWorldSelectionContext carries only the requested world's inventory rows.
  const readB = await f.call('ReadWorldSelectionContext', 'S1', { worldRef: 'world-b' });
  assert.deepEqual(readB.result.inventory.connections.map(row => row.connectionRef), ['conn-b']);

  const backToA = await f.call('SwitchWorldConnection', 'S1',
    f.switchRequest(toB.result, 'conn-a', 'world-a'));
  assert.equal(backToA.error, null, JSON.stringify(backToA.error));
  assert.equal(backToA.result.activeWorldRef, 'world-a');
  assert.equal(backToA.result.localContext.connectionIncarnationRef, 'open-a-1');
  same((await f.read('S1', 'world-a')).context, backToA.result);
  // S2 never moved, and its revisions were never touched by S1's switches.
  same((await f.read('S2', 'world-a')).context, s2);
  // A world-bound request of S2 still admits with its unchanged context.
  const listed = await f.call('ListObjects', 'S2', { worldRef: 'world-a',
    localContext: s2.localContext, expectedRevision: null });
  assert.equal(listed.error, null, JSON.stringify(listed.error));
});

test('SwitchWorldConnection refuses before any state change; a duplicate never switches twice', async t => {
  const f = await boot(t);
  const s1 = await f.select('S1', 'conn-a', 'world-a');
  const unchanged = async () => same((await f.read('S1', 'world-a')).context, s1);
  const refused = async (body, code, sessionRef = 'S1') => {
    const response = await f.call('SwitchWorldConnection', sessionRef, body);
    assert.equal(response.error?.code, code, JSON.stringify(response));
    await unchanged();
  };
  await refused(f.switchRequest(s1, 'conn-b', 'world-b', { expectedRevision: 'selection-stale' }),
    'STALE_REVISION');
  await refused(f.switchRequest(s1, 'conn-b', 'world-b', { fromWorldRef: 'world-b',
    worldRef: 'world-b' }), 'CURRENT_WORLD_MISMATCH');
  await refused(f.switchRequest(s1, 'conn-b', 'world-a'), 'CURRENT_WORLD_MISMATCH');
  // expectedContext must be the current localContext (contracts validateCurrentRequest).
  const stale = await f.call('SwitchWorldConnection', 'S1', f.switchRequest(s1, 'conn-b',
    'world-b', { expectedContext: { ...s1.localContext, connectionIncarnationRef: 'open-a-0' } }));
  assert.ok(stale.error, 'stale expectedContext must be refused');
  await unchanged();
  // An unbound Session has nothing to switch.
  await refused({ worldRef: 'world-a', fromWorldRef: 'world-a', toConnectionRef: 'conn-b',
    toWorldRef: 'world-b', expectedRevision: 'session-0', expectedContext: null },
  'WORLD_NOT_BOUND', 'S9');
  // The target's inventory row must carry the same incarnation as its readback.
  const port = f.canvas.adapter;
  f.canvas.adapter = { ...port, async call(operation, request) {
    const response = await port.call(operation, request);
    if (operation === 'DiscoverConnections') response.result.connections
      .find(row => row.connectionRef === 'conn-b').connectionIncarnationRef = 'open-b-0';
    return response;
  } };
  await refused(f.switchRequest(s1, 'conn-b', 'world-b'), 'CURRENT_WORLD_MISMATCH');
  f.canvas.adapter = port;

  const request = { ...base('S1'), requestId: 'switch-once',
    ...f.switchRequest(s1, 'conn-b', 'world-b') };
  const first = await f.canvas.call('SwitchWorldConnection', request);
  assert.equal(first.error, null, JSON.stringify(first.error));
  const calls = f.adapter.calls.length;
  // Exact replay after success: the contracts SDK (validateCurrentRequest) checks
  // expectedContext against the now-current context before the replay disposition, so the
  // duplicate is refused by name; it never executes a second switch.
  const replay = await f.canvas.call('SwitchWorldConnection', request);
  assert.equal(replay.error?.code, 'CURRENT_WORLD_MISMATCH', JSON.stringify(replay));
  assert.equal(f.adapter.calls.length, calls, 'the duplicate reads no Adapter and changes nothing');
  same((await f.read('S1', 'world-b')).context, first.result);
});

test('switching to another world clears the object selection; a same-world reconnect keeps it',
  async t => {
    const f = await boot(t);
    const s1 = await f.select('S1', 'conn-a', 'world-a');
    // FIXTURE setup: one registered object in world A (no BUILD needed for selection rules).
    await f.canvas.store.commit(state => {
      state.objects['world-a'] = { 'obj-1': { worldRef: 'world-a', objectRef: 'obj-1',
        objectRevision: 'object-1', displayName: null, nameRevision: null,
        creationSequence: 0, status: 'READY' } };
    });
    const set = await f.call('SetObjectSelection', 'S1', { worldRef: 'world-a', objectRefs: ['obj-1'],
      expectedSelectionRevision: s1.selectionRevision, localContext: s1.localContext });
    assert.equal(set.error, null, JSON.stringify(set.error));
    const selected = (await f.read('S1', 'world-a')).context;
    assert.deepEqual([...selected.orderedSelectedObjectRefs], ['obj-1']);
    // Same world, the Adapter reopened the connection (new incarnation): selection kept.
    f.adapter.live['conn-a'].incarnation = 'open-a-2';
    const reconnect = await f.call('SwitchWorldConnection', 'S1',
      f.switchRequest(selected, 'conn-a', 'world-a'));
    assert.equal(reconnect.error, null, JSON.stringify(reconnect.error));
    assert.deepEqual([...reconnect.result.orderedSelectedObjectRefs], ['obj-1']);
    assert.equal(reconnect.result.localContext.connectionIncarnationRef, 'open-a-2');
    // Another world: out-of-world selection cleared (canvasEventRules ActiveWorldChanged).
    const toB = await f.call('SwitchWorldConnection', 'S1',
      f.switchRequest(reconnect.result, 'conn-b', 'world-b'));
    assert.equal(toB.error, null, JSON.stringify(toB.error));
    assert.deepEqual([...toB.result.orderedSelectedObjectRefs], []);
  });

test('a Session switch is refused while one of its own transactions is unfinished', async t => {
  const f = await boot(t);
  const s1 = await f.select('S1', 'conn-a', 'world-a');
  await f.canvas.store.commit(state => {
    state.pending['tx-open'] = { body: { sessionRef: 'S1', worldRef: 'world-a' },
      phase: 'RESERVED' };
  });
  const response = await f.call('SwitchWorldConnection', 'S1', f.switchRequest(s1, 'conn-b', 'world-b'));
  assert.equal(response.error?.code, 'TRANSACTION_CONFLICT');
  same((await f.read('S1', 'world-a')).context, s1);
});

/*
 * I-K2 typed selected-object / objectRevision snapshot over EXISTING public canvas/v5
 * routes only (no new wire, nothing read from display, request echo, a first ref or a
 * private map): R1 = ReadWorldSelectionContext (typed CurrentContext: currentSession,
 * activeWorldRef, orderedSelectedObjectRefs 0..n, selectionRevision, sessionRevision,
 * localContext with connectionIncarnationRef) → ListObjects with R1's localContext
 * (Canvas admission re-checks Session, world, the exact localContext incl. selectionRevision
 * and the Adapter's live incarnation) → R2 = ReadWorldSelectionContext; accepted only if
 * R2.context equals R1.context. FIXTURE: undo fixture world/Adapter (two committed objects).
 */

async function selectedSnapshot(canvas, sessionRef, worldRef, id) {
  const read = async n => canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v5',
    sessionRef, requestId: `${id}-read-${n}`, worldRef });
  const r1 = await read(1);
  if (r1.error) return { refused: r1.error.code };
  if (r1.result.selection.status === 'UNBOUND') return { unbound: r1.result.selection };
  const context = r1.result.selection.context;
  const listed = await canvas.call('ListObjects', { contractVersion: 'canvas/v5', sessionRef,
    requestId: `${id}-list`, worldRef, expectedRevision: null, localContext: context.localContext });
  if (listed.error) return { refused: listed.error.code };
  const r2 = await read(2);
  if (r2.error || canonicalJSON(r2.result.selection.context) !== canonicalJSON(context))
    return { refused: 'SELECTION_MOVED' };
  const objects = new Map(listed.result.objects.map(row => [row.objectRef, row]));
  return { snapshot: { sessionRef: context.currentSession, worldRef: context.activeWorldRef,
    connectionRef: context.localContext.connectionRef,
    connectionIncarnationRef: context.localContext.connectionIncarnationRef,
    sessionRevision: context.sessionRevision, selectionRevision: context.selectionRevision,
    registryRevision: listed.result.registryRevision,
    selected: context.orderedSelectedObjectRefs.map(objectRef =>
      ({ objectRef, objectRevision: objects.get(objectRef).objectRevision })) } };
}

test('I-K2 snapshot: zero and multi selection, objectRevision, Session/world/incarnation consistency',
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-selected-snapshot-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await createUndoExample(directory);
    const host = await openUndoHost(directory);
    const { canvas } = host;
    // Zero selection.
    const zero = await selectedSnapshot(canvas, undoSessionRef, undoWorldRef, 'zero');
    assert.deepEqual(zero.snapshot?.selected, [], JSON.stringify(zero));
    assert.equal(zero.snapshot.connectionIncarnationRef, 'undo-fixture-incarnation');
    // Multi selection, in the caller's order, each with its current objectRevision.
    const listed = await canvas.call('ListObjects', { contractVersion: 'canvas/v5',
      sessionRef: undoSessionRef, requestId: 'all', worldRef: undoWorldRef, expectedRevision: null,
      localContext: (await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v5',
        sessionRef: undoSessionRef, requestId: 'ctx', worldRef: undoWorldRef }))
        .result.selection.context.localContext });
    const refs = listed.result.objects.map(row => row.objectRef).reverse();
    assert.equal(refs.length, 2);
    const before = (await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v5',
      sessionRef: undoSessionRef, requestId: 'ctx-2', worldRef: undoWorldRef })).result.selection.context;
    const set = await canvas.call('SetObjectSelection', { contractVersion: 'canvas/v5',
      sessionRef: undoSessionRef, requestId: 'select-two', worldRef: undoWorldRef, objectRefs: refs,
      expectedSelectionRevision: before.selectionRevision, localContext: before.localContext });
    assert.equal(set.error, null, JSON.stringify(set.error));
    const multi = await selectedSnapshot(canvas, undoSessionRef, undoWorldRef, 'multi');
    assert.deepEqual(multi.snapshot.selected.map(row => row.objectRef), refs);
    for (const row of multi.snapshot.selected)
      assert.equal(row.objectRevision, listed.result.objects.find(o => o.objectRef === row.objectRef)
        .objectRevision);
    assert.notEqual(multi.snapshot.selectionRevision, zero.snapshot.selectionRevision);
    // A stale localContext (old selectionRevision) is refused by Canvas admission.
    const stale = await canvas.call('ListObjects', { contractVersion: 'canvas/v5',
      sessionRef: undoSessionRef, requestId: 'stale', worldRef: undoWorldRef, expectedRevision: null,
      localContext: before.localContext });
    assert.equal(stale.error?.code, 'CURRENT_WORLD_MISMATCH');
    // Another world, or an unknown Session, never yields this Session's selection.
    assert.equal((await selectedSnapshot(canvas, undoSessionRef, 'other-world', 'w')).refused,
      'CURRENT_WORLD_MISMATCH');
    assert.equal((await selectedSnapshot(canvas, 'other-session', undoWorldRef, 's')).unbound?.status,
      'UNBOUND');
    // The Adapter's live connection moved to a new incarnation: no snapshot is issued.
    const port = canvas.adapter;
    canvas.adapter = { ...port, async call(operation, request) {
      const response = await port.call(operation, request);
      if (operation === 'ReadLocalConnection') response.result = { ...response.result,
        connectionIncarnationRef: 'undo-fixture-incarnation-2' };
      return response;
    } };
    assert.equal((await selectedSnapshot(canvas, undoSessionRef, undoWorldRef, 'inc')).refused,
      'CURRENT_WORLD_MISMATCH');
    canvas.adapter = port;
  });
