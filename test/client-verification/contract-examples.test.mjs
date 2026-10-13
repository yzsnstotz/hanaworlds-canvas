import test from 'node:test';
import assert from 'node:assert/strict';
import { examples, checkEnvelope, bind } from './contracts.mjs';
import { contractMetadata } from '../../src/protocol/local/generated/contracts.mjs';
import { validateRequest, validateResponse, validateType, validateCanvasEvent,
  validateRegionUndo, validateScopedRegionUndo, digestValue } from '../../src/protocol/local/index.mjs';
import { summaryRequest, summarySource } from '../../src/tool-summary.mjs';
import { displayDescriptor, actionsDescriptor, undoDescriptor, changesDescriptor } from '../../src/display-remote.mjs';

test('complete examples close all published Canvas operations and the five documented events', () => {
  const published = ['canvas/v7', 'canvas-region/v3'].flatMap(wire => contractMetadata.operations[wire].map(c => wire + '/' + c.operation)).sort();
  assert.deepEqual(examples.cases.map(c => c.wire + '/' + c.id).sort(), published);
  assert.deepEqual([...new Set(examples.events.map(e => e.name))].sort(),
    ['WorldConnectionSelectionChanged', 'ActiveWorldChanged', 'AffectedObjectNotificationRequired', 'TransactionVerified', 'HistoryPositionChanged'].sort());
  assert.equal(examples.cases.length, 29); assert.equal(examples.events.length, 6);
  assert.equal(examples.local.length, 17); assert.equal(examples.business.length, 11);
  assert.deepEqual(examples.scenarios.map(s => s.kind), ['DIRECT_DECISION', 'APPLY_NULL_DECISION']);
});

const operation = id => examples.cases.find(c => c.id === id);
const analysisDigest = value => digestValue('affected-analysis', value).sha256;

