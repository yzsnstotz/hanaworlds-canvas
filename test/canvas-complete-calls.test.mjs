import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { digestValue, validateRequest, validateResponse, guardRefusalError } from '../src/protocol/local/index.mjs';
import { createUndoExample } from './support/undo-example.mjs';
import { openUndoHost } from './support/undo-host.mjs';
import { undoSessionRef, undoWorldRef } from './support/undo-fixture-world.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';

// COMPONENT + CONTRACT-DOCUMENT FIXTURE. The production Canvas functions and
// fsynced CanvasStore are real; Adapter/Workshop/world inputs use this module's
// existing document-shaped fixtures. This is neither REAL_HOST nor REAL_UI.
// Authority: live canvas-host-supply-02 / formal C-canvas Q-178, items 1-2.
// Candidate analysisRevision interpretation is in this round's pending review
// contract-add: digestValue('affected-analysis', entire public projection).sha256
// equals analysisDigest. It is NOT guessed from worldRevision or a private token.
const root = new URL('../../evidence/q178/', import.meta.url);
const D = (kind, value) => digestValue(kind, value).sha256;
const id = name => `q178-${name}-${randomUUID()}`;
const writes = new Set(['ApplyCompiledTransaction', 'ApplyHistoryTransaction', 'RestoreTransaction', 'WriteRegion']);
const clone = value => structuredClone(value);
const base = { contractVersion: 'canvas/v7', sessionRef: undoSessionRef, worldRef: undoWorldRef };

