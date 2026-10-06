import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const consumer = process.argv[2];
assert.ok(consumer, 'consumer directory required');
const moduleAt = path => import(pathToFileURL(join(consumer, 'node_modules', path)).href);
const { CanvasStore, CanvasV4 } = await moduleAt('hanaworlds-canvas/src/index.mjs');
const { contractHandshake } = await moduleAt('hanaworlds-contracts/dist/v4/index.mjs');
const installedContracts = JSON.parse(await readFile(join(consumer, 'node_modules',
  'hanaworlds-contracts', 'package.json'), 'utf8'));
assert.equal(installedContracts.version, '0.3.9');

const select = { contractVersion: 'canvas/v4', actorRef: 'actor', sessionRef: 'session',
  requestId: 'select', authorizationRef: 'grant', worldRef: 'world',
  connectionRef: 'connection', expectedRevision: '0' };
let caseNumber = 0;
async function runCase({ descriptorVersion = '0.2.7', receiptVersion = '0.2.7',
  readiness = 'CONNECTION_UNAUTHORIZED', recoveryGuarantee = 'RECOVERABLE_VERIFIED',
  allowed = true } = {}) {
  const store = await CanvasStore.open(join(consumer, `store-${++caseNumber}`));
  const calls = [];
  const adapter = { contractHandshake, async call(operation, request) {
    calls.push(operation);
    if (operation === 'ListWorlds' || operation === 'DiscoverConnections')
      return { contractVersion: 'world-adapter/v4', requestId: request.requestId,
        result: { capabilityRevision: 'capability-1', connections: [{
          adapterId: 'adapter', connectionRef: 'connection', worldRef: 'world',
          displayName: 'World', capabilityRevision: 'capability-1',
          payloadVersion: descriptorVersion, readiness }] }, error: null };
    assert.equal(operation, 'AuthorizeBinding');
    return { contractVersion: 'world-adapter/v4', requestId: request.requestId,
      result: { connectionRef: 'connection', worldRef: 'world',
        payloadVersion: receiptVersion,
        payloadDigest: 'fdf68248d774ba06a649aa50e4ead8c69290cee6ea99bf06fd549a35a832276f',
        binding: { authorizerRef: 'owner', actorRef: 'actor', bindingRef: 'binding',
          worldRef: 'world', grantEpoch: 'epoch', allowedActions: ['READ'] },
        capabilities: { providerRef: 'adapter', capabilityRevision: 'capability-1',
          worldRef: 'world', engineBounds: null, limits: [], recoveryGuarantee,
          stateProfile: null, regionProtectionWriters: [],
          sessionDeleteSupported: false, imageMediaTypes: [], model: null } }, error: null };
  } };
  const canvas = new CanvasV4({ store, adapters: [{ adapterId: 'adapter', port: adapter }],
    authority: { async verify(request, operation) {
      return { current: allowed, actorRef: request.actorRef,
        sessionRef: request.sessionRef, authorizationRef: request.authorizationRef,
        worldRef: request.worldRef, allowedActions: [operation],
        sessionIncarnationRef: 'incarnation', nativeGrantRef: 'native-grant',
        invocationRef: 'invocation', invocationStatus: 'ACTIVE',
        grantStatus: allowed ? 'CURRENT' : 'REVOKED' };
    } } });
  assert.equal(canvas.contractHandshake.contracts, 'hanaworlds-contracts@0.3.9');
  const response = await canvas.call('SelectWorldConnection', select);
  return { canvas, store, calls, response };
}

const current = await runCase();
assert.equal(current.response.error, null);
assert.equal(current.store.snapshot.bindings.session.payloadDigest,
  'fdf68248d774ba06a649aa50e4ead8c69290cee6ea99bf06fd549a35a832276f');
const context = await current.canvas.call('ReadWorldSelectionContext', {
  contractVersion: 'canvas/v4', actorRef: 'actor', sessionRef: 'session',
  requestId: 'read', authorizationRef: 'grant', worldRef: 'world' });
assert.equal(context.error, null);
assert.equal(context.result.selection.status, 'BOUND');
for (const [name, options, code] of [
  ['old-descriptor', { descriptorVersion: '0.2.0' }, 'PAYLOAD_VERSION_MISMATCH'],
  ['old-receipt', { receiptVersion: '0.2.0' }, 'PAYLOAD_VERSION_MISMATCH'],
  ['mismatch-readiness', { readiness: 'PAYLOAD_VERSION_MISMATCH' },
    'PAYLOAD_VERSION_MISMATCH'],
  ['missing-capability-readiness', { readiness: 'CAPABILITY_UNAVAILABLE' },
    'CAPABILITY_UNAVAILABLE'],
  ['missing-capability', { recoveryGuarantee: null }, 'CAPABILITY_UNAVAILABLE'],
  ['host-revoked', { allowed: false }, 'AUTHORIZATION_REVOKED'],
]) {
  const denied = await runCase(options);
  assert.equal(denied.response.error.code, code, name);
  assert.equal(denied.response.error.mutationState, 'NONE', name);
  assert.equal(Object.keys(denied.store.snapshot.bindings).length, 0, name);
}
console.log(JSON.stringify({ installedContracts: installedContracts.version,
  advertised: current.canvas.contractHandshake.contracts,
  currentPayload: '0.2.7', publicSelection: context.result.selection.status,
  capabilityRevision: context.result.inventory.capabilityRevision,
  rejected: ['old-descriptor', 'old-receipt', 'mismatch-readiness',
    'missing-capability-readiness', 'missing-capability', 'host-revoked'],
  bindingWritesOnRejected: 0 }));
