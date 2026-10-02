import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasStore, CanvasV4 } from '../src/index.mjs';
import placement from 'hanaworlds-contracts/v4/fixtures/placement-region-chain-v4' with { type: 'json' };
import { validateResponse, contractHandshake } from 'hanaworlds-contracts/v4';

const chain = placement.validCases[0].materializedChain;
async function fixture(t, { adapter, currentWorldRevision = 'fixture-world-10',
  inspectGrant = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions['fixture-session'] = { currentSession: 'fixture-session',
      activeWorldRef: 'fixture-world', orderedSelectedObjectRefs: [],
      sessionRevision: 'session-1', selectionRevision: 'fixture-selection-0' };
    state.bindings['fixture-session'] = { adapterId: 'fixture-adapter',
      worldRef: 'fixture-world', recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.placementSettings = { 'fixture-world': structuredClone(chain.canvasSettingsRecord) };
    state.registryRevisions['fixture-world'] = '0';
  });
  let current = true;
  const authority = { async verify(body, operation) {
    return { current, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, authorRef: 'alice',
      allowedActions: inspectGrant ? [operation, 'INSPECT'] : [operation],
      currentWorldRevision };
  } };
  const calls = [];
  const port = adapter ?? { async call(operation, request) {
    calls.push({ operation, request });
    if (operation === 'InspectRegion') return { ...chain.adapterInspectResponse,
      requestId: request.requestId,
      result: { outcome: 'REGION_INSPECTED', inspection: {
        ...chain.adapterInspectResponse.result.inspection,
        inspectionId: request.inspectionId,
        placementSettings: request.placementSettings } } };
    throw Error('adapter operation intentionally unavailable');
  } };
  port.contractHandshake ??= contractHandshake;
  const canvas = new CanvasV4({ store, adapters: [{ adapterId: 'fixture-adapter', port }],
    authority, serviceActorRef: 'canvas-service' });
  return { directory, store, canvas, calls, revoke: () => { current = false; } };
}

test('v4 current inventory returns one authorized durable snapshot after restart and binds selected ref', async t => {
  const f = await fixture(t);
  await f.store.commit(state => {
    state.registryRevisions['fixture-world'] = 'opaque-registry-9';
    state.objects['fixture-world'] = { 'stable-gate': { worldRef: 'fixture-world',
      objectRef: 'stable-gate', objectRevision: 'revision-1', displayName: '門',
      nameRevision: 'name-1', creationSequence: 1, status: 'READY' } };
  });
  const reopened = new CanvasV4({ store: await CanvasStore.open(f.directory),
    authority: f.canvas.authority });
  const request = { contractVersion: 'canvas/v4', actorRef: 'fixture-actor',
    sessionRef: 'fixture-session', requestId: 'current-list',
    authorizationRef: 'fixture-current-grant', worldRef: 'fixture-world',
    expectedRevision: null };
  const before = JSON.stringify(reopened.store.snapshot);
  const response = await reopened.call('ListObjects', request);
  assert.equal(response.error, null);
  validateResponse('canvas/v4', 'ListObjects', response);
  assert.equal(response.result.registryRevision, 'opaque-registry-9');
  assert.equal(response.result.objects[0].objectRef, 'stable-gate');
  assert.equal(JSON.stringify(reopened.store.snapshot), before);
  const selected = await reopened.call('SetObjectSelection', { contractVersion: 'canvas/v4',
    actorRef: request.actorRef, sessionRef: request.sessionRef,
    requestId: 'select-returned', authorizationRef: request.authorizationRef,
    worldRef: request.worldRef, objectRefs: [response.result.objects[0].objectRef],
    expectedSelectionRevision: 'fixture-selection-0' });
  assert.equal(selected.error, null);
  const stale = await reopened.call('ListObjects', { ...request,
    requestId: 'old-revision', expectedRevision: 'opaque-registry-8' });
  assert.equal(stale.error.code, 'STALE_REVISION');
  const forged = await reopened.call('SetObjectSelection', { contractVersion: 'canvas/v4',
    actorRef: request.actorRef, sessionRef: request.sessionRef,
    requestId: 'select-forged', authorizationRef: request.authorizationRef,
    worldRef: request.worldRef, objectRefs: ['not-returned-and-not-registered'],
    expectedSelectionRevision: selected.result.selectionRevision });
  assert.equal(forged.error.code, 'OBJECT_NOT_FOUND');
  f.revoke();
  const revoked = await reopened.call('ListObjects', { ...request, requestId: 'revoked' });
  assert.equal(revoked.error.code, 'AUTHORIZATION_REVOKED');
});

