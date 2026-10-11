import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as contracts from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';
import { guardSlot } from '../scripts/fixture-engine-guards.mjs';

/*
 * session-world-seam/v1 (canvas/v7 minor 1): Canvas's G-S/G-U/G-L/G-D authority over the
 * exact candidate's public fixture `fixtures/session-world`. FIXTURE: the Adapter (from the
 * fixture's adapterInventory) and the session/v5 port (from its sessionDirectory) are
 * contracts-shaped stand-ins, not the real Adapter or Workshop; nothing here signs a real gate.
 * On Contracts without the seam (0.5.3) these operations do not exist and the file is skipped.
 */
// canvas/v7 (Contracts 1.x) always carries the session-world seam.
const SEAM = contracts.contractProtocols.find(row => row.protocol === 'canvas').major === 7;
const fixture = SEAM ? createRequire(import.meta.url)('hanaworlds-contracts/fixtures/session-world') : null;
const evidence = process.env.CANVAS_SEAM_EVIDENCE ?? null;
const stateProfile = { profileVersion: 'state-profile/v3', derivedFields: ['light'], preservedFields: ['inventory', 'metadata', 'timer'], clearedFields: [] };

function seamAdapter() {
  const rows = [...fixture.adapterInventory.A.connections, ...fixture.adapterInventory.B.connections]
    .map(row => structuredClone(row));
  const adapter = { rows, calls: [], protocolHandshake: g3CellHandshake(),
    async call(operation, request) {
      adapter.calls.push(operation);
      const respond = result => guardSlot('world-adapter/v8', operation, { contractVersion: 'world-adapter/v8', requestId: request.requestId, result, error: null });
      if (operation === 'DiscoverConnections')
        return respond({ capabilityRevision: fixture.adapterInventory.A.capabilityRevision,
          connections: structuredClone(rows) });
      if (operation === 'ReadLocalConnection') {
        const row = rows.find(r => r.connectionRef === request.connectionRef);
        return respond({ connectionRef: row.connectionRef,
          connectionIncarnationRef: row.connectionIncarnationRef, worldRef: row.worldRef,
          payloadVersion: row.payloadVersion, payloadDigest: '1'.repeat(64),
          capabilities: { providerRef: 'fixture-adapter', capabilityRevision: row.capabilityRevision,
            worldRef: row.worldRef, engineBounds: { min: [-64, -64, -64], max: [64, 64, 64] },
            limits: [], worldGeometry: { profileVersion: 'world-geometry/v1', geometryProfiles: ['voxel-grid/v1'], partition: { edge: [16, 16, 16] }, postWriteLighting: 'REQUIRED' }, recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
            sessionDeleteSupported: true, imageMediaTypes: [], model: null, engineGuards: null } });
      }
      throw new Error(`unexpected v6 operation ${operation}`);
    } };
  return adapter;
}
function seamSessions() {
  const revisions = Object.fromEntries(fixture.sessionDirectory.list.response.result.sessions
    .map(row => [row.sessionRef, row.sessionRevision]));
  return fixtureSessions({ revisions, unknown: [fixture.sessionDirectory.unknown.request.sessionRef] });
}
async function boot(t, { sessions = seamSessions() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-seam-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = seamAdapter();
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter, sessions });
  let n = 0;
  const call = (operation, body) => canvas.call(operation,
    { contractVersion: 'canvas/v7', requestId: `${operation}-${++n}`, ...body });
  const S1 = 'fixture-session-S1', S2 = 'fixture-session-S2', A = 'fixture-world-A', B = 'fixture-world-B';
  const conn = { [A]: 'fixture-connection-A', [B]: 'fixture-connection-B' };
  const inc = worldRef => adapter.rows.find(r => r.worldRef === worldRef).connectionIncarnationRef;
  const read = async (sessionRef, worldRef = A) => call('ReadWorldSelectionContext', { sessionRef, worldRef });
  const select = async (sessionRef, worldRef) => {
    const unbound = (await read(sessionRef, worldRef)).result.selection;
    assert.equal(unbound.status, 'UNBOUND');
    const response = await call('SelectWorldConnection', { sessionRef, worldRef, connectionRef: conn[worldRef],
      connectionIncarnationRef: inc(worldRef), expectedRevision: unbound.sessionRevision, expectedContext: null });
    assert.equal(response.error, null, JSON.stringify(response.error));
    return response.result;
  };
  const inventory = async worldRef => call('ListWorldSelections', { worldRef });
  return { canvas, adapter, sessions, call, read, select, inventory, S1, S2, A, B, conn, inc };
}

