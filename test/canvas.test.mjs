import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasStore, CanvasV2, apply } from '../src/index.mjs';
import canonicalize from 'canonicalize';
import { CodePointSetData } from 'icu';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const contracts = process.env.HANAWORLDS_CONTRACTS_DIST ?
  await import(pathToFileURL(process.env.HANAWORLDS_CONTRACTS_DIST).href) : null;
const digest = (kind, value) => createHash('sha256').update(
  `HanaWorlds|contracts@0.1.0|${kind}\n${canonicalize(value)}`).digest('hex');

const request = (fields = {}) => ({ contractVersion: 'canvas/v2', actorRef: 'actor',
  sessionRef: 'session', requestId: crypto.randomUUID(), authorizationRef: 'grant',
  worldRef: 'world', ...fields });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hw-canvas-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await CanvasStore.open(dir);
  const calls = [];
  const adapter = { async call(operation, body) {
    calls.push({ operation, body });
    if (operation === 'DiscoverConnections' || operation === 'ListWorlds') return {
      result: { capabilityRevision: 'inventory-1', connections: [{ adapterId: 'adapter',
        connectionRef: 'connection', worldRef: 'world', displayName: 'World',
        capabilityRevision: 'cap-1', payloadVersion: '0.1.0', readiness: 'READY' },
      { adapterId: 'adapter', connectionRef: 'connection-2', worldRef: 'world-2',
        displayName: 'Other', capabilityRevision: 'cap-2', payloadVersion: '0.1.0',
        readiness: 'READY' }].filter(x => operation === 'DiscoverConnections' ||
          x.connectionRef === body.connectionRef) }, error: null };
    if (operation === 'AuthorizeBinding') return { result: { connectionRef: body.connectionRef,
      worldRef: body.worldRef, payloadVersion: '0.1.0', payloadDigest: 'a'.repeat(64),
      binding: { authorizerRef: 'owner', actorRef: 'actor', bindingRef: 'binding',
        worldRef: body.worldRef, grantEpoch: 'epoch', allowedActions: ['READ'] },
      capabilities: { providerRef: 'adapter', capabilityRevision: 'cap', worldRef: body.worldRef,
        engineBounds: null, limits: [], recoveryGuarantee: 'RECOVERABLE_VERIFIED',
        stateProfile: null, regionProtectionWriters: [], sessionDeleteSupported: false,
        imageMediaTypes: [], model: null } }, error: null };
    if (operation === 'InspectWorld') return { result: { profileVersion: 'target-facts/v2',
      source: 'INSPECTED', worldRef: body.worldRef, objectRef: 'A',
      worldRevision: 'world-rev-1', objectRevision: '1', buildDigest: null,
      planRevision: null, catalogueDigest: 'a'.repeat(64), frameDigest: 'b'.repeat(64),
      sampledBounds: body.sampledBounds, coverageDigest: 'c'.repeat(64),
      occupiedCells: [], knownEmptyCells: [[0, 0, 0]], unknownCells: [],
      portals: [], usableVolume: null }, error: null };
    return { result: null, error: { code: 'ADAPTER_UNAVAILABLE' } };
  } };
  const authority = { async verify(body, operation) {
    return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation],
      currentWorldRevision: 'world-rev-1' };
  } };
  const canvas = new CanvasV2({ store, adapters: [{ adapterId: 'adapter', port: adapter }], authority });
  if (contracts) {
    const original = canvas.call.bind(canvas);
    canvas.call = async (operation, body) => {
      const answer = await original(operation, body);
      if (answer.requestId !== null) contracts.validateResponse('canvas/v2', operation, answer);
      return answer;
    };
  }
  return { store, calls, adapter, authority, canvas };
}

