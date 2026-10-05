import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CanvasStore, CanvasV4 } from '../src/index.mjs';

const root = join(homedir(), '.cache', 'hanaworlds-runs', 'S1-CANVAS-WORLD-CONTEXT-01');
const readRequest = (overrides = {}) => ({ contractVersion: 'canvas/v4',
  actorRef: 'actor', sessionRef: 'session', requestId: 'read-context',
  authorizationRef: 'grant', worldRef: 'world', ...overrides });

async function fixture(t) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  let current = true;
  let incarnation = 'incarnation-1';
  let invocationStatus = 'ACTIVE';
  let grant = 'native-grant-1';
  let proofWorld = null;
  let capabilityRevision = 'capability-1';
  let onDiscovery = () => {};
  const calls = [];
  const authority = { async verify(request, operation) {
    return { current, actorRef: request.actorRef,
      sessionRef: request.sessionRef, authorizationRef: request.authorizationRef,
      worldRef: proofWorld ?? request.worldRef, allowedActions: [operation],
      sessionIncarnationRef: incarnation, nativeGrantRef: grant,
      invocationRef: 'invocation-1', invocationStatus,
      grantStatus: current ? 'CURRENT' : 'REVOKED',
      currentWorldRevision: 'world-revision-1' };
  } };
  const adapter = { contractHandshake: null, async call(operation, request) {
    calls.push({ operation, request });
    const descriptors = [
      { adapterId: 'adapter', connectionRef: 'connection', worldRef: 'world',
        displayName: 'World', capabilityRevision,
        payloadVersion: '0.2.0', readiness: 'READY' },
      { adapterId: 'adapter', connectionRef: 'connection-2', worldRef: 'world-2',
        displayName: 'World 2', capabilityRevision,
        payloadVersion: '0.2.0', readiness: 'READY' },
    ];
    if (operation === 'DiscoverConnections') await onDiscovery();
    if (operation === 'ListWorlds' || operation === 'DiscoverConnections')
      return { contractVersion: 'world-adapter/v4', requestId: request.requestId,
        result: { capabilityRevision, connections:
          operation === 'ListWorlds' ? descriptors.filter(row =>
            row.connectionRef === request.connectionRef) : descriptors }, error: null };
    if (operation === 'AuthorizeBinding')
      return { contractVersion: 'world-adapter/v4', requestId: request.requestId,
        result: { connectionRef: request.connectionRef, worldRef: request.worldRef,
          payloadVersion: '0.2.0', payloadDigest: 'a'.repeat(64),
          binding: { authorizerRef: 'owner', actorRef: 'actor',
            bindingRef: 'binding', worldRef: request.worldRef,
            grantEpoch: 'epoch', allowedActions: ['READ'] },
          capabilities: { providerRef: 'adapter', capabilityRevision,
            worldRef: request.worldRef, engineBounds: null, limits: [],
            recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile: null,
            regionProtectionWriters: [], sessionDeleteSupported: false,
            imageMediaTypes: [], model: null } }, error: null };
    throw new Error(`unexpected ${operation}`);
  } };
  let canvas = new CanvasV4({ store, adapters: [{ adapterId: 'adapter', port: adapter }],
    authority });
  adapter.contractHandshake = canvas.contractHandshake;
  return { get canvas() { return canvas; }, store, directory, calls,
    async reopen() { canvas = new CanvasV4({ store: await CanvasStore.open(directory),
      adapters: [{ adapterId: 'adapter', port: adapter }], authority }); return canvas; },
    revoke() { current = false; }, replaceSession() { incarnation = 'incarnation-2'; },
    cancel() { invocationStatus = 'CANCELLED'; },
    replaceGrant() { grant = 'native-grant-2'; },
    clearIncarnation() { incarnation = null; },
    wrongWorld() { proofWorld = 'unrelated-world'; },
    setCapability(value) { capabilityRevision = value; },
    onDiscovery(callback) { onDiscovery = callback; } };
}

const selectRequest = (revision, overrides = {}) => ({ contractVersion: 'canvas/v4',
  actorRef: 'actor', sessionRef: 'session', requestId: 'select-world',
  authorizationRef: 'grant', worldRef: 'world', connectionRef: 'connection',
  expectedRevision: revision, ...overrides });

const switchRequest = (revision, overrides = {}) => ({ contractVersion: 'canvas/v4',
  actorRef: 'actor', sessionRef: 'session', requestId: 'switch-world',
  authorizationRef: 'grant', worldRef: 'world', fromWorldRef: 'world',
  toWorldRef: 'world-2', toConnectionRef: 'connection-2',
  expectedRevision: revision, ...overrides });

test('current context reads confirmed unbound Canvas CAS without changing binding', async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.store.snapshot);
  const result = await f.canvas.call('ReadWorldSelectionContext', readRequest());
  assert.equal(result.error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.selection)),
    { status: 'UNBOUND', sessionRef: 'session', sessionRevision: '0' });
  assert.equal(result.result.inventory.capabilityRevision, 'capability-1');
  assert.deepEqual(result.result.inventory.connections.map(row => row.connectionRef),
    ['connection']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.store.snapshot.sessions)),
    JSON.parse(before).sessions);
  assert.deepEqual(JSON.parse(JSON.stringify(f.store.snapshot.bindings)),
    JSON.parse(before).bindings);
});

