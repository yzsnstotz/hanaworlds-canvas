import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as canvas from '../src/v3-legacy.mjs';
import oracle from 'hanaworlds-contracts/v3/fixtures/contract-v3-oracles' with { type: 'json' };
import eventOracle from 'hanaworlds-contracts/v3/fixtures/canvas-events-v3' with { type: 'json' };
import { canonicalJSON, digestValue, validateResponse,
  validateCanvasEvent } from 'hanaworlds-contracts/v3';

test('Canvas exposes the approved v3 public port', () => {
  assert.equal(typeof canvas.CanvasV3, 'function');
});

test('v3 store upgrades the existing durable snapshot with an exact rollback backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = { schemaVersion: 1, sessions: { existing: { activeWorldRef: 'world' } },
    bindings: {}, objects: {}, names: {}, footprints: {}, registryRevisions: {},
    analyses: {}, decisions: {}, transactions: {}, history: {}, replay: {}, pending: {} };
  const bytes = JSON.stringify(old);
  await writeFile(join(directory, 'canvas-v2.json'), bytes);
  const store = await canvas.CanvasStore.open(directory);
  assert.equal(store.snapshot.schemaVersion, 2);
  assert.equal(store.snapshot.sessions.existing.activeWorldRef, 'world');
  assert.equal(await readFile(join(directory, 'canvas-v2.pre-v3.json'), 'utf8'), bytes);
  const reopened = await canvas.CanvasStore.open(directory);
  assert.equal(reopened.snapshot.schemaVersion, 2);
});

test('v3 ListObjects reads the bound world and rejects a legacy v2 envelope', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world',
      orderedSelectedObjectRefs: [], sessionRevision: '1', selectionRevision: '0' };
  });
  const service = new canvas.CanvasV3({ store, authority: { async verify(body, operation) {
    return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation] };
  } } });
  const request = { contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'list-1', authorizationRef: 'grant', worldRef: 'world', expectedRevision: '0' };
  const listed = await service.call('ListObjects', request);
  assert.equal(listed.error, null);
  assert.equal(listed.contractVersion, 'canvas/v3');
  assert.deepEqual(listed.result.objects, []);
  const legacy = await service.call('ListObjects', { ...request,
    contractVersion: 'canvas/v2', requestId: 'list-2' });
  assert.equal(legacy.error.code, 'UNSUPPORTED_VERSION');
});

test('v3 named object survives restart but stale ListObjects cannot bootstrap its revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-registry-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world',
      orderedSelectedObjectRefs: [], sessionRevision: 'session-1', selectionRevision: '0' };
    state.registryRevisions.world = 'opaque-after-creation';
    state.objects.world = { 'generated-object': { worldRef: 'world',
      objectRef: 'generated-object', objectRevision: 'object-1',
      displayName: null, nameRevision: null, creationSequence: 1, status: 'READY' } };
  });
  const authority = { async verify(body, operation) {
    return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation],
      authorRef: 'creator' };
  } };
  const beforeRestart = new canvas.CanvasV3({ store, authority });
  const context = { actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'grant', worldRef: 'world' };
  const liveEvents = [];
  await beforeRestart.subscribeCanvasEvents(context, event => liveEvents.push(event));
  const otherLiveEvents = [];
  await beforeRestart.subscribeCanvasEvents({ ...context,
    authorizationRef: 'other-grant' }, event => otherLiveEvents.push(event));
  const named = await beforeRestart.call('NameObject', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'name-before-restart', authorizationRef: 'grant', worldRef: 'world',
    objectRef: 'generated-object', name: 'House', expectedRevision: 'object-1',
    expectedRegistryRevision: 'opaque-after-creation' });
  assert.equal(named.error, null);
  assert.equal(named.result.displayName, 'House');
  assert.deepEqual(liveEvents.map(event => event.event),
    ['ObjectNameChanged', 'ObjectInventoryChanged']);
  validateCanvasEvent('ObjectNameChanged', liveEvents[0]);
  validateCanvasEvent('ObjectInventoryChanged', liveEvents[1]);
  assert.equal(liveEvents[1].receipt.result.registryRevision,
    named.result.registryRevision);
  assert.deepEqual(otherLiveEvents.map(event => event.event),
    ['ObjectInventoryChanged']);
  const unchanged = await beforeRestart.call('RenameObject', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'same-name', authorizationRef: 'grant', worldRef: 'world',
    objectRef: 'generated-object', name: 'House',
    expectedRevision: named.result.objectRevision,
    expectedRegistryRevision: named.result.registryRevision });
  assert.equal(unchanged.error, null);
  assert.equal(unchanged.result.registryRevision, named.result.registryRevision);
  assert.equal(liveEvents.length, 2);
  assert.equal(otherLiveEvents.length, 1);
  const restarted = new canvas.CanvasV3({ store: await canvas.CanvasStore.open(directory),
    authority });
  const afterRestartEvents = [];
  await restarted.subscribeCanvasEvents(context, event => afterRestartEvents.push(event));
  const otherAfterRestartEvents = [];
  await restarted.subscribeCanvasEvents({ ...context,
    authorizationRef: 'other-grant' }, event => otherAfterRestartEvents.push(event));
  assert.deepEqual(afterRestartEvents, []);
  const request = { contractVersion: 'canvas/v3', actorRef: 'actor',
    sessionRef: 'session', requestId: 'catchup-1', authorizationRef: 'grant',
    worldRef: 'world', expectedRevision: 'opaque-after-creation' };
  const stale = await restarted.call('ListObjects', request);
  assert.equal(stale.result, null);
  assert.equal(stale.error.code, 'STALE_REVISION');
  assert.equal(Object.hasOwn(stale.error, 'registryRevision'), false);
  assert.equal(JSON.stringify(stale).includes(named.result.registryRevision), false);
  assert.equal(JSON.stringify(stale).includes('generated-object'), false);
  const known = await restarted.call('ListObjects', { ...request,
    requestId: 'catchup-2', expectedRevision: named.result.registryRevision });
  assert.equal(known.error, null);
  assert.equal(known.result.objects[0].objectRef, 'generated-object');
  assert.equal(known.result.objects[0].displayName, 'House');
  assert.deepEqual(afterRestartEvents, []);
  const selected = await restarted.call('SetObjectSelection', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'select-after-restart', authorizationRef: 'grant', worldRef: 'world',
    objectRefs: [known.result.objects[0].objectRef], expectedSelectionRevision: '0' });
  assert.equal(selected.error, null);
  assert.deepEqual(selected.result.selectedObjectRefs, ['generated-object']);
  assert.deepEqual(afterRestartEvents.map(event => event.event),
    ['ActiveObjectSelectionReplaced']);
  validateCanvasEvent('ActiveObjectSelectionReplaced', afterRestartEvents[0]);
  assert.deepEqual(otherAfterRestartEvents, []);
  const renamed = await restarted.call('RenameObject', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'rename-after-restart', authorizationRef: 'grant', worldRef: 'world',
    objectRef: 'generated-object', name: 'House Two',
    expectedRevision: known.result.objects[0].objectRevision,
    expectedRegistryRevision: known.result.registryRevision });
  assert.equal(renamed.error, null);
  assert.deepEqual(afterRestartEvents.map(event => event.event),
    ['ActiveObjectSelectionReplaced', 'ObjectNameChanged',
      'ObjectInventoryChanged']);
  assert.equal(afterRestartEvents[1].operation, 'RenameObject');
  validateCanvasEvent('ObjectNameChanged', afterRestartEvents[1]);
  assert.deepEqual(otherAfterRestartEvents.map(event => event.event),
    ['ObjectInventoryChanged']);
});