test('binding persists across reopening the Canvas store', async t => {
  const f = await fixture(t);
  const result = await f.canvas.call('SelectWorldConnection', request({ connectionRef: 'connection', expectedRevision: '0' }));
  assert.equal(result.error, null);
  assert.equal(result.result.activeWorldRef, 'world');
  const reopened = await CanvasStore.open(f.store.directory);
  assert.equal(reopened.snapshot.sessions.session.activeWorldRef, 'world');
  assert.deepEqual(f.calls.map(x => x.operation), ['ListWorlds', 'AuthorizeBinding']);
});

test('inspection binds Adapter facts to selected registered object; history query persists across restart', async t => {
  const f = await fixture(t);
  await f.canvas.call('SelectWorldConnection', request({ connectionRef: 'connection', expectedRevision: '0' }));
  await f.store.commit(state => { state.objects.world = { A: { worldRef: 'world',
    objectRef: 'A', objectRevision: '1', displayName: 'House', nameRevision: '1',
    creationSequence: 1, status: 'READY' } }; });
  const inspected = await f.canvas.call('InspectObject', request({ objectRef: 'A',
    expectedRevision: '1', sampledBounds: { min: [0, 0, 0], max: [0, 0, 0] } }));
  assert.equal(inspected.error, null);
  assert.equal(inspected.result.objectRef, 'A');
  assert.equal(inspected.result.source, 'INSPECTED');
  const history = await f.canvas.call('HistoryQuery', request({ objectRef: 'A',
    expectedHistoryRevision: '0' }));
  assert.equal(history.error, null);
  assert.deepEqual(history.result.entries, []);
  const reopened = await CanvasStore.open(f.store.directory);
  assert.equal(reopened.snapshot.objects.world.A.displayName, 'House');
});

test('object registration rejects unverified transaction without engine mutation', async t => {
  const f = await fixture(t);
  await f.canvas.call('SelectWorldConnection', request({ connectionRef: 'connection', expectedRevision: '0' }));
  const answer = await f.canvas.call('CreateObject', request({ objectRef: 'fabricated',
    transactionId: 'tx', verifiedReceiptDigest: 'a'.repeat(64), expectedRevision: '0' }));
  assert.equal(answer.error.code, 'TRANSACTION_CONFLICT');
  assert.equal(f.calls.filter(x => /Prepare|Apply|Restore|Readback/.test(x.operation)).length, 0);
});

test('raw duplicate decoded key, invalid UTF-8 and getter fail before authority lookup', async t => {
  const f = await fixture(t);
  let authorityCalls = 0;
  f.authority.verify = async () => { authorityCalls++; return { current: true }; };
  const body = request({ expectedRevision: '0' });
  const duplicate = JSON.stringify(body).replace('"actorRef":"actor"',
    '"actorRef":"actor","\\u0061ctorRef":"other"');
  assert.equal((await f.canvas.call('ListObjects', Buffer.from(duplicate))).error.code,
    'NON_CANONICAL_AMBIGUITY');
  assert.equal((await f.canvas.call('ListObjects', Buffer.from([0xc3, 0x28]))).error.code,
    'SCHEMA_INVALID');
  const getter = { ...body };
  Object.defineProperty(getter, 'requestId', { enumerable: true, get() { throw new Error('side effect'); } });
  assert.equal((await f.canvas.call('ListObjects', getter)).error.code, 'SCHEMA_INVALID');
  assert.equal(authorityCalls, 0);
});