test('public selection, lost receipt, restart, same-world and cross-world switch read current facts', async t => {
  const f = await fixture(t);
  const request = readRequest();
  const first = await f.canvas.call('ReadWorldSelectionContext', request);
  const selected = await f.canvas.call('SelectWorldConnection',
    selectRequest(first.result.selection.sessionRevision));
  assert.equal(selected.error, null);
  const current = await f.canvas.call('ReadWorldSelectionContext', request);
  assert.equal(current.error, null);
  assert.equal(current.result.selection.status, 'BOUND');
  assert.equal(current.result.selection.context.activeWorldRef, 'world');
  assert.equal(current.result.selection.context.sessionRevision,
    selected.result.sessionRevision);
  assert.equal(current.result.selection.connectionRef, 'connection');
  const restarted = await f.reopen();
  const afterRestart = await restarted.call('ReadWorldSelectionContext', request);
  assert.equal(afterRestart.result.selection.context.sessionRevision,
    selected.result.sessionRevision);
  const same = await restarted.call('SwitchWorldConnection', switchRequest(
    selected.result.sessionRevision, { requestId: 'same-world',
      toWorldRef: 'world', toConnectionRef: 'connection' }));
  assert.equal(same.error, null);
  assert.equal(same.result.activeWorldRef, 'world');
  assert.equal((await restarted.call('SwitchWorldConnection', switchRequest(
    selected.result.sessionRevision, { requestId: 'stale-switch' }))).error.code,
  'STALE_REVISION');
  const switched = await restarted.call('SwitchWorldConnection',
    switchRequest(same.result.sessionRevision));
  assert.equal(switched.error, null);
  const target = await restarted.call('ReadWorldSelectionContext',
    readRequest({ requestId: 'target-read', worldRef: 'world-2' }));
  assert.equal(target.error, null);
  assert.equal(target.result.selection.context.activeWorldRef, 'world-2');
  assert.equal(target.result.selection.context.sessionRevision,
    switched.result.sessionRevision);
  assert.deepEqual(target.result.inventory.connections.map(row => row.connectionRef),
    ['connection-2']);
  const objects = await restarted.call('ListObjects', { ...readRequest({
    requestId: 'target-objects', worldRef: 'world-2' }), expectedRevision: null });
  assert.equal(objects.error, null);
  assert.deepEqual(objects.result.objects, []);
  assert.equal((await restarted.call('SwitchWorldConnection', switchRequest(
    selected.result.sessionRevision, { requestId: 'wrong-old-world' }))).error.code,
  'WORLD_NOT_BOUND');
});

test('read rejects changed request reuse, unavailable storage and corrupt binding facts', async t => {
  const f = await fixture(t);
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest())).error, null);
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest({
    worldRef: 'world-2' }))).error.code, 'REPLAY_MISMATCH');
  f.store.unavailable = true;
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest({
    requestId: 'storage-unavailable' }))).error.code, 'CAPABILITY_UNAVAILABLE');
  f.store.unavailable = false;
  const selected = await f.canvas.call('SelectWorldConnection', selectRequest('0'));
  assert.equal(selected.error, null);
  await f.store.commit(state => { delete state.bindings.session.connectionRef; });
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest({
    requestId: 'corrupt-binding' }))).error.code, 'CAPABILITY_UNAVAILABLE');
});

test('revocation, cancellation, session replacement and late grant change fail closed', async t => {
  const f = await fixture(t);
  f.revoke();
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest())).error.code,
    'AUTHORIZATION_REVOKED');
});

test('late Session incarnation change is rejected after Adapter discovery', async t => {
  const f = await fixture(t);
  f.onDiscovery(() => f.replaceSession());
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest())).error.code,
    'PERMISSION_DENIED');
});

test('cancelled invocation is rejected before Adapter discovery', async t => {
  const f = await fixture(t);
  f.cancel();
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest())).error.code,
    'PERMISSION_DENIED');
  assert.equal(f.calls.length, 0);
});

test('late original grant replacement is rejected after Adapter discovery', async t => {
  const f = await fixture(t);
  f.onDiscovery(() => f.replaceGrant());
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest())).error.code,
    'AUTHORIZATION_REVOKED');
});

test('changing Adapter capability during discovery refuses an incoherent read', async t => {
  const f = await fixture(t);
  let reads = 0;
  f.onDiscovery(() => { if (++reads === 2) f.setCapability('capability-2'); });
  assert.equal((await f.canvas.call('ReadWorldSelectionContext', readRequest())).error.code,
    'CAPABILITY_UNAVAILABLE');
});

test('missing live Session and wrong-world proof are rejected before discovery', async t => {
  const missing = await fixture(t);
  missing.clearIncarnation();
  assert.equal((await missing.canvas.call('ReadWorldSelectionContext',
    readRequest())).error.code, 'SESSION_NOT_FOUND');
  assert.equal(missing.calls.length, 0);
  const wrong = await fixture(t);
  wrong.wrongWorld();
  assert.equal((await wrong.canvas.call('ReadWorldSelectionContext',
    readRequest())).error.code, 'PERMISSION_DENIED');
  assert.equal(wrong.calls.length, 0);
});

test('concurrent Canvas state replacement during discovery refuses stale context', async t => {
  const f = await fixture(t);
  let changed = false;
  f.onDiscovery(async () => {
    if (changed) return;
    changed = true;
    await f.store.commit(state => { state.registryRevisions.world = 'new-registry'; });
  });
  assert.equal((await f.canvas.call('ReadWorldSelectionContext',
    readRequest())).error.code, 'CAPABILITY_UNAVAILABLE');
});
