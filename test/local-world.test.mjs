import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { CanvasV5, CanvasStore, apply: applyCanvas } = await import(process.env.CANVAS_ENTRY ??
  new URL('../src/index.mjs', import.meta.url).href);
import { openRuntime } from './support/cordis-runtime.mjs';
const consumer = await import(process.env.CANVAS_CONSUMER_ENTRY ?? 'hanaworlds-contracts');
import { readFile, writeFile } from 'node:fs/promises';
import { digestValue, checkContractHandshake, contractHandshake, guardRefusalError,
  validateResponse, createPlacementProposal, confirmedPlacementBinding, confirmedPlacement } from 'hanaworlds-contracts';
import majorCompat from 'hanaworlds-contracts/fixtures/contracts-major-compat' with { type: 'json' };
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import canonicalize from 'canonicalize';
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';
import { fixtureEngineGuards, guardSlot } from '../scripts/fixture-engine-guards.mjs';

const G1_REFUSAL = { guard: 'BODY_CLEARANCE', stage: 'RESTORE', finding: 'BODY_OCCUPIED' };
const stateProfile = { profileVersion: 'state-profile/v3', derivedFields: ['light'], preservedFields: ['inventory', 'metadata', 'timer'], clearedFields: [] };
const connection = { connectionRef: 'local-connection', connectionIncarnationRef: 'socket-open-1',
  worldRef: 'local-world', payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
  capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef: 'local-world',
    engineBounds: { min: [0, 0, 0], max: [9, 9, 9] }, limits: [],
    worldGeometry: { profileVersion: 'world-geometry/v1', geometryProfiles: ['voxel-grid/v1'], partition: { edge: [16, 16, 16] }, postWriteLighting: 'REQUIRED' }, recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    sessionDeleteSupported: true, imageMediaTypes: [], model: null,
    engineGuards: fixtureEngineGuards() } };