test('v3 private name event rechecks action permission while inventory stays list-scoped', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-event-action-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world',
      orderedSelectedObjectRefs: [], sessionRevision: '1', selectionRevision: '0' };
    state.objects.world = { object: { worldRef: 'world', objectRef: 'object',
      objectRevision: '1', displayName: null, nameRevision: null,
      creationSequence: 1, status: 'READY' } };
  });
  let nameVerifications = 0;
  const service = new canvas.CanvasV3({ store, authority: { async verify(body, operation) {
    const current = operation !== 'NameObject' || ++nameVerifications === 1;
    return { current, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation],
      authorRef: 'engine-author' };
  } } });
  const events = [];
  await service.subscribeCanvasEvents({ actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'grant', worldRef: 'world' }, event => events.push(event));
  const named = await service.call('NameObject', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'name-action-revoked', authorizationRef: 'grant', worldRef: 'world',
    objectRef: 'object', name: 'House', expectedRevision: '1',
    expectedRegistryRevision: '0' });
  assert.equal(named.error, null);
  assert.equal(nameVerifications, 2);
  assert.deepEqual(events.map(event => event.event), ['ObjectInventoryChanged']);
});

test('v3 Apply rejects a recursive unknown field before authorization and Adapter entry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-decode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let verified = 0;
  let adapted = 0;
  const service = new canvas.CanvasV3({ store: await canvas.CanvasStore.open(directory),
    authority: { async verify() { verified++; return { current: true }; } },
    adapter: { async call() { adapted++; return null; } } });
  const valid = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  const invalid = { ...valid, operations: { ...valid.operations,
    effects: [{ ...valid.operations.effects[0], hidden: true }] } };
  const response = await service.call('ApplyRecoverableCommit', invalid);
  assert.equal(response.error.code, 'UNKNOWN_REQUIRED_FIELD');
  const callerPrepared = await service.call('ApplyRecoverableCommit', {
    ...valid, preparedTransaction: { transactionPayloadDigest: 'f'.repeat(64) } });
  assert.equal(callerPrepared.error.code, 'UNKNOWN_REQUIRED_FIELD');
  assert.equal(verified, 0);
  assert.equal(adapted, 0);
});

test('v3 affected analysis preserves the approved v2 digest projection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-analysis-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const apply = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  await store.commit(state => {
    state.sessions[apply.sessionRef] = { currentSession: apply.sessionRef,
      activeWorldRef: apply.worldRef, orderedSelectedObjectRefs: [],
      sessionRevision: '1', selectionRevision: '0' };
    state.objects[apply.worldRef] = { 'other-object': { worldRef: apply.worldRef,
      objectRef: 'other-object', objectRevision: '1', displayName: 'Other',
      nameRevision: '1', creationSequence: 1, status: 'READY' } };
    state.footprints[apply.worldRef] = { 'other-object': [[0, 0, 0]] };
  });
  const service = new canvas.CanvasV3({ store, authority: { async verify(body, operation) {
    return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation],
      currentWorldRevision: apply.expectedWorldRevision, authorRef: 'engine-author' };
  } } });
  const events = [];
  await service.subscribeCanvasEvents({ actorRef: apply.actorRef,
    sessionRef: apply.sessionRef, authorizationRef: apply.authorizationRef,
    worldRef: apply.worldRef }, event => events.push(event));
  const otherEvents = [];
  await service.subscribeCanvasEvents({ actorRef: apply.actorRef,
    sessionRef: apply.sessionRef, authorizationRef: 'other-grant',
    worldRef: apply.worldRef }, event => otherEvents.push(event));
  const request = { contractVersion: 'canvas/v3', actorRef: apply.actorRef,
    sessionRef: apply.sessionRef, requestId: 'analyze-v3',
    authorizationRef: apply.authorizationRef, worldRef: apply.worldRef,
    transactionId: apply.transactionId, operations: apply.operations,
    operationDigest: apply.operationDigest, expectedRevision: apply.expectedWorldRevision,
    expectedRegistryRevision: '0', expectedSelectionRevision: '0' };
  const response = await service.call('AnalyzeAffectedObjects', request);
  assert.equal(response.error, null);
  assert.equal(response.result.contractVersion, 'canvas/v2');
  validateResponse('canvas/v3', 'AnalyzeAffectedObjects', response);
  assert.deepEqual(response.result.affectedObjectRefs, ['other-object']);
  assert.deepEqual(events.map(event => event.event), ['AffectedObjectAnalysisReady']);
  validateCanvasEvent('AffectedObjectAnalysisReady', events[0]);
  const analysisDigest = digestValue('affected-analysis', response.result).sha256;
  const blocked = await service.call('DecideAffectedObjectNotification', {
    contractVersion: 'canvas/v3', actorRef: apply.actorRef,
    sessionRef: apply.sessionRef, requestId: 'block-other-object',
    authorizationRef: apply.authorizationRef, worldRef: apply.worldRef,
    transactionId: apply.transactionId, analysis: response.result,
    analysisDigest, analysisRevision: '1', decision: 'BLOCK_AND_NOTIFY',
    expectedDecisionRevision: null });
  assert.equal(blocked.error, null);
  assert.deepEqual(events.map(event => event.event),
    ['AffectedObjectAnalysisReady', 'AffectedObjectNotificationRequired']);
  validateCanvasEvent('AffectedObjectNotificationRequired', events[1]);
  assert.deepEqual(otherEvents, []);
});