test('affected analysis covers exact cells and requires explicit confirmed continuation', async t => {
  const f = await fixture(t);
  await f.canvas.call('SelectWorldConnection', request({ connectionRef: 'connection', expectedRevision: '0' }));
  await f.store.commit(state => {
    state.objects.world = {
      A: { worldRef: 'world', objectRef: 'A', objectRevision: '1', displayName: null,
        nameRevision: null, creationSequence: 1, status: 'READY' },
      B: { worldRef: 'world', objectRef: 'B', objectRevision: '1', displayName: null,
        nameRevision: null, creationSequence: 2, status: 'READY' } };
    state.footprints = { world: { A: [[0, 0, 0]], B: [[1, 0, 0]] } };
    state.sessions.session.orderedSelectedObjectRefs = ['A'];
    state.sessions.session.selectionRevision = '1';
  });
  const operations = { contractVersion: 'operations/v2', buildDigest: 'a'.repeat(64),
    compilerRevision: 'compiler-1', compilationConfigDigest: 'b'.repeat(64),
    worldRef: 'world', frameDigest: 'c'.repeat(64), catalogueDigest: 'd'.repeat(64),
    targetFactsDigest: 'e'.repeat(64), effects: [
      { position: [0, 0, 0], nodeName: 'stone', param2: 0 },
      { position: [1, 0, 0], nodeName: 'stone', param2: 0 }] };
  const analyzed = await f.canvas.call('AnalyzeAffectedObjects', request({ transactionId: 'tx',
    operations, operationDigest: digest('operations', operations), expectedRevision: 'world-rev-1',
    expectedRegistryRevision: '0', expectedSelectionRevision: '1' }));
  assert.equal(analyzed.error, null);
  assert.deepEqual(analyzed.result.affectedObjectRefs, ['A', 'B']);
  const analysisDigest = digest('affected-analysis', analyzed.result);
  const blocked = await f.canvas.call('DecideAffectedObjectNotification', request({ transactionId: 'tx',
    analysis: analyzed.result, analysisDigest, analysisRevision: '1',
    decision: 'BLOCK_AND_NOTIFY', expectedDecisionRevision: null }));
  assert.equal(blocked.error, null);
  assert.equal(blocked.result.decisionKind, 'BLOCK_AND_NOTIFY');
  const noProof = await f.canvas.call('DecideAffectedObjectNotification', request({ transactionId: 'tx',
    analysis: analyzed.result, analysisDigest, analysisRevision: '1',
    decision: 'CONTINUE', expectedDecisionRevision: '1' }));
  assert.equal(noProof.error.code, 'PERMISSION_DENIED');
  assert.equal(f.store.snapshot.decisions.world.tx.decisionKind, 'BLOCK_AND_NOTIFY');
});

test('connection listing is adapter supplied and switching preserves Session while clearing selection', async t => {
  const f = await fixture(t);
  const listed = await f.canvas.call('ListWorldConnections', request({ expectedCapabilityRevision: 'inventory-1' }));
  assert.equal(listed.error, null);
  assert.deepEqual(listed.result.connections.map(x => x.connectionRef), ['connection', 'connection-2']);
  await f.canvas.call('SelectWorldConnection', request({ connectionRef: 'connection', expectedRevision: '0' }));
  await f.store.commit(state => { state.sessions.session.orderedSelectedObjectRefs = ['old'];
    state.sessions.session.selectionRevision = '1'; });
  const changed = await f.canvas.call('SwitchWorldConnection', request({ fromWorldRef: 'world',
    toConnectionRef: 'connection-2', toWorldRef: 'world-2', expectedRevision: '1' }));
  assert.equal(changed.error, null);
  assert.equal(changed.result.currentSession, 'session');
  assert.deepEqual(changed.result.orderedSelectedObjectRefs, []);
  const reopened = await CanvasStore.open(f.store.directory);
  assert.deepEqual(reopened.snapshot.sessions.session.orderedSelectedObjectRefs, []);
});

test('revocation precedes replay and leaves durable state unchanged', async t => {
  const f = await fixture(t);
  const body = request({ connectionRef: 'connection', expectedRevision: '0' });
  assert.equal((await f.canvas.call('SelectWorldConnection', body)).error, null);
  f.canvas.authority.verify = async () => ({ current: false });
  const replay = await f.canvas.call('SelectWorldConnection', body);
  assert.equal(replay.error.code, 'AUTHORIZATION_REVOKED');
  assert.equal(f.store.snapshot.sessions.session.activeWorldRef, 'world');
});

