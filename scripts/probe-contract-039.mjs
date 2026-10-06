import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const consumer = process.argv[2];
assert.ok(consumer, 'consumer directory required');
const moduleAt = path => import(pathToFileURL(join(consumer, 'node_modules', path)).href);
const { CanvasStore, CanvasV4 } = await moduleAt('hanaworlds-canvas/src/index.mjs');
const { checkCurrentBuildAuthorizationHandshake, checkWorldContextHandshake,
  validateWorldSelectionContextResponse } = await moduleAt('hanaworlds-contracts/dist/v4/index.mjs');
const contractsPackage = JSON.parse(await readFile(join(consumer, 'node_modules',
  'hanaworlds-contracts', 'package.json'), 'utf8'));
assert.equal(contractsPackage.version, '0.3.9');

const store = await CanvasStore.open(join(consumer, 'canvas-store'));
let current = true;
let discoveryCalls = 0;
const authority = { async verify(request, operation) {
  return { current, actorRef: request.actorRef, sessionRef: request.sessionRef,
    authorizationRef: request.authorizationRef, worldRef: request.worldRef,
    allowedActions: [operation], sessionIncarnationRef: 'incarnation',
    nativeGrantRef: 'native-grant', invocationRef: 'invocation',
    invocationStatus: 'ACTIVE', grantStatus: current ? 'CURRENT' : 'REVOKED' };
} };
const adapter = { contractHandshake: null, async call(operation, request) {
  assert.equal(operation, 'DiscoverConnections');
  discoveryCalls++;
  return { contractVersion: 'world-adapter/v4', requestId: request.requestId,
    result: { capabilityRevision: 'capability-1', connections: [{
      adapterId: 'adapter', connectionRef: 'connection', worldRef: 'world',
      displayName: 'World', capabilityRevision: 'capability-1',
      payloadVersion: '0.2.0', readiness: 'READY' }] }, error: null };
} };
const canvas = new CanvasV4({ store, adapters: [{ adapterId: 'adapter', port: adapter }],
  authority });
adapter.contractHandshake = canvas.contractHandshake;
assert.equal(canvas.contractHandshake.contracts, 'hanaworlds-contracts@0.3.9');
for (const check of [checkWorldContextHandshake,
  checkCurrentBuildAuthorizationHandshake]) {
  assert.equal(check(canvas.contractHandshake).result, 'HANDSHAKE_OPERATION_MATCH');
  assert.throws(() => check({ ...canvas.contractHandshake,
    contracts: 'hanaworlds-contracts@0.3.8' }), /UNSUPPORTED_VERSION/);
}
const request = { contractVersion: 'canvas/v4', actorRef: 'actor',
  sessionRef: 'session', requestId: 'read', authorizationRef: 'grant',
  worldRef: 'world' };
const response = await canvas.call('ReadWorldSelectionContext', request);
assert.equal(response.error, null);
assert.equal(response.result.selection.status, 'UNBOUND');
assert.equal(response.result.selection.sessionRevision, '0');
assert.equal(response.result.inventory.capabilityRevision, 'capability-1');
assert.equal(response.result.inventory.connections[0].connectionRef, 'connection');
assert.deepEqual(validateWorldSelectionContextResponse(request, response), response);
assert.equal(Object.keys(store.snapshot.sessions).length, 0);
assert.equal(Object.keys(store.snapshot.bindings).length, 0);
current = false;
const denied = await canvas.call('ReadWorldSelectionContext',
  { ...request, requestId: 'revoked' });
assert.equal(denied.error.code, 'AUTHORIZATION_REVOKED');
assert.equal(denied.error.mutationState, 'NONE');
assert.equal(discoveryCalls, 2);
console.log(JSON.stringify({ installedContracts: contractsPackage.version,
  advertised: canvas.contractHandshake.contracts, worldContext: response.result.selection,
  capabilityRevision: response.result.inventory.capabilityRevision,
  negativeHandshake: 'UNSUPPORTED_VERSION', revoked: denied.error.code,
  mutationState: denied.error.mutationState, discoveryCalls }));
