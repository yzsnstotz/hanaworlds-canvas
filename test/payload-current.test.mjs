import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contractHandshake } from 'hanaworlds-contracts/v4';
import { CanvasStore, CanvasV4 } from '../src/index.mjs';

const root = join(homedir(), '.cache', 'hanaworlds-runs',
  'S1-CANVAS-WORLD-CONTEXT-01', 'payload-current-20261006');
const request = { contractVersion: 'canvas/v4', actorRef: 'actor',
  sessionRef: 'session', requestId: 'bind-current', authorizationRef: 'grant',
  worldRef: 'world', connectionRef: 'connection', expectedRevision: '0' };

async function fixture(t, { descriptorVersion = '0.2.7',
  receiptVersion = '0.2.7', readiness = 'CONNECTION_UNAUTHORIZED',
  payloadDigest = 'fdf68248d774ba06a649aa50e4ead8c69290cee6ea99bf06fd549a35a832276f',
  recoveryGuarantee = 'RECOVERABLE_VERIFIED', capabilityRevision = 'capability-1',
  receiptCapabilityRevision = capabilityRevision, adapterDenied = false,
  adapterPayloadMismatch = false,
  hostCurrent = true } = {}) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  const calls = [];
  const adapter = { contractHandshake, async call(operation, body) {
    calls.push(operation);
    const descriptor = { adapterId: 'adapter', connectionRef: 'connection',
      worldRef: 'world', displayName: 'World', capabilityRevision,
      payloadVersion: descriptorVersion, readiness };
    if (operation === 'ListWorlds' || operation === 'DiscoverConnections')
      return { contractVersion: 'world-adapter/v4', requestId: body.requestId,
        result: { capabilityRevision, connections: [descriptor] }, error: null };
    assert.equal(operation, 'AuthorizeBinding');
    if (adapterPayloadMismatch) return { contractVersion: 'world-adapter/v4',
      requestId: body.requestId, result: null,
      error: { code: 'PAYLOAD_VERSION_MISMATCH', phase: 'validate',
        retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE',
        transactionRef: null, causeCode: null, reason: 'POLICY_UNAVAILABLE' } };
    if (adapterDenied) return { contractVersion: 'world-adapter/v4',
      requestId: body.requestId, result: null,
      error: { code: 'CONNECTION_UNAUTHORIZED', phase: 'authorize',
        retryability: 'AFTER_NEW_AUTH', mutationState: 'NONE',
        transactionRef: null, causeCode: null, reason: 'SCOPE_DENIED' } };
    return { contractVersion: 'world-adapter/v4', requestId: body.requestId,
      result: { connectionRef: 'connection', worldRef: 'world',
        payloadVersion: receiptVersion, payloadDigest,
        binding: { authorizerRef: 'owner', actorRef: 'actor',
          bindingRef: 'binding', worldRef: 'world', grantEpoch: 'epoch',
          allowedActions: ['READ'] },
        capabilities: { providerRef: 'adapter', capabilityRevision: receiptCapabilityRevision,
          worldRef: 'world', engineBounds: null, limits: [], recoveryGuarantee,
          stateProfile: null, regionProtectionWriters: [],
          sessionDeleteSupported: false, imageMediaTypes: [], model: null } }, error: null };
  } };
  const canvas = new CanvasV4({ store, adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(body, operation) {
      return { current: hostCurrent, actorRef: body.actorRef,
        sessionRef: body.sessionRef, authorizationRef: body.authorizationRef,
        worldRef: body.worldRef, allowedActions: [operation],
        sessionIncarnationRef: 'incarnation', nativeGrantRef: 'native-grant',
        invocationRef: 'invocation', invocationStatus: 'ACTIVE',
        grantStatus: hostCurrent ? 'CURRENT' : 'REVOKED' };
    } } });
  return { canvas, store, calls };
}

test('current public payload binds and world context reads its durable selection', async t => {
  const f = await fixture(t);
  const selected = await f.canvas.call('SelectWorldConnection', request);
  assert.equal(selected.error, null);
  assert.equal(f.store.snapshot.bindings.session.payloadDigest,
    'fdf68248d774ba06a649aa50e4ead8c69290cee6ea99bf06fd549a35a832276f');
  const read = await f.canvas.call('ReadWorldSelectionContext', {
    contractVersion: 'canvas/v4', actorRef: 'actor', sessionRef: 'session',
    requestId: 'read-current', authorizationRef: 'grant', worldRef: 'world' });
  assert.equal(read.error, null);
  assert.equal(read.result.selection.status, 'BOUND');
  assert.equal(read.result.selection.connectionRef, 'connection');
  assert.equal(read.result.inventory.capabilityRevision, 'capability-1');
  assert.deepEqual(f.calls, ['ListWorlds', 'AuthorizeBinding',
    'DiscoverConnections', 'DiscoverConnections']);
});

for (const [name, options, code, operations] of [
  ['old advertised payload', { descriptorVersion: '0.2.0' },
    'PAYLOAD_VERSION_MISMATCH', ['ListWorlds']],
  ['declared payload mismatch', { readiness: 'PAYLOAD_VERSION_MISMATCH' },
    'PAYLOAD_VERSION_MISMATCH', ['ListWorlds']],
  ['declared missing capability', { readiness: 'CAPABILITY_UNAVAILABLE' },
    'CAPABILITY_UNAVAILABLE', ['ListWorlds']],
  ['declared Adapter unavailable', { readiness: 'ADAPTER_UNAVAILABLE' },
    'ADAPTER_UNAVAILABLE', ['ListWorlds']],
  ['old binding receipt payload', { receiptVersion: '0.2.0' },
    'PAYLOAD_VERSION_MISMATCH', ['ListWorlds', 'AuthorizeBinding']],
  ['bad payload digest', { payloadDigest: 'not-a-digest' },
    'CONNECTION_UNAUTHORIZED', ['ListWorlds', 'AuthorizeBinding']],
  ['missing recovery capability', { recoveryGuarantee: null },
    'CAPABILITY_UNAVAILABLE', ['ListWorlds', 'AuthorizeBinding']],
  ['changed capability revision', { receiptCapabilityRevision: 'capability-2' },
    'CONNECTION_UNAUTHORIZED', ['ListWorlds', 'AuthorizeBinding']],
  ['Adapter denies binding', { adapterDenied: true },
    'CONNECTION_UNAUTHORIZED', ['ListWorlds', 'AuthorizeBinding']],
  ['Adapter reports payload mismatch', { adapterPayloadMismatch: true },
    'PAYLOAD_VERSION_MISMATCH', ['ListWorlds', 'AuthorizeBinding']],
  ['Host denies operation', { hostCurrent: false },
    'AUTHORIZATION_REVOKED', []],
]) test(`${name} rejects without Canvas binding`, async t => {
  const f = await fixture(t, options);
  const response = await f.canvas.call('SelectWorldConnection', request);
  assert.equal(response.error.code, code);
  assert.equal(response.error.mutationState, 'NONE');
  assert.equal(Object.keys(f.store.snapshot.sessions).length, 0);
  assert.equal(Object.keys(f.store.snapshot.bindings).length, 0);
  assert.deepEqual(f.calls, operations);
});
