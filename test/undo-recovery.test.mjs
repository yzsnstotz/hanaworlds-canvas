import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import canonicalize from 'canonicalize';
import { CanvasStore, CanvasV4 } from '../src/index.mjs';
import { contractHandshake, digestValue, validateResponse } from
  '../vendor/contracts/dist/v4/index.mjs';
import oracles from '../vendor/contracts/fixtures/v4/candidate/contract-v4-oracles.json' with { type: 'json' };

const source = oracles.cases.find(row => row.id === 'A-VALID-AUTHOR-LINKED-UNDO').request;
const undo = { contractVersion: 'canvas/v4', actorRef: source.actorRef,
  sessionRef: source.sessionRef, requestId: 'workshop-original-undo',
  authorizationRef: source.authorizationRef, worldRef: source.worldRef,
  objectRef: 'fixture-object', transactionId: source.transactionId,
  historyTransactionId: source.originTransactionId,
  expectedHistoryRevision: source.expectedHistoryRevision,
  expectedWorldRevision: source.expectedWorldRevision,
  expectedObjectRevisions: source.expectedObjectRevisions,
  intentDigest: source.authorizationBinding.intentDigest,
  surfaceActionDigest: source.authorizationBinding.surfaceActionDigest };
const operationDigest = 'e'.repeat(64);
const transactionPayloadDigest = 'f'.repeat(64);
const digest = createHash('sha256').update(canonicalize(undo)).digest('hex');
const request = { contractVersion: 'canvas/v4', actorRef: undo.actorRef,
  sessionRef: undo.sessionRef, requestId: 'service-read-1',
  authorizationRef: undo.authorizationRef, worldRef: undo.worldRef,
  serviceRecoveryRef: 'trusted-workshop-service-1',
  originalUndoRequestId: undo.requestId };

async function fixture(t, status = 'HISTORY_RECOVERY_PENDING') {
  const root = join(homedir(), '.cache', 'hanaworlds-runs',
    'S1-CANVAS-UNDO-RECOVERY-READBACK-01');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'canvas-undo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  const receipt = { contractVersion: 'canvas/v2', transactionId: undo.transactionId,
    operationDigest, transactionPayloadDigest, status: 'ROLLED_BACK',
    previousWorldRevision: undo.expectedWorldRevision,
    observedWorldRevision: 'world-restored', readbackDigest: 'd'.repeat(64),
    restoreStatus: 'VERIFIED_RESTORED', error: { code: 'READBACK_MISMATCH',
      phase: 'readback', retryability: 'NEVER', mutationState: 'ROLLED_BACK',
      transactionRef: undo.transactionId, causeCode: null, reason: 'READBACK_ERROR' } };
  await store.commit(state => {
    state.sessions[undo.sessionRef] = { activeWorldRef: undo.worldRef };
    state.bindings[undo.sessionRef] = { adapterId: 'fixture-adapter',
      worldRef: undo.worldRef, recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.pending[undo.transactionId] = { status, direction: 'UNDO',
      request: undo, digest, actorRef: undo.actorRef, sessionRef: undo.sessionRef,
      worldRef: undo.worldRef, authorRef: 'author',
      historyOperationDigest: operationDigest,
      prepared: { transactionId: undo.transactionId, direction: 'UNDO',
        historyOperationDigest: operationDigest, transactionPayloadDigest,
        beforeImageDigest: 'b'.repeat(64) },
      ...(status === 'ROLLED_BACK' ? { receipt } : {}) };
  });
  let serviceCurrent = true;
  let adapterOutcome = 'ROLLED_BACK';
  const calls = [];
  const authority = { async verify() { return { current: false }; },
    async verifyService(body, operation) {
    if (operation === 'RestoreTransaction') return {
      current: serviceCurrent, sessionRef: body.sessionRef,
      worldRef: body.worldRef, authorizationRef: body.authorizationRef,
      domainOwner: 'hanaworlds-canvas' };
    return { current: serviceCurrent, actorRef: body.actorRef,
      sessionRef: body.sessionRef, worldRef: body.worldRef,
      authorizationRef: body.authorizationRef,
      serviceRecoveryRef: body.serviceRecoveryRef,
      domainOwner: 'hanaworlds-workshop', allowedActions: [operation] };
  } };
  const adapter = { contractHandshake, async call(operation, body) {
    calls.push({ operation, body });
    if (adapterOutcome === 'UNKNOWN') throw Error('world result unknown');
    return { contractVersion: 'world-adapter/v4', requestId: body.requestId,
      result: receipt, error: null };
  } };
  const reopen = async () => new CanvasV4({ store: await CanvasStore.open(directory),
    adapters: [{ adapterId: 'fixture-adapter', port: adapter }], authority });
  return { store, directory, receipt, calls, reopen,
    setServiceCurrent(value) { serviceCurrent = value; },
    setAdapterOutcome(value) { adapterOutcome = value; } };
}

