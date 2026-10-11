import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestValue, historicalReceiptResponse } from 'hanaworlds-contracts';
import { createUndoExample } from './support/undo-example.mjs';
import { openUndoHost } from './support/undo-host.mjs';
import { undoSessionRef, undoWorldRef } from './support/undo-fixture-world.mjs';

// Q-28 / Contracts 2.8.0: an unknown History outcome is resolved after the Adapter stopped and
// the Session re-selected the same world over a new connection incarnation. QueryTransaction
// speaks for the current context; the durable receipt keeps the context it was written with.
const D = (kind, value) => digestValue(kind, value).sha256;
const lost = q => ({ contractVersion: 'world-adapter/v8', requestId: q.requestId, result: null, guardRefusal: null,
  error: { code: 'RECOVERY_PENDING', phase: 'apply', retryability: 'SAME_TRANSACTION_QUERY', mutationState: 'UNKNOWN',
    transactionRef: q.transactionId, causeCode: null, reason: 'TRANSPORT_OUTCOME_UNKNOWN' } });

/**
 * A Redo whose apply reply and first query are lost (stays RECOVERY_PENDING), then a FIXTURE
 * reconnect: the Adapter now names incarnation-2 and the Session re-selects the same world.
 * `answerQuery(q, receipt)` is the Adapter's QueryTransaction answer after the reconnect.
 */
async function pendingAcrossReconnect(t, answerQuery) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-history-reconnect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createUndoExample(directory);
  const host = await openUndoHost(directory);
  const events = [];
  host.canvas.emitEvent = event => { events.push(event); };
  const ref = (await host.readView()).entries[1].objectRef;
  assert.equal((await host.perform(ref, 'undo')).status, 'VERIFIED');
  events.length = 0;
  const port = host.canvas.adapter, original = port.call.bind(port);
  let receipt = null, reconnected = false, applies = 0, restores = 0;
  const incarnation = row => reconnected ? { ...row, connectionIncarnationRef: 'undo-fixture-incarnation-2' } : row;
  port.call = async (op, q) => {
    if (op === 'ApplyHistoryTransaction') { applies++; receipt = (await original(op, q)).result; return lost(q); }
    if (op === 'QueryTransaction') {
      if (!reconnected) throw new Error('ADAPTER_STOPPED');
      return answerQuery(q, receipt);
    }
    if (op === 'RestoreTransaction') { restores++; throw new Error('STALE_TRANSACTION'); }
    const reply = await original(op, q);
    if (op === 'ReadLocalConnection') return { ...reply, result: incarnation(reply.result) };
    if (op === 'DiscoverConnections')
      return { ...reply, result: { ...reply.result, connections: reply.result.connections.map(incarnation) } };
    return reply;
  };
  const failed = await host.perform(ref, 'redo');
  assert.equal(failed.error?.code, 'RECOVERY_PENDING');
  assert.ok(host.canvas.store.snapshot.pending[failed.transactionId]);
  const written = receipt.localContext;
  assert.deepEqual({ ...written }, failed.request.localContext);

  // FIXTURE stop/reconnect, then the product path: the Session re-selects the same world.
  reconnected = true;
  const current = host.canvas.current(undoSessionRef);
  const selected = await host.canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v7', sessionRef: undoSessionRef,
    requestId: 'reconnect-select', worldRef: undoWorldRef, connectionRef: written.connectionRef,
    connectionIncarnationRef: 'undo-fixture-incarnation-2', expectedRevision: current.selectionRevision,
    expectedContext: current.localContext });
  assert.equal(selected.error, null, JSON.stringify(selected.error));
  // A new incarnation is a changed connection: the selection event is published for it.
  assert.deepEqual(events.map(e => e.event), ['WorldConnectionSelectionChanged']);
  events.length = 0;
  const live = selected.result.localContext;
  assert.notEqual(live.connectionIncarnationRef, written.connectionIncarnationRef);
  assert.notEqual(live.selectionRevision, written.selectionRevision);
  return { host, events, ref, failed, written, live, counts: () => ({ applies, restores }) };
}