test('v3 world selection binds an Adapter 0.1.1 payload through the public v3 port', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-bind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const adapter = { async call(operation, body) {
    calls.push(operation);
    const descriptor = { adapterId: 'adapter', connectionRef: 'connection',
      worldRef: 'world', displayName: 'World', capabilityRevision: 'cap-1',
      payloadVersion: '0.1.1', readiness: 'READY' };
    const result = operation === 'ListWorlds' ? { capabilityRevision: 'cap-1',
      connections: [descriptor] } : { connectionRef: 'connection', worldRef: 'world',
      payloadVersion: '0.1.1', payloadDigest: 'a'.repeat(64),
      binding: { authorizerRef: 'owner', actorRef: 'actor', bindingRef: 'binding',
        worldRef: 'world', grantEpoch: 'epoch', allowedActions: ['READ'] },
      capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1',
        worldRef: 'world', engineBounds: null, limits: [],
        recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile: null,
        regionProtectionWriters: [], sessionDeleteSupported: false,
        imageMediaTypes: [], model: null } };
    return validateResponse('world-adapter/v3', operation, { contractVersion: 'world-adapter/v3',
      requestId: body.requestId, result, error: null });
  } };
  const service = new canvas.CanvasV3({ store: await canvas.CanvasStore.open(directory),
    adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation] };
    } } });
  const response = await service.call('SelectWorldConnection', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'bind-v3', authorizationRef: 'grant', worldRef: 'world',
    connectionRef: 'connection', expectedRevision: '0' });
  assert.equal(response.error, null);
  assert.equal(response.result.activeWorldRef, 'world');
  assert.deepEqual(calls, ['ListWorlds', 'AuthorizeBinding']);
});

test('v3 connection and world events follow durable changes and recheck the new world', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-world-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world-a',
      orderedSelectedObjectRefs: [], sessionRevision: 'session-1', selectionRevision: '0' };
    state.bindings.session = { adapterId: 'adapter', connectionRef: 'connection-a',
      worldRef: 'world-a', recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
  });
  const worlds = { 'connection-b': 'world-a', 'connection-c': 'world-b' };
  const adapter = { async call(operation, body) {
    const worldRef = worlds[body.connectionRef];
    const descriptor = { adapterId: 'adapter', connectionRef: body.connectionRef,
      worldRef, displayName: worldRef, capabilityRevision: 'cap-1',
      payloadVersion: '0.1.1', readiness: 'READY' };
    const result = operation === 'ListWorlds' ? { capabilityRevision: 'cap-1',
      connections: [descriptor] } : { connectionRef: body.connectionRef, worldRef,
      payloadVersion: '0.1.1', payloadDigest: 'a'.repeat(64),
      binding: { authorizerRef: 'owner', actorRef: 'actor',
        bindingRef: `binding-${worldRef}`, worldRef, grantEpoch: 'epoch',
        allowedActions: ['READ'] },
      capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1',
        worldRef, engineBounds: null, limits: [],
        recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile: null,
        regionProtectionWriters: [], sessionDeleteSupported: false,
        imageMediaTypes: [], model: null } };
    return validateResponse('world-adapter/v3', operation, {
      contractVersion: 'world-adapter/v3', requestId: body.requestId,
      result, error: null });
  } };
  const service = new canvas.CanvasV3({ store,
    adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        authorRef: 'engine-author' };
    } } });
  const events = [];
  await service.subscribeCanvasEvents({ actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'grant', worldRef: 'world-a' }, event => events.push(event));
  const otherEvents = [];
  await service.subscribeCanvasEvents({ actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'other-grant', worldRef: 'world-a' },
  event => otherEvents.push(event));
  const selected = await service.call('SelectWorldConnection', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'reselect-connection', authorizationRef: 'grant',
    worldRef: 'world-a', connectionRef: 'connection-b', expectedRevision: 'session-1' });
  assert.equal(selected.error, null);
  assert.deepEqual(events.map(event => event.event), ['WorldConnectionSelectionChanged']);
  validateCanvasEvent('WorldConnectionSelectionChanged', events[0]);
  const same = await service.call('SelectWorldConnection', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'same-connection', authorizationRef: 'grant',
    worldRef: 'world-a', connectionRef: 'connection-b',
    expectedRevision: selected.result.sessionRevision });
  assert.equal(same.error, null);
  assert.equal(events.length, 1);
  const switched = await service.call('SwitchWorldConnection', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'switch-world', authorizationRef: 'grant', worldRef: 'world-a',
    fromWorldRef: 'world-a', toConnectionRef: 'connection-c',
    toWorldRef: 'world-b', expectedRevision: same.result.sessionRevision });
  assert.equal(switched.error, null);
  assert.deepEqual(events.map(event => event.event),
    ['WorldConnectionSelectionChanged', 'ActiveWorldChanged']);
  validateCanvasEvent('ActiveWorldChanged', events[1]);
  const cleared = await service.call('SetObjectSelection', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'clear-in-new-world', authorizationRef: 'grant', worldRef: 'world-b',
    objectRefs: [], expectedSelectionRevision: switched.result.selectionRevision });
  assert.equal(cleared.error, null);
  assert.deepEqual(events.map(event => event.event),
    ['WorldConnectionSelectionChanged', 'ActiveWorldChanged',
      'ActiveObjectSelectionReplaced']);
  assert.deepEqual(otherEvents, []);
});

test('v3 changed authorized Adapter inventory emits only after a prior observed snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-inventory-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world',
      orderedSelectedObjectRefs: [], sessionRevision: '1', selectionRevision: '0' };
  });
  let capabilityRevision = 'cap-1';
  const adapter = { async call(operation, body) {
    assert.equal(operation, 'DiscoverConnections');
    const result = { capabilityRevision, connections: [{ adapterId: 'adapter',
      connectionRef: 'connection', worldRef: 'world', displayName: 'World',
      capabilityRevision, payloadVersion: '0.1.1', readiness: 'READY' }] };
    return validateResponse('world-adapter/v3', operation, {
      contractVersion: 'world-adapter/v3', requestId: body.requestId,
      result, error: null });
  } };
  const service = new canvas.CanvasV3({ store,
    adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        authorRef: 'engine-author' };
    } } });
  const events = [];
  await service.subscribeCanvasEvents({ actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'grant', worldRef: 'world' }, event => events.push(event));
  const otherEvents = [];
  await service.subscribeCanvasEvents({ actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'other-grant', worldRef: 'world' },
  event => otherEvents.push(event));
  const base = { contractVersion: 'canvas/v3', actorRef: 'actor',
    sessionRef: 'session', authorizationRef: 'grant', worldRef: 'world' };
  const first = await service.call('ListWorldConnections', { ...base,
    requestId: 'first-inventory', expectedCapabilityRevision: 'cap-1' });
  assert.equal(first.error, null);
  assert.deepEqual(events, []);
  capabilityRevision = 'cap-2';
  const stale = await service.call('ListWorldConnections', { ...base,
    requestId: 'stale-inventory', expectedCapabilityRevision: 'cap-1' });
  assert.equal(stale.error.code, 'STALE_REVISION');
  assert.deepEqual(events.map(event => event.event),
    ['WorldConnectionInventoryChanged']);
  validateCanvasEvent('WorldConnectionInventoryChanged', events[0]);
  assert.equal(events[0].receipt.result.capabilityRevision, 'cap-2');
  assert.deepEqual(otherEvents, []);
  const current = await service.call('ListWorldConnections', { ...base,
    requestId: 'current-inventory', expectedCapabilityRevision: 'cap-2' });
  assert.equal(current.error, null);
  assert.equal(events.length, 1);
});