const CANVAS_TOKEN = /^fixture-(selection|inventory|reservation)-/u;
test('minimal consistency: Canvas reproduces the candidate public ownerAScenario (steps 1–14)',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const f = await boot(t);
    const map = new Map(), deviations = [], log = [];
    const bind = (expected, actual, path) => {
      if (typeof expected === 'string' && CANVAS_TOKEN.test(expected)) {
        if (map.has(expected)) assert.equal(actual, map.get(expected), `${path}: ${expected}`);
        else {
          assert.ok(![...map.values()].includes(actual), `${path}: ${actual} already bound`);
          map.set(expected, actual);
        }
        return;
      }
      if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual) && actual.length === expected.length, `${path}: ${JSON.stringify(actual)}`);
        expected.forEach((v, i) => bind(v, actual[i], `${path}[${i}]`));
      } else if (expected && typeof expected === 'object') {
        assert.ok(actual && typeof actual === 'object', `${path}: ${JSON.stringify(actual)}`);
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
        for (const k of Object.keys(expected)) bind(expected[k], actual[k], `${path}.${k}`);
      } else assert.equal(actual, expected, path);
    };
    const lastUnbound = new Map();
    for (const step of fixture.ownerAScenario) {
      if (step.wire !== 'canvas/v7') { log.push({ title: step.title, skipped: 'session/v5 is Workshop' }); continue; }
      const request = structuredClone(step.request);
      for (const [k, v] of Object.entries(request)) {
        if (typeof v !== 'string' || !CANVAS_TOKEN.test(v) || map.has(v)) {
          if (typeof v === 'string' && map.has(v)) request[k] = map.get(v);
          continue;
        }
        // A revision not yet published to the caller: read it from the public route that publishes it.
        if (k === 'expectedInventoryRevision') {
          request[k] = (await f.inventory(request.worldRef)).result.inventoryRevision;
          map.set(v, request[k]);
        } else if (k === 'expectedRevision' && step.operation === 'SelectWorldConnection') {
          const unbound = lastUnbound.get(request.sessionRef) ??
            (await f.read(request.sessionRef, request.worldRef)).result.selection.sessionRevision;
          request[k] = unbound;
        } else throw new Error(`unresolvable token ${v} in step ${step.title}`);
        deviations.push({ step: step.title, field: k, fixtureToken: v, used: request[k] });
      }
      for (const k of ['expectedContext']) if (request[k]) request[k] = JSON.parse(
        JSON.stringify(request[k]).replace(/"(fixture-(?:selection|inventory|reservation)-[^"]+)"/gu,
          (m, token) => JSON.stringify(map.get(token) ?? token)));
      const response = await f.canvas.call(step.operation, request);
      log.push({ title: step.title, request, response });
      if (step.response.error) {
        assert.equal(response.error?.code, step.response.error.code, `${step.title}: ${JSON.stringify(response)}`);
        assert.equal(response.error.reason, step.response.error.reason, step.title);
        assert.equal(response.error.mutationState, 'NONE', step.title);
      } else bind(step.response, response, step.title);
      if (step.operation === 'ReadWorldSelectionContext' && response.result.selection.status === 'UNBOUND')
        lastUnbound.set(request.sessionRef, response.result.selection.sessionRevision);
    }
    // After step 10, the retired S2 is unknown to Canvas (fixture step 15 is Workshop's).
    assert.equal((await f.read(f.S2)).error?.code, 'SESSION_NOT_FOUND');
    assert.ok(!f.sessions.calls.includes('DeleteSession'), 'Canvas never deletes a Session');
    if (evidence) await writeFile(evidence, JSON.stringify({ deviations, tokens: Object.fromEntries(map), log }, null, 1));
    // The only substitutions are the two published-elsewhere revisions (see REPORT).
    assert.deepEqual(deviations.map(d => [d.field, d.fixtureToken]), [
      ['expectedRevision', 'fixture-selection-S1-0'], ['expectedRevision', 'fixture-selection-S2-0'],
      ['expectedInventoryRevision', 'fixture-inventory-A-4']]);
  });

