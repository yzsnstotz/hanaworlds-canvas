import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJSON, digestValue, validateBoundResponse, validateResponse, validateType,
  worldErrorContext } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, CanvasRegionV1, apply } from '../src/index.mjs';
import { withTargetWorld } from '../src/world-error.mjs';
import { undoFailureLabel } from '../src/display-view.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef, undoWorldRef } from './support/undo-fixture-world.mjs';
import { undoWorldFile } from './support/undo-host.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';
import { guardSlot } from '../scripts/fixture-engine-guards.mjs';
import { buildWorldErrorFixture } from '../scripts/world-error-fixture.mjs';

/*
 * Contracts 2.7.0 Error.worldRef: when Canvas fails closed because the world an admitted request
 * needs is unavailable, the public error names that world and nothing is written. FIXTURE peers
 * only (in-memory Adapter, isolated fixture world file); no real world connection.
 */
assert.equal(worldErrorContext.introducedIn, '2.7.0');
const D = (kind, value) => digestValue(kind, value).sha256;
const temp = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-world-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const named = (response, worldRef, code = 'CAPABILITY_UNAVAILABLE') => {
  assert.equal(response.result, null);
  assert.equal(response.error?.code, code, JSON.stringify(response.error));
  assert.equal(response.error.worldRef, worldRef);
  assert.equal(response.error.mutationState, 'NONE');
};
const stateProfile = { profileVersion: 'state-profile/v3', derivedFields: ['light'],
  preservedFields: ['inventory', 'metadata', 'timer'], clearedFields: [] };
const readback = (connectionRef, worldRef, incarnation) => ({ connectionRef,
  connectionIncarnationRef: incarnation, worldRef, payloadVersion: 'local-world/v1',
  payloadDigest: '1'.repeat(64),
  capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef,
    engineBounds: { min: [-64, -64, -64], max: [64, 64, 64] }, limits: [],
    worldGeometry: { profileVersion: 'world-geometry/v1', geometryProfiles: ['voxel-grid/v1'], partition: { edge: [16, 16, 16] }, postWriteLighting: 'REQUIRED' },
    recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    sessionDeleteSupported: true, imageMediaTypes: [], model: null, engineGuards: null } });