test('v3 observed world revision invalidates a prior inspected snapshot once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-inspection-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const facts = eventOracle.cases.find(row =>
    row.id === 'EVENT-ObjectInspectionInvalidated-InspectObject-VALID').input.receipt.result;
  const store = await canvas.CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: facts.worldRef,
      orderedSelectedObjectRefs: [facts.objectRef], sessionRevision: '1',
      selectionRevision: '0' };
    state.bindings.session = { adapterId: 'adapter', worldRef: facts.worldRef,
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.objects[facts.worldRef] = { [facts.objectRef]: {
      worldRef: facts.worldRef, objectRef: facts.objectRef,
      objectRevision: facts.objectRevision, displayName: null,
      nameRevision: null, creationSequence: 1, status: 'READY' } };
  });
  let worldRevision = facts.worldRevision;
  let adapterCalls = 0;
  const service = new canvas.CanvasV3({ store,
    adapters: [{ adapterId: 'adapter', port: { async call(operation, body) {
      adapterCalls++;
      assert.equal(operation, 'InspectWorld');
      return validateResponse('world-adapter/v3', operation, {
        contractVersion: 'world-adapter/v3', requestId: body.requestId,
        result: facts, error: null });
    } } }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        authorRef: 'engine-author', currentWorldRevision: worldRevision };
    } } });
  const events = [];
  await service.subscribeCanvasEvents({ actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'grant', worldRef: facts.worldRef },
  event => events.push(event));
  const otherEvents = [];
  await service.subscribeCanvasEvents({ actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'other-grant', worldRef: facts.worldRef },
  event => otherEvents.push(event));
  const request = { contractVersion: 'canvas/v3', actorRef: 'actor',
    sessionRef: 'session', requestId: 'inspect-before-change',
    authorizationRef: 'grant', worldRef: facts.worldRef,
    objectRef: facts.objectRef, expectedRevision: facts.objectRevision,
    sampledBounds: facts.sampledBounds };
  const inspected = await service.call('InspectObject', request);
  assert.equal(inspected.error, null);
  assert.deepEqual(events, []);
  worldRevision = 'fixture-world-2';
  const observed = await service.call('ListObjects', {
    contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    requestId: 'observe-new-revision', authorizationRef: 'grant',
    worldRef: facts.worldRef, expectedRevision: '0' });
  assert.equal(observed.error, null);
  assert.deepEqual(events.map(event => event.event), ['ObjectInspectionInvalidated']);
  validateCanvasEvent('ObjectInspectionInvalidated', events[0]);
  assert.equal(events[0].newWorldRevision, worldRevision);
  assert.equal(events[0].receipt.result.worldRevision, facts.worldRevision);
  assert.deepEqual(otherEvents, []);
  const oldReplay = await service.call('InspectObject', request);
  assert.equal(oldReplay.error.code, 'STALE_REVISION');
  assert.equal(adapterCalls, 1);
  assert.equal(events.length, 1);
});

test('v3 Apply durably reserves its transaction before trusted Adapter Prepare', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-prepare-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const request = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  await store.commit(state => {
    state.sessions[request.sessionRef] = { currentSession: request.sessionRef,
      activeWorldRef: request.worldRef, orderedSelectedObjectRefs: ['fixture-object'],
      sessionRevision: '1', selectionRevision: 'fixture-selection-1' };
    state.bindings[request.sessionRef] = { adapterId: 'adapter', worldRef: request.worldRef,
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.objects[request.worldRef] = { 'fixture-object': { worldRef: request.worldRef,
      objectRef: 'fixture-object', objectRevision: 'fixture-object-1',
      displayName: 'Fixture', nameRevision: '1', creationSequence: 1, status: 'READY' } };
    state.analyses[request.worldRef] = { [request.transactionId]: {
      revision: '1', digest: request.analysisDigest,
      result: { contractVersion: 'canvas/v2', worldRef: request.worldRef,
        worldRevision: request.expectedWorldRevision, registryRevision: '0',
        selectionRevision: 'fixture-selection-1', operationDigest: request.operationDigest,
        orderedSelectedRefs: ['fixture-object'], affectedObjectRefs: ['fixture-object'] },
      positions: [[0, 0, 0]] } };
  });
  const observed = [];
  const adapter = { async call(operation, body) {
    observed.push({ operation, body, pending: store.snapshot.pending[request.transactionId] });
    return { contractVersion: 'world-adapter/v3', requestId: body.requestId,
      result: null, error: { code: 'CAPABILITY_UNAVAILABLE', phase: 'validate',
        retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE', transactionRef: null,
        causeCode: null, reason: 'POLICY_UNAVAILABLE' } };
  } };
  const service = new canvas.CanvasV3({ store, adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        currentWorldRevision: request.expectedWorldRevision, authorRef: 'engine-author',
        domainOwner: 'hanaworlds-canvas' };
    } } });
  const result = await service.call('ApplyRecoverableCommit', request);
  assert.equal(observed[0]?.operation, 'PrepareRecoverableTransaction');
  assert.equal(observed[0]?.pending?.status, 'RESERVED');
  assert.equal(observed[0]?.body?.transactionId, request.transactionId);
  assert.equal(result.error?.code, 'CAPABILITY_UNAVAILABLE');
  const reopened = await canvas.CanvasStore.open(directory);
  assert.equal(reopened.snapshot.pending[request.transactionId]?.status, 'RESERVED');
});