test('G-S: Select/Switch/Read need a Workshop-known Session; no port fails closed',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const f = await boot(t);
    const unknown = fixture.sessionDirectory.unknown.request.sessionRef;
    const calls = f.adapter.calls.length;
    assert.equal((await f.read(unknown)).error?.code, 'SESSION_NOT_FOUND');
    const select = await f.call('SelectWorldConnection', { sessionRef: unknown, worldRef: f.A,
      connectionRef: f.conn[f.A], connectionIncarnationRef: f.inc(f.A), expectedRevision: 'x',
      expectedContext: null });
    assert.equal(select.error?.code, 'SESSION_NOT_FOUND');
    assert.equal(f.adapter.calls.length - calls, 1, 'only Read reached the Adapter inventory');
    // UNBOUND.sessionRevision is Workshop's SessionIdentity.sessionRevision; a stale one is refused.
    const unbound = (await f.read(f.S1)).result.selection;
    assert.equal(unbound.sessionRevision, fixture.sessionDirectory.read.response.result.sessionRevision);
    const stale = await f.call('SelectWorldConnection', { sessionRef: f.S1, worldRef: f.A,
      connectionRef: f.conn[f.A], connectionIncarnationRef: f.inc(f.A), expectedRevision: 'session-0',
      expectedContext: null });
    assert.equal(stale.error?.code, 'STALE_REVISION');
    const bare = await boot(t, { sessions: null });
    assert.equal((await bare.read(f.S1)).error?.code, 'CAPABILITY_UNAVAILABLE');
  });

test('G-U: Unselect is a CAS back to UNBOUND; refusals change nothing',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const f = await boot(t);
    const s1 = await f.select(f.S1, f.A);
    const unselect = extra => f.call('UnselectWorldConnection', { sessionRef: f.S1, worldRef: f.A,
      expectedRevision: s1.selectionRevision, expectedContext: s1.localContext, ...extra });
    const keep = async () => assert.equal(contracts.canonicalJSON((await f.read(f.S1)).result.selection.context),
      contracts.canonicalJSON(s1));
    assert.equal((await unselect({ expectedRevision: 'selection-stale' })).error?.code, 'STALE_REVISION'); await keep();
    // Not the Session's current world (a self-consistent request; the contracts refuse a
    // worldRef that disagrees with its own expectedContext as SCHEMA_INVALID).
    assert.equal((await unselect({ worldRef: f.B, expectedContext: { ...s1.localContext, worldRef: f.B } }))
      .error?.code, 'WORLD_NOT_BOUND'); await keep();
    assert.ok((await unselect({ expectedContext: { ...s1.localContext, connectionIncarnationRef: 'old' } })).error);
    await keep();
    await f.canvas.store.commit(state => { state.pending.open = { body: { sessionRef: f.S1 } }; });
    assert.equal((await unselect()).error?.code, 'TRANSACTION_CONFLICT'); await keep();
    await f.canvas.store.commit(state => { delete state.pending.open; });
    const done = await unselect();
    assert.equal(done.error, null, JSON.stringify(done.error));
    assert.equal(done.result.activeWorldRef, null);
    assert.equal(done.result.localContext, null);
    assert.equal((await f.read(f.S1)).result.selection.status, 'UNBOUND');
    assert.deepEqual([...(await f.inventory(f.A)).result.sessionRefs], []);
    await f.select(f.S1, f.A); // re-select with the published UNBOUND revision
  });