/** Two live fixture connections (world A, world B); `down` makes every call report unavailable. */
function twoWorldAdapter() {
  const live = { 'conn-a': { worldRef: 'world-a', incarnation: 'open-a-1' },
    'conn-b': { worldRef: 'world-b', incarnation: 'open-b-1' } };
  const adapter = { live, calls: [], down: false, async call(operation, request) {
    adapter.calls.push(operation);
    if (adapter.down) return { contractVersion: 'world-adapter/v8', requestId: request.requestId,
      result: null, error: { code: 'ADAPTER_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
        mutationState: 'NONE', transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' } };
    const respond = result => guardSlot('world-adapter/v8', operation, { contractVersion: 'world-adapter/v8', requestId: request.requestId, result, error: null });
    if (operation === 'DiscoverConnections') return respond({ capabilityRevision: 'cap-1',
      connections: Object.entries(live).map(([connectionRef, row]) => ({
        adapterId: 'hanaworlds-world-adapter', connectionRef, worldRef: row.worldRef,
        displayName: `Fixture ${row.worldRef}`, capabilityRevision: 'cap-1',
        payloadVersion: 'local-world/v1', readiness: 'READY', connectionIncarnationRef: row.incarnation })) });
    if (operation === 'ReadLocalConnection') {
      const row = live[request.connectionRef];
      return respond(readback(request.connectionRef, row.worldRef, row.incarnation));
    }
    throw new Error(`unexpected world-adapter/v8 operation ${operation}`);
  } };
  return adapter;
}

test('store unavailable: an admitted request names its own world; undecoded input names none', async () => {
  const canvas = new CanvasV5({ store: null });
  const request = { contractVersion: 'canvas/v7', sessionRef: 'S1', requestId: 'r1', worldRef: 'world-a',
    connectionRef: 'conn-a', connectionIncarnationRef: 'open-a-1', expectedRevision: 'sel-0', expectedContext: null };
  const response = await canvas.call('SelectWorldConnection', request);
  named(response, 'world-a');
  validateBoundResponse('canvas/v7', 'SelectWorldConnection', request, response);
  // Same request as raw bytes: admitted after decoding, so it names its world too.
  const bytes = value => new TextEncoder().encode(value);
  named(await canvas.call('SelectWorldConnection', bytes(canonicalJSON(request))), 'world-a');
  // Not admitted (truncated bytes; a missing field): no world is echoed back.
  for (const raw of [bytes(canonicalJSON(request).slice(0, -1)), { ...request, expectedContext: undefined }]) {
    const refused = await canvas.call('SelectWorldConnection', raw);
    assert.equal(refused.error.code === 'CAPABILITY_UNAVAILABLE', false);
    assert.equal(Object.hasOwn(refused.error, 'worldRef'), false, JSON.stringify(refused.error));
  }
  // The region wire as well.
  const region = new CanvasRegionV1(canvas);
  const undecoded = await region.call('ApplyRegionCommit', { contractVersion: 'canvas-region/v3', requestId: 'x', worldRef: 'world-a' });
  assert.equal(Object.hasOwn(undecoded.error, 'worldRef'), false);
});

test('host ports readWorldRevision / readHistoryFacts name the asked world, never a malformed one', async t => {
  const missing = new CanvasV5({ store: null });
  const caught = async promise => promise.then(() => assert.fail('expected a refusal'), error => error.publicError);
  assert.equal((await caught(missing.readWorldRevision('world-a'))).worldRef, 'world-a');
  assert.equal((await caught(missing.readHistoryFacts({ sessionRef: 'S1', worldRef: 'world-a',
    originTransactionId: 't' }))).worldRef, 'world-a');
  for (const worldRef of ['', 7, undefined])
    assert.equal(Object.hasOwn(await caught(missing.readHistoryFacts({ worldRef })), 'worldRef'), false);
  // Durable store, nothing bound to world-z: WORLD_NOT_BOUND names the asked world.
  const canvas = new CanvasV5({ store: await CanvasStore.open(await temp(t)) });
  const unbound = await caught(canvas.readWorldRevision('world-z'));
  assert.equal(unbound.code, 'WORLD_NOT_BOUND');
  assert.equal(unbound.worldRef, 'world-z');
  validateType('Error', unbound);
});

test('no Adapter service on the Host (world not started) names the world, not a decode failure', async t => {
  const directory = await temp(t);
  const ctx = { get: name => name === 'dshHomePath' ? (...p) => join(directory, 'host', ...p) : undefined,
    provide: () => {} };
  const canvas = apply(ctx);
  await canvas.ready;
  canvas.store = await CanvasStore.open(join(directory, 'store'));
  canvas.sessions = fixtureSessions();
  const request = { contractVersion: 'canvas/v7', sessionRef: 'S1', requestId: 'ctx-1', worldRef: 'world-a' };
  const response = await canvas.call('ReadWorldSelectionContext', request);
  named(response, 'world-a');
  assert.equal(response.error.phase, 'validate');
  assert.equal(response.error.retryability, 'AFTER_NEW_FACTS');
  assert.equal(canonicalJSON(canvas.store.snapshot.sessions), '{}');
});

test('an unreachable world keeps the provider error and names the target; sessions never cross', async t => {
  const adapter = twoWorldAdapter();
  const canvas = new CanvasV5({ store: await CanvasStore.open(await temp(t)), adapter,
    sessions: fixtureSessions() });
  let n = 0;
  const call = (operation, sessionRef, body) => canvas.call(operation,
    { contractVersion: 'canvas/v7', sessionRef, requestId: `${operation}-${++n}`, ...body });
  const select = async (sessionRef, connectionRef, worldRef) => {
    const context = await call('ReadWorldSelectionContext', sessionRef, { worldRef });
    assert.equal(context.error, null, JSON.stringify(context.error));
    const selected = await call('SelectWorldConnection', sessionRef, { worldRef, connectionRef,
      connectionIncarnationRef: adapter.live[connectionRef].incarnation,
      expectedRevision: context.result.selection.sessionRevision, expectedContext: null });
    assert.equal(selected.error, null, JSON.stringify(selected.error));
    return selected.result;
  };
  const a = await select('S1', 'conn-a', 'world-a');
  const b = await select('S2', 'conn-a', 'world-a');
  // S1 switches A→B; S2 stays on A. Then the Adapter goes away.
  const switched = await call('SwitchWorldConnection', 'S1', { worldRef: 'world-a',
    fromWorldRef: 'world-a', toConnectionRef: 'conn-b', toWorldRef: 'world-b',
    expectedRevision: a.selectionRevision, expectedContext: a.localContext });
  assert.equal(switched.error, null, JSON.stringify(switched.error));
  assert.equal(canvas.store.snapshot.sessions.S1.activeWorldRef, 'world-b');
  const sessions = canonicalJSON(canvas.store.snapshot.sessions);
  adapter.down = true;
  // ListWorldConnections always asks the Adapter. Each error names the request's own world:
  // each Session's current world, an explicitly asked other world, an unbound Session's world.
  for (const [sessionRef, worldRef] of [['S1', 'world-b'], ['S2', 'world-a'], ['S1', 'world-a'], ['S3', 'world-b']]) {
    const request = { contractVersion: 'canvas/v7', sessionRef, requestId: `down-${sessionRef}-${worldRef}`,
      worldRef, expectedCapabilityRevision: 'cap-1' };
    const response = await canvas.call('ListWorldConnections', request);
    named(response, worldRef, 'ADAPTER_UNAVAILABLE');
    assert.equal(response.error.reason, 'REQUIRED_FACT_UNKNOWN');
    validateBoundResponse('canvas/v7', 'ListWorldConnections', request, response);
  }
  assert.equal(canonicalJSON(canvas.store.snapshot.sessions), sessions, 'nothing written while down');
  // A refusal that is not world unavailability (another Session's world) names no world.
  adapter.down = false;
  const mismatch = await call('ListObjects', 'S2', { worldRef: 'world-b', localContext: b.localContext, expectedRevision: null });
  assert.equal(mismatch.error.code, 'CURRENT_WORLD_MISMATCH');
  assert.equal(Object.hasOwn(mismatch.error, 'worldRef'), false);
});

test('ApplyRecoverableCommit without readScopedState names the world before any reservation or write', async t => {
  const directory = await temp(t);
  const world = await openUndoFixtureWorld(undoWorldFile(directory), { create: true });
  const store = await CanvasStore.open(join(directory, 'store'));
  const canvas = new CanvasV5({ store, adapter: world.adapter, nativeFacts: {}, sessions: fixtureSessions() });
  world.readWorldRevision = () => canvas.readWorldRevision(undoWorldRef);
  const base = { contractVersion: 'canvas/v7', sessionRef: undoSessionRef, worldRef: undoWorldRef };
  const ok = async (operation, body) => {
    const response = await canvas.call(operation, { ...base, ...body });
    assert.equal(response.error, null, JSON.stringify(response.error));
    return response.result;
  };
  const context = await ok('ReadWorldSelectionContext', { requestId: 'c' });
  const selected = await ok('SelectWorldConnection', { requestId: 's', connectionRef: undoConnection.connectionRef,
    connectionIncarnationRef: undoConnection.connectionIncarnationRef,
    expectedRevision: context.selection.sessionRevision, expectedContext: null });
  const localContext = selected.localContext;
  const operations = { contractVersion: 'operations/v4', buildDigest: 'b'.repeat(64), compilerRevision: 'world-error-cell-1',
    compilationConfigDigest: 'a'.repeat(64), worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64),
    targetFactsDigest: 'd'.repeat(64), effects: [{ position: [4, 2, 4], geometryProfile: 'voxel-grid/v1', materialRef: 'fixture:stone', orientation: 0 }] };
  const operationDigest = D('operations', operations);
  const worldRevision = await canvas.readWorldRevision(undoWorldRef);
  const listed = await ok('ListObjects', { requestId: 'l', localContext, expectedRevision: null });
  const transactionId = 'world-error-apply';
  const analyzed = await ok('AnalyzeAffectedObjects', { requestId: 'a', transactionId, operations, operationDigest,
    expectedRevision: worldRevision, expectedRegistryRevision: listed.registryRevision,
    expectedSelectionRevision: selected.selectionRevision, localContext });
  const before = world.calls.length;
  const request = { ...base, requestId: transactionId, transactionId, operations, operationDigest,
    analysisDigest: D('affected-analysis', analyzed), decisionRevision: null, expectedWorldRevision: worldRevision,
    expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED', regionInspectionBinding: null, localContext };
  const response = await canvas.call('ApplyRecoverableCommit', request);
  named(response, undoWorldRef);
  assert.equal(response.error.reason, 'REQUIRED_FACT_UNKNOWN');
  assert.equal(response.guardRefusal, null);
  validateBoundResponse('canvas/v7', 'ApplyRecoverableCommit', request, response);
  // Only the current-connection read happened: no Prepare, Apply, Readback or Restore.
  assert.deepEqual(world.calls.slice(before).map(row => row.operation), ['ReadLocalConnection']);
  assert.equal(store.snapshot.pending[transactionId], undefined);
  assert.equal(store.snapshot.transactions[transactionId], undefined);
  assert.equal(await canvas.readWorldRevision(undoWorldRef), worldRevision);
});

test('withTargetWorld keeps every field, never names a world it cannot determine', () => {
  const unknown = { code: 'APPLY_FAILED', phase: 'apply', retryability: 'SAME_TRANSACTION_QUERY',
    mutationState: 'UNKNOWN', transactionRef: 't1', causeCode: 'READBACK_FAILED', reason: 'APPLY_ERROR' };
  // Not a world-unavailability code: untouched (written-state errors stay exactly as they are).
  assert.equal(withTargetWorld(unknown, { worldRef: 'w' }), unknown);
  const partial = { ...unknown, code: 'CAPABILITY_UNAVAILABLE', mutationState: 'PARTIAL' };
  assert.deepEqual(withTargetWorld(partial, { worldRef: 'w' }), { ...partial, worldRef: 'w' });
  const plain = { code: 'CAPABILITY_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
    mutationState: 'NONE', transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' };
  // Two different selectors, or none and no trusted binding: no world.
  assert.equal(withTargetWorld(plain, { worldRef: 'a', localContext: { worldRef: 'b' } }), plain);
  assert.equal(withTargetWorld(plain, { sessionRef: 'S1' }), plain);
  // Selector-less request: only this Session's own trusted binding, never another Session's.
  assert.equal(withTargetWorld(plain, { sessionRef: 'S1' }, { S1: 'world-a' }).worldRef, 'world-a');
  assert.equal(withTargetWorld(plain, { sessionRef: 'S2' }, { S1: 'world-a' }), plain);
  // A provider error that already names a world is kept as is.
  const providerNamed = { ...plain, worldRef: 'world-a' };
  assert.equal(withTargetWorld(providerNamed, { worldRef: 'world-a' }), providerNamed);
  // Pre-2.7 seven-field errors still decode.
  validateType('Error', plain);
  validateType('Error', unknown);
});

test('the published Canvas world-error fixture is exactly what Canvas answers and binds', async () => {
  const published = JSON.parse(await readFile(new URL('../fixtures/world-error.json', import.meta.url), 'utf8'));
  assert.equal(canonicalJSON(published), canonicalJSON(await buildWorldErrorFixture()));
  for (const x of published.exchanges) {
    validateBoundResponse(x.wire, x.operation, x.request, x.response);
    assert.equal(x.response.error.worldRef, x.request.worldRef, x.title);
  }
  validateResponse(published.undecoded.wire, published.undecoded.operation, published.undecoded.response);
  assert.equal(Object.hasOwn(published.undecoded.response.error, 'worldRef'), false);
});

test('panel names the needed world by its reference only; no name is generated', () => {
  assert.equal(undoFailureLabel('CAPABILITY_UNAVAILABLE', 'world-a'),
    '需要的世界现在不可用（未启动、连不上或缺少所需能力），未撤回。 需要的世界：world-a');
  assert.equal(undoFailureLabel('CAPABILITY_UNAVAILABLE', null),
    '需要的世界现在不可用（未启动、连不上或缺少所需能力），未撤回。');
});