for (const [status, expectedOperation] of [
  ['PREPARED', 'QueryPreparedTransaction'],
  ['APPLYING', 'QueryTransaction'],
]) test(`v3 restart queries ${status} without a fresh world write`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-query-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const request = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  const identity = createHash('sha256').update(canonicalJSON(request)).digest('hex');
  await store.commit(state => {
    state.sessions[request.sessionRef] = { currentSession: request.sessionRef,
      activeWorldRef: request.worldRef, orderedSelectedObjectRefs: ['fixture-object'],
      sessionRevision: '1', selectionRevision: 'fixture-selection-1' };
    state.bindings[request.sessionRef] = { adapterId: 'adapter', worldRef: request.worldRef,
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.objects[request.worldRef] = { 'fixture-object': { worldRef: request.worldRef,
      objectRef: 'fixture-object', objectRevision: 'fixture-object-1',
      displayName: 'Fixture', nameRevision: '1', creationSequence: 1, status: 'READY' } };
    state.analyses[request.worldRef] = { [request.transactionId]: {
      revision: '1', digest: request.analysisDigest,
      result: { contractVersion: 'canvas/v2', worldRef: request.worldRef,
        worldRevision: request.expectedWorldRevision, registryRevision: '0',
        selectionRevision: 'fixture-selection-1', operationDigest: request.operationDigest,
        orderedSelectedRefs: ['fixture-object'], affectedObjectRefs: ['fixture-object'] },
      positions: [[0, 0, 0]] } };
    state.pending[request.transactionId] = { status,
      worldRef: request.worldRef, sessionRef: request.sessionRef,
      actorRef: request.actorRef, authorRef: 'engine-author',
      request, digest: identity, affectedObjectRefs: ['fixture-object'],
      positions: [[0, 0, 0]], preparedRequestId: `${request.requestId}:prepare`,
      prepared: { transactionPayloadDigest: 'c'.repeat(64) } };
  });
  const calls = [];
  let queryOutcome = 'UNKNOWN';
  const adapter = { async call(operation, body) {
    calls.push(operation);
    if (status === 'APPLYING' && queryOutcome === 'ROLLED_BACK') {
      const result = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
        operationDigest: request.operationDigest, transactionPayloadDigest: 'c'.repeat(64),
        status: 'ROLLED_BACK', previousWorldRevision: request.expectedWorldRevision,
        observedWorldRevision: 'restored-1', readbackDigest: 'd'.repeat(64),
        restoreStatus: 'VERIFIED_RESTORED', error: { code: 'READBACK_MISMATCH',
          phase: 'readback', retryability: 'NEVER', mutationState: 'ROLLED_BACK',
          transactionRef: request.transactionId, causeCode: null, reason: 'READBACK_ERROR' } };
      return validateResponse('world-adapter/v3', operation, {
        contractVersion: 'world-adapter/v3', requestId: body.requestId,
        result, error: null });
    }
    return { contractVersion: 'world-adapter/v3', requestId: body.requestId,
      result: null, error: status === 'PREPARED' ? {
        code: 'STALE_TRANSACTION', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
        mutationState: 'NONE', transactionRef: null, causeCode: null,
        reason: 'POLICY_UNAVAILABLE' } : {
        code: 'RECOVERY_PENDING', phase: 'apply', retryability: 'SAME_TRANSACTION_QUERY',
        mutationState: 'UNKNOWN', transactionRef: request.transactionId, causeCode: null,
        reason: 'TRANSPORT_OUTCOME_UNKNOWN' } };
  } };
  const service = new canvas.CanvasV3({ store: await canvas.CanvasStore.open(directory),
    adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        currentWorldRevision: request.expectedWorldRevision, authorRef: 'engine-author' };
    } } });
  await service.call('ApplyRecoverableCommit', request);
  assert.deepEqual(calls, [expectedOperation]);
  if (status === 'APPLYING') {
    queryOutcome = 'ROLLED_BACK';
    const result = await service.call('ApplyRecoverableCommit', request);
    assert.equal(result.error, null);
    assert.equal(result.result.status, 'ROLLED_BACK');
    assert.equal(service.store.snapshot.pending[request.transactionId].status, 'ROLLED_BACK');
    assert.deepEqual(service.store.snapshot.authorHistory[request.worldRef], undefined);
    assert.deepEqual(calls, ['QueryTransaction', 'QueryTransaction']);
  }
});

test('v3 object registration requires trusted Canvas provenance for the pinned ref', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-create-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const ref = 'object-generated-by-canvas';
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world',
      orderedSelectedObjectRefs: [], sessionRevision: '1', selectionRevision: '0' };
    state.transactions.world = { tx: { status: 'VERIFIED', worldRef: 'world',
      transactionId: 'tx', authorRef: 'engine-author', sessionRef: 'session',
      receiptDigest: 'a'.repeat(64), reservedObjectRef: ref, positions: [[0, 0, 0]] } };
  });
  let domainOwner;
  const service = new canvas.CanvasV3({ store, authority: { async verify(body, operation) {
    return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation],
      authorRef: 'engine-author', domainOwner };
  } } });
  const request = { contractVersion: 'canvas/v3', actorRef: 'actor',
    sessionRef: 'session', requestId: 'create-1', authorizationRef: 'grant',
    worldRef: 'world', objectRef: ref, transactionId: 'tx',
    verifiedReceiptDigest: 'a'.repeat(64), expectedRevision: '0' };
  const publicResult = await service.call('CreateObject', request);
  assert.equal(publicResult.error.code, 'PERMISSION_DENIED');
  assert.equal(publicResult.error.reason, 'OWNERSHIP_VIOLATION');
  assert.equal(store.snapshot.objects.world, undefined);
  domainOwner = 'hanaworlds-canvas';
  const wrong = await service.call('CreateObject', { ...request,
    requestId: 'create-wrong', objectRef: 'user-picked-ref' });
  assert.equal(wrong.error.code, 'OBJECT_SCOPE_MISMATCH');
  const created = await service.call('CreateObject', { ...request, requestId: 'create-trusted' });
  assert.equal(created.error, null);
  assert.equal(created.result.objectRef, ref);
  const reopened = await canvas.CanvasStore.open(directory);
  assert.equal(reopened.snapshot.objects.world[ref].objectRef, ref);
});

test('v3 Readback returns only the same verified authored transaction receipt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-readback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const base = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  const receipt = { contractVersion: 'canvas/v2', transactionId: base.transactionId,
    operationDigest: base.operationDigest, transactionPayloadDigest: 'c'.repeat(64),
    status: 'VERIFIED', previousWorldRevision: base.expectedWorldRevision,
    observedWorldRevision: 'world-after', readbackDigest: 'd'.repeat(64),
    restoreStatus: 'NOT_REQUIRED', error: null };
  await store.commit(state => {
    state.sessions[base.sessionRef] = { currentSession: base.sessionRef,
      activeWorldRef: base.worldRef, orderedSelectedObjectRefs: [],
      sessionRevision: '1', selectionRevision: '0' };
    state.bindings[base.sessionRef] = { adapterId: 'adapter', worldRef: base.worldRef,
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.transactions[base.worldRef] = { [base.transactionId]: {
      status: 'VERIFIED', authorRef: 'engine-author', sessionRef: base.sessionRef,
      operationDigest: base.operationDigest, transactionPayloadDigest: 'c'.repeat(64),
      receipt } };
  });
  const service = new canvas.CanvasV3({ store,
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        authorRef: 'engine-author' };
    } } });
  const request = { contractVersion: 'canvas/v3', actorRef: base.actorRef,
    sessionRef: base.sessionRef, requestId: 'readback-1',
    authorizationRef: base.authorizationRef, worldRef: base.worldRef,
    transactionId: base.transactionId, commitRevision: 'world-after',
    expectedOperations: base.operations, transactionPayloadDigest: 'c'.repeat(64) };
  const response = await service.call('Readback', request);
  assert.equal(response.error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result)), receipt);
  const mismatched = await service.call('Readback', { ...request,
    requestId: 'readback-wrong', transactionPayloadDigest: 'e'.repeat(64) });
  assert.equal(mismatched.error.code, 'REPLAY_MISMATCH');
});