test('actual connection readback binds the current local world durably', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-local-'));
  try {
    const calls = [];
    const adapter = { protocolHandshake: g3CellHandshake(), async call(operation, request) {
      calls.push(operation);
      if (operation === 'DiscoverConnections') return {
        contractVersion: 'world-adapter/v8', requestId: request.requestId,
        result: { capabilityRevision: 'cap-1', connections: [{
          adapterId: 'hanaworlds-world-adapter', connectionRef: connection.connectionRef,
          worldRef: connection.worldRef, displayName: 'Local world',
          capabilityRevision: 'cap-1', payloadVersion: connection.payloadVersion,
          readiness: 'READY',
          connectionIncarnationRef: connection.connectionIncarnationRef }] }, error: null };
      if (operation === 'ReadLocalConnection') return {
        contractVersion: 'world-adapter/v8', requestId: request.requestId,
        result: connection, error: null };
      throw new Error(`unexpected adapter operation ${operation}`);
    } };
    const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter,
      sessions: fixtureSessions() });
    const selectionContext = await canvas.call('ReadWorldSelectionContext', {
      contractVersion: 'canvas/v7', sessionRef: 'session-1', requestId: 'context-1',
      worldRef: 'local-world' });
    assert.equal(selectionContext.error, null);
    assert.equal(selectionContext.result.selection.status, 'UNBOUND');
    // A caller only uses what it read: the published UNBOUND sessionRevision.
    const unboundRevision = selectionContext.result.selection.sessionRevision;
    const request = { contractVersion: 'canvas/v7', sessionRef: 'session-1', requestId: 'select-1',
      worldRef: 'local-world', connectionRef: 'local-connection',
      connectionIncarnationRef: 'socket-open-1', expectedRevision: unboundRevision,
      expectedContext: null };
    // An unpublished private constant is not a revision a fresh Session accepts.
    const privateConstant = await canvas.call('SelectWorldConnection',
      { ...request, requestId: 'select-private', expectedRevision: 'selection-0' });
    assert.equal(privateConstant.error?.code, 'STALE_REVISION');
    const wrongWorld = await canvas.call('SelectWorldConnection',
      { ...request, requestId: 'select-wrong-world', worldRef: 'other-world' });
    assert.notEqual(wrongWorld.error, null);
    assert.equal(canvas.current('session-1'), null);
    calls.length = 0;
    const result = await canvas.call('SelectWorldConnection', request);
    assert.equal(result.error, null, JSON.stringify(result.error));
    assert.equal(result.result.localContext.connectionIncarnationRef, 'socket-open-1');
    assert.deepEqual(calls, ['ReadLocalConnection',
      'DiscoverConnections']);
    // Read back the binding; reselection uses the published selectionRevision.
    const bound = await canvas.call('ReadWorldSelectionContext', {
      contractVersion: 'canvas/v7', sessionRef: 'session-1', requestId: 'context-2',
      worldRef: 'local-world' });
    assert.equal(bound.error, null, JSON.stringify(bound.error));
    assert.equal(bound.result.selection.status, 'BOUND');
    assert.equal(bound.result.selection.context.selectionRevision,
      result.result.selectionRevision);
    assert.equal(JSON.stringify(bound.result.selection.context.localContext),
      JSON.stringify(result.result.localContext));
    const staleUnbound = await canvas.call('SelectWorldConnection',
      { ...request, requestId: 'select-stale-unbound' });
    // A bound Session never accepts the unbound revision again (refused at admission).
    assert.equal(staleUnbound.error?.code, 'CURRENT_WORLD_MISMATCH');
    const reselected = await canvas.call('SelectWorldConnection', { ...request,
      requestId: 'select-2', expectedRevision: bound.result.selection.context.selectionRevision,
      expectedContext: bound.result.selection.context.localContext });
    assert.equal(reselected.error, null, JSON.stringify(reselected.error));
    assert.notEqual(reselected.result.selectionRevision, result.result.selectionRevision);
    const staleBound = await canvas.call('SelectWorldConnection', { ...request,
      requestId: 'select-3', expectedRevision: result.result.selectionRevision,
      expectedContext: reselected.result.localContext });
    // Canvas's bound-revision protection is unchanged.
    assert.equal(staleBound.error?.code, 'STALE_REVISION');
    const staleContext = await canvas.call('SelectWorldConnection', { ...request,
      requestId: 'select-4', expectedRevision: reselected.result.selectionRevision,
      expectedContext: result.result.localContext });
    assert.equal(staleContext.error?.code, 'CURRENT_WORLD_MISMATCH');
    assert.equal(canvas.current('session-1').selectionRevision,
      reselected.result.selectionRevision);
    const reopened = new CanvasV5({ store: await CanvasStore.open(directory), adapter,
      sessions: fixtureSessions() });
    assert.equal(JSON.stringify(reopened.current('session-1').localContext),
      JSON.stringify(reselected.result.localContext));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('build commits only after complete readback and stores one durable history row', async () => {
  const fixture = JSON.parse(await readFile(new URL(import.meta.resolve(
    'hanaworlds-contracts/fixtures/main'))));
  const D = (kind, value) => digestValue(kind, value).sha256;
  const profile = await mkdtemp(join(tmpdir(), 'canvas-build-'));
  const directory = join(profile, 'data', 'hanaworlds-canvas-v2');
  const saveState = async name => {
    if (process.env.CANVAS_RUNTIME_EVIDENCE)
      await writeFile(join(process.env.CANVAS_RUNTIME_EVIDENCE, name),
        await readFile(join(directory, 'canvas-v7.json')), { mode: 0o600 });
  };
  let runtime;
  try {
    const worldRef = fixture.request.worldRef;
    const connected = { ...connection, worldRef,
      capabilities: { ...connection.capabilities, worldRef } };
    const sessionRef = 'build-session';
    const position = [0, 1, 3];
    let record = { position, geometryProfile: 'voxel-grid/v1', materialRef: 'air',  orientation: 0,
      state: { inventory: {}, metadata: {}, timer: null } };
    let writes = 0;
    let restores = 0;
    let mismatchAfterApply = false;
    let restoreFails = false;
    let queryRequest = null;
    let queryBadPayload = false;
    let inspectionExtra = null;
    let inspectionRefusal = null;
    const preparedTransactions = new Set();
    let scopedFactReads = 0;
    let lastOpaqueDigest;
    let regionInspection;
    let inspectedObjectRef;
    let inspectedObjectRevision;
    const publicPort = process.env.CANVAS_NATIVEFACTS_NORMAL_ONLY ?
      await (await import('hanaworlds-canvas/examples/native-facts-consumer.mjs'))
        .createFixtureNativeFactsPort(consumer) : null;
    const nativeFacts = { async readScopedState(connectionRef, positions) {
      scopedFactReads++;
      assert.equal(connectionRef, connected.connectionRef);
      assert.deepEqual(positions, [position]);
      lastOpaqueDigest = createHash('sha256')
          .update('HanaWorlds|contracts@0.4.0|adapter-scoped-cell/v1\n')
          .update(canonicalize({ profile: stateProfile, record })).digest('hex');
      const expected = { worldRef, stateProfile, cells: [{ position,
        availability: 'KNOWN', stateDigest: lastOpaqueDigest }] };
      if (!publicPort) return expected;
      const raw = await publicPort.readScopedState(connectionRef, positions);
      assert.deepEqual(raw, expected);
      if (process.env.CANVAS_RUNTIME_EVIDENCE)
        await writeFile(join(process.env.CANVAS_RUNTIME_EVIDENCE, 'native-facts-original-call.json'),
          JSON.stringify({ method: 'readScopedState', arguments: [connectionRef, positions], rawReturn: raw }, null, 2), { mode: 0o600 });
      return raw;
    } };
    const calls = [];
    const adapter = { protocolHandshake: g3CellHandshake(), async call(operation, request) {
      calls.push(operation);
      const respond = result => guardSlot('world-adapter/v8', operation, { contractVersion: 'world-adapter/v8', requestId: request.requestId, result, error: null });
      if (operation === 'DiscoverConnections') return respond({
        capabilityRevision: 'cap-1', connections: [{
          adapterId: 'hanaworlds-world-adapter',
          connectionRef: connected.connectionRef, worldRef,
          displayName: 'Fixture local world', capabilityRevision: 'cap-1',
          payloadVersion: connected.payloadVersion, readiness: 'READY',
          connectionIncarnationRef: connected.connectionIncarnationRef }] });
      if (operation === 'ReadLocalConnection') return respond(connected);
      // FIXTURE: the engine refuses the inspection (guard at INSPECT_REGION), error beside refusal.
      if (operation === 'InspectRegion' && inspectionRefusal) return { contractVersion: 'world-adapter/v8',
        requestId: request.requestId, result: null, guardRefusal: inspectionRefusal,
        error: guardRefusalError(inspectionRefusal) };
      if (operation === 'InspectRegion') {
        const targetFacts = { ...fixture.request.regionInspection.targetFacts,
          worldRevision: request.expectedWorldRevision };
        const inspected = { ...fixture.request.regionInspection,
          inspectionId: request.inspectionId, placementSettings: request.placementSettings,
          targetFacts, targetFactsDigest: D('target-facts', targetFacts),
          evidence: { ...fixture.request.regionInspection.evidence,
            worldRevision: request.expectedWorldRevision } };
        // FIXTURE negative: a 0.x-style inspection carrying player geometry.
        if (inspectionExtra) return respond({ outcome: 'REGION_INSPECTED',
          inspection: { ...inspected, ...inspectionExtra } });
        regionInspection = inspected;
        return respond({ outcome: 'REGION_INSPECTED', inspection: regionInspection });
      }
      if (operation === 'InspectWorld') return respond({
        ...fixture.request.regionInspection.targetFacts, source: 'INSPECTED',
        worldRevision: request.expectedWorldRevision,
        objectRef: inspectedObjectRef,
        objectRevision: inspectedObjectRevision,
        sampledBounds: request.sampledBounds });
      if (operation === 'Readback') {
        if (!preparedTransactions.has(request.transactionId))
          throw new Error('STALE_TRANSACTION');
        const projection = { worldRef, coveredPositions: [position],
          records: [record], stateProfile };
        return respond({ projection, readbackDigest: D('readback', projection),
          adapterExecutionRevision: `execution-${writes}` });
      }
      if (operation === 'PrepareRecoverableTransaction') {
        assert.equal(request.scope.cells[0].stateDigest, lastOpaqueDigest);
        preparedTransactions.add(request.transactionId);
        const payload = { contractVersion: 'world-adapter/v8',
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
        if (restoreFails === 'QUERY_G1') throw Object.assign(new Error('RESTORE_FAILED'),
          { publicError: { code: 'RESTORE_FAILED', phase: 'apply', retryability: 'NEVER',
            mutationState: 'UNKNOWN', transactionRef: request.transactionId,
            causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' } });
        writes++;
        record = { ...record, materialRef: mismatchAfterApply ? 'fixture:wrong' : 'fixture:stone' };
        const projection = { worldRef, coveredPositions: [position], records: [record],
          stateProfile };
        return respond({ contractVersion: 'canvas/v7',
          transactionId: request.transactionId, operationDigest: request.operationDigest,
          transactionPayloadDigest: request.preparedTransaction.transactionPayloadDigest,
          status: 'VERIFIED', previousWorldRevision: writes === 1 ?
            fixture.request.targetFacts.worldRevision : 'world-3',
          observedWorldRevision: writes === 1 ? 'world-2' : 'world-4',
          readbackDigest: D('readback', projection),
          restoreStatus: 'NOT_REQUIRED', error: null, guardRefusal: null, applyFailure: null, localContext: request.localContext });
      }
      if (operation === 'QueryTransaction' && restoreFails === 'QUERY_G1') {
        return respond({ contractVersion: 'canvas/v7', transactionId: request.transactionId,
          operationDigest: queryRequest.operationDigest,
          transactionPayloadDigest: queryBadPayload ? '9'.repeat(64) : request.transactionPayloadDigest, status: 'RESTORE_FAILED',
          previousWorldRevision: queryRequest.expectedWorldRevision, observedWorldRevision: null,
          readbackDigest: null, restoreStatus: 'FAILED',
          error: guardRefusalError(G1_REFUSAL, { transactionRef: request.transactionId, cause: 'READBACK_MISMATCH' }),
          guardRefusal: G1_REFUSAL, applyFailure: { error: { code: 'READBACK_MISMATCH',
            phase: 'apply', retryability: 'NEVER', mutationState: 'UNKNOWN',
            transactionRef: request.transactionId, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' },
            guardRefusal: null }, localContext: request.localContext });
      }
      if (operation === 'RestoreTransaction') {
        restores++;
        if (restoreFails === 'QUERY_G1') throw Object.assign(new Error('RESTORE_FAILED'),
          { publicError: { code: 'RESTORE_FAILED', phase: 'apply', retryability: 'NEVER',
            mutationState: 'UNKNOWN', transactionRef: request.originTransactionId,
            causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' } });
        // G1 FIXTURE: the engine's BODY_CLEARANCE guard refuses the restore (a real body blocks a
        // solid target), with the public GuardRefusal beside the Contracts restore error. The
        // Adapter does not know why Canvas restores.
        // rc.3 engine form: no cause, nothing written; Canvas owns the transaction form.
        if (restoreFails === 'G1') return { contractVersion: 'world-adapter/v8',
          requestId: request.requestId, result: null, guardRefusal: G1_REFUSAL,
          error: guardRefusalError(G1_REFUSAL, { transactionRef: request.originTransactionId }) };
        // FIXTURE: a restore whose outcome the transport cannot tell (no receipt rule fits).
        if (restoreFails === 'UNKNOWN') throw new Error('FIXTURE_TRANSPORT_LOST');
        record = { ...record, materialRef: 'air' };
        const projection = { worldRef, coveredPositions: [position], records: [record],
          stateProfile };
        return respond({ contractVersion: 'canvas/v7',
          transactionId: request.originTransactionId,
          operationDigest: request.operationDigest,
          transactionPayloadDigest: '5'.repeat(64), status: 'ROLLED_BACK',
          previousWorldRevision: 'world-4', observedWorldRevision: 'world-5',
          readbackDigest: D('readback', projection),
          restoreStatus: 'VERIFIED_RESTORED', error: null, guardRefusal: null, applyFailure: null,
          localContext: request.localContext });
      }
      if (operation === 'PrepareHistoryTransaction') {
        preparedTransactions.add(request.transactionId);
        return respond({
        originTransactionId: request.originTransactionId,
        transactionId: request.transactionId, direction: 'UNDO',
        historyOperationDigest: request.historyOperationDigest,
        transactionPayloadDigest: '5'.repeat(64), beforeImageDigest: '6'.repeat(64),
        targetStateDigest: request.targetStateDigest, stateProfile,
        adapterExecutionRevision: `execution-${writes}`,
        guarantee: 'RECOVERABLE_VERIFIED', status: 'PREPARED',
        localContext: request.localContext });
      }
      if (operation === 'ApplyHistoryTransaction') {
        writes++;
        record = { ...record, materialRef: 'air' };
        const projection = { worldRef, coveredPositions: [position], records: [record],
          stateProfile };
        return respond({ contractVersion: 'canvas/v7',
          transactionId: request.transactionId,
          operationDigest: request.historyOperationDigest,
          transactionPayloadDigest: request.preparedHistoryTransaction.transactionPayloadDigest,
          status: 'VERIFIED', previousWorldRevision: 'world-2',
          observedWorldRevision: 'world-3', readbackDigest: D('readback', projection),
          restoreStatus: 'NOT_REQUIRED', error: null, guardRefusal: null, applyFailure: null, localContext: request.localContext });
      }
      throw new Error(`unexpected adapter operation ${operation}`);
    } };
    runtime = await openRuntime(profile, { adapter, nativeFacts });
    let canvas = runtime.canvas;
    assert.equal(canvas.status().storage, 'READY');
    const requirement = consumer.protocolRequirement('canvas/v7', []);
    assert.equal(consumer.checkProtocolCompatibility(canvas.protocolHandshake,
      [requirement]).result, 'PROTOCOL_COMPATIBLE');
    const unbound = await canvas.call('ReadWorldSelectionContext', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'unbound-build', worldRef });
    assert.equal(unbound.result.selection.status, 'UNBOUND');
    const selected = await canvas.call('SelectWorldConnection', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'select-build', worldRef,
      connectionRef: connected.connectionRef,
      connectionIncarnationRef: connected.connectionIncarnationRef,
      expectedRevision: unbound.result.selection.sessionRevision, expectedContext: null });
    assert.equal(selected.error, null);
    const localContext = selected.result.localContext;
    const initialWorldRevision = await canvas.readWorldRevision(worldRef);
    assert.equal(initialWorldRevision, 'world-0');
    const placement = await canvas.call('InspectPlacementRegion', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'inspect-placement', worldRef,
      anchor: { kind: 'CURRENT_VIEW', invocationId: 'confirmed-1' },
      footprint: { geometryProfile: 'voxel-grid/v1', widthCells: 1, depthCells: 1, heightCells: 1 }, localContext });
    assert.equal(placement.error, null, JSON.stringify(placement));
    assert.equal(placement.result.inspection.targetFacts.worldRevision, initialWorldRevision);
    assert.deepEqual({ ...placement.result.inspection.placementSettings },
      { frontGapCells: 2, forwardSearchCells: 16, lateralSearchCells: 8,
        verticalSearchCells: 4, settingsRevision: 'placement-0' });
    // rc.4: InspectPlacementRegion forwards the Adapter's guard refusal and its error unchanged.
    inspectionRefusal = { guard: 'CELL_PROTECTION', stage: 'INSPECT_REGION', finding: 'PROTECTED_CELL' };
    const refusedInspection = await canvas.call('InspectPlacementRegion', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'inspect-refused', worldRef,
      anchor: { kind: 'CURRENT_VIEW', invocationId: 'confirmed-refused' },
      footprint: { geometryProfile: 'voxel-grid/v1', widthCells: 1, depthCells: 1, heightCells: 1 }, localContext });
    inspectionRefusal = null;
    validateResponse('canvas/v7', 'InspectPlacementRegion', refusedInspection);
    assert.deepEqual({ ...refusedInspection.guardRefusal }, { guard: 'CELL_PROTECTION',
      stage: 'INSPECT_REGION', finding: 'PROTECTED_CELL' });
    assert.deepEqual({ ...refusedInspection.error }, { ...guardRefusalError(refusedInspection.guardRefusal) });
    assert.equal(placement.guardRefusal, null);
    // Contracts 1.x: no player geometry is accepted from the Adapter or persisted by Canvas.
    inspectionExtra = { bodyOccupiedPositions: [[0, 1, 3]] };
    const withBody = await canvas.call('InspectPlacementRegion', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'inspect-with-body', worldRef,
      anchor: { kind: 'CURRENT_VIEW', invocationId: 'confirmed-body' },
      footprint: { geometryProfile: 'voxel-grid/v1', widthCells: 1, depthCells: 1, heightCells: 1 }, localContext });
    inspectionExtra = null;
    assert.notEqual(withBody.error, null);
    assert.equal(withBody.result, null);
    const persisted = await readFile(join(directory, 'canvas-v7.json'), 'utf8');
    for (const word of ['bodyOccupiedPositions', 'avatarDimensions', 'collisionBox'])
      assert.equal(persisted.includes(word), false, word);
    const placementStore = await CanvasStore.open(directory);
    assert.equal(Object.keys(placementStore.snapshot.placementInspections).length, 1);
    assert.equal(placementStore.snapshot.placementInspections[
      placement.result.inspection.inspectionId].inspection.targetFacts.worldRevision,
    initialWorldRevision);
    const build = structuredClone(fixture.response.result.build);
    build.targetFactsDigest = regionInspection.targetFactsDigest;
    build.witnesses = build.witnesses.map(witness => ({ ...witness,
      targetFactsDigest: regionInspection.targetFactsDigest,
      facts: witness.facts.evidence ? { ...witness.facts,
        evidence: { ...witness.facts.evidence, worldRevision: initialWorldRevision } } :
        witness.facts }));
    const operations = { contractVersion: 'operations/v4',
      buildDigest: D('build', build), compilerRevision: 'brush-1',
      compilationConfigDigest: 'a'.repeat(64), worldRef,
      frameDigest: fixture.request.targetFacts.frameDigest,
      catalogueDigest: build.catalogueDigest,
      targetFactsDigest: regionInspection.targetFactsDigest,
      effects: [{ position, geometryProfile: 'voxel-grid/v1', materialRef: 'fixture:stone', orientation: 0 }] };
    const operationDigest = D('operations', operations);
    const analyzed = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'analyze-build', worldRef,
      transactionId: 'build-1', operations, operationDigest,
      expectedRevision: initialWorldRevision,
      expectedRegistryRevision: 'registry-0',
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(analyzed.error, null);
    assert.deepEqual([...analyzed.result.affectedObjectRefs], []);
    const apply = { contractVersion: 'canvas/v7', sessionRef,
      requestId: 'apply-build', worldRef, transactionId: 'build-1', operations,
      operationDigest, analysisDigest: D('affected-analysis', analyzed.result),
      decisionRevision: null,
      expectedWorldRevision: initialWorldRevision,
      expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED',
      regionInspectionBinding: { inspectionId: regionInspection.inspectionId,
        build }, localContext };
    const wrongInspection = await canvas.call('ApplyRecoverableCommit', {
      ...apply, requestId: 'apply-unregistered-inspection',
      regionInspectionBinding: { ...apply.regionInspectionBinding,
        inspectionId: 'unregistered-inspection' } });
    assert.equal(wrongInspection.error?.code, 'INSPECTION_FAILED');
    assert.equal(writes, 0);
    // Confirmed placement is made by the public contract from this actual fixture inspection.
    const proposal = createPlacementProposal(regionInspection, { kind: 'EXACT_CELLS', cells: [position] });
    const intent = { ...fixture.request.intent, confirmedIntent: {
      ...fixture.request.intent.confirmedIntent, placement: proposal } };
    apply.regionInspectionBinding.confirmedPlacement = confirmedPlacementBinding(intent);
    const shiftedOperations = { ...operations, effects: operations.effects.map(effect => ({
      ...effect, position: [effect.position[0] + 1, effect.position[1], effect.position[2]] })) };
    const shifted = await canvas.call('ApplyRecoverableCommit', { ...apply,
      requestId: 'apply-confirmed-A-effects-B', operations: shiftedOperations,
      operationDigest: D('operations', shiftedOperations) });
    const targetFailure = confirmedPlacement.namedFailures.find(f => f.failure === 'PLACEMENT_TARGET_MISMATCH');
    assert.equal(shifted.error?.code, targetFailure.code);
    assert.equal(shifted.error?.reason, targetFailure.reason);
    assert.equal(writes, 0, 'confirmed A / effects B is refused before any write');
    assert.equal(scopedFactReads, 0);
    const storedInspection = structuredClone(canvas.store.snapshot.placementInspections[regionInspection.inspectionId]);
    // SOURCE/FIXTURE: simulate a recorded source being replaced, with the same frame/facts/revision.
    // The old checks accepted this; the new public source identity check must run before facts or writes.
    await canvas.store.commit(next => {
      next.placementInspections[regionInspection.inspectionId].inspection.inspectionId = 'changed-recorded-inspection';
    });
    const sourceChanged = await canvas.call('ApplyRecoverableCommit', { ...apply, requestId: 'apply-changed-source' });
    const sourceFailure = confirmedPlacement.namedFailures.find(f => f.failure === 'PLACEMENT_INSPECTION_CHANGED');
    assert.equal(sourceChanged.error?.code, sourceFailure.code);
    assert.equal(sourceChanged.error?.reason, sourceFailure.reason);
    assert.equal(writes, 0, 'changed confirmation source cannot issue any Adapter write');
    assert.equal(scopedFactReads, 0, 'confirmed source is checked before new scoped facts');
    await canvas.store.commit(next => { next.placementInspections[regionInspection.inspectionId] = storedInspection; });
    const completed = await canvas.call('ApplyRecoverableCommit', apply);
    assert.equal(completed.error, null, JSON.stringify({ calls, completed,
      pending: canvas.store.snapshot.pending }));
    assert.equal(completed.result.status, 'VERIFIED');
    assert.equal(writes, 1);
    assert.equal(scopedFactReads, 1);
    const readbackRequest = {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'public-readback', worldRef,
      transactionId: 'build-1', commitRevision: completed.result.observedWorldRevision,
      expectedOperations: operations,
      transactionPayloadDigest: completed.result.transactionPayloadDigest,
      localContext };
    const publicReadback = await canvas.call('Readback', readbackRequest);
    assert.equal(publicReadback.error, null, JSON.stringify(publicReadback));
    assert.deepEqual(publicReadback.result, completed.result);
    const replay = await canvas.call('ApplyRecoverableCommit', apply);
    assert.equal(replay.result.transactionId, 'build-1');
    assert.equal(writes, 1);
    const reopened = await CanvasStore.open(directory);
    assert.equal(reopened.snapshot.transactions['build-1'].history.status, 'VERIFIED');
    assert.equal(reopened.snapshot.transactions['build-1'].displayMetadata.mode, 'CELL');
    assert.equal(reopened.snapshot.transactions['build-1'].displayMetadata.affectedCells, 1);
    assert.ok(Number.isFinite(Date.parse(reopened.snapshot.transactions['build-1'].displayMetadata.committedAt)));
    const objectRef = reopened.snapshot.transactions['build-1'].objectRef;
    const displayBeforeUndo = await canvas.readObjectsHistory(sessionRef);
    assert.equal(displayBeforeUndo.history[0].mode, 'CELL');
    assert.equal(displayBeforeUndo.history[0].affectedCells, 1);
    assert.deepEqual(displayBeforeUndo.objects[0].bounds.min, position);
    const objectRevision = reopened.snapshot.objects[worldRef][objectRef].objectRevision;
    inspectedObjectRef = objectRef;
    inspectedObjectRevision = objectRevision;
    await saveState('cell-before-normal-reopen.json');
    await runtime.dispose();
    runtime = await openRuntime(profile, { adapter, nativeFacts });
    canvas = runtime.canvas;
    const persistedCanvas = canvas;
    assert.equal(canvas.status().storage, 'READY');
    assert.equal(consumer.checkProtocolCompatibility(canvas.protocolHandshake,
      [requirement]).result, 'PROTOCOL_COMPATIBLE');
    const reopenedReadback = await canvas.call('Readback', {
      ...readbackRequest, requestId: 'readback-after-normal-reopen' });
    assert.equal(reopenedReadback.error, null, JSON.stringify(reopenedReadback));
    assert.deepEqual(reopenedReadback.result, completed.result);
    const footprints = await persistedCanvas.readFootprints(worldRef, [objectRef], {
      sessionRef, worldRef, localContext });
    assert.equal(footprints.current, true);
    assert.equal(footprints.durable, true);
    assert.deepEqual([...footprints.objects[0].positions[0]], position);
    assert.equal(footprints.objects[0].provenance, 'CANVAS_REGISTERED');
    await assert.rejects(() => persistedCanvas.readFootprints(worldRef, [objectRef], {
      sessionRef, worldRef,
      localContext: { ...localContext, connectionIncarnationRef: 'reopened-connection' } }),
    /CURRENT_WORLD_MISMATCH/);
    assert.equal(await persistedCanvas.readWorldRevision(worldRef), 'world-2');
    const historyFacts = await persistedCanvas.readHistoryFacts({
      sessionRef, worldRef, localContext, originTransactionId: 'build-1' });
    assert.equal(historyFacts.current, true);
    assert.equal(historyFacts.originVerifiedReceiptDigest,
      reopened.snapshot.transactions['build-1'].history.receiptDigest);
    assert.equal(historyFacts.objectRevisions[objectRef], objectRevision);
    const inspectObjectRequest = {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'inspect-object', worldRef,
      objectRef, expectedRevision: objectRevision,
      sampledBounds: fixture.request.regionInspection.targetFacts.sampledBounds,
      localContext };
    const inspectedObject = await canvas.call('InspectObject', inspectObjectRequest);
    assert.equal(inspectedObject.error, null, JSON.stringify(inspectedObject));
    assert.equal(inspectedObject.result.objectRef, objectRef);
    assert.equal(inspectedObject.result.objectRevision, objectRevision);
    assert.equal(inspectedObject.result.worldRevision, 'world-2');
    const objects = await canvas.call('ListObjects', { contractVersion: 'canvas/v7',
      sessionRef, requestId: 'list-objects', worldRef, expectedRevision: null,
      localContext });
    assert.equal(objects.error, null);
    assert.equal(objects.result.objects[0].objectRef, objectRef);
    const historyView = await canvas.call('HistoryQuery', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'history-build', worldRef,
      objectRef, expectedHistoryRevision: null, localContext });
    assert.equal(historyView.error, null);
    assert.equal(historyView.result.entries[0].transactionId, 'build-1');
    const conflictAnalysis = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'analyze-conflict', worldRef,
      transactionId: 'conflict-1', operations, operationDigest,
      expectedRevision: 'world-2',
      expectedRegistryRevision: reopened.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(conflictAnalysis.error, null);
    assert.deepEqual([...conflictAnalysis.result.affectedObjectRefs], [objectRef]);
    const conflict = await canvas.call('ApplyRecoverableCommit', {
      ...apply, requestId: 'apply-conflict', transactionId: 'conflict-1',
      analysisDigest: D('affected-analysis', conflictAnalysis.result),
      expectedWorldRevision: 'world-2', regionInspectionBinding: { inspectionId: apply.regionInspectionBinding.inspectionId, build: apply.regionInspectionBinding.build } });
    assert.equal(conflict.error.code, 'OTHER_OBJECTS_AFFECTED');
    assert.equal(writes, 1);
    const undoRequest = { contractVersion: 'canvas/v7',
      sessionRef, requestId: 'undo-build', worldRef, objectRef,
      transactionId: 'undo-1', historyTransactionId: 'build-1',
      expectedHistoryRevision: reopened.snapshot.history[objectRef][0].historyRevision,
      expectedWorldRevision: 'world-2',
      expectedObjectRevisions: { [objectRef]: objectRevision },
      intentDigest: '7'.repeat(64), surfaceActionDigest: '8'.repeat(64), localContext };
    const undo = await canvas.call('Undo', undoRequest);
    assert.equal(record.materialRef, 'air');
    assert.equal(undo.error, null, JSON.stringify({ undo, calls }));
    assert.equal(undo.result.status, 'VERIFIED');
    assert.equal(writes, 2);
    const undoReplay = await canvas.call('Undo', undoRequest);
    assert.equal(undoReplay.result.transactionId, 'undo-1');
    assert.equal(writes, 2);
    await saveState('cell-after-same-transaction-undo.json');
    const afterUndo = await CanvasStore.open(directory);
    assert.equal(afterUndo.snapshot.history[objectRef].at(-1).originTransactionId, 'build-1');
    if (process.env.CANVAS_NATIVEFACTS_NORMAL_ONLY) {
      assert.equal(writes, 2);
      console.log(JSON.stringify({ runtime: 'REAL_CORDIS_CANVAS_AND_FS_STORE',
        external: 'PUBLIC_NATIVE_FACTS_ADAPTER_AND_WORLD_FIXTURE', consumerVersion: consumer.version,
        publicFixtureConsumed: true, publicReadback: publicReadback.result.status,
        reopenedReadback: reopenedReadback.result.status, undo: undo.result.status,
        originalTransaction: 'build-1', undoTransaction: 'undo-1', writes, scopedFactReads,
        originalHistoryAssociation: afterUndo.snapshot.history[objectRef].at(-1).originTransactionId }));
      return;
    }
    const staleReadback = await canvas.call('Readback', readbackRequest);
    assert.equal(staleReadback.error?.code, 'STALE_REVISION');
    const staleObject = await canvas.call('InspectObject', inspectObjectRequest);
    assert.equal(staleObject.error?.code, 'STALE_REVISION');
    const undoneCanvas = new CanvasV5({ store: afterUndo, adapter, sessions: fixtureSessions() });
    assert.equal(afterUndo.snapshot.transactions['undo-1'].displayMetadata.mode, 'CELL');
    assert.equal(afterUndo.snapshot.transactions['undo-1'].displayMetadata.affectedCells, 1);
    assert.ok(Date.parse(afterUndo.snapshot.transactions['undo-1'].displayMetadata.committedAt) >= Date.parse(afterUndo.snapshot.transactions['build-1'].displayMetadata.committedAt));
    assert.equal(await undoneCanvas.readWorldRevision(worldRef), 'world-3');
    assert.deepEqual((await undoneCanvas.readFootprints(worldRef, [objectRef], {
      sessionRef, worldRef, localContext })).objects[0].positions, []);
    // Redo seam (real-GO finding): after Undo, the Adapter's history Prepare reads these facts
    // for the undone origin; the head is the Undo row, whose revision the Redo checks.
    const redoFacts = await undoneCanvas.readHistoryFacts({ sessionRef, worldRef,
      localContext, originTransactionId: 'build-1' });
    assert.equal(redoFacts.historyRevision, afterUndo.snapshot.history[objectRef].at(-1).historyRevision);
    assert.equal(redoFacts.originVerifiedReceiptDigest,
      afterUndo.snapshot.transactions['build-1'].history.receiptDigest);
    await assert.rejects(() => undoneCanvas.readHistoryFacts({ sessionRef, worldRef,
      localContext, originTransactionId: 'not-a-transaction' }), /UNDO_CONFLICT/);
    const wrongWorld = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'wrong-world',
      worldRef, transactionId: 'wrong-world-tx', operations, operationDigest,
      expectedRevision: 'world-3',
      expectedRegistryRevision: afterUndo.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision,
      localContext: { ...localContext, connectionIncarnationRef: 'socket-open-2' } });
    assert.equal(wrongWorld.error.code, 'CURRENT_WORLD_MISMATCH');
    assert.equal(writes, 2);
    const secondPlacement = await canvas.call('InspectPlacementRegion', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'inspect-rebuild', worldRef,
      anchor: { kind: 'CURRENT_VIEW', invocationId: 'confirmed-2' },
      footprint: { geometryProfile: 'voxel-grid/v1', widthCells: 1, depthCells: 1, heightCells: 1 }, localContext });
    assert.equal(secondPlacement.error, null);
    const secondInspection = secondPlacement.result.inspection;
    const secondBuild = structuredClone(build);
    secondBuild.targetFactsDigest = secondInspection.targetFactsDigest;
    secondBuild.witnesses = secondBuild.witnesses.map(witness => ({ ...witness,
      targetFactsDigest: secondInspection.targetFactsDigest,
      facts: witness.facts.evidence ? { ...witness.facts,
        evidence: { ...witness.facts.evidence, worldRevision: 'world-3' } } :
        witness.facts }));
    const secondOperations = { ...operations, buildDigest: D('build', secondBuild),
      targetFactsDigest: secondInspection.targetFactsDigest };
    const secondOperationDigest = D('operations', secondOperations);
    const secondBinding = { inspectionId: secondInspection.inspectionId,
      build: secondBuild };
    const badOperations = { ...secondOperations, effects: [{ position: [0, 1, 4], geometryProfile: 'voxel-grid/v1',
      materialRef: 'fixture:stone', orientation: 0 }] };
    const badOperationDigest = D('operations', badOperations);
    const badAnalysis = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'analyze-bad-geometry',
      worldRef, transactionId: 'bad-geometry', operations: badOperations,
      operationDigest: badOperationDigest, expectedRevision: 'world-3',
      expectedRegistryRevision: afterUndo.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(badAnalysis.error, null);
    const badGeometry = await canvas.call('ApplyRecoverableCommit', {
      ...apply, requestId: 'apply-bad-geometry', transactionId: 'bad-geometry',
      operations: badOperations, operationDigest: badOperationDigest,
      analysisDigest: D('affected-analysis', badAnalysis.result),
      expectedWorldRevision: 'world-3', regionInspectionBinding: secondBinding });
    assert.equal(badGeometry.error.code, 'CATALOGUE_MISMATCH');
    assert.equal(writes, 2);
    const reanalyzed = await canvas.call('AnalyzeAffectedObjects', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'analyze-rebuild', worldRef,
      transactionId: 'build-2', operations: secondOperations,
      operationDigest: secondOperationDigest,
      expectedRevision: 'world-3',
      expectedRegistryRevision: afterUndo.snapshot.registryRevisions[worldRef],
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(reanalyzed.error, null);
    mismatchAfterApply = true;
    const failed = await canvas.call('ApplyRecoverableCommit', {
      ...apply, requestId: 'apply-rebuild', transactionId: 'build-2',
      operations: secondOperations, operationDigest: secondOperationDigest,
      analysisDigest: D('affected-analysis', reanalyzed.result),
      expectedWorldRevision: 'world-3', regionInspectionBinding: secondBinding });
    assert.equal(failed.error, null, JSON.stringify({ failed, calls }));
    assert.equal(failed.result.status, 'ROLLED_BACK');
    assert.equal(restores, 1);
    await saveState('cell-after-rollback.json');
    const afterRollback = await CanvasStore.open(directory);
    assert.equal(afterRollback.snapshot.transactions['build-2'].receipt.status, 'ROLLED_BACK');
    assert.equal(afterRollback.snapshot.history[objectRef].length, 2);
    const selectedObject = await canvas.call('SetObjectSelection', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'select-object', worldRef,
      objectRefs: [objectRef],
      expectedSelectionRevision: selected.result.selectionRevision, localContext });
    assert.equal(selectedObject.error, null);
    const selectedContext = { ...localContext,
      selectionRevision: selectedObject.result.selectionRevision };
    const selectedView = await canvas.call('ReadWorldSelectionContext', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'selected-view', worldRef });
    assert.equal(selectedView.error, null);
    assert.equal(selectedView.result.selection.context.localContext.selectionRevision,
      selectedContext.selectionRevision);
    assert.deepEqual([...selectedView.result.selection.context.orderedSelectedObjectRefs],
      [objectRef]);
    assert.equal(calls.filter(operation => operation === 'DiscoverConnections').length, 2);
    console.log(JSON.stringify({ runtime: 'REAL_CORDIS_CANVAS_AND_FS_STORE',
      external: 'ADAPTER_AND_WORLD_FIXTURE', consumerVersion: consumer.version,
      publicReadback: publicReadback.result.status, reopenedReadback: reopenedReadback.result.status,
      undo: undo.result.status, originalTransaction: 'build-1', undoTransaction: 'undo-1',
      noDuplicateWrites: writes === 3, rollback: failed.result.status, restores }));
    // G1: a rollback the engine refuses is a canvas/v7 RESTORE_FAILED receipt pending manual
    // recovery, never success; an unknown restore outcome stays RECOVERY_PENDING.
    const registry = async () => (await CanvasStore.open(directory)).snapshot.registryRevisions[worldRef];
    const attempt = async (transactionId, invocationId) => {
      const worldNow = await canvas.readWorldRevision(worldRef);
      const placed = await canvas.call('InspectPlacementRegion', {
        contractVersion: 'canvas/v7', sessionRef, requestId: `inspect-${transactionId}`, worldRef,
        anchor: { kind: 'CURRENT_VIEW', invocationId },
        footprint: { geometryProfile: 'voxel-grid/v1', widthCells: 1, depthCells: 1, heightCells: 1 }, localContext: selectedContext });
      assert.equal(placed.error, null, JSON.stringify(placed));
      const inspection = placed.result.inspection;
      const nextBuild = structuredClone(build);
      nextBuild.targetFactsDigest = inspection.targetFactsDigest;
      nextBuild.witnesses = nextBuild.witnesses.map(witness => ({ ...witness,
        targetFactsDigest: inspection.targetFactsDigest,
        facts: witness.facts.evidence ? { ...witness.facts,
          evidence: { ...witness.facts.evidence, worldRevision: worldNow } } : witness.facts }));
      const nextOperations = { ...operations, buildDigest: D('build', nextBuild),
        targetFactsDigest: inspection.targetFactsDigest };
      const nextDigest = D('operations', nextOperations);
      const analysis = await canvas.call('AnalyzeAffectedObjects', {
        contractVersion: 'canvas/v7', sessionRef, requestId: `analyze-${transactionId}`, worldRef,
        transactionId, operations: nextOperations, operationDigest: nextDigest,
        expectedRevision: worldNow, expectedRegistryRevision: await registry(),
        expectedSelectionRevision: selectedObject.result.selectionRevision,
        localContext: selectedContext });
      assert.equal(analysis.error, null, JSON.stringify(analysis));
      return { ...apply, requestId: `apply-${transactionId}`, transactionId,
        operations: nextOperations, operationDigest: nextDigest,
        analysisDigest: D('affected-analysis', analysis.result),
        expectedWorldRevision: worldNow, localContext: selectedContext,
        regionInspectionBinding: { inspectionId: inspection.inspectionId, build: nextBuild } };
    };
    const g1Request = await attempt('build-3', 'confirmed-3');
    restoreFails = 'G1';
    const pendingRestore = await canvas.call('ApplyRecoverableCommit', g1Request);
    assert.equal(pendingRestore.error, null, JSON.stringify(pendingRestore));
    const g1Receipt = pendingRestore.result;
    assert.equal(g1Receipt.status, 'RESTORE_FAILED');
    assert.equal(g1Receipt.restoreStatus, 'FAILED');
    assert.equal(g1Receipt.readbackDigest, null);
    assert.equal(g1Receipt.observedWorldRevision, null);
    // causeCode names why Canvas restored; the restore's own reason is the guard refusal; the
    // causing failure is kept in full.
    assert.deepEqual({ ...g1Receipt.error }, { ...guardRefusalError(G1_REFUSAL,
      { transactionRef: 'build-3', cause: 'READBACK_MISMATCH' }) });
    assert.deepEqual({ ...g1Receipt.guardRefusal }, G1_REFUSAL);
    assert.equal(g1Receipt.applyFailure.error.code, 'READBACK_MISMATCH');
    assert.equal(g1Receipt.applyFailure.guardRefusal, null);
    assert.equal(restores, 2);
    const afterRestoreFailed = await CanvasStore.open(directory);
    assert.equal(afterRestoreFailed.snapshot.transactions['build-3'], undefined);
    assert.equal(afterRestoreFailed.snapshot.pending['build-3'].phase, 'RESTORE_PENDING');
    // The store keeps the engine's own code (engine form); the receipt is the transaction form.
    assert.equal(afterRestoreFailed.snapshot.pending['build-3'].restoreCode, 'SAFETY_INVARIANT_FAILED');
    assert.equal(g1Receipt.error.code, 'RESTORE_FAILED');
    assert.equal(afterRestoreFailed.snapshot.pending['build-3'].causeCode, 'READBACK_MISMATCH');
    let actions = await canvas.readHistoryActions(sessionRef);
    assert.deepEqual(actions.recovery, [{ transactionId: 'build-3', mode: 'CELL',
      phase: 'RESTORE_PENDING', recoveryPending: true, receiptStatus: 'RESTORE_FAILED',
      guardRefusal: G1_REFUSAL, restoreCode: 'SAFETY_INVARIANT_FAILED', causeCode: 'READBACK_MISMATCH',
      mutationState: 'UNKNOWN', abortConfirmation: null, originalFailure: null, queryFailure: null }]);
    assert.ok(actions.objects.every(row => row.undo.reason === 'TRANSACTION_PENDING' ||
      row.undo.reason === 'NOTHING_TO_UNDO'));
    // The same request replays the same receipt and never writes or restores again.
    const writesBefore = writes;
    const repeated = await canvas.call('ApplyRecoverableCommit', g1Request);
    assert.deepEqual(repeated, pendingRestore);
    assert.equal(writes, writesBefore);
    assert.equal(restores, 2);
    // The World stays blocked: a new BUILD is refused while recovery is pending.
    const blockedRequest = { ...g1Request, requestId: 'apply-blocked', transactionId: 'build-4' };
    assert.notEqual((await canvas.call('ApplyRecoverableCommit', blockedRequest)).error, null);
    assert.equal(writes, writesBefore);
    // Real Adapter 0.12.1 throws a simplified RESTORE_FAILED from rollback. The full,
    // durable error + guard + original failure are available through QueryTransaction.
    const queryStore = await CanvasStore.open(directory);
    await queryStore.commit(state => { delete state.pending['build-3']; });
    await runtime.dispose();
    runtime = await openRuntime(profile, { adapter, nativeFacts });
    canvas = runtime.canvas;
    restoreFails = 'QUERY_G1';
    queryRequest = await attempt('build-query-g1', 'confirmed-query-g1');
    const queryResult = await canvas.call('ApplyRecoverableCommit', queryRequest);
    assert.equal(queryResult.error, null, JSON.stringify(queryResult));
    assert.equal(queryResult.result.status, 'RESTORE_FAILED');
    assert.equal(queryResult.result.error.causeCode, 'READBACK_MISMATCH');
    assert.equal(queryResult.result.applyFailure.error.code, 'READBACK_MISMATCH');
    assert.deepEqual({ ...queryResult.result.guardRefusal }, G1_REFUSAL);
    const queryView = await canvas.readHistoryActions(sessionRef);
    assert.equal(queryView.recovery[0].receiptStatus, 'RESTORE_FAILED');
    assert.equal(queryView.recovery[0].causeCode, 'READBACK_MISMATCH');
    assert.deepEqual(queryView.recovery[0].guardRefusal, G1_REFUSAL);
    const queryCount = calls.filter(op => op === 'QueryTransaction').length;
    assert.equal(queryCount, 1);
    assert.deepEqual(await canvas.call('ApplyRecoverableCommit', queryRequest), queryResult);
    assert.equal(calls.filter(op => op === 'QueryTransaction').length, queryCount);
    await canvas.store.commit(state => { delete state.pending['build-query-g1']; });
    queryBadPayload = true;
    queryRequest = await attempt('build-query-mismatch', 'confirmed-query-mismatch');
    const queryMismatch = await canvas.call('ApplyRecoverableCommit', queryRequest);
    assert.equal(queryMismatch.result, null);
    assert.equal(queryMismatch.error.code, 'RECOVERY_PENDING');
    assert.equal(canvas.store.snapshot.pending['build-query-mismatch'].receiptStatus, 'RECOVERY_PENDING');
    assert.ok(canvas.store.snapshot.pending['build-query-mismatch'].receiptRejected);
    await canvas.store.commit(state => { delete state.pending['build-query-mismatch']; });
    queryBadPayload = false;

    // An unknown restore outcome (transport lost) is RECOVERY_PENDING, not a receipt.
    const unknownDirectory = await mkdtemp(join(tmpdir(), 'canvas-g1-unknown-'));
    await rm(unknownDirectory, { recursive: true, force: true });
    restoreFails = 'UNKNOWN';
    const pendingStore = await CanvasStore.open(directory);
    delete pendingStore.snapshot.pending['build-3'];
    await pendingStore.commit(state => { delete state.pending['build-3']; });
    await runtime.dispose();
    runtime = await openRuntime(profile, { adapter, nativeFacts });
    canvas = runtime.canvas;
    const unknownRequest = await attempt('build-5', 'confirmed-5');
    const lost = await canvas.call('ApplyRecoverableCommit', unknownRequest);
    assert.equal(lost.result, null);
    assert.equal(lost.error.code, 'RECOVERY_PENDING');
    assert.equal(lost.error.mutationState, 'UNKNOWN');
    actions = await canvas.readHistoryActions(sessionRef);
    assert.equal(actions.recovery.find(row => row.transactionId === 'build-5').receiptStatus,
      'RECOVERY_PENDING');
  } finally { await runtime?.dispose(); await rm(profile, { recursive: true, force: true }); }
});