test('G-D: retirement reservation serializes world deletion with selection',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const f = await boot(t);
    const s1 = await f.select(f.S1, f.A);
    let inv = (await f.inventory(f.A)).result;
    assert.deepEqual([...inv.sessionRefs], [f.S1]);
    const reserve = expectedInventoryRevision => f.call('ReserveWorldRetirement',
      { worldRef: f.A, expectedInventoryRevision });
    assert.equal((await reserve(inv.inventoryRevision)).error?.code, 'TRANSACTION_CONFLICT');
    // S1 moves to B: A is free.
    const toB = await f.call('SwitchWorldConnection', { sessionRef: f.S1, worldRef: f.A, fromWorldRef: f.A,
      toConnectionRef: f.conn[f.B], toWorldRef: f.B, expectedRevision: s1.selectionRevision,
      expectedContext: s1.localContext });
    assert.equal(toB.error, null, JSON.stringify(toB.error));
    assert.equal((await reserve(inv.inventoryRevision)).error?.code, 'STALE_REVISION');
    inv = (await f.inventory(f.A)).result;
    const reserved = await reserve(inv.inventoryRevision);
    assert.equal(reserved.error, null, JSON.stringify(reserved.error));
    assert.equal(reserved.result.inventoryRevision, inv.inventoryRevision);
    assert.equal((await f.inventory(f.A)).result.retirementReservationRef, reserved.result.reservationRef);
    assert.equal((await reserve(inv.inventoryRevision)).error?.code, 'TRANSACTION_CONFLICT');
    // Under reservation: no Session may select or switch into A.
    const s2read = (await f.read(f.S2)).result.selection;
    const s2 = await f.call('SelectWorldConnection', { sessionRef: f.S2, worldRef: f.A, connectionRef: f.conn[f.A],
      connectionIncarnationRef: f.inc(f.A), expectedRevision: s2read.sessionRevision, expectedContext: null });
    assert.equal(s2.error?.code, 'TRANSACTION_CONFLICT');
    assert.equal(s2.error.reason, 'SCOPE_DENIED');
    const back = await f.call('SwitchWorldConnection', { sessionRef: f.S1, worldRef: f.B, fromWorldRef: f.B,
      toConnectionRef: f.conn[f.A], toWorldRef: f.A, expectedRevision: toB.result.selectionRevision,
      expectedContext: toB.result.localContext });
    assert.equal(back.error?.code, 'TRANSACTION_CONFLICT');
    const release = (reservationRef, outcome) => f.call('ReleaseWorldRetirement', { worldRef: f.A, reservationRef, outcome });
    assert.equal((await release('retirement-other', 'ABORTED')).error?.code, 'STALE_REVISION');
    // Adapter deletion failed: ABORTED, A selectable again.
    const aborted = await release(reserved.result.reservationRef, 'ABORTED');
    assert.equal(aborted.error, null, JSON.stringify(aborted.error));
    assert.notEqual(aborted.result.inventoryRevision, inv.inventoryRevision);
    const again = await f.select(f.S2, f.A);
    assert.equal(again.activeWorldRef, f.A);
    // Retire for real: S2 leaves (unselect), reserve, RETIRED.
    await f.call('UnselectWorldConnection', { sessionRef: f.S2, worldRef: f.A,
      expectedRevision: again.selectionRevision, expectedContext: again.localContext });
    const r2 = await reserve((await f.inventory(f.A)).result.inventoryRevision);
    const retired = await release(r2.result.reservationRef, 'RETIRED');
    assert.equal(retired.error, null, JSON.stringify(retired.error));
    const repeat = await release(r2.result.reservationRef, 'RETIRED');
    assert.equal(contracts.canonicalJSON(repeat.result), contracts.canonicalJSON(retired.result),
      'an exact repeat returns the same release');
    assert.equal((await f.inventory(f.A)).error?.code, 'WORLD_NOT_FOUND');
    assert.equal((await reserve('any')).error?.code, 'WORLD_NOT_FOUND');
    const s2b = (await f.read(f.S2)).result.selection;
    assert.equal((await f.call('SelectWorldConnection', { sessionRef: f.S2, worldRef: f.A, connectionRef: f.conn[f.A],
      connectionIncarnationRef: f.inc(f.A), expectedRevision: s2b.sessionRevision, expectedContext: null }))
      .error?.code, 'WORLD_NOT_FOUND');
  });