test('v3 HistoryQuery exposes only the current trusted author linked entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-author-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const entry = { transactionId: 'tx-author-a', originTransactionId: null,
    affectedObjectRefs: ['object'], operationDigest: 'a'.repeat(64),
    beforeImageDigest: 'b'.repeat(64), expectedAfterReadbackDigest: 'c'.repeat(64),
    receiptDigest: 'd'.repeat(64), historyRevision: 'rev-A', status: 'VERIFIED' };
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world',
      orderedSelectedObjectRefs: [], sessionRevision: '1', selectionRevision: '0' };
    state.objects.world = { object: { worldRef: 'world', objectRef: 'object',
      objectRevision: '1', displayName: 'House', nameRevision: '1',
      creationSequence: 1, status: 'READY' } };
    state.authorHistory = { world: { object: { 'author-a': {
      historyRevision: 'rev-A', headTransactionId: 'tx-author-a',
      entries: [entry], undoAvailable: true, redoAvailable: false } } } };
  });
  let authorRef = 'author-a';
  const service = new canvas.CanvasV3({ store, authority: { async verify(body, operation) {
    return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, allowedActions: [operation], authorRef };
  } } });
  const base = { contractVersion: 'canvas/v3', actorRef: 'actor', sessionRef: 'session',
    authorizationRef: 'grant', worldRef: 'world', objectRef: 'object' };
  const own = await service.call('HistoryQuery', { ...base, requestId: 'history-a',
    expectedHistoryRevision: 'rev-A' });
  assert.equal(own.error, null);
  assert.equal(own.result.entries.length, 1);
  authorRef = 'author-b';
  const crossedReplay = await service.call('HistoryQuery', { ...base, requestId: 'history-a',
    expectedHistoryRevision: 'rev-A' });
  assert.equal(crossedReplay.error.code, 'PERMISSION_DENIED');
  assert.equal(crossedReplay.error.reason, 'OWNERSHIP_VIOLATION');
  const other = await service.call('HistoryQuery', { ...base, requestId: 'history-b',
    expectedHistoryRevision: '0' });
  assert.equal(other.error, null);
  assert.deepEqual(other.result.entries, []);
});

test('v3 Undo refuses another author origin before Adapter prepare', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-undo-author-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions.session = { currentSession: 'session', activeWorldRef: 'world',
      orderedSelectedObjectRefs: ['object'], sessionRevision: '1', selectionRevision: '1' };
    state.bindings.session = { adapterId: 'adapter', worldRef: 'world',
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.objects.world = { object: { worldRef: 'world', objectRef: 'object',
      objectRevision: 'object-1', displayName: 'House', nameRevision: '1',
      creationSequence: 1, status: 'READY' } };
    state.transactions.world = { 'other-tx': { status: 'VERIFIED', worldRef: 'world',
      transactionId: 'other-tx', authorRef: 'other-author', sessionRef: 'session' } };
  });
  const calls = [];
  const service = new canvas.CanvasV3({ store,
    adapters: [{ adapterId: 'adapter', port: { async call(operation) { calls.push(operation); } } }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        currentWorldRevision: 'world-1', authorRef: 'current-author' };
    } } });
  const result = await service.call('Undo', { contractVersion: 'canvas/v3',
    actorRef: 'actor', sessionRef: 'session', requestId: 'undo-other',
    authorizationRef: 'grant', worldRef: 'world', objectRef: 'object',
    transactionId: 'new-undo', historyTransactionId: 'other-tx',
    expectedHistoryRevision: '0', expectedWorldRevision: 'world-1',
    expectedObjectRevisions: { object: 'object-1' },
    intentDigest: 'a'.repeat(64), surfaceActionDigest: 'b'.repeat(64) });
  assert.equal(result.error.code, 'PERMISSION_DENIED');
  assert.equal(result.error.reason, 'OWNERSHIP_VIOLATION');
  assert.deepEqual(calls, []);
});

test('v3 same transaction restart completes pending linked history without another world write', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-history-recover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const request = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  const identity = createHash('sha256').update(canonicalJSON(request)).digest('hex');
  const prepared = { beforeImageDigest: 'b'.repeat(64),
    transactionPayloadDigest: 'c'.repeat(64) };
  const receipt = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
    operationDigest: request.operationDigest, transactionPayloadDigest: 'c'.repeat(64),
    status: 'VERIFIED', previousWorldRevision: request.expectedWorldRevision,
    observedWorldRevision: 'world-after', readbackDigest: 'd'.repeat(64),
    restoreStatus: 'NOT_REQUIRED', error: null };
  await store.commit(state => {
    state.sessions[request.sessionRef] = { currentSession: request.sessionRef,
      activeWorldRef: request.worldRef, orderedSelectedObjectRefs: ['fixture-object'],
      sessionRevision: '1', selectionRevision: 'fixture-selection-1' };
    state.bindings[request.sessionRef] = { adapterId: 'adapter', worldRef: request.worldRef,
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.objects[request.worldRef] = { 'fixture-object': { worldRef: request.worldRef,
      objectRef: 'fixture-object', objectRevision: 'fixture-object-1',
      displayName: 'Fixture', nameRevision: '1', creationSequence: 1, status: 'READY' } };
    state.analyses[request.worldRef] = { [request.transactionId]: {
      revision: '1', digest: request.analysisDigest,
      result: { contractVersion: 'canvas/v2', worldRef: request.worldRef,
        worldRevision: request.expectedWorldRevision, registryRevision: '0',
        selectionRevision: 'fixture-selection-1', operationDigest: request.operationDigest,
        orderedSelectedRefs: ['fixture-object'], affectedObjectRefs: ['fixture-object'] },
      positions: [[0, 0, 0]] } };
    state.pending[request.transactionId] = { status: 'VERIFIED_PENDING_HISTORY',
      worldRef: request.worldRef, sessionRef: request.sessionRef,
      actorRef: request.actorRef, authorRef: 'engine-author',
      request, digest: identity, affectedObjectRefs: ['fixture-object'],
      positions: [[0, 0, 0]], prepared, receipt,
      receiptDigest: digestValue('receipt', receipt).sha256 };
  });
  const calls = [];
  const faultedStore = await canvas.CanvasStore.open(directory);
  faultedStore.commit = async () => { throw new Error('storage unavailable after readback'); };
  const faulted = new canvas.CanvasV3({ store: faultedStore,
    adapters: [{ adapterId: 'adapter', port: { async call(op) { calls.push(op); } } }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        currentWorldRevision: request.expectedWorldRevision, authorRef: 'engine-author' };
    } } });
  const failed = await faulted.call('ApplyRecoverableCommit', request);
  assert.equal(failed.error.code, 'RECOVERY_PENDING');
  assert.equal(failed.error.mutationState, 'UNKNOWN');
  const service = new canvas.CanvasV3({ store: await canvas.CanvasStore.open(directory),
    adapters: [{ adapterId: 'adapter', port: { async call(op) { calls.push(op); } } }],
    authority: { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        currentWorldRevision: request.expectedWorldRevision, authorRef: 'engine-author' };
    } } });
  const response = await service.call('ApplyRecoverableCommit', request);
  assert.equal(response.error, null);
  assert.equal(response.result.status, 'VERIFIED');
  assert.deepEqual(calls, []);
  const reopened = await canvas.CanvasStore.open(directory);
  assert.equal(reopened.snapshot.authorHistory[request.worldRef]['fixture-object']['engine-author'].entries.length, 1);
});