function component(name, run) {
  test(`COMPONENT Q178: ${name}`, async t => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root.pathname, 'complete-calls-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const built = await createUndoExample(directory);
    assert.ok(built.trace.every(row => row.response.error === null), 'Fixture setup must reach real Canvas business assertions');
    const host = await openUndoHost(directory);
    const env = { directory, host, events: [] };
    host.canvas.emitEvent = event => env.events.push(clone(event));
    await run(env);
  });
}
async function call(env, operation, request) {
  validateRequest('canvas/v7', operation, request);
  const response = await env.host.canvas.call(operation, clone(request));
  validateResponse('canvas/v7', operation, response);
  assert.equal(response.requestId, request.requestId);
  return clone(response);
}
function success(response, operation) {
  assert.equal(response.error, null, `${operation} must execute its published business capability: ${JSON.stringify(response.error)}`);
  assert.ok(response.result, `${operation} must return its complete public result`);
  return response.result;
}
async function observed(env) {
  await env.host.canvas.store.busy;
  return {
    canvas: JSON.parse(await readFile(join(env.directory, 'canvas-v7.json'), 'utf8')),
    world: JSON.parse(await readFile(join(env.directory, 'fixture-world.json'), 'utf8')),
    view: await env.host.canvas.readObjectsHistory(undoSessionRef),
    events: clone(env.events),
  };
}
function writeCount(env) { return env.host.world.calls.filter(row => writes.has(row.operation)).length; }
async function rejectWithoutEffects(env, operation, request, code) {
  const before = await observed(env), count = writeCount(env);
  const response = await call(env, operation, request);
  assert.ok(response.error, `${operation} must refuse the invalid business request`);
  assert.notEqual(response.error.code, 'CAPABILITY_UNAVAILABLE', `${operation} needs its actual business refusal, not an absent entry point`);
  if (code) assert.equal(response.error.code, code);
  assert.equal(response.error.mutationState, 'NONE');
  assert.equal(writeCount(env), count);
  assert.deepEqual(await observed(env), before, 'Refusal must preserve complete durable world/selection/history/pending/config and events');
  return response;
}
function reopen(env, config) {
  return CanvasStore.open(env.directory).then(store => {
    env.host.canvas = new CanvasV5({ store, adapter: env.host.world.adapter,
      nativeFacts: env.host.world.nativeFacts, sessions: fixtureSessions(), config,
      emitEvent: event => env.events.push(clone(event)) });
    env.host.world.readWorldRevision = () => env.host.canvas.readWorldRevision(undoWorldRef);
    return env.host.canvas.syncPlacementSettings();
  });
}
async function inventory(env) {
  return success(await call(env, 'ListObjects', { ...base, requestId: id('inventory'),
    expectedRevision: null, localContext: clone(env.host.canvas.current(undoSessionRef).localContext) }), 'ListObjects');
}
async function objectInput(env, index = 1) {
  const listed = await inventory(env), object = listed.objects[index];
  assert.ok(object, 'Public fixture commits must produce the requested real Canvas object');
  const history = success(await call(env, 'HistoryQuery', { ...base, requestId: id('history'),
    objectRef: object.objectRef, expectedHistoryRevision: null,
    localContext: clone(env.host.canvas.current(undoSessionRef).localContext) }), 'HistoryQuery');
  return { listed, object, history, localContext: clone(env.host.canvas.current(undoSessionRef).localContext) };
}
async function createRequest(env) {
  const facts = await objectInput(env);
  const origin = facts.history.entries.find(row => row.transactionId === 'undo-fixture-cell-2');
  assert.equal(origin?.status, 'VERIFIED');
  return { ...base, requestId: id('create-object'), objectRef: facts.object.objectRef,
    transactionId: origin.transactionId, verifiedReceiptDigest: origin.receiptDigest,
    expectedRevision: facts.listed.registryRevision, localContext: facts.localContext };
}
async function nameRequest(env, operation, name = '样例对象', index = 1) {
  const facts = await objectInput(env, index);
  return { ...base, requestId: id(operation), objectRef: facts.object.objectRef, name,
    expectedRevision: facts.object.objectRevision, expectedRegistryRevision: facts.listed.registryRevision,
    localContext: facts.localContext };
}
async function analyze(env, { transactionId = id('transaction'), position = [20, 2, 20], operations } = {}) {
  operations ??= { contractVersion: 'operations/v4', buildDigest: 'b'.repeat(64),
    compilerRevision: 'undo-fixture-brush-cell-1', compilationConfigDigest: 'a'.repeat(64),
    worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64), targetFactsDigest: 'd'.repeat(64),
    effects: [{ position, geometryProfile: 'voxel-grid/v1', materialRef: 'fixture:stone', orientation: 0 }] };
  const listed = await inventory(env), current = env.host.canvas.current(undoSessionRef);
  const request = { ...base, requestId: id('analysis'), transactionId, operations,
    operationDigest: D('operations', operations), expectedRevision: await env.host.canvas.readWorldRevision(undoWorldRef),
    expectedRegistryRevision: listed.registryRevision, expectedSelectionRevision: current.selectionRevision,
    localContext: clone(current.localContext) };
  const analysis = success(await call(env, 'AnalyzeAffectedObjects', request), 'AnalyzeAffectedObjects');
  return { transactionId, operations, operationDigest: request.operationDigest, analysis,
    analysisDigest: D('affected-analysis', analysis), localContext: clone(current.localContext) };
}
function decisionRequest(input, decision = 'NO_NOTIFICATION', expectedDecisionRevision = null) {
  return { ...base, requestId: id('decision'), transactionId: input.transactionId,
    analysis: clone(input.analysis), analysisDigest: input.analysisDigest,
    analysisRevision: input.analysisDigest, decision, expectedDecisionRevision,
    localContext: clone(input.localContext) };
}
async function decide(env, input, kind = 'NO_NOTIFICATION') {
  const request = decisionRequest(input, kind);
  const decision = success(await call(env, 'DecideAffectedObjectNotification', request), 'DecideAffectedObjectNotification');
  assert.equal(decision.transactionId, input.transactionId);
  assert.equal(decision.analysisDigest, input.analysisDigest);
  assert.equal(decision.decisionKind, kind);
  assert.deepEqual(decision.orderedSelectedRefs, input.analysis.orderedSelectedRefs);
  assert.deepEqual(decision.affectedObjectRefs, input.analysis.affectedObjectRefs);
  assert.equal(typeof decision.decisionRevision, 'string');
  assert.ok(decision.decisionRevision.length);
  return { request, decision };
}
function applyRequest(input, decisionRevision = null) {
  return { ...base, requestId: id('apply'), transactionId: input.transactionId,
    operations: clone(input.operations), operationDigest: input.operationDigest,
    analysisDigest: input.analysisDigest, decisionRevision,
    expectedWorldRevision: input.analysis.worldRevision, expectedObjectRevisions: {},
    guarantee: 'RECOVERABLE_VERIFIED', regionInspectionBinding: null, localContext: clone(input.localContext) };
}