test('selection replaces exact order, clears, and rejects duplicate without changing revision', async t => {
  const f = await fixture(t);
  await f.canvas.call('SelectWorldConnection', request({ connectionRef: 'connection', expectedRevision: '0' }));
  await f.store.commit(state => { state.objects.world = {
    A: { worldRef: 'world', objectRef: 'A', objectRevision: '1', displayName: null,
      nameRevision: null, creationSequence: 1, status: 'READY' },
    B: { worldRef: 'world', objectRef: 'B', objectRevision: '1', displayName: null,
      nameRevision: null, creationSequence: 2, status: 'READY' } }; });
  const first = await f.canvas.call('SetObjectSelection', request({ objectRefs: ['B', 'A'], expectedSelectionRevision: '0' }));
  assert.deepEqual(first.result.selectedObjectRefs, ['B', 'A']);
  const bad = await f.canvas.call('SetObjectSelection', request({ objectRefs: ['A', 'A'], expectedSelectionRevision: '1' }));
  assert.equal(bad.error.code, 'DUPLICATE_OBJECT_REF');
  assert.deepEqual(f.store.snapshot.sessions.session.orderedSelectedObjectRefs, ['B', 'A']);
  const clear = await f.canvas.call('SetObjectSelection', request({ objectRefs: [], expectedSelectionRevision: '1' }));
  assert.deepEqual(clear.result.selectedObjectRefs, []);
});

test('Unicode 17 naming uses exact display and NFC plus ASCII comparison key', async t => {
  const f = await fixture(t);
  await f.canvas.call('SelectWorldConnection', request({ connectionRef: 'connection', expectedRevision: '0' }));
  await f.store.commit(state => { state.objects.world = {
    A: { worldRef: 'world', objectRef: 'A', objectRevision: '1', displayName: null,
      nameRevision: null, creationSequence: 1, status: 'READY' },
    B: { worldRef: 'world', objectRef: 'B', objectRevision: '1', displayName: null,
      nameRevision: null, creationSequence: 2, status: 'READY' } }; });
  const first = await f.canvas.call('NameObject', request({ objectRef: 'A', name: ' がA ',
    expectedRevision: '1', expectedRegistryRevision: '0' }));
  assert.equal(first.error, null);
  assert.equal(first.result.displayName, 'がA');
  assert.equal(first.result.comparisonKey, 'がa');
  if (contracts && process.versions.unicode === '17.0') {
    assert.deepEqual({ displayName: first.result.displayName,
      comparisonKey: first.result.comparisonKey }, contracts.normalizeName(' がA '));
  }
  const second = await f.canvas.call('NameObject', request({ objectRef: 'B', name: 'か\u3099a',
    expectedRevision: '1', expectedRegistryRevision: '1' }));
  assert.equal(second.error.code, 'OBJECT_NAME_CONFLICT');
  const forbidden = await f.canvas.call('RenameObject', request({ objectRef: 'A', name: '\nOK',
    expectedRevision: '2', expectedRegistryRevision: '1' }));
  assert.equal(forbidden.error.code, 'INVALID_NAME');
  const list = await f.canvas.call('ListObjects', request({ expectedRevision: '1' }));
  assert.equal(list.result.objects[0].displayName, 'がA');
  assert.equal(list.result.registryRevision, '1');
});

test('portable ICU4X White_Space set matches the frozen Unicode 17 list', () => {
  const expected = [9, 10, 11, 12, 13, 32, 133, 160, 5760,
    ...Array.from({ length: 11 }, (_, index) => 8192 + index),
    8232, 8233, 8239, 8287, 12288];
  const actual = [];
  for (let point = 0; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    if (CodePointSetData.whiteSpaceForChar(point)) actual.push(point);
  }
  assert.deepEqual(actual, expected);
});

test('DSH plugin loads without optional host services and fails closed without profile storage', async () => {
  const services = new Map();
  const host = { get(name) { return services.get(name); },
    provide(name, service) { services.set(name, service); } };
  const effect = apply(host);
  assert.equal(effect, undefined);
  const service = services.get('hanaworldsCanvasV2');
  await service.ready;
  assert.equal(services.get('hanaworldsCanvasV2'), service);
  assert.equal(service.status().storage, 'UNAVAILABLE');
  const answer = await service.call('ListObjects', request({ expectedRevision: '0' }));
  assert.equal(answer.error.code, 'AUTHORIZATION_REVOKED');
});