test('v3 Apply resumes an uncertain write by query and readback without writing twice', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-apply-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const request = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  await store.commit(state => {
    state.sessions[request.sessionRef] = { currentSession: request.sessionRef,
      activeWorldRef: request.worldRef, orderedSelectedObjectRefs: ['fixture-object'],
      sessionRevision: '1', selectionRevision: 'fixture-selection-1' };
    state.bindings[request.sessionRef] = { adapterId: 'adapter', worldRef: request.worldRef,
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.objects[request.worldRef] = { 'fixture-object': { worldRef: request.worldRef,
      objectRef: 'fixture-object', objectRevision: 'fixture-object-1',
      displayName: 'Fixture', nameRevision: '1', creationSequence: 1, status: 'READY' } };
    state.analyses[request.worldRef] = { [request.transactionId]: {
      revision: '1', digest: request.analysisDigest,
      result: { contractVersion: 'canvas/v2', worldRef: request.worldRef,
        worldRevision: request.expectedWorldRevision, registryRevision: '0',
        selectionRevision: 'fixture-selection-1', operationDigest: request.operationDigest,
        orderedSelectedRefs: ['fixture-object'], affectedObjectRefs: ['fixture-object'] },
      positions: [[0, 0, 0]] } };
  });
  const stateProfile = { profileVersion: 'state-profile/v2',
    nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
    inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
  const payload = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
    operationDigest: request.operationDigest,
    authorizationBindingDigest: request.authorizationBindingDigest,
    expectedWorldRevision: request.expectedWorldRevision,
    expectedObjectRevisions: request.expectedObjectRevisions, beforeImageDigest: 'b'.repeat(64) };
  const transactionPayloadDigest = digestValue('transaction-payload', payload).sha256;
  const prepared = { payload, transactionPayloadDigest, beforeImageDigest: 'b'.repeat(64),
    guarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    protectedPositions: [[0, 0, 0]], adapterExecutionRevision: 'execution-1' };
  const pendingReceipt = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
    operationDigest: request.operationDigest, transactionPayloadDigest,
    status: 'APPLIED_PENDING_READBACK', previousWorldRevision: request.expectedWorldRevision,
    observedWorldRevision: null, readbackDigest: null, restoreStatus: 'NOT_REQUIRED', error: null };
  const projection = { worldRef: request.worldRef, coveredPositions: [[0, 0, 0]],
    records: [{ position: [0, 0, 0], nodeName: 'fixture:stone', param1: 0,
      param2: 0, metadata: {}, inventory: {}, timer: null }], stateProfile };
  const readbackDigest = digestValue('readback', projection).sha256;
  const operations = [];
  const adapter = { async call(operation, body) {
    operations.push(operation);
    if (operation === 'ApplyCompiledTransaction') throw new Error('transport lost after write');
    const result = operation === 'PrepareRecoverableTransaction' ? prepared :
      operation === 'QueryTransaction' ? pendingReceipt :
      operation === 'Readback' ? { projection, readbackDigest,
        adapterExecutionRevision: 'execution-1' } : null;
    return validateResponse('world-adapter/v3', operation, { contractVersion: 'world-adapter/v3',
      requestId: body.requestId, result, error: null });
  } };
  const authority = { async verify(body, operation) {
      return { current: true, actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        currentWorldRevision: request.expectedWorldRevision, authorRef: 'engine-author' };
    } };
  const service = new canvas.CanvasV3({ store, adapters: [{ adapterId: 'adapter', port: adapter }],
    authority });
  const first = await service.call('ApplyRecoverableCommit', request);
  assert.equal(first.error.code, 'RECOVERY_PENDING');
  assert.equal(first.error.mutationState, 'UNKNOWN');
  assert.equal(store.snapshot.pending[request.transactionId].status, 'RECOVERY_PENDING');
  const reopened = await canvas.CanvasStore.open(directory);
  const restarted = new canvas.CanvasV3({ store: reopened,
    adapters: [{ adapterId: 'adapter', port: adapter }], authority });
  const response = await restarted.call('ApplyRecoverableCommit', request);
  assert.equal(response.error, null);
  assert.equal(response.result.status, 'VERIFIED');
  assert.deepEqual(operations, ['PrepareRecoverableTransaction', 'ApplyCompiledTransaction',
    'QueryTransaction', 'Readback']);
  assert.equal(reopened.snapshot.transactions[request.worldRef][request.transactionId].status, 'VERIFIED');
  assert.equal(reopened.snapshot.authorHistory[request.worldRef]['fixture-object']['engine-author'].entries.length, 1);
  assert.notEqual(reopened.snapshot.objects[request.worldRef]['fixture-object'].objectRevision, 'NaN');
});

