import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import canonicalize from 'canonicalize';
import { CanvasStore, CanvasV4 } from '../src/index.mjs';
import { validateResponse } from '../vendor/contracts/dist/v4/index.mjs';

const worldRef = 'fixture-world';
const objectRef = 'fixture-object';
const sessionRef = 'fixture-session';
const authorizationRef = 'fixture-grant';
const entry = { transactionId: 'fixture-build', originTransactionId: null,
  affectedObjectRefs: [objectRef], operationDigest: 'a'.repeat(64),
  beforeImageDigest: 'b'.repeat(64), expectedAfterReadbackDigest: 'c'.repeat(64),
  receiptDigest: 'd'.repeat(64), historyRevision: 'fixture-history-1', status: 'VERIFIED' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-history-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions[sessionRef] = { currentSession: sessionRef, activeWorldRef: worldRef,
      orderedSelectedObjectRefs: [objectRef], sessionRevision: 'session-1',
      selectionRevision: 'selection-1' };
    state.objects[worldRef] = { [objectRef]: { worldRef, objectRef,
      objectRevision: 'object-1', displayName: 'Home', nameRevision: 'name-1',
      creationSequence: 1, status: 'READY' } };
    state.authorHistory[worldRef] = { [objectRef]: {
      alice: { historyRevision: 'fixture-history-1', headTransactionId: 'fixture-build',
        entries: [entry], undoAvailable: true, redoAvailable: false },
      bob: { historyRevision: 'fixture-history-other', headTransactionId: 'fixture-other',
        entries: [{ ...entry, transactionId: 'fixture-other',
          historyRevision: 'fixture-history-other' }],
        undoAvailable: true, redoAvailable: false } } };
  });
  let authorRef = 'alice';
  let current = true;
  let onVerify = null;
  const authority = { async verify(body, operation) {
    if (onVerify) await onVerify();
    return { current, actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, authorRef,
      allowedActions: [operation], currentWorldRevision: 'world-1' };
  } };
  const canvas = new CanvasV4({ store, authority });
  const request = { contractVersion: 'canvas/v4', actorRef: 'fixture-actor',
    sessionRef, requestId: 'history-current', authorizationRef,
    worldRef, objectRef, expectedHistoryRevision: null };
  return { directory, store, canvas, authority, request,
    setAuthor: value => { authorRef = value; },
    revoke: () => { current = false; },
    setOnVerify: value => { onVerify = value; } };
}

test('v4 null HistoryQuery reads current durable author head after restart without history movement', async t => {
  const f = await fixture(t);
  const restarted = new CanvasV4({ store: await CanvasStore.open(f.directory),
    authority: f.authority });
  const beforeHistory = structuredClone(restarted.store.snapshot.authorHistory);
  const response = await restarted.call('HistoryQuery', f.request);
  assert.equal(response.error, null);
  validateResponse('canvas/v4', 'HistoryQuery', response);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result)), { worldRef, objectRef,
    ...beforeHistory[worldRef][objectRef].alice });
  assert.deepEqual(JSON.parse(JSON.stringify(restarted.store.snapshot.authorHistory)),
    beforeHistory);
  const stale = await restarted.call('HistoryQuery', { ...f.request,
    requestId: 'history-stale', expectedHistoryRevision: 'fixture-history-0' });
  assert.equal(stale.error.code, 'STALE_REVISION');
  const exact = await restarted.call('HistoryQuery', { ...f.request,
    requestId: 'history-exact', expectedHistoryRevision: 'fixture-history-1' });
  assert.equal(exact.error, null);
  assert.deepEqual(exact.result, response.result);
});