test('host exposes durable Canvas facts as separate public ports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-host-'));
  try {
    const ports = new Map();
    const homePath = (...parts) => join(directory, ...parts);
    const ctx = { get: name => name === 'dshHomePath' ? homePath : null,
      provide: (name, port) => ports.set(name, port) };
    const canvas = applyCanvas(ctx);
    await canvas.ready;
    assert.equal(canvas.storageState, 'READY');
    assert.equal(typeof ports.get('hanaworldsCanvasFootprintRegistry')?.readFootprints, 'function');
    assert.equal(typeof ports.get('hanaworldsCanvasHistoryFacts')?.read, 'function');
    assert.equal(typeof ports.get('hanaworldsWorldRevisionOracle')?.read, 'function');
    assert.equal(ports.has('hanaworldsLuantiInspectionContext'), false);
    const advertised = ports.get('hanaworldsCanvasV5').contractHandshake;
    // Canvas advertises the identity of the Contracts package it runs on (the resolved
    // commit is the lockfile's job). Consumers decide it with the Contracts same-major
    // predicate only; its cell admission uses ProtocolHandshake.
    const entry = process.env.CANVAS_ENTRY ?? new URL('../src/index.mjs', import.meta.url).href;
    const running = createRequire(entry)('hanaworlds-contracts/package.json');
    assert.equal(advertised.contracts, `hanaworlds-contracts@${running.version}`);
    assert.equal(ports.get('hanaworldsCanvasV5').status().version, '0.15.1');
    assert.doesNotThrow(() => checkContractHandshake(advertised));
    // Public Contracts conformance cases, each patched over Canvas's advertised handshake.
    const patched = c => { const h = { ...advertised, ...c.patch };
      if (c.dropWire) h.wireVersions = h.wireVersions.filter(w => w !== c.dropWire); return h; };
    for (const c of majorCompat.contractHandshake.accept)
      assert.equal(checkContractHandshake(patched(c)).result, c.expect, c.title);
    for (const c of majorCompat.contractHandshake.reject)
      assert.throws(() => checkContractHandshake(patched(c)), error =>
        error.code === c.error.code && error.reason === c.error.reason, c.title);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