test('v3 creating Apply generates one stable object ref and registers its history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-v3-new-object-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await canvas.CanvasStore.open(directory);
  const base = oracle.cases.find(row => row.id === 'B-VALID-CANVAS-PREPARE').request;
  const analysis = { contractVersion: 'canvas/v2', worldRef: base.worldRef,
    worldRevision: base.expectedWorldRevision, registryRevision: '0',
    selectionRevision: '0', operationDigest: base.operationDigest,
    orderedSelectedRefs: [], affectedObjectRefs: [] };
  const analysisDigest = digestValue('affected-analysis', analysis).sha256;
  const authorizationBinding = { ...base.authorizationBinding,
    selectionRevision: '0', analysisDigest };
  const request = { ...base, requestId: 'create-apply',
    transactionId: 'create-transaction', analysisDigest,
    authorizationBinding: { ...authorizationBinding, transactionId: 'create-transaction' },
    expectedObjectRevisions: {} };
  request.authorizationBindingDigest = digestValue('authorization-binding',
    request.authorizationBinding).sha256;
  await store.commit(state => {
    state.sessions[request.sessionRef] = { currentSession: request.sessionRef,
      activeWorldRef: request.worldRef, orderedSelectedObjectRefs: [],
      sessionRevision: '1', selectionRevision: '0' };
    state.bindings[request.sessionRef] = { adapterId: 'adapter', worldRef: request.worldRef,
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.analyses[request.worldRef] = { [request.transactionId]: {
      revision: '1', digest: analysisDigest, result: analysis, positions: [[0, 0, 0]] } };
  });
  const stateProfile = { profileVersion: 'state-profile/v2',
    nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
    inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
  const payload = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
    operationDigest: request.operationDigest,
    authorizationBindingDigest: request.authorizationBindingDigest,
    expectedWorldRevision: request.expectedWorldRevision,
    expectedObjectRevisions: {}, beforeImageDigest: 'b'.repeat(64) };
  const transactionPayloadDigest = digestValue('transaction-payload', payload).sha256;
  const prepared = { payload, transactionPayloadDigest, beforeImageDigest: 'b'.repeat(64),
    guarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    protectedPositions: [[0, 0, 0]], adapterExecutionRevision: 'execution-1' };
  const pendingReceipt = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
    operationDigest: request.operationDigest, transactionPayloadDigest,
    status: 'APPLIED_PENDING_READBACK', previousWorldRevision: request.expectedWorldRevision,
    observedWorldRevision: null, readbackDigest: null, restoreStatus: 'NOT_REQUIRED', error: null };
  const projection = { worldRef: request.worldRef, coveredPositions: [[0, 0, 0]],
    records: [{ position: [0, 0, 0], nodeName: 'fixture:stone', param1: 0,
      param2: 0, metadata: {}, inventory: {}, timer: null }], stateProfile };
  const readbackDigest = digestValue('readback', projection).sha256;
  const misplaced = { ...projection,
    records: [{ ...projection.records[0], position: [1, 0, 0] }] };
  let readbackCalls = 0;
  const adapter = { async call(operation, body) {
    if (operation === 'Readback') readbackCalls++;
    const result = operation === 'PrepareRecoverableTransaction' ? prepared :
      operation === 'ApplyCompiledTransaction' ? pendingReceipt :
      operation === 'QueryTransaction' ? pendingReceipt :
      operation === 'Readback' ? { projection: readbackCalls === 1 ? misplaced : projection,
        readbackDigest: readbackCalls === 1 ? digestValue('readback', misplaced).sha256 : readbackDigest,
        adapterExecutionRevision: 'execution-1' } : null;
    return validateResponse('world-adapter/v3', operation, { contractVersion: 'world-adapter/v3',
      requestId: body.requestId, result, error: null });
  } };
  let revokeSubscription = false;
  const service = new canvas.CanvasV3({ store, adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(body, operation) {
      return { current: !(operation === 'ListObjects' &&
          body.authorizationRef === 'revoked-grant' && revokeSubscription),
        actorRef: body.actorRef, sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef, allowedActions: [operation],
        currentWorldRevision: request.expectedWorldRevision,
        authorRef: body.authorizationRef === 'other-grant' ? 'other-author' : 'engine-author',
        domainOwner: 'hanaworlds-canvas' };
    } } });
  const ownEvents = [];
  const otherEvents = [];
  const revokedEvents = [];
  const subscription = { actorRef: request.actorRef, sessionRef: request.sessionRef,
    authorizationRef: request.authorizationRef, worldRef: request.worldRef };
  const unsubscribe = await service.subscribeCanvasEvents(subscription,
    event => ownEvents.push(event));
  await service.subscribeCanvasEvents({ ...subscription, authorizationRef: 'other-grant' },
    event => otherEvents.push(event));
  await service.subscribeCanvasEvents({ ...subscription, authorizationRef: 'revoked-grant' },
    event => revokedEvents.push(event));
  revokeSubscription = true;
  const failed = await service.call('ApplyRecoverableCommit', request);
  assert.equal(failed.error.code, 'RECOVERY_PENDING');
  assert.equal(store.snapshot.objects[request.worldRef], undefined);
  assert.deepEqual(ownEvents.map(event => event.event),
    ['TransactionAppliedPendingReadback']);
  validateCanvasEvent('TransactionAppliedPendingReadback', ownEvents[0]);
  const response = await service.call('ApplyRecoverableCommit', request);
  assert.equal(response.error, null);
  assert.equal(response.result.status, 'VERIFIED');
  const reopened = await canvas.CanvasStore.open(directory);
  const tx = reopened.snapshot.transactions[request.worldRef][request.transactionId];
  assert.match(tx.reservedObjectRef, /^[0-9a-f-]{36}$/);
  assert.equal(reopened.snapshot.objects[request.worldRef][tx.reservedObjectRef].objectRef,
    tx.reservedObjectRef);
  assert.equal(reopened.snapshot.authorHistory[request.worldRef][tx.reservedObjectRef]['engine-author'].entries.length, 1);
  assert.deepEqual(ownEvents.map(event => event.event),
    ['TransactionAppliedPendingReadback', 'TransactionAppliedPendingReadback',
      'ObjectCreated', 'ObjectInventoryChanged', 'TransactionVerified',
      'HistoryInventoryChanged']);
  validateCanvasEvent('ObjectCreated', ownEvents[2]);
  validateCanvasEvent('ObjectInventoryChanged', ownEvents[3]);
  validateCanvasEvent('TransactionVerified', ownEvents[4]);
  validateCanvasEvent('HistoryInventoryChanged', ownEvents[5]);
  assert.equal(ownEvents[2].receipt.result.objectRef, tx.reservedObjectRef);
  assert.equal(ownEvents[3].receipt.result.objects[0].objectRef, tx.reservedObjectRef);
  assert.equal(ownEvents[3].receipt.result.registryRevision,
    reopened.snapshot.registryRevisions[request.worldRef]);
  assert.deepEqual(otherEvents.map(event => event.event), ['ObjectInventoryChanged']);
  validateCanvasEvent('ObjectInventoryChanged', otherEvents[0]);
  assert.deepEqual(revokedEvents, []);
  await service.call('ApplyRecoverableCommit', request);
  assert.equal(ownEvents.length, 6);
  assert.equal(otherEvents.length, 1);
  unsubscribe();
  const created = await service.call('CreateObject', { contractVersion: 'canvas/v3',
    actorRef: request.actorRef, sessionRef: request.sessionRef,
    requestId: 'create-object-receipt', authorizationRef: request.authorizationRef,
    worldRef: request.worldRef, objectRef: tx.reservedObjectRef,
    transactionId: request.transactionId, verifiedReceiptDigest: tx.receiptDigest,
    expectedRevision: reopened.snapshot.registryRevisions[request.worldRef] });
  assert.equal(created.error, null);
  assert.equal(created.result.objectRef, tx.reservedObjectRef);
});