test('trusted service settles only the matching durable post-barrier Undo and reads it after restart', async t => {
  const f = await fixture(t);
  const canvas = await f.reopen();
  const settled = await canvas.call('RecoverPendingUndo', request);
  validateResponse('canvas/v4', 'RecoverPendingUndo', settled);
  assert.equal(settled.result.status, 'ROLLED_BACK');
  assert.equal(settled.result.receipt, null);
  assert.deepEqual(f.calls.map(row => row.operation), ['RestoreTransaction']);
  const again = await (await f.reopen()).call('ReadPendingUndoResult',
    { ...request, requestId: 'service-read-2' });
  validateResponse('canvas/v4', 'ReadPendingUndoResult', again);
  assert.equal(again.result.status, 'ROLLED_BACK');
  assert.equal(f.calls.length, 1);
  const repeated = await (await f.reopen()).call('RecoverPendingUndo',
    { ...request, requestId: 'service-recover-again' });
  assert.equal(repeated.error.code, 'TRANSACTION_CONFLICT');
  assert.equal(f.calls.length, 1);
});

test('revoked ordinary Undo stays refused while a trusted pending read remains available', async t => {
  const f = await fixture(t);
  const canvas = await f.reopen();
  const ordinary = await canvas.call('Undo', undo);
  assert.equal(ordinary.error.code, 'AUTHORIZATION_REVOKED');
  f.setServiceCurrent(false);
  const untrusted = await canvas.call('RecoverPendingUndo', request);
  assert.equal(untrusted.error.code, 'PERMISSION_DENIED');
  assert.equal(f.calls.length, 0);
});

test('service cannot choose a transaction or cross original identity boundaries', async t => {
  const f = await fixture(t);
  const canvas = await f.reopen();
  const forgedId = await canvas.call('RecoverPendingUndo',
    { ...request, transactionId: undo.transactionId });
  assert.equal(forgedId.error.code, 'UNKNOWN_REQUIRED_FIELD');
  for (const wrong of [
    { originalUndoRequestId: 'other-undo' }, { worldRef: 'other-world' },
    { sessionRef: 'other-session' }, { authorizationRef: 'other-grant' },
    { actorRef: 'other-actor' }]) {
    const answer = await canvas.call('RecoverPendingUndo', { ...request, ...wrong });
    assert.notEqual(answer.error, null, JSON.stringify(wrong));
  }
  assert.equal(f.calls.length, 0);
});

test('unknown Adapter outcome remains durable pending and cannot claim a history head move', async t => {
  const f = await fixture(t);
  f.setAdapterOutcome('UNKNOWN');
  const first = await (await f.reopen()).call('RecoverPendingUndo', request);
  assert.equal(first.result.status, 'UNKNOWN');
  assert.equal(first.result.receipt, null);
  const stored = (await CanvasStore.open(f.directory)).snapshot.pending[undo.transactionId];
  assert.equal(stored.status, 'HISTORY_RECOVERY_PENDING');
  const read = await (await f.reopen()).call('ReadPendingUndoResult',
    { ...request, requestId: 'service-read-unknown' });
  assert.equal(read.result.status, 'UNKNOWN');
  assert.equal(f.calls.length, 1);
});

test('pre-barrier row cannot be recovered and absence rejects rather than returning UNKNOWN', async t => {
  const f = await fixture(t, 'HISTORY_RESERVED');
  const canvas = await f.reopen();
  assert.equal((await canvas.call('RecoverPendingUndo', request)).error.code,
    'TRANSACTION_CONFLICT');
  await f.store.commit(state => { delete state.pending[undo.transactionId]; });
  const reopened = await f.reopen();
  assert.equal((await reopened.call('ReadPendingUndoResult', request)).error.code,
    'TRANSACTION_CONFLICT');
  assert.equal(f.calls.length, 0);
});

test('already VERIFIED Undo is read from the matching durable receipt without a new world call', async t => {
  const f = await fixture(t);
  const verified = { ...f.receipt, status: 'VERIFIED',
    restoreStatus: 'NOT_REQUIRED', error: null,
    readbackDigest: 'a'.repeat(64) };
  const receiptDigest = digestValue('receipt', verified).sha256;
  await f.store.commit(state => {
    const row = state.pending[undo.transactionId];
    row.status = 'VERIFIED';
    row.receipt = verified;
    row.receiptDigest = receiptDigest;
    state.transactions[undo.worldRef] = { [undo.transactionId]: {
      status: 'VERIFIED', transactionId: undo.transactionId,
      worldRef: undo.worldRef, sessionRef: undo.sessionRef,
      authorRef: row.authorRef, operationDigest,
      receiptDigest } };
  });
  const canvas = await f.reopen();
  const read = await canvas.call('ReadPendingUndoResult', request);
  validateResponse('canvas/v4', 'ReadPendingUndoResult', read);
  assert.equal(read.result.status, 'VERIFIED');
  assert.equal(JSON.stringify(read.result.receipt), JSON.stringify(verified));
  assert.equal((await canvas.call('RecoverPendingUndo', request)).error.code,
    'TRANSACTION_CONFLICT');
  assert.equal(f.calls.length, 0);
});

test('corrupt durable identity and receipt cannot be promoted to a settled result', async t => {
  const f = await fixture(t);
  await f.store.commit(state => {
    state.pending[undo.transactionId].digest = '0'.repeat(64);
  });
  const canvas = await f.reopen();
  const answer = await canvas.call('RecoverPendingUndo', request);
  assert.equal(answer.error.code, 'TRANSACTION_CONFLICT');
  assert.equal(f.calls.length, 0);
});