test('opaque refs that equal JavaScript prototype keys persist without aliasing', async t => {
  const f = await fixture(t);
  const selected = await f.canvas.call('SelectWorldConnection', request({
    sessionRef: '__proto__', connectionRef: 'connection', expectedRevision: '0' }));
  assert.equal(selected.error, null);
  assert.equal(Object.getPrototypeOf(f.store.snapshot.sessions), null);
  assert.equal(f.store.snapshot.sessions.__proto__.activeWorldRef, 'world');
  await f.store.commit(state => {
    state.objects.world = Object.create(null);
    state.objects.world.__proto__ = { worldRef: 'world', objectRef: '__proto__',
      objectRevision: '1', displayName: null, nameRevision: null,
      creationSequence: 1, status: 'READY' };
  });
  const list = await f.canvas.call('ListObjects', request({
    sessionRef: '__proto__', expectedRevision: '0' }));
  assert.equal(list.result.objects[0].objectRef, '__proto__');
  const reopened = await CanvasStore.open(f.store.directory);
  assert.equal(reopened.snapshot.objects.world.__proto__.objectRef, '__proto__');
  assert.equal(Object.getPrototypeOf(reopened.snapshot.objects.world), null);
});

test('malformed revision and digest fail at P0 before authorization or adapter effect', async t => {
  const f = await fixture(t);
  let verifications = 0;
  f.canvas.authority.verify = async () => { verifications++; return { current: true }; };
  const malformedRevision = await f.canvas.call('ListObjects', request({ expectedRevision: 0 }));
  const malformedDigest = await f.canvas.call('AnalyzeAffectedObjects', request({
    transactionId: 'tx', operations: {}, operationDigest: 'bad', expectedRevision: '1',
    expectedRegistryRevision: '0', expectedSelectionRevision: '0' }));
  assert.equal(malformedRevision.error.phase, 'decode');
  assert.equal(malformedDigest.error.phase, 'decode');
  assert.equal(verifications, 0);
  assert.equal(f.calls.length, 0);
});

