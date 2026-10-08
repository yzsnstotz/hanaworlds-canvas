import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import canonicalize from 'canonicalize';
import { apply, CanvasStore, CanvasV4 } from '../src/index.mjs';
import { contractHandshake, digestValue, validateBoundRequest,
  validateResponse } from '../vendor/contracts/dist/v4/index.mjs';
import placement from '../vendor/contracts/fixtures/v4/candidate/placement-region-chain-v4.json' with { type: 'json' };
import oracles from '../vendor/contracts/fixtures/v4/candidate/contract-v4-oracles.json' with { type: 'json' };
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';

const request = placement.validCases[0].materializedChain.applyRequest;
const payload = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
  operationDigest: request.operationDigest,
  authorizationBindingDigest: request.authorizationBindingDigest,
  expectedWorldRevision: request.expectedWorldRevision,
  expectedObjectRevisions: request.expectedObjectRevisions,
  beforeImageDigest: 'b'.repeat(64) };
const prepared = { payload, transactionPayloadDigest:
  digestValue('transaction-payload', payload).sha256,
  beforeImageDigest: payload.beforeImageDigest };
const requestDigest = createHash('sha256').update(canonicalize(request)).digest('hex');

async function fixture(t, status = 'RECOVERY_PENDING') {
  const runRoot = join(homedir(), '.cache', 'hanaworlds-runs',
    'S1-CANVAS-RECOVERY-01');
  await mkdir(runRoot, { recursive: true });
  const directory = await mkdtemp(join(runRoot, 'canvas-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions[request.sessionRef] = { activeWorldRef: request.worldRef };
    state.bindings[request.sessionRef] = { adapterId: 'fixture-adapter',
      worldRef: request.worldRef, recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.pending[request.transactionId] = { status,
      worldRef: request.worldRef, sessionRef: request.sessionRef,
      actorRef: request.actorRef, authorRef: 'author', request,
      digest: requestDigest, positions: [[0, 1, 3]],
      affectedObjectRefs: [], prepared };
  });
  let serviceCurrent = true;
  let outcome = 'ROLLED_BACK';
  let receiptIdentity = { transactionId: request.transactionId,
    operationDigest: request.operationDigest,
    transactionPayloadDigest: prepared.transactionPayloadDigest };
  const calls = [];
  const authority = { async verify() { throw Error('revoked user grant must not be consulted'); },
    async verifyService(body, operation) {
      assert.equal(operation, 'RestoreTransaction');
      return { current: serviceCurrent, worldRef: body.worldRef,
        sessionRef: body.sessionRef, authorizationRef: body.authorizationRef,
        domainOwner: 'hanaworlds-canvas' };
    } };
  const adapter = { contractHandshake, protocolHandshake: g3CellHandshake(), async call(operation, body) {
    validateBoundRequest('world-adapter/v4', operation, body);
    calls.push({ operation, body });
    if (outcome === 'UNKNOWN') throw Error('transport outcome unknown');
    if (outcome === 'PREPARED') return { contractVersion: 'world-adapter/v4',
      requestId: body.requestId, result: null, error: { code: 'STALE_TRANSACTION',
        phase: 'validate', retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE',
        transactionRef: null, causeCode: null, reason: 'POLICY_UNAVAILABLE' } };
    const result = { contractVersion: 'canvas/v2', ...receiptIdentity,
      status: 'ROLLED_BACK', previousWorldRevision: request.expectedWorldRevision,
      observedWorldRevision: 'restored-world-1', readbackDigest: 'd'.repeat(64),
      restoreStatus: 'VERIFIED_RESTORED', error: { code: 'READBACK_MISMATCH',
        phase: 'readback', retryability: 'NEVER', mutationState: 'ROLLED_BACK',
        transactionRef: receiptIdentity.transactionId, causeCode: null,
        reason: 'READBACK_ERROR' } };
    return validateResponse('world-adapter/v4', operation, {
      contractVersion: 'world-adapter/v4', requestId: body.requestId,
      result, error: null });
  } };
  const reopen = async () => new CanvasV4({ store: await CanvasStore.open(directory),
    adapters: [{ adapterId: 'fixture-adapter', port: adapter }],
    authority, serviceActorRef: 'canvas-service' });
  return { directory, reopen, calls,
    setServiceCurrent: value => { serviceCurrent = value; },
    setOutcome: value => { outcome = value; },
    setReceiptIdentity: value => { receiptIdentity = value; } };
}

test('restarted Canvas settles its durable post-barrier transaction after grant revocation', async t => {
  const f = await fixture(t);
  const canvas = await f.reopen();
  const result = await canvas.recoverPending();
  assert.deepEqual(result, [{ transactionId: request.transactionId, status: 'ROLLED_BACK' }]);
  assert.deepEqual(f.calls.map(x => x.operation), ['RestoreTransaction']);
  assert.equal(f.calls[0].body.actorRef, 'canvas-service');
  assert.equal(f.calls[0].body.authorizationRef, request.authorizationRef);
  assert.equal(f.calls[0].body.originTransactionId, request.transactionId);
  assert.equal(f.calls[0].body.beforeImageDigest, prepared.beforeImageDigest);
  assert.equal((await CanvasStore.open(f.directory)).snapshot.pending[request.transactionId].status,
    'ROLLED_BACK');
  await canvas.recoverPending();
  assert.equal(f.calls.length, 1, 'settled transaction never rewrites the world');
});

test('unknown restore outcome stays durable pending and is not reported as success', async t => {
  const f = await fixture(t);
  f.setOutcome('UNKNOWN');
  const canvas = await f.reopen();
  const result = await canvas.recoverPending();
  assert.equal(result[0].status, 'RECOVERY_PENDING');
  assert.equal((await CanvasStore.open(f.directory)).snapshot.pending[request.transactionId].status,
    'RECOVERY_PENDING');
  assert.equal((await CanvasStore.open(f.directory)).snapshot.pending[request.transactionId]
    .lastRecoveryError, 'TRANSPORT_OUTCOME_UNKNOWN');
  assert.equal(canvas.status().recovery, 'PENDING');
});

test('recovery rejects untrusted service, pre-barrier, verified and conflicting records without world writes', async t => {
  const f = await fixture(t, 'PREPARED');
  const canvas = await f.reopen();
  assert.deepEqual(await canvas.recoverPending(), []);
  assert.equal(canvas.status().recovery, 'PENDING');
  await canvas.store.commit(state => { state.pending[request.transactionId].status = 'VERIFIED'; });
  assert.deepEqual(await canvas.recoverPending(), []);
  await canvas.store.commit(state => { state.pending[request.transactionId].status = 'APPLYING';
    state.transactions[request.worldRef] = { [request.transactionId]: { status: 'VERIFIED' } }; });
  assert.equal((await canvas.recoverPending())[0].status, 'RECOVERY_PENDING');
  assert.equal(f.calls.length, 0);
  await canvas.store.commit(state => { delete state.transactions[request.worldRef]; });
  f.setServiceCurrent(false);
  assert.equal((await canvas.recoverPending())[0].status, 'RECOVERY_PENDING');
  assert.equal(f.calls.length, 0);
  f.setServiceCurrent(true);
  await canvas.store.commit(state => { state.pending[request.transactionId].digest = '0'.repeat(64); });
  assert.equal((await canvas.recoverPending())[0].status, 'RECOVERY_PENDING');
  assert.equal(f.calls.length, 0);
});

test('restarted Canvas rolls back a pending Undo without advancing linked history', async t => {
  const f = await fixture(t);
  const source = oracles.cases.find(row => row.id === 'A-VALID-AUTHOR-LINKED-UNDO').request;
  const undo = { contractVersion: 'canvas/v4', actorRef: source.actorRef,
    sessionRef: source.sessionRef, requestId: 'undo-pending',
    authorizationRef: source.authorizationRef, worldRef: source.worldRef,
    objectRef: 'fixture-object', transactionId: source.transactionId,
    historyTransactionId: source.originTransactionId,
    expectedHistoryRevision: source.expectedHistoryRevision,
    expectedWorldRevision: source.expectedWorldRevision,
    expectedObjectRevisions: source.expectedObjectRevisions,
    intentDigest: source.authorizationBinding.intentDigest,
    surfaceActionDigest: source.authorizationBinding.surfaceActionDigest };
  const historyDigest = 'e'.repeat(64);
  const historyPayloadDigest = 'f'.repeat(64);
  await (await f.reopen()).store.commit(state => {
    delete state.pending[request.transactionId];
    state.sessions[undo.sessionRef] = { activeWorldRef: undo.worldRef };
    state.bindings[undo.sessionRef] = { adapterId: 'fixture-adapter',
      worldRef: undo.worldRef, recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.authorHistory[undo.worldRef] = { 'fixture-object': { author: {
      historyRevision: undo.expectedHistoryRevision,
      headTransactionId: undo.historyTransactionId, entries: [],
      undoAvailable: true, redoAvailable: false } } };
    state.pending[undo.transactionId] = { status: 'HISTORY_RECOVERY_PENDING',
      direction: 'UNDO', request: undo, worldRef: undo.worldRef,
      sessionRef: undo.sessionRef, actorRef: undo.actorRef, authorRef: 'author',
      digest: createHash('sha256').update(canonicalize(undo)).digest('hex'),
      historyOperationDigest: historyDigest,
      prepared: { transactionId: undo.transactionId, direction: 'UNDO',
        historyOperationDigest: historyDigest, transactionPayloadDigest: historyPayloadDigest,
        beforeImageDigest: 'b'.repeat(64) } };
  });
  const canvas = await f.reopen();
  const beforeHistory = JSON.stringify(canvas.store.snapshot.authorHistory[undo.worldRef]);
  f.setReceiptIdentity({ transactionId: undo.transactionId,
    operationDigest: historyDigest, transactionPayloadDigest: historyPayloadDigest });
  const result = await canvas.recoverPending();
  assert.equal(result[0].status, 'ROLLED_BACK');
  assert.equal(JSON.stringify(canvas.store.snapshot.authorHistory[undo.worldRef]), beforeHistory);
  assert.equal(f.calls.at(-1).operation, 'RestoreTransaction');
  assert.equal(f.calls.at(-1).body.originTransactionId, undo.transactionId);
  assert.equal(f.calls.at(-1).body.operationDigest, historyDigest);
  assert.equal((await CanvasStore.open(f.directory)).snapshot.pending[undo.transactionId].status,
    'ROLLED_BACK');
});

test('DSH service startup runs recovery from its own native durable directory', async t => {
  const f = await fixture(t);
  const root = await mkdtemp(join(homedir(), '.cache', 'hanaworlds-runs',
    'S1-CANVAS-RECOVERY-01', 'dsh-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'data', 'hanaworlds-canvas');
  await mkdir(directory, { recursive: true });
  await copyFile(join(f.directory, 'canvas-v2.json'), join(directory, 'canvas-v2.json'));
  const services = new Map([
    ['dshHomePath', (...parts) => join(root, ...parts)],
    ['hanaworldsWorldAdapterV4', (await f.reopen()).adapters[0].port],
    ['hanaworldsAuthority', (await f.reopen()).authority],
  ]);
  apply({ get: key => services.get(key), provide: (key, service) => services.set(key, service) },
    { adapterId: 'fixture-adapter' });
  const service = services.get('hanaworldsCanvasV4');
  await service.ready;
  await service.recovery;
  assert.equal(service.store.snapshot.pending[request.transactionId].status, 'ROLLED_BACK');
  assert.deepEqual(f.calls.map(row => row.operation), ['RestoreTransaction']);
  assert.equal((await CanvasStore.open(directory)).snapshot.pending[request.transactionId].status,
    'ROLLED_BACK');
});

test('restarted Canvas finalizes its already verified readback without another Adapter write', async t => {
  const f = await fixture(t, 'VERIFIED_PENDING_HISTORY');
  const verified = { contractVersion: 'canvas/v2', transactionId: request.transactionId,
    operationDigest: request.operationDigest,
    transactionPayloadDigest: prepared.transactionPayloadDigest,
    status: 'VERIFIED', previousWorldRevision: request.expectedWorldRevision,
    observedWorldRevision: 'world-after-apply', readbackDigest: 'd'.repeat(64),
    restoreStatus: 'NOT_REQUIRED', error: null };
  const seed = await f.reopen();
  await seed.store.commit(state => {
    const row = state.pending[request.transactionId];
    row.receipt = verified;
    row.receiptDigest = digestValue('receipt', verified).sha256;
    row.reservedObjectRef = 'created-object';
  });
  const canvas = await f.reopen();
  const result = await canvas.recoverPending();
  assert.deepEqual(result, [{ transactionId: request.transactionId, status: 'VERIFIED' }]);
  assert.equal(f.calls.length, 0);
  assert.equal((await CanvasStore.open(f.directory)).snapshot.pending[request.transactionId].status,
    'VERIFIED');
  assert.equal(canvas.store.snapshot.transactions[request.worldRef][request.transactionId].status,
    'VERIFIED');
});

test('conflicting verified readback never turns into a restore write', async t => {
  const f = await fixture(t, 'VERIFIED_PENDING_HISTORY');
  const canvas = await f.reopen();
  await canvas.store.commit(state => {
    state.pending[request.transactionId].receipt = { status: 'VERIFIED',
      transactionId: 'another-transaction' };
    state.pending[request.transactionId].receiptDigest = '0'.repeat(64);
  });
  assert.equal((await canvas.recoverPending())[0].status, 'RECOVERY_PENDING');
  assert.equal(canvas.store.snapshot.pending[request.transactionId].status,
    'VERIFIED_PENDING_HISTORY');
  assert.equal((await canvas.recoverPending())[0].status, 'RECOVERY_PENDING');
  assert.equal(f.calls.length, 0);
});

test('late DSH authority triggers the original pending recovery through its service wrapper', async t => {
  const f = await fixture(t);
  const root = await mkdtemp(join(homedir(), '.cache', 'hanaworlds-runs',
    'S1-CANVAS-RECOVERY-01', 'late-authority-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'data', 'hanaworlds-canvas');
  await mkdir(directory, { recursive: true });
  await copyFile(join(f.directory, 'canvas-v2.json'), join(directory, 'canvas-v2.json'));
  const services = new Map([
    ['dshHomePath', (...parts) => join(root, ...parts)],
    ['hanaworldsWorldAdapterV4', (await f.reopen()).adapters[0].port],
  ]);
  const injections = [];
  const ctx = { get: key => services.get(key),
    provide: (key, value) => services.set(key, value),
    inject: (keys, callback) => injections.push({ keys, callback }) };
  apply(ctx, { adapterId: 'fixture-adapter' });
  const canvas = services.get('hanaworldsCanvasV4');
  await canvas.recovery;
  assert.equal(canvas.store.snapshot.pending[request.transactionId].status,
    'RECOVERY_PENDING');
  assert.equal(f.calls.length, 0);

  const recoveryCalls = new AsyncLocalStorage();
  services.set('hanaworldsAuthority', {
    async verify() { throw Error('the revoked user grant is not a recovery grant'); },
    async verifyService(body, operation) {
      return recoveryCalls.getStore() === canvas && operation === 'RestoreTransaction' ?
        { current: true, worldRef: body.worldRef, sessionRef: body.sessionRef,
          authorizationRef: body.authorizationRef, domainOwner: 'hanaworlds-canvas' } :
        { current: false };
    },
  });
  // Cordis announces the newly provided service before Shell finishes
  // attaching the trust-context wrapper in the same activation turn.
  for (const injection of injections.filter(row =>
    row.keys.includes('hanaworldsAuthority')))
    injection.callback(ctx);
  const original = canvas.recoverPending;
  canvas.recoverPending = (...args) => recoveryCalls.run(canvas,
    () => original.apply(canvas, args));
  await canvas.recovery;
  assert.equal(canvas.store.snapshot.pending[request.transactionId].status,
    'ROLLED_BACK');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].operation, 'RestoreTransaction');
  assert.equal((await CanvasStore.open(directory)).snapshot.pending[request.transactionId].status,
    'ROLLED_BACK');
});