test('v4 placement settings fail closed and expose missing setting names before Adapter call', async t => {
  const f = await fixture(t);
  await f.store.commit(state => { delete state.placementSettings['fixture-world'].stored['placement.frontGapCells']; });
  const response = await f.canvas.call('InspectPlacementRegion', chain.canvasInspectRequest);
  assert.equal(response.error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(response.error.phase, 'validate');
  assert.deepEqual(response.unavailableSettings, ['placement.frontGapCells']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.canvas.adminProjection('fixture-world').settings.find(x =>
    x.name === 'placement.frontGapCells').currentValue, null);
  await f.store.commit(state => {
    delete state.placementSettings['fixture-world'].settingsRevision;
  });
  const combined = await f.canvas.call('InspectPlacementRegion', {
    ...chain.canvasInspectRequest, requestId: 'missing-value-and-revision' });
  assert.equal(combined.error.code, 'CAPABILITY_UNAVAILABLE');
  validateResponse('canvas/v4', 'InspectPlacementRegion', combined);
  assert.deepEqual(combined.unavailableSettings, [
    'placement.forwardSearchCells', 'placement.frontGapCells',
    'placement.lateralSearchCells', 'placement.verticalSearchCells',
  ].sort());
  assert.equal(f.calls.length, 0);
});

test('v4 InspectPlacementRegion durably records Adapter outcome and gates Apply evidence', async t => {
  const f = await fixture(t);
  const response = await f.canvas.call('InspectPlacementRegion', chain.canvasInspectRequest);
  assert.equal(response.error, null);
  validateResponse('canvas/v4', 'InspectPlacementRegion', response);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.actorRef, 'canvas-service');
  const inspection = response.result.inspection;
  assert.equal(f.store.snapshot.placementInspections[
    'fixture-session\u0000InspectPlacementRegion\u0000workshop-place-1'].outcome.inspection.inspectionId,
    inspection.inspectionId);
  const restarted = new CanvasV4({ store: await CanvasStore.open(f.directory),
    adapters: f.canvas.adapters, authority: f.canvas.authority,
    serviceActorRef: 'canvas-service' });
  const replay = await restarted.call('InspectPlacementRegion', chain.canvasInspectRequest);
  assert.equal(replay.result.inspection.inspectionId, inspection.inspectionId);
  assert.equal(f.calls.length, 1);
  const apply = structuredClone(chain.applyRequest);
  apply.regionInspectionBinding.inspectionId = inspection.inspectionId;
  await f.store.commit(state => {
    state.analyses['fixture-world'] = { [apply.transactionId]: {
      digest: apply.analysisDigest, positions: apply.operations.effects.map(x => x.position),
      result: { operationDigest: apply.operationDigest, worldRevision: apply.expectedWorldRevision,
        selectionRevision: 'fixture-selection-0', registryRevision: '0',
        orderedSelectedRefs: [], affectedObjectRefs: [] } } };
  });
  const invalid = structuredClone(apply);
  invalid.requestId = 'invalid-evidence';
  invalid.regionInspectionBinding.build.witnesses.find(x => x.predicate === 'PROTECTION')
    .facts.evidence.sourceRevision = 'forged';
  const denied = await f.canvas.call('ApplyRecoverableCommit', invalid);
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.equal(denied.error.phase, 'authorize');
  assert.equal(f.calls.length, 1);
  const valid = await f.canvas.call('ApplyRecoverableCommit', apply);
  assert.equal(valid.error.code, 'ADAPTER_UNAVAILABLE');
  assert.equal(f.calls.at(-1).operation, 'PrepareRecoverableTransaction');
  assert.equal(f.calls.at(-1).request.actorRef, 'canvas-service');
});