function frozenMutationRequests() {
  const digest64 = 'a'.repeat(64);
  const operations = { contractVersion: 'operations/v2', buildDigest: digest64,
    compilerRevision: '1', compilationConfigDigest: digest64, worldRef: 'world',
    frameDigest: digest64, catalogueDigest: digest64, targetFactsDigest: digest64,
    effects: [{ position: [0, 0, 0], nodeName: 'default:stone', param2: 0 }] };
  const authorizationBinding = { contractVersion: 'world-adapter/v2',
    authorizerRef: 'owner', actorRef: 'actor', grantEpoch: '1', bindingRef: 'binding',
    worldRef: 'world', sessionRef: 'session', turnRevision: '1', intentDigest: digest64,
    surfaceActionDigest: digest64, allowedAction: 'APPLY_RECOVERABLE',
    transactionId: 'tx', operationDigest: digest64, worldRevision: 'world-rev-1',
    selectionRevision: '0', analysisDigest: digest64, decisionRevision: '1' };
  const preparedTransaction = { payload: { contractVersion: 'canvas/v2',
    transactionId: 'tx', operationDigest: digest64, authorizationBindingDigest: digest64,
    expectedWorldRevision: 'world-rev-1', expectedObjectRevisions: { A: '1' },
    beforeImageDigest: digest64 }, transactionPayloadDigest: digest64,
    beforeImageDigest: digest64, guarantee: 'RECOVERABLE_VERIFIED',
    stateProfile: { profileVersion: 'state-profile/v2',
      nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
      inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' },
    protectedPositions: [[0, 0, 0]], adapterExecutionRevision: '1' };
  return {
    ApplyRecoverableCommit: request({ requestId: 'blocked-apply', transactionId: 'tx',
      operations, operationDigest: digest64, authorizationBinding,
      authorizationBindingDigest: digest64, analysisDigest: digest64,
      decisionRevision: '1', expectedWorldRevision: 'world-rev-1',
      expectedObjectRevisions: { A: '1' }, guarantee: 'RECOVERABLE_VERIFIED',
      preparedTransaction }),
    Readback: request({ requestId: 'blocked-readback', transactionId: 'tx',
      commitRevision: '1', expectedOperations: operations,
      transactionPayloadDigest: digest64 }),
    Undo: request({ requestId: 'blocked-undo', objectRef: 'A',
      transactionId: 'new-tx', historyTransactionId: 'old-tx',
      expectedHistoryRevision: '1', expectedWorldRevision: 'world-rev-1',
      expectedObjectRevisions: { A: '1' }, intentDigest: digest64,
      surfaceActionDigest: digest64 }),
    Redo: request({ requestId: 'blocked-redo', objectRef: 'A',
      transactionId: 'new-tx', historyTransactionId: 'old-tx',
      expectedHistoryRevision: '1', expectedWorldRevision: 'world-rev-1',
      expectedObjectRevisions: { A: '1' }, intentDigest: digest64,
      surfaceActionDigest: digest64 }),
  };
}

test('frozen mutation operation names keep typed fail-closed envelopes and have zero effect', async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.store.snapshot);
  for (const [operation, body] of Object.entries(frozenMutationRequests())) {
    contracts?.validateRequest('canvas/v2', operation, body);
    const response = await f.canvas.call(operation, body);
    contracts?.validateResponse('canvas/v2', operation, response);
    assert.equal(response.requestId, body.requestId);
    assert.equal(response.result, null);
    assert.equal(response.error.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(response.error.phase, 'validate');
    assert.equal(response.error.mutationState, 'NONE');
    assert.equal(response.error.transactionRef, null);
    assert.equal(JSON.stringify(f.store.snapshot), before);
  }
  assert.deepEqual(f.calls, []);
});

test('frozen mutation operations decode and revoke before capability refusal', async t => {
  const f = await fixture(t);
  const requests = frozenMutationRequests();
  let authorizations = 0;
  f.canvas.authority.verify = async (body, operation) => {
    authorizations++;
    return { current: false, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation] };
  };
  for (const [operation, body] of Object.entries(requests)) {
    const revoked = await f.canvas.call(operation, body);
    assert.equal(revoked.requestId, body.requestId);
    assert.equal(revoked.error.code, 'AUTHORIZATION_REVOKED');
    const missing = { ...body };
    delete missing.transactionId;
    const malformed = await f.canvas.call(operation, missing);
    assert.equal(malformed.requestId, body.requestId);
    assert.equal(malformed.error.code, 'SCHEMA_INVALID');
    const extra = await f.canvas.call(operation, { ...body, invented: true });
    assert.equal(extra.requestId, body.requestId);
    assert.equal(extra.error.code, 'UNKNOWN_REQUIRED_FIELD');
    const nested = structuredClone(body);
    if (operation === 'ApplyRecoverableCommit')
      nested.preparedTransaction.stateProfile.nodeFields = ['nodeName', 'param2', 'param1'];
    if (operation === 'Readback') nested.expectedOperations.effects[0].param2 = 256;
    if (operation === 'Undo') nested.expectedObjectRevisions.A = 7;
    if (operation === 'Redo') nested.intentDigest = 'not-a-digest';
    if (contracts) assert.throws(() => contracts.validateRequest('canvas/v2', operation, nested));
    const invalidNested = await f.canvas.call(operation, nested);
    assert.equal(invalidNested.requestId, body.requestId);
    assert.equal(invalidNested.error.code, 'SCHEMA_INVALID');
  }
  assert.equal(authorizations, 4);
  assert.deepEqual(f.calls, []);
});