component('CreateObject confirms the stable VERIFIED object, replay and reopen without duplicate identity/world writes', async env => {
  const request = await createRequest(env), before = await observed(env), count = writeCount(env);
  const first = await call(env, 'CreateObject', request), object = success(first, 'CreateObject');
  assert.equal(object.objectRef, request.objectRef); assert.equal(object.worldRef, request.worldRef);
  assert.equal(object.status, 'READY');
  assert.equal((await inventory(env)).objects.length, before.view.objects.length);
  assert.deepEqual((await observed(env)).world, before.world); assert.equal(writeCount(env), count);
  const after = await observed(env);
  assert.deepEqual(await call(env, 'CreateObject', request), first);
  assert.deepEqual(await observed(env), after);
  await reopen(env);
  assert.deepEqual(await call(env, 'CreateObject', request), first);
  assert.equal((await inventory(env)).objects.filter(x => x.objectRef === object.objectRef).length, 1);
  assert.deepEqual((await observed(env)).world, before.world);
});
for (const invalid of ['receipt-digest', 'transaction', 'registry']) component(`CreateObject refuses ${invalid} before registration or world writes`, async env => {
  const request = await createRequest(env);
  if (invalid === 'receipt-digest') request.verifiedReceiptDigest = '0'.repeat(64);
  if (invalid === 'transaction') request.transactionId = 'q178-no-verified-transaction';
  if (invalid === 'registry') request.expectedRevision = 'q178-stale-registry';
  await rejectWithoutEffects(env, 'CreateObject', request, invalid === 'registry' ? 'STALE_REVISION' : undefined);
});
for (const operation of ['NameObject', 'RenameObject']) {
  component(`${operation} changes the public name and generations, preserves history/world, replays and survives reopen`, async env => {
    const request = await nameRequest(env, operation), before = await observed(env), count = writeCount(env);
    const response = await call(env, operation, request), named = success(response, operation);
    assert.equal(named.displayName, request.name); assert.equal(named.objectRef, request.objectRef);
    assert.notEqual(named.registryRevision, request.expectedRegistryRevision);
    assert.equal((await env.host.canvas.readObjectsHistory(undoSessionRef)).objects.find(x => x.objectRef === request.objectRef).name, request.name);
    assert.deepEqual((await observed(env)).view.history, before.view.history);
    assert.deepEqual((await observed(env)).world, before.world); assert.equal(writeCount(env), count);
    const after = await observed(env);
    assert.deepEqual(await call(env, operation, request), response); assert.deepEqual(await observed(env), after);
    await reopen(env);
    assert.deepEqual(await call(env, operation, request), response);
    assert.equal((await env.host.canvas.readObjectsHistory(undoSessionRef)).objects.find(x => x.objectRef === request.objectRef).name, request.name);
  });
  for (const invalid of ['object', 'registry', 'context']) component(`${operation} refuses changed ${invalid} CAS with zero effects`, async env => {
    const request = await nameRequest(env, operation);
    if (invalid === 'object') request.expectedRevision = 'q178-old-object';
    if (invalid === 'registry') request.expectedRegistryRevision = 'q178-old-registry';
    if (invalid === 'context') request.localContext.selectionRevision = 'q178-old-selection';
    await rejectWithoutEffects(env, operation, request, invalid === 'context' ? 'CURRENT_WORLD_MISMATCH' : 'STALE_REVISION');
  });
  component(`${operation} rejects duplicate same-world names and conflicting exact-request replay`, async env => {
    const firstRequest = await nameRequest(env, operation, '样例对象', 0);
    success(await call(env, operation, firstRequest), operation);
    const duplicate = await nameRequest(env, operation, '样例对象', 1);
    await rejectWithoutEffects(env, operation, duplicate, 'OBJECT_NAME_CONFLICT');
    await rejectWithoutEffects(env, operation, { ...firstRequest, name: '另一个名字' }, 'TRANSACTION_CONFLICT');
  });
}

component('ReadPlacementSettings exposes full current policy/revision read-only, exact repeats and reopen', async env => {
  const request = { ...base, requestId: id('placement-read'), localContext: clone(env.host.canvas.current(undoSessionRef).localContext) };
  const before = await observed(env), count = writeCount(env);
  const response = await call(env, 'ReadPlacementSettings', request), result = success(response, 'ReadPlacementSettings');
  assert.equal(result.sessionRef, undoSessionRef); assert.equal(result.worldRef, undoWorldRef);
  assert.deepEqual(result.localContext, request.localContext);
  assert.deepEqual(result.placementSettings, { ...env.host.canvas.placementConfig,
    settingsRevision: before.canvas.placementSettings[undoWorldRef].settingsRevision });
  assert.deepEqual(await observed(env), before); assert.equal(writeCount(env), count);
  assert.deepEqual(await call(env, 'ReadPlacementSettings', request), response);
  await reopen(env); assert.deepEqual(await call(env, 'ReadPlacementSettings', request), response);
});
component('ReadPlacementSettings rejects stale current connection scope without changing stored policy', async env => {
  const request = { ...base, requestId: id('placement-stale'), localContext: clone(env.host.canvas.current(undoSessionRef).localContext) };
  request.localContext.connectionIncarnationRef = 'q178-old-incarnation';
  await rejectWithoutEffects(env, 'ReadPlacementSettings', request, 'CURRENT_WORLD_MISMATCH');
});
component('ReadPlacementSettings re-reads changed saved policy after restart with a new settingsRevision', async env => {
  const request = { ...base, requestId: id('placement-before'), localContext: clone(env.host.canvas.current(undoSessionRef).localContext) };
  const first = success(await call(env, 'ReadPlacementSettings', request), 'ReadPlacementSettings');
  const history = (await observed(env)).view.history, world = (await observed(env)).world;
  const placement = { frontGapCells: 0, forwardSearchCells: 3, lateralSearchCells: 1, verticalSearchCells: 0 };
  await reopen(env, { placement });
  const next = success(await call(env, 'ReadPlacementSettings', { ...request, requestId: id('placement-after') }), 'ReadPlacementSettings');
  for (const [key, value] of Object.entries(placement)) assert.equal(next.placementSettings[key], value);
  assert.notEqual(next.placementSettings.settingsRevision, first.placementSettings.settingsRevision);
  assert.deepEqual((await observed(env)).view.history, history); assert.deepEqual((await observed(env)).world, world);
});

