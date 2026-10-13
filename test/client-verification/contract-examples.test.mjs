import test from 'node:test';
import assert from 'node:assert/strict';
import { examples, checkEnvelope, bind } from './contracts.mjs';
import { contractMetadata } from '../../src/protocol/local/generated/contracts.mjs';
import { validateRequest, validateResponse, validateType, validateCanvasEvent,
  validateRegionUndo, validateScopedRegionUndo } from '../../src/protocol/local/index.mjs';
import { summaryRequest, summarySource } from '../../src/tool-summary.mjs';
import { displayDescriptor, actionsDescriptor, undoDescriptor, changesDescriptor } from '../../src/display-remote.mjs';

test('complete examples close all published Canvas operations and the five documented events', () => {
  const published = ['canvas/v7', 'canvas-region/v3'].flatMap(wire => contractMetadata.operations[wire].map(c => wire + '/' + c.operation)).sort();
  assert.deepEqual(examples.cases.map(c => c.wire + '/' + c.id).sort(), published);
  assert.deepEqual([...new Set(examples.events.map(e => e.name))].sort(),
    ['WorldConnectionSelectionChanged', 'ActiveWorldChanged', 'AffectedObjectNotificationRequired', 'TransactionVerified', 'HistoryPositionChanged'].sort());
});

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
  for (const event of item.success.events) {
    validateCanvasEvent(event.event, event);
    assert.equal(event.receipt.requestId, item.success.response.requestId);
    assert.deepEqual(event.receipt.result, item.success.response.result);
  }
  assert.deepEqual(item.refusal.events, []); assert.deepEqual(item.replay.events, []);
  assert.equal(item.refusal.response.error.mutationState, 'NONE');
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
});