test('v4 linked Undo binds the saved before-state digest and moves only the author head after readback', async t => {
  const seam = (await import('hanaworlds-contracts/v4/fixtures/history-seam-chain-v4',
    { with: { type: 'json' } })).default;
  const oracle = (await import('hanaworlds-contracts/v4/fixtures/contract-v4-oracles',
    { with: { type: 'json' } })).default;
  const source = structuredClone(oracle.cases.find(x =>
    x.id === 'A-VALID-AUTHOR-LINKED-UNDO').request);
  source.affectedObjectRefs = ['fixture-object', 'fixture-object-2'];
  source.expectedObjectRevisions['fixture-object-2'] = 'fixture-object-2-rev';
  const historyRequest = {
    contractVersion: 'canvas/v4', actorRef: source.actorRef,
    sessionRef: source.sessionRef, requestId: 'canvas-undo-1',
    authorizationRef: source.authorizationRef, worldRef: source.worldRef,
    objectRef: 'fixture-object', transactionId: source.transactionId,
    historyTransactionId: source.originTransactionId,
    expectedHistoryRevision: source.expectedHistoryRevision,
    expectedWorldRevision: source.expectedWorldRevision,
    expectedObjectRevisions: source.expectedObjectRevisions,
    intentDigest: source.authorizationBinding.intentDigest,
    surfaceActionDigest: source.authorizationBinding.surfaceActionDigest };
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v4-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions[source.sessionRef] = { currentSession: source.sessionRef,
      activeWorldRef: source.worldRef, orderedSelectedObjectRefs: ['fixture-object'],
      sessionRevision: 'session-1', selectionRevision: source.authorizationBinding.selectionRevision };
    state.bindings[source.sessionRef] = { adapterId: 'fixture-adapter',
      worldRef: source.worldRef, recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.objects[source.worldRef] = { 'fixture-object': { worldRef: source.worldRef,
      objectRef: 'fixture-object', objectRevision: source.expectedObjectRevisions['fixture-object'],
      displayName: 'Home', nameRevision: 'name-1', creationSequence: 1, status: 'READY' } };
    state.objects[source.worldRef]['fixture-object-2'] = { worldRef: source.worldRef,
      objectRef: 'fixture-object-2', objectRevision: 'fixture-object-2-rev',
      displayName: 'Gate', nameRevision: 'name-2', creationSequence: 2, status: 'READY' };
    state.authorHistory[source.worldRef] = { 'fixture-object': { alice: {
      historyRevision: source.expectedHistoryRevision,
      headTransactionId: source.originTransactionId,
      entries: [{ transactionId: source.originTransactionId, originTransactionId: null,
        affectedObjectRefs: source.affectedObjectRefs,
        operationDigest: 'a'.repeat(64), beforeImageDigest: source.originBeforeImageDigest,
        expectedAfterReadbackDigest: source.originAfterReadbackDigest,
        receiptDigest: source.originVerifiedReceiptDigest,
        historyRevision: source.expectedHistoryRevision, status: 'VERIFIED' }],
      undoAvailable: true, redoAvailable: false } } };
    state.authorHistory[source.worldRef]['fixture-object-2'] = {
      alice: structuredClone(state.authorHistory[source.worldRef]['fixture-object'].alice) };
    state.transactions[source.worldRef] = { [source.originTransactionId]: {
      status: 'VERIFIED', worldRef: source.worldRef,
      authorRef: 'alice', sessionRef: source.sessionRef,
      affectedObjectRefs: source.affectedObjectRefs, positions: [[0, 0, 0]],
      beforeImageDigest: source.originBeforeImageDigest,
      beforeStateReadbackDigest: source.originBeforeStateReadbackDigest,
      afterReadbackDigest: source.originAfterReadbackDigest,
      receiptDigest: source.originVerifiedReceiptDigest } };
  });
  const calls = [];
  let redoPhase = false;
  const adapter = { contractHandshake, async call(operation, request) {
    calls.push({ operation, request });
    let result;
    if (operation === 'PrepareHistoryTransaction') result = {
      originTransactionId: request.originTransactionId, transactionId: request.transactionId,
      direction: request.direction, historyOperationDigest: request.historyOperationDigest,
      transactionPayloadDigest: 'b'.repeat(64),
      beforeImageDigest: source.originBeforeImageDigest,
      targetStateDigest: request.targetStateDigest,
      protectedPositions: [[0, 0, 0]],
      stateProfile: seam.savedBeforeImage.stateProfile,
      adapterExecutionRevision: 'adapter-exec-1',
      guarantee: 'RECOVERABLE_VERIFIED', status: 'PREPARED' };
    else if (operation === 'ApplyHistoryTransaction') result = {
      contractVersion: 'canvas/v2', transactionId: request.transactionId,
      operationDigest: request.historyOperationDigest,
      transactionPayloadDigest: request.preparedHistoryTransaction.transactionPayloadDigest,
      status: 'APPLIED_PENDING_READBACK', previousWorldRevision: request.expectedWorldRevision,
      observedWorldRevision: null, readbackDigest: null,
      restoreStatus: 'NOT_REQUIRED', error: null };
    else if (operation === 'Readback') result = {
      projection: redoPhase ? (await import('hanaworlds-contracts/v4/fixtures/production-goldens',
        { with: { type: 'json' } })).default.vectors.find(x => x.id === 'PROD-readback').payload :
        seam.digestGolden.beforeStateReadbackProjection,
      readbackDigest: redoPhase ? source.originAfterReadbackDigest :
        source.originBeforeStateReadbackDigest,
      adapterExecutionRevision: 'adapter-exec-1' };
    else throw Error(`Unexpected ${operation}`);
    return { contractVersion: 'world-adapter/v4', requestId: request.requestId,
      result, error: null };
  } };
  let verification = 0;
  const authority = { async verify(body, operation) {
    verification++;
    return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, authorRef: 'alice',
      allowedActions: [operation],
      currentWorldRevision: redoPhase ?
        (verification === 4 ? 'fixture-world-2' : 'fixture-world-3') :
        (verification === 1 ? source.expectedWorldRevision : 'fixture-world-2'),
      authorizationBinding: source.authorizationBinding };
  } };
  const canvas = new CanvasV4({ store, adapters: [{ adapterId: 'fixture-adapter', port: adapter }],
    authority, serviceActorRef: 'canvas-service' });
  const response = await canvas.call('Undo', historyRequest);
  assert.equal(response.error, null, JSON.stringify(response.error));
  validateResponse('canvas/v4', 'Undo', response);
  assert.deepEqual(calls.map(x => x.operation),
    ['PrepareHistoryTransaction', 'ApplyHistoryTransaction', 'Readback']);
  assert.equal(calls[0].request.originBeforeStateReadbackDigest,
    source.originBeforeStateReadbackDigest);
  assert.equal(calls[0].request.targetStateDigest, source.originBeforeStateReadbackDigest);
  assert.equal(calls[0].request.actorRef, 'canvas-service');
  assert.equal(store.snapshot.authorHistory[source.worldRef]['fixture-object'].alice.headTransactionId,
    null);
  assert.equal(store.snapshot.authorHistory[source.worldRef]['fixture-object'].alice.redoAvailable,
    true);
  assert.equal(store.snapshot.authorHistory[source.worldRef]['fixture-object-2'].alice.headTransactionId,
    null);
  assert.equal(store.snapshot.authorHistory[source.worldRef]['fixture-object'].alice.historyRevision,
    store.snapshot.authorHistory[source.worldRef]['fixture-object-2'].alice.historyRevision);
  const replay = await canvas.call('Undo', historyRequest);
  assert.equal(replay.error, null);
  assert.equal(calls.length, 3);
  const reopened = await CanvasStore.open(directory);
  assert.equal(reopened.snapshot.authorHistory[source.worldRef]['fixture-object'].alice.redoAvailable,
    true);
  redoPhase = true;
  const afterUndo = store.snapshot.authorHistory[source.worldRef]['fixture-object'].alice;
  const redo = { ...historyRequest, requestId: 'canvas-redo-1',
    transactionId: 'fixture-redo-tx', expectedHistoryRevision: afterUndo.historyRevision,
    expectedWorldRevision: 'fixture-world-2', expectedObjectRevisions: {
      'fixture-object': store.snapshot.objects[source.worldRef]['fixture-object'].objectRevision,
      'fixture-object-2': store.snapshot.objects[source.worldRef]['fixture-object-2'].objectRevision } };
  const redone = await canvas.call('Redo', redo);
  assert.equal(redone.error, null, JSON.stringify(redone.error));
  assert.equal(store.snapshot.authorHistory[source.worldRef]['fixture-object'].alice.headTransactionId,
    source.originTransactionId);
  assert.equal(store.snapshot.authorHistory[source.worldRef]['fixture-object'].alice.redoAvailable,
    false);
  assert.equal(store.snapshot.authorHistory[source.worldRef]['fixture-object'].alice.historyRevision,
    store.snapshot.authorHistory[source.worldRef]['fixture-object-2'].alice.historyRevision);
});