test('G-D race: a reservation made while a Select awaits the Adapter wins; the Select commits nothing',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const f = await boot(t);
    const unbound = (await f.read(f.S1)).result.selection;
    const port = f.canvas.adapter;
    let reservation = null;
    f.canvas.adapter = { ...port, async call(operation, request) {
      if (operation === 'DiscoverConnections' && reservation === null) {
        // The Adapter reserves A for deletion between Select's checks and its commit.
        reservation = await f.call('ReserveWorldRetirement', { worldRef: f.A,
          expectedInventoryRevision: (await f.inventory(f.A)).result.inventoryRevision });
      }
      return port.call(operation, request);
    } };
    const select = await f.call('SelectWorldConnection', { sessionRef: f.S1, worldRef: f.A,
      connectionRef: f.conn[f.A], connectionIncarnationRef: f.inc(f.A),
      expectedRevision: unbound.sessionRevision, expectedContext: null });
    f.canvas.adapter = port;
    assert.equal(reservation.error, null, JSON.stringify(reservation.error));
    assert.equal(select.error?.code, 'TRANSACTION_CONFLICT');
    assert.equal((await f.read(f.S1)).result.selection.status, 'UNBOUND');
    assert.deepEqual([...(await f.inventory(f.A)).result.sessionRefs], []);
  });

test('G-L: Canvas only retires on Workshop’s call; UNSUPPORTED deletion leaves everything unchanged',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const f = await boot(t);
    const s1 = await f.select(f.S1, f.A);
    const s2 = await f.select(f.S2, f.A);
    // Workshop side today: provider without persistent deletion → SESSION_DELETE_UNSUPPORTED,
    // RetireSessionSelection is not called (fixture sessionDeletion.unsupported.retireCalled:false).
    assert.throws(() => contracts.requireSessionDeleteSupported(fixture.sessionDeletion.unsupportedCapabilities),
      error => error.code === 'SESSION_DELETE_UNSUPPORTED');
    assert.equal(fixture.sessionDeletion.unsupported.retireCalled, false);
    assert.equal(contracts.canonicalJSON((await f.read(f.S1)).result.selection.context), contracts.canonicalJSON(s1));
    // A pending transaction of the Session blocks retirement.
    await f.canvas.store.commit(state => { state.pending.open = { body: { sessionRef: f.S2 } }; });
    assert.equal((await f.call('RetireSessionSelection', { sessionRef: f.S2 })).error?.code, 'TRANSACTION_CONFLICT');
    await f.canvas.store.commit(state => { delete state.pending.open; });
    // Supported provider: Workshop retires first. Canvas clears S2 atomically, S1 untouched.
    const retired = await f.call('RetireSessionSelection', { sessionRef: f.S2 });
    assert.equal(retired.error, null, JSON.stringify(retired.error));
    assert.equal(retired.result.releasedWorldRef, f.A);
    assert.notEqual(retired.result.selectionRevision, s2.selectionRevision);
    assert.deepEqual([...(await f.inventory(f.A)).result.sessionRefs], [f.S1]);
    for (const [operation, body] of [['ReadWorldSelectionContext', { worldRef: f.A }],
      ['SelectWorldConnection', { worldRef: f.A, connectionRef: f.conn[f.A], connectionIncarnationRef: f.inc(f.A),
        expectedRevision: 'any', expectedContext: null }],
      ['ListObjects', { worldRef: f.A, expectedRevision: null, localContext: s2.localContext }]])
      assert.equal((await f.call(operation, { sessionRef: f.S2, ...body })).error?.code, 'SESSION_NOT_FOUND', operation);
    // Irreversible and idempotent: a retry is the same retirement, never a restore.
    const retry = await f.call('RetireSessionSelection', { sessionRef: f.S2 });
    assert.equal(retry.result.selectionRevision, retired.result.selectionRevision);
    assert.equal(retry.result.releasedWorldRef, null);
    assert.equal(contracts.canonicalJSON((await f.read(f.S1)).result.selection.context), contracts.canonicalJSON(s1));
    assert.ok(!f.sessions.calls.includes('DeleteSession'), 'Canvas never deletes or reports a deletion');
  });

