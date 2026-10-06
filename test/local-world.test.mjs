import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';
import { digestValue } from 'hanaworlds-contracts';

const stateProfile = { profileVersion: 'state-profile/v2',
  nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
  inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
const connection = { connectionRef: 'local-connection', connectionIncarnationRef: 'socket-open-1',
  worldRef: 'local-world', payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
  capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef: 'local-world',
    engineBounds: { min: [0, 0, 0], max: [9, 9, 9] }, limits: [],
    recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    sessionDeleteSupported: true, imageMediaTypes: [], model: null } };

test('actual connection readback binds the current local world durably', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-local-'));
  try {
    const calls = [];
    const adapter = { async call(operation, request) {
      calls.push(operation);
      if (operation === 'DiscoverConnections') return {
        contractVersion: 'world-adapter/v6', requestId: request.requestId,
        result: { capabilityRevision: 'cap-1', connections: [{
          adapterId: 'hanaworlds-world-adapter', connectionRef: connection.connectionRef,
          worldRef: connection.worldRef, displayName: 'Local world',
          capabilityRevision: 'cap-1', payloadVersion: connection.payloadVersion,
          readiness: 'READY',
          connectionIncarnationRef: connection.connectionIncarnationRef }] }, error: null };
      if (operation === 'ReadLocalConnection') return {
        contractVersion: 'world-adapter/v6', requestId: request.requestId,
        result: connection, error: null };
      throw new Error(`unexpected adapter operation ${operation}`);
    } };
    const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter });
    const selectionContext = await canvas.call('ReadWorldSelectionContext', {
      contractVersion: 'canvas/v5', sessionRef: 'session-1', requestId: 'context-1',
      worldRef: 'local-world' });
    assert.equal(selectionContext.error, null);
    assert.equal(selectionContext.result.selection.status, 'UNBOUND');
    const request = { contractVersion: 'canvas/v5', sessionRef: 'session-1', requestId: 'select-1',
      worldRef: 'local-world', connectionRef: 'local-connection',
      connectionIncarnationRef: 'socket-open-1', expectedRevision: 'selection-0',
      expectedContext: null };
    const result = await canvas.call('SelectWorldConnection', request);
    assert.equal(result.error, null);
    assert.equal(result.result.localContext.connectionIncarnationRef, 'socket-open-1');
    assert.deepEqual(calls, ['DiscoverConnections', 'ReadLocalConnection']);
    const reopened = new CanvasV5({ store: await CanvasStore.open(directory), adapter });
    assert.equal(JSON.stringify(reopened.current('session-1').localContext),
      JSON.stringify(result.result.localContext));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('build commits only after complete readback and stores one durable history row', async () => {
  const fixture = JSON.parse(await readFile(new URL(import.meta.resolve(
    'hanaworlds-contracts/fixtures/main'))));
  const D = (kind, value) => digestValue(kind, value).sha256;
  const directory = await mkdtemp(join(tmpdir(), 'canvas-build-'));
  try {
    const worldRef = fixture.request.worldRef;
    const connected = { ...connection, worldRef,
      capabilities: { ...connection.capabilities, worldRef } };
    const sessionRef = 'build-session';
    const position = [0, 1, 3];
    let record = { position, nodeName: 'air', param1: 0, param2: 0,
      metadata: {}, inventory: {}, timer: null };
    let writes = 0;
    let restores = 0;
    let mismatchAfterApply = false;
    const calls = [];
    const adapter = { async call(operation, request) {
      calls.push(operation);
      const respond = result => ({ contractVersion: 'world-adapter/v6',
        requestId: request.requestId, result, error: null });
      if (operation === 'ReadLocalConnection') return respond(connected);
      if (operation === 'Readback') {
        const projection = { worldRef, coveredPositions: [position],
          records: [record], stateProfile };
        return respond({ projection, readbackDigest: D('readback', projection),
          adapterExecutionRevision: `execution-${writes}` });
      }
      if (operation === 'PrepareRecoverableTransaction') {
        const payload = { contractVersion: 'world-adapter/v6',
          transactionId: request.transactionId, worldRef,
          operationDigest: request.operationDigest, scopeDigest: request.scopeDigest,
          beforeImageDigest: '3'.repeat(64), localContext: request.localContext };
        return respond({ payload,
          transactionPayloadDigest: D('scoped-transaction-payload', payload),
          beforeImageDigest: payload.beforeImageDigest, scopeDigest: request.scopeDigest,
          guarantee: 'RECOVERABLE_VERIFIED', stateProfile,
          adapterExecutionRevision: `execution-${writes}`,
          beforeStateReadbackDigest: D('readback', {
            worldRef, coveredPositions: [position], records: [record], stateProfile }) });
      }
      if (operation === 'ApplyCompiledTransaction') {
        writes++;
        record = { ...record, nodeName: mismatchAfterApply ? 'fixture:wrong' : 'fixture:stone' };
        const projection = { worldRef, coveredPositions: [position], records: [record],
          stateProfile };
        return respond({ contractVersion: 'canvas/v5',
          transactionId: request.transactionId, operationDigest: request.operationDigest,
          transactionPayloadDigest: request.preparedTransaction.transactionPayloadDigest,
          status: 'VERIFIED', previousWorldRevision: writes === 1 ?
            fixture.request.targetFacts.worldRevision : 'world-3',
          observedWorldRevision: writes === 1 ? 'world-2' : 'world-4',
          readbackDigest: D('readback', projection),
          restoreStatus: 'NOT_REQUIRED', error: null, localContext: request.localContext });
      }
      if (operation === 'RestoreTransaction') {
        restores++;
        record = { ...record, nodeName: 'air' };
        const projection = { worldRef, coveredPositions: [position], records: [record],
          stateProfile };
        return respond({ contractVersion: 'canvas/v5',
          transactionId: request.originTransactionId,
          operationDigest: request.operationDigest,
          transactionPayloadDigest: '5'.repeat(64), status: 'ROLLED_BACK',
          previousWorldRevision: 'world-4', observedWorldRevision: 'world-5',
          readbackDigest: D('readback', projection),
          restoreStatus: 'VERIFIED_RESTORED', error: null,
          localContext: request.localContext });
      }
      if (operation === 'PrepareHistoryTransaction') return respond({
        originTransactionId: request.originTransactionId,
        transactionId: request.transactionId, direction: 'UNDO',
        historyOperationDigest: request.historyOperationDigest,
        transactionPayloadDigest: '5'.repeat(64), beforeImageDigest: '6'.repeat(64),
        targetStateDigest: request.targetStateDigest, stateProfile,
        adapterExecutionRevision: `execution-${writes}`,
        guarantee: 'RECOVERABLE_VERIFIED', status: 'PREPARED',
        localContext: request.localContext });
      if (operation === 'ApplyHistoryTransaction') {
        writes++;
        record = { ...record, nodeName: 'air' };
        const projection = { worldRef, coveredPositions: [position], records: [record],
          stateProfile };
        return respond({ contractVersion: 'canvas/v5',
          transactionId: request.transactionId,
          operationDigest: request.historyOperationDigest,
          transactionPayloadDigest: request.preparedHistoryTransaction.transactionPayloadDigest,
          status: 'VERIFIED', previousWorldRevision: 'world-2',
          observedWorldRevision: 'world-3', readbackDigest: D('readback', projection),
          restoreStatus: 'NOT_REQUIRED', error: null, localContext: request.localContext });
      }
      throw new Error(`unexpected adapter operation ${operation}`);
    } };
    const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter });
    const selected = await canvas.call('SelectWorldConnection', {
      contractVersion: 'canvas/v5', sessionRef, requestId: 'select-build', worldRef,
      connectionRef: connected.connectionRef,
      connectionIncarnationRef: connected.connectionIncarnationRef,
      expectedRevision: 'selection-0', expectedContext: null });
    assert.equal(selected.error, null);
    const localContext = selected.result.localContext;
    const operations = { contractVersion: 'operations/v3',
      buildDigest: fixture.response.result.buildDigest, compilerRevision: 'brush-1',
      compilationConfigDigest: 'a'.repeat(64), worldRef,
      frameDigest: fixture.request.targetFacts.frameDigest,
      catalogueDigest: fixture.response.result.build.catalogueDigest,
      targetFactsDigest: fixture.request.targetFactsDigest,
      effects: [{ position, nodeName: 'fixture:stone', param2: 0 }] };
    const operationDigest = D('operations', operations);
    const analyzed = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v5', sessionRef, requestId: 'analyze-build', worldRef,
      transactionId: 'build-1', operations, operationDigest,
      expectedRevision: fixture.request.targetFacts.worldRevision,
      expectedRegistryRevision: 'registry-0',
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(analyzed.error, null);
    assert.deepEqual([...analyzed.result.affectedObjectRefs], []);
    const apply = { contractVersion: 'canvas/v5', sessionRef,
      requestId: 'apply-build', worldRef, transactionId: 'build-1', operations,
      operationDigest, analysisDigest: D('affected-analysis', analyzed.result),
      decisionRevision: null,
      expectedWorldRevision: fixture.request.targetFacts.worldRevision,
      expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED',
      regionInspectionBinding: { inspectionId: fixture.request.regionInspection.inspectionId,
        build: fixture.response.result.build }, localContext };
    const completed = await canvas.call('ApplyRecoverableCommit', apply);
    assert.equal(completed.error, null, JSON.stringify({ calls, completed,
      pending: canvas.store.snapshot.pending }));
    assert.equal(completed.result.status, 'VERIFIED');
    assert.equal(writes, 1);
    const replay = await canvas.call('ApplyRecoverableCommit', apply);
    assert.equal(replay.result.transactionId, 'build-1');
    assert.equal(writes, 1);
    const reopened = await CanvasStore.open(directory);
    assert.equal(reopened.snapshot.transactions['build-1'].history.status, 'VERIFIED');
    const objectRef = reopened.snapshot.transactions['build-1'].objectRef;
    const objectRevision = reopened.snapshot.objects[worldRef][objectRef].objectRevision;
    const objects = await canvas.call('ListObjects', { contractVersion: 'canvas/v5',
      sessionRef, requestId: 'list-objects', worldRef, expectedRevision: null,
      localContext });
    assert.equal(objects.error, null);
    assert.equal(objects.result.objects[0].objectRef, objectRef);
    const historyView = await canvas.call('HistoryQuery', {
      contractVersion: 'canvas/v5', sessionRef, requestId: 'history-build', worldRef,
      objectRef, expectedHistoryRevision: null, localContext });
    assert.equal(historyView.error, null);
    assert.equal(historyView.result.entries[0].transactionId, 'build-1');
    const conflictAnalysis = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v5', sessionRef, requestId: 'analyze-conflict', worldRef,
      transactionId: 'conflict-1', operations, operationDigest,
      expectedRevision: 'world-2',
      expectedRegistryRevision: reopened.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(conflictAnalysis.error, null);
    assert.deepEqual([...conflictAnalysis.result.affectedObjectRefs], [objectRef]);
    const conflict = await canvas.call('ApplyRecoverableCommit', {
      ...apply, requestId: 'apply-conflict', transactionId: 'conflict-1',
      analysisDigest: D('affected-analysis', conflictAnalysis.result),
      expectedWorldRevision: 'world-2' });
    assert.equal(conflict.error.code, 'OTHER_OBJECTS_AFFECTED');
    assert.equal(writes, 1);
    const undoRequest = { contractVersion: 'canvas/v5',
      sessionRef, requestId: 'undo-build', worldRef, objectRef,
      transactionId: 'undo-1', historyTransactionId: 'build-1',
      expectedHistoryRevision: reopened.snapshot.history[objectRef][0].historyRevision,
      expectedWorldRevision: 'world-2',
      expectedObjectRevisions: { [objectRef]: objectRevision },
      intentDigest: '7'.repeat(64), surfaceActionDigest: '8'.repeat(64), localContext };
    const undo = await canvas.call('Undo', undoRequest);
    assert.equal(undo.error, null, JSON.stringify({ undo, calls }));
    assert.equal(undo.result.status, 'VERIFIED');
    assert.equal(writes, 2);
    const undoReplay = await canvas.call('Undo', undoRequest);
    assert.equal(undoReplay.result.transactionId, 'undo-1');
    assert.equal(writes, 2);
    const afterUndo = await CanvasStore.open(directory);
    assert.equal(afterUndo.snapshot.history[objectRef].at(-1).originTransactionId, 'build-1');
    const wrongWorld = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v5', sessionRef, requestId: 'wrong-world',
      worldRef, transactionId: 'wrong-world-tx', operations, operationDigest,
      expectedRevision: 'world-3',
      expectedRegistryRevision: afterUndo.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision,
      localContext: { ...localContext, connectionIncarnationRef: 'socket-open-2' } });
    assert.equal(wrongWorld.error.code, 'CURRENT_WORLD_MISMATCH');
    assert.equal(writes, 2);
    const badOperations = { ...operations, effects: [{ position: [0, 1, 4],
      nodeName: 'fixture:stone', param2: 0 }] };
    const badOperationDigest = D('operations', badOperations);
    const badAnalysis = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v5', sessionRef, requestId: 'analyze-bad-geometry',
      worldRef, transactionId: 'bad-geometry', operations: badOperations,
      operationDigest: badOperationDigest, expectedRevision: 'world-3',
      expectedRegistryRevision: afterUndo.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(badAnalysis.error, null);
    const badGeometry = await canvas.call('ApplyRecoverableCommit', {
      ...apply, requestId: 'apply-bad-geometry', transactionId: 'bad-geometry',
      operations: badOperations, operationDigest: badOperationDigest,
      analysisDigest: D('affected-analysis', badAnalysis.result),
      expectedWorldRevision: 'world-3' });
    assert.equal(badGeometry.error.code, 'CATALOGUE_MISMATCH');
    assert.equal(writes, 2);
    const reanalyzed = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v5', sessionRef, requestId: 'analyze-rebuild', worldRef,
      transactionId: 'build-2', operations, operationDigest,
      expectedRevision: 'world-3',
      expectedRegistryRevision: afterUndo.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(reanalyzed.error, null);
    mismatchAfterApply = true;
    const failed = await canvas.call('ApplyRecoverableCommit', {
      ...apply, requestId: 'apply-rebuild', transactionId: 'build-2',
      analysisDigest: D('affected-analysis', reanalyzed.result),
      expectedWorldRevision: 'world-3' });
    assert.equal(failed.error, null, JSON.stringify({ failed, calls }));
    assert.equal(failed.result.status, 'ROLLED_BACK');
    assert.equal(restores, 1);
    const afterRollback = await CanvasStore.open(directory);
    assert.equal(afterRollback.snapshot.transactions['build-2'].receipt.status, 'ROLLED_BACK');
    assert.equal(afterRollback.snapshot.history[objectRef].length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