test('v4 placement choice releases typed player names only with current INSPECT scope', async t => {
  const names = ['alice', 'bob'];
  const choicePort = { contractHandshake, async call(operation, request) {
    assert.equal(operation, 'InspectRegion');
    return { contractVersion: 'world-adapter/v4', requestId: request.requestId,
      result: { outcome: 'PLACEMENT_CHOICE_REQUIRED', choice: {
        anchorKind: 'DEFAULT_PLAYER', reasons: ['MULTIPLE_ONLINE_PLAYERS'],
        options: ['NAME_PLAYER', 'PICK_WORLD_POINT'], candidatePlayerNames: names,
        placementSettings: request.placementSettings,
        observedWorldRevision: request.expectedWorldRevision } }, error: null };
  } };
  const allowed = await fixture(t, { adapter: choicePort, inspectGrant: true });
  const shown = await allowed.canvas.call('InspectPlacementRegion', chain.canvasInspectRequest);
  assert.equal(shown.error, null);
  assert.deepEqual(shown.result.choice.options, ['NAME_PLAYER', 'PICK_WORLD_POINT']);
  assert.deepEqual(shown.result.choice.candidatePlayerNames, names);
  const denied = await fixture(t, { adapter: choicePort });
  const hidden = await denied.canvas.call('InspectPlacementRegion', chain.canvasInspectRequest);
  assert.equal(hidden.result, null);
  assert.equal(hidden.error.code, 'PERMISSION_DENIED');
  assert.equal(denied.store.snapshot.placementInspections[
    'fixture-session\u0000InspectPlacementRegion\u0000workshop-place-1'].status, 'RESERVED');
});