component('public NO_NOTIFICATION produces the durable revision used by a non-null Apply, with replay/reopen', async env => {
  const input = await analyze(env), beforeDecision = await observed(env), count = writeCount(env);
  assert.deepEqual(input.analysis.affectedObjectRefs, []);
  const { request, decision } = await decide(env, input);
  assert.equal(writeCount(env), count); assert.deepEqual((await observed(env)).world, beforeDecision.world);
  assert.deepEqual(env.events, beforeDecision.events, 'NO_NOTIFICATION must not emit a notification event');
  const storedDecision = await observed(env);
  assert.deepEqual(await call(env, 'DecideAffectedObjectNotification', request), {
    contractVersion: 'canvas/v7', requestId: request.requestId, result: decision, error: null });
  assert.deepEqual(await observed(env), storedDecision);
  await reopen(env);
  const replay = success(await call(env, 'DecideAffectedObjectNotification', request), 'DecideAffectedObjectNotification');
  assert.equal(replay.decisionRevision, decision.decisionRevision, 'Actual provider revision must persist across restart');
  const apply = applyRequest(input, replay.decisionRevision), response = await call(env, 'ApplyRecoverableCommit', apply);
  assert.equal(success(response, 'ApplyRecoverableCommit').status, 'VERIFIED');
  assert.equal(env.host.world.readCells([[20, 2, 20]])[0].materialRef, 'fixture:stone');
  const committed = await observed(env), written = writeCount(env);
  assert.deepEqual(await call(env, 'ApplyRecoverableCommit', apply), response);
  assert.equal(writeCount(env), written); assert.deepEqual(await observed(env), committed);
});
component('an arbitrary non-null revision never authorizes Apply', async env => {
  const input = await analyze(env);
  await rejectWithoutEffects(env, 'ApplyRecoverableCommit', applyRequest(input, 'q178-never-granted-decision'));
});
for (const invalid of ['cross-transaction', 'old-analysis', 'selection-generation', 'registry-generation', 'world-generation', 'decision-generation'])
component(`a real NO_NOTIFICATION revision refuses ${invalid} changes before writes`, async env => {
  const input = await analyze(env), grant = await decide(env, input);
  let apply = applyRequest(input, grant.decision.decisionRevision);
  if (invalid === 'cross-transaction') {
    const other = await analyze(env, { position: [21, 2, 20] });
    apply = applyRequest(other, grant.decision.decisionRevision);
  } else if (invalid === 'old-analysis') {
    await analyze(env, { transactionId: input.transactionId, position: [21, 2, 20] });
  } else if (invalid === 'selection-generation') {
    const selected = env.host.canvas.current(undoSessionRef), object = (await inventory(env)).objects[0];
    success(await call(env, 'SetObjectSelection', { ...base, requestId: id('select-object'), objectRefs: [object.objectRef],
      expectedSelectionRevision: selected.selectionRevision, localContext: clone(selected.localContext) }), 'SetObjectSelection');
    apply.localContext = clone(env.host.canvas.current(undoSessionRef).localContext);
  } else if (invalid === 'registry-generation') {
    success(await call(env, 'NameObject', await nameRequest(env, 'NameObject', '已更新登记名称', 0)), 'NameObject');
  } else if (invalid === 'world-generation') {
    const another = await analyze(env, { position: [25, 2, 25] });
    assert.equal(success(await call(env, 'ApplyRecoverableCommit', applyRequest(another)), 'null Apply').status, 'VERIFIED');
    apply.expectedWorldRevision = await env.host.canvas.readWorldRevision(undoWorldRef);
  } else {
    const cancel = decisionRequest(input, 'CANCEL', grant.decision.decisionRevision);
    assert.equal(success(await call(env, 'DecideAffectedObjectNotification', cancel), 'CANCEL').decisionKind, 'CANCEL');
  }
  await rejectWithoutEffects(env, 'ApplyRecoverableCommit', apply);
});
component('decision rejects a forged full affected/selected collection, current-generation token notwithstanding', async env => {
  const input = await analyze(env), object = (await inventory(env)).objects[0];
  const request = decisionRequest(input);
  request.analysis.affectedObjectRefs = [object.objectRef];
  request.analysisDigest = D('affected-analysis', request.analysis);
  request.analysisRevision = request.analysisDigest;
  await rejectWithoutEffects(env, 'DecideAffectedObjectNotification', request);
});
for (const kind of ['BLOCK_AND_NOTIFY', 'CONTINUE', 'CANCEL']) component(`${kind} never becomes overlapping-object write authorization`, async env => {
  const input = await analyze(env, { position: [8, 2, 8] });
  assert.ok(input.analysis.affectedObjectRefs.length > 0);
  const grant = await decide(env, input, kind);
  await rejectWithoutEffects(env, 'ApplyRecoverableCommit', applyRequest(input, grant.decision.decisionRevision));
});
component('public decision refuses stale generation and conflicting payload replay without moving state', async env => {
  const input = await analyze(env), grant = await decide(env, input);
  await rejectWithoutEffects(env, 'DecideAffectedObjectNotification', { ...grant.request, decision: 'CANCEL' }, 'TRANSACTION_CONFLICT');
  await rejectWithoutEffects(env, 'DecideAffectedObjectNotification', { ...grant.request, requestId: id('stale-analysis-generation'), analysisRevision: 'q178-stale-analysis-generation' });
  await rejectWithoutEffects(env, 'DecideAffectedObjectNotification', { ...grant.request, requestId: id('stale-decision-generation'), expectedDecisionRevision: 'q178-stale-decision-generation' });
});