function documentedBindings(pair, bindings) {
  assert.ok(bindings.every(row => /^\/(request|response|events|failure)\//.test(row.path)));
  for (const row of bindings) {
    const value = row.path.slice(1).split('/').reduce((parent, key) => parent?.[key], pair);
    if (value === undefined) continue;
    assert.equal(typeof value, 'string', 'Binding preserves an opaque scalar, never a set or response subtree');
    assert.equal(value, row.example);
  }
  const rows = bindings.filter(row => row.path.slice(1).split('/').reduce((parent, key) => parent?.[key], pair) !== undefined)
    .map(row => ({ ...row, value: row.example, observedBeforeCall: true }));
  assert.deepEqual(bind(pair, rows, bindings), pair, 'Static example binding remains compatible with the unchanged locked validator');
}

function decisionRelation(request, response) {
  checkEnvelope(operation('DecideAffectedObjectNotification'), request, response);
  assert.equal(request.analysisDigest, analysisDigest(request.analysis));
  assert.equal(request.analysisRevision, request.analysisDigest, 'The generation is the exact complete analysis digest');
  assert.equal(response.result.transactionId, request.transactionId);
  assert.equal(response.result.analysisDigest, request.analysisDigest);
  assert.equal(response.result.decisionKind, request.decision);
  assert.deepEqual(response.result.affectedObjectRefs, request.analysis.affectedObjectRefs);
  assert.deepEqual(response.result.orderedSelectedRefs, request.analysis.orderedSelectedRefs);
}

function prepareRelation(chain, applyRequest, requireDecision) {
  assert.equal(chain.classification, 'COMPLETE_DOCUMENT_DATA_NOT_RUNTIME_EVIDENCE');
  assert.equal(chain.steps.length, requireDecision ? 3 : 1);
  for (const step of chain.steps) {
    checkEnvelope(operation(step.operation), step.request, step.response);
    assert.deepEqual(step.events, []);
    documentedBindings({ request: step.request, response: step.response }, step.bindings);
  }
  const [analyze, decide, persisted] = chain.steps;
  assert.equal(analyze.operation, 'AnalyzeAffectedObjects');
  assert.deepEqual(analyze.request.operations, applyRequest.operations);
  assert.equal(analyze.request.operationDigest, applyRequest.operationDigest);
  assert.equal(analyze.response.result.worldRevision, applyRequest.expectedWorldRevision);
  assert.equal(analyze.request.expectedRevision, analyze.response.result.worldRevision);
  assert.equal(analyze.request.expectedRegistryRevision, analyze.response.result.registryRevision);
  assert.equal(analyze.request.expectedSelectionRevision, analyze.response.result.selectionRevision);
  assert.deepEqual(analyze.response.result.affectedObjectRefs, []);
  assert.deepEqual(analyze.response.result.orderedSelectedRefs, []);
  assert.equal(applyRequest.analysisDigest, analysisDigest(analyze.response.result));
  for (const step of chain.steps) for (const key of ['sessionRef', 'worldRef', 'transactionId', 'localContext'])
    assert.deepEqual(step.request[key], applyRequest[key]);
  if (!requireDecision) { assert.equal(applyRequest.decisionRevision, null); return; }
  assert.equal(decide.operation, 'DecideAffectedObjectNotification');
  assert.equal(decide.mode, 'ok'); assert.equal(decide.request.decision, 'NO_NOTIFICATION');
  assert.equal(decide.request.expectedDecisionRevision, null);
  assert.deepEqual(decide.request.analysis, analyze.response.result);
  decisionRelation(decide.request, decide.response);
  assert.notEqual(decide.response.result.decisionRevision, null);
  assert.equal(persisted.operation, decide.operation); assert.equal(persisted.mode, 'replay');
  assert.deepEqual(persisted.request, decide.request); assert.deepEqual(persisted.response, decide.response);
  assert.deepEqual(persisted.worldWrites, []);
  assert.equal(applyRequest.decisionRevision, persisted.response.result.decisionRevision);
}

for (const item of examples.cases) test(`document full request/success/refusal ${item.id}`, () => {
  checkEnvelope(item, item.request, item.response);
  if (item.id === 'UndoRegionCommit') validateRegionUndo(item.request, item.response, item.origin.result);
  if (item.id === 'UndoScopedRegionCommit') validateScopedRegionUndo(item.request, item.response, item.origin);
  validateResponse(item.wire, item.id, item.failure);
  assert.throws(() => validateRequest(item.wire, item.id, item.invalidRequest),
    e => e.publicError?.code === item.failure.error.code && e.publicError.phase === item.failure.error.phase);
  assert.notEqual(item.response.result, null); assert.equal(item.response.error, null);
  assert.equal(item.failure.result, null); assert.equal(item.failure.error.mutationState, 'NONE');
  assert.equal(item.failure.error.transactionRef, null);
});

for (const item of examples.events) test(`document event success/refusal/replay ${item.id}`, () => {
  const actualOperation = item.name === 'TransactionVerified' ? 'ApplyRecoverableCommit' : item.trigger;
  for (const mode of ['success', 'refusal', 'replay']) {
    const pair = item[mode];
    if (mode === 'refusal') {
      validateResponse('canvas/v7', actualOperation, pair.response);
      assert.throws(() => validateRequest('canvas/v7', actualOperation, pair.request),
        error => error.publicError?.code === pair.response.error.code && error.publicError.phase === pair.response.error.phase);
    } else checkEnvelope(operation(actualOperation), pair.request, pair.response);
  }
  assert.deepEqual(item.replay.request, item.success.request);
  assert.deepEqual(item.replay.response, item.success.response, 'Replay preserves the complete actual public API return');
  if (item.name === 'AffectedObjectNotificationRequired') {
    assert.equal(item.trigger, 'AnalyzeAffectedObjects');
    for (const mode of ['success', 'refusal', 'replay']) {
      assert.equal(item[mode].actualTrigger.operation, item.trigger);
      assert.deepEqual(item[mode].actualTrigger.request, item[mode].request);
      assert.deepEqual(item[mode].actualTrigger.response, item[mode].response);
    }
    for (const mode of ['success', 'replay']) {
      const pair = item[mode], internal = pair.internalDecision;
      assert.equal(internal.operation, 'DecideAffectedObjectNotification');
      assert.deepEqual(Object.keys(internal).sort(), ['operation', 'response'], 'No fabricated internal public Decision request');
      validateResponse('canvas/v7', internal.operation, internal.response);
      assert.equal(internal.response.requestId, pair.request.requestId);
      assert.equal(internal.response.result.transactionId, pair.request.transactionId);
      assert.equal(internal.response.result.analysisDigest, analysisDigest(pair.response.result));
      assert.equal(internal.response.result.decisionKind, 'BLOCK_AND_NOTIFY');
      for (const key of ['orderedSelectedRefs', 'affectedObjectRefs'])
        assert.deepEqual(internal.response.result[key], pair.response.result[key]);
      assert.notDeepEqual(pair.response, internal.response, 'The Decision receipt cannot stand in for Analyzer response');
      documentedBindings({ response: internal.response }, item.internalDecisionBindings);
    }
    assert.deepEqual(item.replay.internalDecision, item.success.internalDecision);
    assert.equal(item.replay.internalDecisionSource, 'PRIOR_DURABLE_RECEIPT_NOT_ANALYZER_RETURN');
  }
  for (const event of item.success.events) {
    validateCanvasEvent(event.event, event);
    const receipt = item.name === 'AffectedObjectNotificationRequired' ? item.success.internalDecision.response : item.success.response;
    assert.equal(event.receipt.requestId, receipt.requestId);
    assert.deepEqual(event.receipt.result, receipt.result);
    if (item.name === 'AffectedObjectNotificationRequired') assert.deepEqual(event.receipt, receipt);
  }
  assert.deepEqual(item.refusal.events, []); assert.deepEqual(item.replay.events, []);
  assert.equal(item.refusal.response.error.mutationState, 'NONE');
  documentedBindings(item.success, item.bindings);
});

for (const item of examples.scenarios) test(`document separate scenario success/refusal/replay ${item.id}`, () => {
  checkEnvelope(operation(item.operation), item.success.request, item.success.response);
  checkEnvelope(operation(item.operation), item.replay.request, item.replay.response);
  validateResponse(item.wire, item.operation, item.refusal.response);
  assert.throws(() => validateRequest(item.wire, item.operation, item.refusal.request),
    error => error.publicError?.code === item.refusal.response.error.code && error.publicError.phase === item.refusal.response.error.phase);
  assert.deepEqual(item.replay.request, item.success.request); assert.deepEqual(item.replay.response, item.success.response);
  assert.deepEqual(item.refusal.events, []); assert.deepEqual(item.replay.events, []);
  assert.equal(item.refusal.response.error.mutationState, 'NONE');
  assert.equal(item.refusal.response.error.transactionRef, null);
  assert.equal(item.refusal.response.requestId, item.refusal.request.requestId);
  documentedBindings(item.success, item.bindings);
  for (const event of item.success.events) {
    validateCanvasEvent(event.event, event);
    assert.equal(event.receipt.requestId, item.success.response.requestId);
    assert.deepEqual(event.receipt.result, item.success.response.result);
  }
  if (item.kind === 'DIRECT_DECISION') {
    decisionRelation(item.success.request, item.success.response);
    decisionRelation(item.replay.request, item.replay.response);
    assert.equal(item.success.events.length, 1);
    assert.deepEqual(item.success.events[0].receipt, item.success.response);
  } else {
    prepareRelation(item.prepareChain, item.success.request, false);
    assert.equal(item.success.events[0].event, 'TransactionVerified');
  }
});

test('non-null Apply keeps a complete public durable NO_NOTIFICATION preparation chain', () => {
  const apply = operation('ApplyRecoverableCommit');
  assert.notEqual(apply.request.decisionRevision, null);
  prepareRelation(apply.prepareChain, apply.request, true);
  const verified = examples.events.find(e => e.name === 'TransactionVerified');
  prepareRelation(verified.prepareChain, verified.success.request, true);
});

for (const item of examples.business) test(`document complete business refusal ${item.id}`, () => {
  validateType(item.requestType, item.request); validateResponse(item.wire, item.id, item.response);
  assert.equal(item.response.requestId, item.request.requestId); assert.equal(item.response.result, null);
  assert.equal(item.response.error.mutationState, 'NONE'); assert.equal(item.response.error.phase, 'validate');
  assert.deepEqual(item.events, []); assert.deepEqual(item.worldWrites, []);
});

test('additive facts, error relay, display and navigation have complete examples', () => {
  const summary = examples.local.find(c => c.id === 'readToolSummary');
  summaryRequest(summary.request); summarySource(summary.response.source);
  assert.throws(() => summaryRequest(summary.invalidRequest), e => e.publicError?.code === summary.failure.publicError.code);
  const foreign = examples.local.find(c => c.id === 'Error.source').response.publicError;
  validateType('Error', foreign);
  assert.deepEqual(Object.keys(foreign.source).sort(), ['kind', 'nativeCode', 'operation', 'owner', 'resource']);
  for (const [id, descriptor] of [['display.read', displayDescriptor], ['display.actions', actionsDescriptor], ['display.undo', undoDescriptor], ['display.redo', undoDescriptor], ['display.changes', changesDescriptor]])
    descriptor.result.create().parse(examples.local.find(c => c.id === id).response);
  for (const [id, code] of [['display.undo', 'canvas/undo-rejected'], ['display.redo', 'canvas/redo-rejected']])
    assert.deepEqual(examples.local.find(c => c.id === id).failure,
      { code, message: 'Canvas has no such object in this Session world.', details: { reason: 'OBJECT_NOT_FOUND' } });
  const panel = examples.local.find(c => c.id === 'panelId');
  assert.equal(panel.response.main.key, panel.response.sidebar.id);
  const objects = examples.cases.find(c => c.id === 'ListObjects').response.result.objects;
  assert.ok(objects.length > 0);
  for (const id of ['NameObject', 'RenameObject']) {
    const c = examples.cases.find(c => c.id === id); assert.equal(c.response.result.displayName, c.request.name);
  }
});

test('example binding cannot convert status/policy/geometry into a passing response', () => {
  const item = examples.cases.find(c => c.id === 'ApplyRecoverableCommit');
  assert.throws(() => bind({ request: item.request, response: item.response },
    [{ path: '/response/result/status', kind: 'Ref', example: 'VERIFIED', value: 'ROLLED_BACK', observedBeforeCall: true }], item.bindings));
  const row = item.bindings.find(x => x.path === '/request/worldRef');
  assert.throws(() => bind({ request: item.request }, [{ ...row, value: 'another-world', observedBeforeCall: false }], item.bindings));
  const notify = examples.events.find(e => e.name === 'AffectedObjectNotificationRequired');
  for (const path of ['/response/result/affectedObjectRefs', '/internalDecision/response/result/decisionKind'])
    assert.throws(() => bind(notify.success, [{ path, kind: 'Ref', example: null, value: 'replacement', observedBeforeCall: true }], notify.bindings));
  for (const step of item.prepareChain.steps) assert.ok(step.bindings.every(row => /^\/(request|response)\//.test(row.path)),
    'Each public preparation step uses the locked validator relative request/response paths');
});