test('v4 handshake mismatch stops before any Adapter request', async t => {
  let called = 0;
  const f = await fixture(t, { adapter: { contractHandshake: {
    ...contractHandshake, wireVersions: ['world-adapter/v3'] },
  async call() { called++; throw Error('must not call'); } } });
  const response = await f.canvas.call('InspectPlacementRegion', chain.canvasInspectRequest);
  assert.equal(response.error.code, 'UNSUPPORTED_VERSION');
  assert.equal(response.error.phase, 'decode');
  assert.equal(called, 0);
});

test('v4 admin settings require host proof and retain explicit edits across restart', async t => {
  const f = await fixture(t);
  const context = { actorRef: 'admin', authorizationRef: 'admin-grant' };
  const settings = { 'placement.frontGapCells': 3, 'placement.forwardSearchCells': 5,
    'placement.lateralSearchCells': 2, 'placement.verticalSearchCells': 1 };
  const denied = await f.canvas.setPlacementSettings('fixture-world', settings, context)
    .then(() => null, error => error);
  assert.equal(denied.publicError.code, 'PERMISSION_DENIED');
  const admin = new CanvasV4({ store: f.store, authority: f.canvas.authority,
    adminAuthority: { async verify(_context, operation, worldRef) {
      assert.equal(operation, 'UpdatePlacementSettings');
      return { current: true, worldRef, domainOwner: 'hanaworlds-canvas' };
    } } });
  const projection = await admin.setPlacementSettings('fixture-world', settings, context);
  assert.equal(projection.settings.find(x => x.name === 'placement.frontGapCells').currentValue, 3);
  const reopened = new CanvasV4({ store: await CanvasStore.open(f.directory) });
  assert.equal(reopened.adminProjection('fixture-world').settings.find(x =>
    x.name === 'placement.forwardSearchCells').currentValue, 5);
});