test('C2: connection state of a BOUND selection is derived from the Adapter inventory',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const f = await boot(t);
    await f.select(f.S1, f.A);
    const selection = (await f.read(f.S1)).result.selection;
    const inventory = (await f.canvas.adapter.call('DiscoverConnections', { requestId: 'd' })).result;
    assert.equal(contracts.describeSelectionConnection(selection, inventory).state ??
      contracts.describeSelectionConnection(selection, inventory).status, 'CONNECTED');
    f.adapter.rows.find(r => r.worldRef === f.A).connectionIncarnationRef = 'fixture-incarnation-A-2';
    const reopened = (await f.canvas.adapter.call('DiscoverConnections', { requestId: 'd2' })).result;
    const state = contracts.describeSelectionConnection(selection, reopened);
    assert.equal(state.state ?? state.status, 'SELECTED_NOT_CONNECTED');
    // Writes with the old context are refused by Canvas admission.
    assert.equal((await f.call('ListObjects', { sessionRef: f.S1, worldRef: f.A, expectedRevision: null,
      localContext: selection.context.localContext })).error?.code, 'CURRENT_WORLD_MISMATCH');
  });

/*
 * Public assembly: Workshop 0.4.12 (4547f3cf) registers one WorkshopV3 instance as
 * hanaworldsWorkshop and hanaworldsWorkshopV3 (public summary, SOURCE); it registers no
 * hanaworldsSessionV3. Canvas's apply() consumes exactly hanaworldsWorkshopV3, per call.
 * FIXTURE: the provider here is the fixture session/v5 port inside a real Cordis plugin
 * fiber; real Loader/Host mapping is NOT_RUN.
 */
test('apply() consumes Workshop’s public hanaworldsWorkshopV3; other keys and a disposed provider fail closed',
  { skip: !SEAM && 'Contracts without session-world-seam/v1' }, async t => {
    const { Context } = await import('cordis');
    const canvasModule = await import('../src/index.mjs');
    const read = async canvas => canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v7',
      sessionRef: 'fixture-session-S1', requestId: `r-${Math.random()}`, worldRef: 'fixture-world-A' });
    const assemble = async key => {
      const directory = await mkdtemp(join(tmpdir(), 'canvas-seam-assembly-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const ctx = new Context();
      ctx.provide('dshHomePath', (...parts) => join(directory, ...parts));
      ctx.provide('hanaworldsWorldAdapterV6', seamAdapter());
      const port = seamSessions();
      const workshop = ctx.plugin({ name: 'fixture-workshop', apply: c => { if (key) c.provide(key, port); } });
      await workshop;
      const fiber = ctx.plugin(canvasModule.default);
      await fiber;
      const canvas = ctx.get('hanaworldsCanvasV5');
      await canvas.ready;
      t.after(async () => { await fiber.dispose(); await ctx.fiber.dispose(); });
      return { canvas, port, workshop };
    };
    const live = await assemble('hanaworldsWorkshopV3');
    const ok = await read(live.canvas);
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    assert.equal(ok.result.selection.sessionRevision,
      fixture.sessionDirectory.read.response.result.sessionRevision);
    assert.deepEqual(live.port.calls, ['ReadSessionIdentity']);
    for (const key of ['hanaworldsSessionV3', 'hanaworldsWorkshop', null]) {
      const other = await assemble(key);
      assert.equal((await read(other.canvas)).error?.code, 'CAPABILITY_UNAVAILABLE', String(key));
      assert.deepEqual(other.port.calls, [], `${key} must not be consumed`);
    }
    // The provider belongs to Workshop's plugin fiber: after its dispose Canvas fails closed.
    await live.workshop.dispose();
    assert.equal((await read(live.canvas)).error?.code, 'CAPABILITY_UNAVAILABLE');
  });