test('v4 null HistoryQuery ignores persisted replay and reads a newer durable head with the same requestId', async t => {
  const f = await fixture(t);
  const first = await f.canvas.call('HistoryQuery', f.request);
  assert.equal(first.error, null);
  assert.equal(first.result.headTransactionId, 'fixture-build');
  const exactRequest = { ...f.request, requestId: 'exact-history-before-move',
    expectedHistoryRevision: 'fixture-history-1' };
  const exactBeforeMove = await f.canvas.call('HistoryQuery', exactRequest);
  assert.equal(exactBeforeMove.error, null);
  const replayKey = `${sessionRef}\u0000HistoryQuery\u0000${f.request.requestId}`;
  await f.store.commit(state => {
    state.replay[replayKey] = { digest: createHash('sha256')
      .update(canonicalize(f.request)).digest('hex'), authorRef: 'alice',
    response: first };
  });
  assert.equal(f.store.snapshot.replay[replayKey].response.result.headTransactionId,
    'fixture-build');
  await f.store.commit(state => {
    const history = state.authorHistory[worldRef][objectRef].alice;
    history.historyRevision = 'fixture-history-2';
    history.headTransactionId = 'fixture-new-build';
    history.entries.push({ ...entry, transactionId: 'fixture-new-build',
      historyRevision: 'fixture-history-2' });
  });
  const restarted = new CanvasV4({ store: await CanvasStore.open(f.directory),
    authority: f.authority });
  const second = await restarted.call('HistoryQuery', f.request);
  assert.equal(second.error, null);
  assert.equal(second.result.historyRevision, 'fixture-history-2');
  assert.equal(second.result.headTransactionId, 'fixture-new-build');
  assert.deepEqual(second.result.entries.map(row => row.transactionId),
    ['fixture-build', 'fixture-new-build']);
  assert.equal(restarted.store.snapshot.replay[replayKey].response.result.headTransactionId,
    'fixture-build');
  const exactReplay = await restarted.call('HistoryQuery', exactRequest);
  assert.equal(exactReplay.error, null);
  assert.equal(exactReplay.result.headTransactionId, 'fixture-build');
  const staleExact = await restarted.call('HistoryQuery', { ...exactRequest,
    requestId: 'new-exact-history-after-move' });
  assert.equal(staleExact.error.code, 'STALE_REVISION');
});

test('v4 null HistoryQuery reads without committing replay or rewriting the durable store', async t => {
  const f = await fixture(t);
  const commit = f.store.commit.bind(f.store);
  let commits = 0;
  f.store.commit = change => { commits += 1; return commit(change); };
  const before = JSON.stringify(f.store.snapshot);
  const response = await f.canvas.call('HistoryQuery', f.request);
  assert.equal(response.error, null);
  assert.equal(response.result.headTransactionId, 'fixture-build');
  assert.equal(commits, 0);
  assert.equal(JSON.stringify(f.store.snapshot), before);
});

test('v4 null HistoryQuery isolates authors and rechecks authorization before release', async t => {
  const f = await fixture(t);
  const alice = await f.canvas.call('HistoryQuery', f.request);
  assert.equal(alice.error, null);
  f.setAuthor('bob');
  const sameRequest = await f.canvas.call('HistoryQuery', f.request);
  assert.equal(sameRequest.error, null);
  assert.equal(sameRequest.result.headTransactionId, 'fixture-other');
  assert.equal(sameRequest.result.entries.some(row => row.transactionId === 'fixture-build'),
    false);
  const bob = await f.canvas.call('HistoryQuery', { ...f.request, requestId: 'history-bob' });
  assert.equal(bob.error, null);
  assert.equal(bob.result.headTransactionId, 'fixture-other');
  f.setAuthor('alice');
  let proofs = 0;
  f.setOnVerify(() => {
    proofs += 1;
    if (proofs === 2) f.revoke();
  });
  const revoked = await f.canvas.call('HistoryQuery', { ...f.request,
    requestId: 'history-revoked-at-release' });
  assert.equal(revoked.error.code, 'AUTHORIZATION_REVOKED');
  assert.equal(revoked.result, null);
  assert.equal(proofs, 2);
});

test('v4 null HistoryQuery refuses a world switch before releasing the result', async t => {
  const f = await fixture(t);
  let proofs = 0;
  f.setOnVerify(async () => {
    proofs += 1;
    if (proofs === 2) await f.store.commit(state => {
      state.sessions[sessionRef].activeWorldRef = 'other-world';
    });
  });
  const switched = await f.canvas.call('HistoryQuery', { ...f.request,
    requestId: 'history-switched-at-release' });
  assert.equal(switched.error.code, 'WORLD_NOT_BOUND');
  assert.equal(switched.result, null);
});