test('v4 world bind uses admitted Adapter wire and initializes placement defaults once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v4-bind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  const calls = [];
  const port = { contractHandshake, async call(operation, body) {
    calls.push({ operation, body });
    const descriptor = { adapterId: 'adapter', connectionRef: 'connection',
      worldRef: 'world', displayName: 'World', capabilityRevision: 'cap-1',
      payloadVersion: '0.2.0', readiness: 'READY' };
    const result = operation === 'ListWorlds' ? { capabilityRevision: 'cap-1',
      connections: [descriptor] } : { connectionRef: 'connection', worldRef: 'world',
      payloadVersion: '0.2.0', payloadDigest: 'a'.repeat(64),
      binding: { authorizerRef: 'owner', actorRef: 'actor', bindingRef: 'binding',
        worldRef: 'world', grantEpoch: 'epoch', allowedActions: ['READ'] },
      capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1',
        worldRef: 'world', engineBounds: null, limits: [],
        recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile: null,
        regionProtectionWriters: [], sessionDeleteSupported: false,
        imageMediaTypes: [], model: null } };
    return validateResponse('world-adapter/v4', operation, {
      contractVersion: 'world-adapter/v4', requestId: body.requestId,
      result, error: null });
  } };
  const canvas = new CanvasV4({ store, serviceActorRef: 'canvas-service',
    adapters: [{ adapterId: 'adapter', port }],
    authority: { async verify(body, operation) { return { current: true,
      actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation] }; } } });
  const selected = await canvas.call('SelectWorldConnection', {
    contractVersion: 'canvas/v4', actorRef: 'actor', sessionRef: 'session',
    requestId: 'bind-v4', authorizationRef: 'grant', worldRef: 'world',
    connectionRef: 'connection', expectedRevision: '0' });
  assert.equal(selected.error, null);
  assert.deepEqual(calls.map(x => x.operation), ['ListWorlds', 'AuthorizeBinding']);
  assert.ok(calls.every(x => x.body.actorRef === 'canvas-service'));
  assert.deepEqual({ ...store.snapshot.placementSettings.world.stored }, {
    'placement.frontGapCells': 2, 'placement.forwardSearchCells': 16,
    'placement.lateralSearchCells': 8, 'placement.verticalSearchCells': 4 });
});