component('original null path still commits/verifies and preserves exact replay after reopening', async env => {
  const input = await analyze(env), request = applyRequest(input);
  const response = await call(env, 'ApplyRecoverableCommit', request);
  assert.equal(success(response, 'null Apply').status, 'VERIFIED');
  const before = await observed(env), count = writeCount(env);
  assert.deepEqual(await call(env, 'ApplyRecoverableCommit', request), response);
  await reopen(env); assert.deepEqual(await call(env, 'ApplyRecoverableCommit', request), response);
  assert.equal(writeCount(env), count); assert.deepEqual(await observed(env), before);
});
component('original null path retains the complete real fixture guard refusal and NONE world outcome', async env => {
  const input = await analyze(env), request = applyRequest(input), before = await observed(env);
  const guard = { guard: 'PLAYER_ENCLOSURE', stage: 'PREPARE_RECOVERABLE', finding: 'PLAYER_ENCLOSED' };
  env.host.world.refuse = { operation: 'PrepareRecoverableTransaction', refusal: guard };
  const response = await call(env, 'ApplyRecoverableCommit', request);
  assert.deepEqual(response.guardRefusal, guard);
  assert.deepEqual(response.error, clone(guardRefusalError(guard, { transactionRef: request.transactionId })));
  const after = await observed(env);
  assert.deepEqual(after.world, before.world); assert.deepEqual(after.view.history, before.view.history);
  assert.deepEqual(after.canvas.pending, {}); assert.deepEqual(after.events, before.events);
});

