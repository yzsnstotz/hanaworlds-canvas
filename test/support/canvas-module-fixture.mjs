import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { digestValue, validateResponse, validateCanvasEvent }
  from '../../src/protocol/local/index.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef, undoWorldRef }
  from './undo-fixture-world.mjs';
import { fixtureSessions } from '../../scripts/fixture-sessions.mjs';

// MODULE_REAL_CANVAS / CONTRACT_DOCUMENT_PEERS. The packed-build Canvas class,
// durable Store and public decisions are real. World/Adapter/Session answers are
// explicit document samples, and never constitute REAL_HOST or a real world.
// Cell/region compiler inputs are copied whole from the published Canvas golden
// examples: only their declared opaque worldRef binding changes. There is no
// hand-built operation set, history seed, pending seed or Canvas response fixture.
const examples = JSON.parse(await readFile(new URL('../client-verification/canvas-examples.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const digest = (kind, value) => digestValue(kind, value).sha256;
const requestId = operation => `module-${operation}-${randomUUID()}`;
const sample = operation => {
  const row = examples.cases.find(row => row.id === operation);
  assert.ok(row, `Published complete example missing: ${operation}`);
  return row;
};
const writeOperations = new Set(['ApplyCompiledTransaction', 'ApplyHistoryTransaction', 'RestoreTransaction', 'WriteRegion']);
const resultOf = (operation, response) => {
  assert.equal(response.error, null, `${operation} business refusal: ${JSON.stringify(response.error)}`);
  assert.ok(response.result, `${operation} must return its real complete result`);
  return response.result;
};

export async function openCanvasModuleFixture(directory, { config, packageRoot } = {}) {
  // Tests must never borrow an owner's profile or another card's writable root.
  const runRoot = await realpath(new URL('../../../', import.meta.url));
  const target = resolve(directory);
  const suffix = relative(runRoot, target);
  assert.ok(suffix && !suffix.startsWith('..') && !suffix.startsWith('/'), 'Module fixture directory must belong to this card run');
  await mkdir(target, { recursive: true });
  assert.ok(!relative(runRoot, await realpath(target)).startsWith('..'), 'Symlink cannot escape the card run');
  const productionEntry = packageRoot ? pathToFileURL(join(packageRoot, 'lib/src/index.mjs')) : new URL('../../lib/src/index.mjs', import.meta.url);
  const { CanvasV5, CanvasStore, CanvasRegionV1 } = await import(productionEntry.href);
  const worldFile = join(target, 'module-contract-world.json');
  const world = await openUndoFixtureWorld(worldFile, { create: true });
  const fixture = {
    classification: 'MODULE_REAL_CANVAS / CONTRACT_DOCUMENT_PEERS', directory: target, productionEntry: productionEntry.href,
    sessionRef: undoSessionRef, worldRef: undoWorldRef, world, events: [], trace: [], peerCalls: [], writes: [],
  };
  for (const [name, port] of [['adapter', world.adapter], ['regionAdapter', world.regionAdapter]]) {
    const original = port.call.bind(port);
    port.call = async (operation, request) => {
      const row = { classification: 'CONTRACT_DOCUMENT_PEERS', port: name, operation, request: clone(request) };
      fixture.peerCalls.push(row);
      if (writeOperations.has(operation)) fixture.writes.push(row);
      try { const response = await original(operation, request); row.response = clone(response); return response; }
      catch (error) { row.error = { name: error.name, message: error.message }; throw error; }
    };
  }
  const readScopedState = world.nativeFacts.readScopedState.bind(world.nativeFacts);
  world.nativeFacts.readScopedState = async (connectionRef, positions) => {
    const response = await readScopedState(connectionRef, positions);
    fixture.peerCalls.push({ classification: 'CONTRACT_DOCUMENT_PEERS', port: 'scoped-state', operation: 'readScopedState',
      request: { connectionRef, positions: clone(positions) }, response: clone(response) });
    return response;
  };
  const sessions = fixtureSessions();
  const sessionCall = sessions.call.bind(sessions);
  sessions.call = async (operation, request) => {
    const response = await sessionCall(operation, request);
    fixture.peerCalls.push({ classification: 'CONTRACT_DOCUMENT_PEERS', port: 'session', operation,
      request: clone(request), response: clone(response) });
    return response;
  };
  const emitEvent = event => { validateCanvasEvent(event.event, event); fixture.events.push(clone(event)); };
  const observeOwnedCall = (owner, wire) => {
    const original = owner.call.bind(owner);
    owner.call = async (operation, request) => {
      const before = await fixture.snapshot(), eventStart = fixture.events.length, peerStart = fixture.peerCalls.length;
      const response = await original(operation, request);
      validateResponse(wire, operation, response);
      assert.equal(response.requestId, request.requestId);
      fixture.trace.push({ owner: wire, operation, request: clone(request), response: clone(response), before,
        after: await fixture.snapshot(), events: clone(fixture.events.slice(eventStart)), peerCalls: clone(fixture.peerCalls.slice(peerStart)) });
      return response;
    };
  };
  fixture.remount = async nextConfig => {
    if (fixture.canvas) await fixture.canvas.store.busy;
    fixture.canvas = new CanvasV5({ store: await CanvasStore.open(target), adapter: world.adapter,
      nativeFacts: world.nativeFacts, sessions, config: nextConfig, emitEvent });
    fixture.region = new CanvasRegionV1(fixture.canvas, world.regionAdapter);
    world.readWorldRevision = () => fixture.canvas.readWorldRevision(undoWorldRef);
    await fixture.canvas.syncPlacementSettings();
    observeOwnedCall(fixture.canvas, 'canvas/v7');
    observeOwnedCall(fixture.region, 'canvas-region/v3');
    return fixture.canvas;
  };
  await fixture.remount(config);
  fixture.snapshot = async () => {
    await fixture.canvas.store.busy; await world.flush();
    const canvas = JSON.parse(await readFile(join(target, 'canvas-v7.json'), 'utf8'));
    const peerWorld = JSON.parse(await readFile(worldFile, 'utf8'));
    return { canvas, peerWorld, objectsHistory: await fixture.canvas.readObjectsHistory(undoSessionRef),
      historyActions: await fixture.canvas.readHistoryActions(undoSessionRef) };
  };
  fixture.call = async (operation, request) => {
    const wire = request.contractVersion;
    // Let the production decoder receive malformed requests too: a test helper
    // must not substitute its own decode refusal for Canvas's public response.
    const response = await (wire === 'canvas-region/v3' ? fixture.region : fixture.canvas).call(operation, clone(request));
    validateResponse(wire, operation, response);
    assert.equal(response.requestId, request.requestId);
    return response;
  };
  fixture.request = (operation, fields = {}) => ({ ...clone(sample(operation).request),
    requestId: requestId(operation), sessionRef: undoSessionRef, worldRef: undoWorldRef, ...fields });
  fixture.context = () => clone(fixture.canvas.current(undoSessionRef)?.localContext ?? null);
  fixture.select = async () => {
    const context = resultOf('ReadWorldSelectionContext', await fixture.call('ReadWorldSelectionContext',
      fixture.request('ReadWorldSelectionContext')));
    return resultOf('SelectWorldConnection', await fixture.call('SelectWorldConnection', fixture.request('SelectWorldConnection', {
      connectionRef: undoConnection.connectionRef, connectionIncarnationRef: undoConnection.connectionIncarnationRef,
      expectedRevision: context.selection.sessionRevision, expectedContext: fixture.context() })));
  };
  fixture.prepareCommit = async ({ decision = true } = {}) => {
    if (!fixture.canvas.current(undoSessionRef)) await fixture.select();
    const operations = clone(sample('AnalyzeAffectedObjects').request.operations);
    assert.ok(sample('AnalyzeAffectedObjects').bindings.some(row => row.path === '/request/operations/worldRef' && row.kind === 'Ref'));
    operations.worldRef = undoWorldRef;
    const operationDigest = digest('operations', operations), transactionId = requestId('cell-transaction');
    const context = fixture.context();
    const inventory = resultOf('ListObjects', await fixture.call('ListObjects', fixture.request('ListObjects', {
      localContext: context, expectedRevision: null })));
    const worldRevision = await fixture.canvas.readWorldRevision(undoWorldRef);
    const analysis = resultOf('AnalyzeAffectedObjects', await fixture.call('AnalyzeAffectedObjects', fixture.request('AnalyzeAffectedObjects', {
      transactionId, operations, operationDigest, expectedRevision: worldRevision,
      expectedRegistryRevision: inventory.registryRevision, expectedSelectionRevision: context.selectionRevision, localContext: context })));
    const analysisDigest = digest('affected-analysis', analysis);
    let decisionRevision = null;
    if (decision) {
      const request = fixture.request('DecideAffectedObjectNotification', { transactionId, analysis,
        analysisDigest, analysisRevision: analysisDigest, decision: 'NO_NOTIFICATION', expectedDecisionRevision: null, localContext: context });
      const response = await fixture.call('DecideAffectedObjectNotification', request);
      decisionRevision = resultOf('DecideAffectedObjectNotification', response).decisionRevision;
      assert.deepEqual(await fixture.call('DecideAffectedObjectNotification', request), response, 'Exact decision replay must preserve every field');
    }
    const request = fixture.request('ApplyRecoverableCommit', { transactionId, operations, operationDigest,
      analysisDigest, decisionRevision, expectedWorldRevision: worldRevision, expectedObjectRevisions: {},
      guarantee: 'RECOVERABLE_VERIFIED', regionInspectionBinding: null, localContext: context });
    const response = await fixture.call('ApplyRecoverableCommit', request), receipt = resultOf('ApplyRecoverableCommit', response);
    assert.equal(receipt.status, 'VERIFIED', 'Clean public first Apply must verify without any pre-existing history');
    const readback = await fixture.call('Readback', fixture.request('Readback', { transactionId,
      commitRevision: receipt.observedWorldRevision, expectedOperations: operations,
      transactionPayloadDigest: receipt.transactionPayloadDigest, localContext: context }));
    assert.equal(resultOf('Readback', readback).status, 'VERIFIED');
    const history = await fixture.canvas.readObjectsHistory(undoSessionRef);
    assert.ok(history.history.some(row => row.transactionId === transactionId), 'Only the real public Apply may create durable history');
    return { request, response, readback, transactionId, operations, analysis, decisionRevision, history };
  };
  fixture.rename = async (name, { operation = 'RenameObject', objectRef } = {}) => {
    const inventory = resultOf('ListObjects', await fixture.call('ListObjects', fixture.request('ListObjects', {
      expectedRevision: null, localContext: fixture.context() })));
    const object = objectRef ? inventory.objects.find(row => row.objectRef === objectRef) : inventory.objects[0];
    assert.ok(object, 'Name operation needs a real publicly committed object');
    return fixture.call(operation, fixture.request(operation, { name, objectRef: object.objectRef,
      expectedRevision: object.objectRevision, expectedRegistryRevision: inventory.registryRevision, localContext: fixture.context() }));
  };
  fixture.historyRequest = async (action = 'undo', objectRef) => {
    const published = await fixture.canvas.readHistoryActions(undoSessionRef);
    const object = objectRef ? published.objects.find(row => row.objectRef === objectRef) : published.objects.find(row => row[action]?.available);
    assert.ok(object?.[action]?.available, `Real Canvas must publish an available ${action}`);
    const step = object[action], operation = step.operation ?? (action === 'undo' ? 'Undo' : 'Redo');
    if (operation === 'UndoScopedRegionCommit') return { operation, request: fixture.request(operation, {
      originTransactionId: step.historyTransactionId, undoTransactionId: requestId('region-undo'),
      expectedHistoryRevision: step.expectedHistoryRevision, expectedScopeDigest: step.expectedScopeDigest, localContext: published.localContext }) };
    const transactionId = requestId(operation);
    return { operation, request: fixture.request(operation, { objectRef: object.objectRef, transactionId,
      historyTransactionId: step.historyTransactionId, expectedHistoryRevision: step.expectedHistoryRevision,
      expectedWorldRevision: step.expectedWorldRevision, expectedObjectRevisions: clone(step.expectedObjectRevisions),
      localContext: published.localContext }) };
  };
  fixture.performHistory = async (action, objectRef) => {
    const { operation, request } = await fixture.historyRequest(action, objectRef);
    return fixture.call(operation, request);
  };
  fixture.prepareRegion = async () => {
    if (!fixture.canvas.current(undoSessionRef)) await fixture.select();
    const operations = clone(sample('ApplyRegionCommit').request.operations);
    assert.ok(sample('ApplyRegionCommit').bindings.some(row => row.path === '/request/operations/worldRef' && row.kind === 'Ref'));
    operations.worldRef = undoWorldRef;
    const request = fixture.request('ApplyRegionCommit', { transactionId: requestId('region-transaction'), operations,
      operationDigest: digest('region-operations', operations), localContext: fixture.context() });
    const response = await fixture.call('ApplyRegionCommit', request);
    const result = resultOf('ApplyRegionCommit', response);
    assert.equal(result.status ?? result.outcome?.status, 'VERIFIED', 'Document region compiler sample must reach real Canvas verified commit');
    return { request, response };
  };
  const originalAdapterCall = world.adapter.call.bind(world.adapter);
  fixture.armPending = () => {
    const port = world.adapter, original = originalAdapterCall;
    const fault = { known: false, receipt: null, prepared: null, applyCount: 0, restoreCount: 0, abortCount: 0, queries: [] };
    // Existing formal Q178 contract-document transport-outcome example, confined
    // to the peer. Canvas itself reserves, prepares and persists UNKNOWN Undo.
    const uncertain = transactionRef => ({ code: 'RECOVERY_PENDING', phase: 'apply', retryability: 'SAME_TRANSACTION_QUERY',
      mutationState: 'UNKNOWN', transactionRef, causeCode: null, reason: 'TRANSPORT_OUTCOME_UNKNOWN' });
    const injectedCall = async (name, body) => {
      const answer = result => ({ contractVersion: 'world-adapter/v8', requestId: body.requestId, result, error: null });
      if (name === 'PrepareHistoryTransaction') { const response = await original(name, body); fault.prepared = clone(response.result); return response; }
      if (name === 'ApplyHistoryTransaction') { fault.applyCount++; const response = await original(name, body);
        fault.receipt = clone(response.result); return { ...answer(null), error: uncertain(body.transactionId), guardRefusal: null }; }
      if (name === 'QueryPreparedHistoryTransaction') return answer(clone(fault.prepared));
      if (name === 'QueryTransaction') { fault.queries.push(clone(body)); return answer(fault.known ? clone(fault.receipt) : {
        ...clone(fault.receipt), status: 'RECOVERY_PENDING', observedWorldRevision: null, readbackDigest: null,
        restoreStatus: 'UNKNOWN', error: uncertain(body.transactionId), guardRefusal: null, applyFailure: null }); }
      if (name === 'AbortPreparedHistoryTransaction') { fault.abortCount++; return answer({ transactionId: body.transactionId,
        status: 'ABORTED_PREPARED', mutationState: 'NONE' }); }
      if (name === 'RestoreTransaction') { fault.restoreCount++; throw new Error('CONTRACT_DOCUMENT_PEER_FORBIDS_UNKNOWN_RESTORE'); }
      return original(name, body);
    };
    port.call = async (name, body) => {
      const row = { classification: 'CONTRACT_DOCUMENT_PEERS', layer: 'explicit-transport-outcome-fixture',
        port: 'adapter', operation: name, request: clone(body) };
      fixture.peerCalls.push(row);
      try { const response = await injectedCall(name, body); row.response = clone(response); return response; }
      catch (error) { row.error = { name: error.name, message: error.message }; throw error; }
    };
    // This configures only the document peer. No Canvas request executes until
    // the actual client clicks Undo, or preparePending explicitly calls it.
    fixture.armedPending = { fault, traceStart: fixture.trace.length };
    return fault;
  };
  fixture.capturePending = async () => {
    assert.ok(fixture.armedPending, 'Arm the peer transport outcome before the actual Undo');
    const { fault, traceStart } = fixture.armedPending;
    const observed = fixture.trace.slice(traceStart).find(row => row.owner === 'canvas/v7' && row.operation === 'Undo' &&
      row.request.transactionId === fault.receipt?.transactionId && row.response.error?.code === 'RECOVERY_PENDING');
    assert.ok(observed, 'Pending observation requires the actual completed Canvas Undo request/response');
    const { request, response } = observed;
    assert.equal(response.error?.code, 'RECOVERY_PENDING'); assert.equal(response.error.mutationState, 'UNKNOWN');
    assert.ok((await fixture.snapshot()).canvas.pending[request.transactionId], 'Only the public Undo may create pending');
    fixture.pending = { request: clone(request), response: clone(response), fault };
    return fixture.pending;
  };
  fixture.preparePending = async () => {
    const { operation, request } = await fixture.historyRequest('undo');
    assert.equal(operation, 'Undo', 'Uncertain history scenario starts with a real CELL Undo');
    fixture.armPending();
    await fixture.call(operation, request);
    return fixture.capturePending();
  };
  fixture.recover = async ({ known = true } = {}) => {
    assert.ok(fixture.pending, 'Recovery requires a previously executed real Undo');
    fixture.pending.fault.known = known;
    return fixture.call('RecoverPendingUndo', fixture.request('RecoverPendingUndo', {
      originalUndoRequestId: fixture.pending.request.requestId, localContext: fixture.context() }));
  };
  fixture.readPending = () => fixture.call('ReadPendingUndoResult', fixture.request('ReadPendingUndoResult', {
    originalUndoRequestId: fixture.pending.request.requestId, localContext: fixture.context() }));
  fixture.readObjectsHistory = () => fixture.canvas.readObjectsHistory(undoSessionRef);
  fixture.readHistoryActions = () => fixture.canvas.readHistoryActions(undoSessionRef);
  fixture.close = async () => { await fixture.canvas.store.busy; await world.flush(); };
  return fixture;
}