test('after a reconnect the same world accepts the original-instance receipt and finalizes the Redo once', async t => {
  const queries = [];
  const f = await pendingAcrossReconnect(t, (q, receipt) => { queries.push(q); return historicalReceiptResponse(q, receipt, D('receipt', receipt)); });
  const resolution = await f.host.canvas.resolvePendingHistory({ sessionRef: undoSessionRef, transactionId: f.failed.transactionId });
  assert.deepEqual([resolution.status, resolution.mutationState], ['VERIFIED', 'VERIFIED']);
  // The query spoke for the current context; the receipt kept the context it was written with.
  assert.deepEqual(queries.map(q => ({ ...q.localContext })), [{ ...f.live }]);
  assert.deepEqual({ ...resolution.receipt.localContext }, { ...f.written });
  assert.deepEqual(f.host.canvas.store.snapshot.pending, {});
  assert.equal((await f.host.readView()).entries[1].state, 'APPLIED');
  assert.deepEqual(f.counts(), { applies: 1, restores: 0 });
  assert.deepEqual(f.events.map(e => [e.event, e.operation, e.receipt.result.transactionId]),
    [['HistoryPositionChanged', 'Redo', f.failed.transactionId]]);
  // The original Redo request names the pre-reconnect context: Canvas's currency rule refuses
  // it unchanged, and the stored outcome stays readable through the same resolution.
  const replay = await f.host.canvas.call('Redo', f.failed.request);
  assert.equal(replay.error?.code, 'CURRENT_WORLD_MISMATCH');
  const again = await f.host.canvas.resolvePendingHistory({ sessionRef: undoSessionRef, transactionId: f.failed.transactionId });
  assert.equal(JSON.stringify(again), JSON.stringify(resolution));
  assert.deepEqual(f.counts(), { applies: 1, restores: 0 });
  assert.equal(queries.length, 1, 'a finalized outcome is not queried again');
  assert.equal(f.events.length, 1);
});

test('after a reconnect a receipt of another world is refused and the transaction stays pending', async t => {
  const f = await pendingAcrossReconnect(t, (q, receipt) => {
    const other = { ...receipt, localContext: { ...receipt.localContext, worldRef: 'another-world' } };
    return { contractVersion: 'world-adapter/v8', requestId: q.requestId, result: other, error: null,
      currentLocalContext: q.localContext, receiptDigest: D('receipt', other) };
  });
  await assert.rejects(() => f.host.canvas.resolvePendingHistory({ sessionRef: undoSessionRef, transactionId: f.failed.transactionId }),
    error => error.publicError?.code === 'RECOVERY_PENDING' && error.publicError.causeCode === 'CURRENT_WORLD_MISMATCH');
  assert.ok(f.host.canvas.store.snapshot.pending[f.failed.transactionId]);
  assert.equal((await f.host.readView()).entries[1].state, 'UNDONE');
  assert.equal(f.events.length, 0);
});

test('after a reconnect a receipt re-bound to the current context is not this transaction’s receipt', async t => {
  // Contracts accept a well-formed pair; Canvas still requires the context it wrote with.
  const f = await pendingAcrossReconnect(t, (q, receipt) => {
    const rebound = { ...receipt, localContext: q.localContext };
    return historicalReceiptResponse(q, rebound, D('receipt', rebound));
  });
  await assert.rejects(() => f.host.canvas.resolvePendingHistory({ sessionRef: undoSessionRef, transactionId: f.failed.transactionId }),
    error => error.publicError?.code === 'RECOVERY_PENDING' && error.publicError.causeCode === 'REPLAY_MISMATCH');
  assert.ok(f.host.canvas.store.snapshot.pending[f.failed.transactionId]);
  assert.equal(f.events.length, 0);
});

test('after a reconnect a pre-2.8.0 answer (receipt without the pair) is still refused', async t => {
  const f = await pendingAcrossReconnect(t, (q, receipt) =>
    ({ contractVersion: 'world-adapter/v8', requestId: q.requestId, result: receipt, error: null }));
  await assert.rejects(() => f.host.canvas.resolvePendingHistory({ sessionRef: undoSessionRef, transactionId: f.failed.transactionId }),
    error => error.publicError?.code === 'RECOVERY_PENDING' && error.publicError.causeCode === 'CURRENT_WORLD_MISMATCH');
  assert.ok(f.host.canvas.store.snapshot.pending[f.failed.transactionId]);
  assert.deepEqual(f.counts(), { applies: 1, restores: 0 });
});