async function pendingPublicUndo(env) {
  const actions = await env.host.canvas.readHistoryActions(undoSessionRef);
  const object = actions.objects.find(row => row.mode === 'CELL' && row.undo.available);
  assert.ok(object, 'Normal fixture Apply must publish an actual Undo row');
  const step = object.undo, transactionId = id('uncertain-undo');
  const request = { ...base, requestId: id('uncertain-undo-request'), objectRef: object.objectRef,
    transactionId, historyTransactionId: step.historyTransactionId,
    expectedHistoryRevision: step.expectedHistoryRevision, expectedWorldRevision: step.expectedWorldRevision,
    expectedObjectRevisions: clone(step.expectedObjectRevisions), intentDigest: 'a'.repeat(64), surfaceActionDigest: 'b'.repeat(64),
    localContext: clone(actions.localContext) };
  const port = env.host.world.adapter, original = port.call.bind(port);
  const fault = { known: false, receipt: null, prepared: null, applyCount: 0, restoreCount: 0, abortCount: 0, queryRequests: [] };
  const uncertain = transactionRef => ({ code: 'RECOVERY_PENDING', phase: 'apply', retryability: 'SAME_TRANSACTION_QUERY',
    mutationState: 'UNKNOWN', transactionRef, causeCode: null, reason: 'TRANSPORT_OUTCOME_UNKNOWN' });
  // Fault injection is confined to the contract-document fixture port. Canvas's
  // real public Undo creates RESERVED/PREPARED/pending records itself. No seed,
  // store.commit, handwritten pending row or fabricated Canvas response exists.
  port.call = async (operation, body) => {
    const answer = result => ({ contractVersion: 'world-adapter/v8', requestId: body.requestId, result, error: null });
    if (operation === 'PrepareHistoryTransaction') {
      const response = await original(operation, body); fault.prepared = clone(response.result); return response;
    }
    if (operation === 'ApplyHistoryTransaction') {
      fault.applyCount++;
      const response = await original(operation, body);
      fault.receipt = clone(response.result); // actual fixture source applied and durably wrote once
      return { ...answer(null), error: uncertain(body.transactionId), guardRefusal: null };
    }
    if (operation === 'QueryTransaction') {
      fault.queryRequests.push(clone(body));
      if (fault.known) return answer(clone(fault.receipt));
      return answer({ ...clone(fault.receipt), status: 'RECOVERY_PENDING', observedWorldRevision: null,
        readbackDigest: null, restoreStatus: 'UNKNOWN', error: uncertain(body.transactionId), guardRefusal: null, applyFailure: null });
    }
    if (operation === 'QueryPreparedHistoryTransaction') return answer(clone(fault.prepared));
    if (operation === 'AbortPreparedHistoryTransaction') {
      fault.abortCount++; return answer({ transactionId: body.transactionId, status: 'ABORTED_PREPARED', mutationState: 'NONE' });
    }
    if (operation === 'RestoreTransaction') { fault.restoreCount++; throw new Error('Q178_FIXTURE_FORBIDS_RESTORE_OF_UNKNOWN_APPLY'); }
    return original(operation, body);
  };
  const response = await call(env, 'Undo', request);
  assert.equal(response.error?.code, 'RECOVERY_PENDING', 'Fault must reach actual business uncertainty');
  assert.equal(response.error.mutationState, 'UNKNOWN');
  const pending = (await observed(env)).canvas.pending[transactionId];
  assert.ok(pending, 'Actual public Undo must create its own durable pending row');
  assert.equal(pending.body.requestId, request.requestId); assert.equal(pending.body.transactionId, transactionId);
  assert.equal(pending.direction, 'UNDO'); assert.deepEqual(pending.prepared, fault.prepared);
  assert.equal(fault.applyCount, 1); assert.equal(fault.restoreCount, 0); assert.equal(fault.abortCount, 0);
  return { request, fault, recovery: { ...base, requestId: id('recover'), originalUndoRequestId: request.requestId,
    localContext: clone(actions.localContext) } };
}
component('ReadPendingUndoResult reads a public-Undo UNKNOWN outcome without concluding NONE, mutating state or reapplying', async env => {
  const { request, fault, recovery } = await pendingPublicUndo(env), before = await observed(env);
  const query = { ...recovery, requestId: id('read-pending') };
  const response = await call(env, 'ReadPendingUndoResult', query), result = success(response, 'ReadPendingUndoResult');
  assert.equal(result.originalUndoRequestId, request.requestId); assert.equal(result.sessionRef, undoSessionRef);
  assert.equal(result.worldRef, undoWorldRef); assert.ok(['UNKNOWN', 'RECOVERY_PENDING'].includes(result.status));
  if (result.receipt !== null) assert.equal(result.receipt.error?.mutationState, 'UNKNOWN');
  assert.deepEqual(await observed(env), before); assert.equal(fault.applyCount, 1); assert.equal(fault.restoreCount, 0);
  assert.deepEqual(await call(env, 'ReadPendingUndoResult', query), response);
  await reopen(env);
  assert.deepEqual(await call(env, 'ReadPendingUndoResult', query), response);
  assert.deepEqual(await observed(env), before, 'Reopen/read must not secretly recover or forget UNKNOWN');
});
component('RecoverPendingUndo resolves the same real Undo receipt via Query+readback exactly once after restart', async env => {
  const { request, fault, recovery } = await pendingPublicUndo(env);
  await reopen(env); fault.known = true;
  const response = await call(env, 'RecoverPendingUndo', recovery), result = success(response, 'RecoverPendingUndo');
  assert.equal(result.originalUndoRequestId, request.requestId); assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(result.receipt, fault.receipt, 'Forward the exact source receipt including original refs/revisions/digests');
  const resolved = await observed(env);
  assert.equal(resolved.canvas.pending[request.transactionId], undefined);
  assert.ok(resolved.view.history.some(row => row.transactionId === request.historyTransactionId && row.status === 'UNDONE'));
  assert.equal(fault.applyCount, 1); assert.equal(fault.restoreCount, 0); assert.equal(fault.abortCount, 0);
  assert.ok(fault.queryRequests.every(row => row.transactionId === request.transactionId &&
    row.transactionPayloadDigest === fault.prepared.transactionPayloadDigest), 'Never query another transaction/payload');
  assert.deepEqual(await call(env, 'RecoverPendingUndo', recovery), response);
  const read = success(await call(env, 'ReadPendingUndoResult', { ...recovery, requestId: id('read-resolved') }), 'ReadPendingUndoResult');
  assert.deepEqual(read, result);
  assert.deepEqual(await observed(env), resolved);
  await reopen(env);
  assert.deepEqual(await call(env, 'RecoverPendingUndo', recovery), response);
  assert.equal(fault.applyCount, 1); assert.equal(fault.restoreCount, 0);
});
component('RecoverPendingUndo cannot restore/reapply or label UNKNOWN as no mutation when source Query remains uncertain', async env => {
  const { request, fault, recovery } = await pendingPublicUndo(env), before = await observed(env);
  const response = await call(env, 'RecoverPendingUndo', recovery);
  assert.notEqual(response.error?.code, 'CAPABILITY_UNAVAILABLE', 'Public recovery must reach the original transaction');
  assert.equal(response.error?.code, 'RECOVERY_PENDING'); assert.equal(response.error.mutationState, 'UNKNOWN');
  const after = await observed(env);
  assert.ok(after.canvas.pending[request.transactionId]);
  assert.deepEqual(after.world, before.world); assert.deepEqual(after.view.history, before.view.history);
  assert.equal(fault.applyCount, 1); assert.equal(fault.restoreCount, 0); assert.equal(fault.abortCount, 0);
});
for (const operation of ['RecoverPendingUndo', 'ReadPendingUndoResult']) {
  component(`${operation} rejects foreign original request and stale scope without touching a genuine pending Undo`, async env => {
    const { recovery } = await pendingPublicUndo(env);
    await rejectWithoutEffects(env, operation, { ...recovery, originalUndoRequestId: 'q178-no-such-original-undo' });
    await rejectWithoutEffects(env, operation, { ...recovery, requestId: id('stale-recovery-scope'),
      localContext: { ...recovery.localContext, connectionIncarnationRef: 'q178-stale-recovery-incarnation' } }, 'CURRENT_WORLD_MISMATCH');
  });
}

for (const operation of ['CreateObject', 'NameObject', 'RenameObject', 'DecideAffectedObjectNotification',
  'RecoverPendingUndo', 'ReadPendingUndoResult', 'ReadPlacementSettings']) {
  component(`${operation} keeps strict decode refusal ahead of every adapter call and store write`, async env => {
    let request;
    if (operation === 'CreateObject') request = await createRequest(env);
    else if (operation === 'NameObject' || operation === 'RenameObject') request = await nameRequest(env, operation);
    else if (operation === 'DecideAffectedObjectNotification') request = decisionRequest(await analyze(env));
    else if (operation === 'RecoverPendingUndo' || operation === 'ReadPendingUndoResult') {
      request = { ...base, requestId: id('decode-recovery'), originalUndoRequestId: 'unavailable-but-never-admitted',
        localContext: clone(env.host.canvas.current(undoSessionRef).localContext) };
    } else request = { ...base, requestId: id('decode-placement'), localContext: clone(env.host.canvas.current(undoSessionRef).localContext) };
    const before = await observed(env), calls = env.host.world.calls.length;
    const response = await env.host.canvas.call(operation, { ...request, unexpectedRequired: 'must-refuse' });
    validateResponse('canvas/v7', operation, response);
    assert.equal(response.error?.code, 'UNKNOWN_REQUIRED_FIELD'); assert.equal(response.error.phase, 'decode');
    assert.equal(response.error.mutationState, 'NONE'); assert.equal(env.host.world.calls.length, calls);
    assert.deepEqual(await observed(env), before);
  });
}

component('existing public history resolver still finalizes a genuinely uncertain Undo without a second Apply or Restore', async env => {
  const { request, fault } = await pendingPublicUndo(env);
  await reopen(env); fault.known = true;
  const result = await env.host.canvas.resolvePendingHistory({ sessionRef: undoSessionRef, transactionId: request.transactionId });
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(clone(result.receipt), fault.receipt);
  assert.equal((await observed(env)).canvas.pending[request.transactionId], undefined);
  const before = await observed(env);
  assert.deepEqual(clone(await env.host.canvas.resolvePendingHistory({ sessionRef: undoSessionRef, transactionId: request.transactionId })), clone(result));
  assert.equal(fault.applyCount, 1); assert.equal(fault.restoreCount, 0); assert.equal(fault.abortCount, 0);
  assert.deepEqual(await observed(env), before);
});
component('original null path preserves complete ROLLED_BACK guard receipt and verified restored cells', async env => {
  const input = await analyze(env), request = applyRequest(input);
  const beforeCells = env.host.world.readCells([[20, 2, 20]]), history = (await observed(env)).view.history;
  const guard = { guard: 'CELL_PROTECTION', stage: 'APPLY_COMPILED', finding: 'PROTECTED_CELL' };
  env.host.world.refuse = { operation: 'ApplyCompiledTransaction', refusal: guard };
  const receipt = success(await call(env, 'ApplyRecoverableCommit', request), 'null Apply rollback');
  assert.equal(receipt.status, 'ROLLED_BACK'); assert.equal(receipt.restoreStatus, 'VERIFIED_RESTORED');
  assert.deepEqual(receipt.guardRefusal, guard);
  assert.deepEqual(receipt.error, clone(guardRefusalError(guard, { transactionRef: request.transactionId })));
  assert.deepEqual(env.host.world.readCells([[20, 2, 20]]), beforeCells);
  assert.deepEqual((await observed(env)).view.history, history);
  assert.deepEqual((await observed(env)).canvas.pending, {});
  assert.equal(env.events.filter(row => row.event === 'TransactionVerified' && row.receipt.requestId === request.requestId).length, 0);
});

component('NO_NOTIFICATION is refused for actually unselected affected objects, not an overlap authorization', async env => {
  const input = await analyze(env, { position: [8, 2, 8] });
  assert.ok(input.analysis.affectedObjectRefs.length > 0);
  assert.deepEqual(input.analysis.orderedSelectedRefs, []);
  await rejectWithoutEffects(env, 'DecideAffectedObjectNotification', decisionRequest(input));
});
component('a persisted non-null NO_NOTIFICATION revision still honors complete source guard refusal before Prepare', async env => {
  const input = await analyze(env), grant = await decide(env, input);
  const request = applyRequest(input, grant.decision.decisionRevision), before = await observed(env);
  const guard = { guard: 'PLAYER_ENCLOSURE', stage: 'PREPARE_RECOVERABLE', finding: 'PLAYER_ENCLOSED' };
  env.host.world.refuse = { operation: 'PrepareRecoverableTransaction', refusal: guard };
  const response = await call(env, 'ApplyRecoverableCommit', request);
  assert.deepEqual(response.guardRefusal, guard);
  assert.deepEqual(response.error, clone(guardRefusalError(guard, { transactionRef: request.transactionId })));
  const after = await observed(env);
  assert.deepEqual(after.world, before.world); assert.deepEqual(after.view.history, before.view.history);
  assert.deepEqual(after.canvas.pending, {}); assert.deepEqual(after.events, before.events);
});
component('a persisted non-null NO_NOTIFICATION revision still requires verified Restore after an Apply refusal', async env => {
  const input = await analyze(env), grant = await decide(env, input);
  const request = applyRequest(input, grant.decision.decisionRevision);
  const cells = env.host.world.readCells([[20, 2, 20]]), history = (await observed(env)).view.history;
  const guard = { guard: 'CELL_PROTECTION', stage: 'APPLY_COMPILED', finding: 'PROTECTED_CELL' };
  env.host.world.refuse = { operation: 'ApplyCompiledTransaction', refusal: guard };
  const receipt = success(await call(env, 'ApplyRecoverableCommit', request), 'non-null Apply rollback');
  assert.equal(receipt.status, 'ROLLED_BACK'); assert.equal(receipt.restoreStatus, 'VERIFIED_RESTORED');
  assert.deepEqual(receipt.guardRefusal, guard);
  assert.deepEqual(receipt.error, clone(guardRefusalError(guard, { transactionRef: request.transactionId })));
  assert.deepEqual(env.host.world.readCells([[20, 2, 20]]), cells);
  assert.deepEqual((await observed(env)).view.history, history); assert.deepEqual((await observed(env)).canvas.pending, {});
});
