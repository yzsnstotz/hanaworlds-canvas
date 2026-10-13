import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { productBrowser } from './browser.mjs';
import { examples, bind, checkActual, checkLocal, checkEnvelope, checkSnapshot } from './contracts.mjs';
import { validateCanvasEvent, validateResponse, digestValue } from '../../src/protocol/local/index.mjs';

let browser;
const successfulEvents = new Map(), successfulScenarios = new Map();
const operation = id => examples.cases.find(item => item.id === id);
const analysisDigest = value => digestValue('affected-analysis', value).sha256;

// The original coverage is mandatory; the two Q-178 scenarios are additive.
assert.equal(examples.cases.length, 29); assert.equal(examples.local.length, 17);
assert.equal(examples.events.length, 6); assert.equal(new Set(examples.events.map(item => item.name)).size, 5);
assert.equal(examples.business.length, 11);
assert.deepEqual(examples.scenarios.map(item => item.kind).sort(), ['APPLY_NULL_DECISION', 'DIRECT_DECISION']);
before(async () => { browser = await productBrowser(); });
after(() => browser?.close());

function provider(value, key = 'hanaworldsCanvasV5') {
  assert.equal(value.execution, 'INSTALLED_CLIENT_TO_REGISTERED_PROVIDER');
  assert.equal(value.provider.origin, 'OFFICIAL_LOADER');
  assert.equal(value.provider.state, 'ACTIVE');
  assert.equal(value.provider.rootRef, browser.inspect.host.rootRef);
  assert.equal(value.provider.instanceRef, browser.inspect.providers[key].instanceRef);
  assert.equal(value.provider.registrationRef, browser.inspect.providers[key].registrationRef);
}

function publicCall(value, call, after = -1, key = 'hanaworldsCanvasV5') {
  assert.ok(Array.isArray(value.publicCalls), 'Capture actual public calls; a copied preparation receipt is not execution evidence');
  const index = value.publicCalls.findIndex((row, position) => position > after && row.service === key
    && row.operation === call.operation && isDeepStrictEqual(row.request, call.request) && isDeepStrictEqual(row.response, call.response));
  assert.ok(index > after, `Actual ordered ${call.operation} call/complete return is missing`);
  const row = value.publicCalls[index];
  assert.equal(row.ownerRef, browser.inspect.providers[key].instanceRef, 'Actual call owner must be the current official registered instance');
  assert.equal(row.phase, 'result', 'A complete returned public envelope must retain the actual result phase');
  assert.equal(row.error, null, 'A returned public envelope cannot be replaced by a fabricated successful throw outcome');
  return index;
}

function prepareChain(item, value, mainCall) {
  const declared = item.prepareChain?.steps;
  assert.ok(declared?.length, 'Full documented preparation steps are required');
  const observed = value.prepareChain?.steps;
  assert.equal(observed?.length, declared.length, 'Every public preparation call must execute and retain its complete return');
  let previous = -1;
  for (const [index, expectedStep] of declared.entries()) {
    const actual = observed[index];
    assert.equal(actual.operation, expectedStep.operation); assert.equal(actual.mode, expectedStep.mode);
    const expected = bind({ request: expectedStep.request, response: expectedStep.response, events: expectedStep.events },
      actual.actualBindings, expectedStep.bindings);
    assert.deepEqual(actual.request, expected.request); assert.deepEqual(actual.response, expected.response);
    assert.deepEqual(actual.events, expected.events);
    checkEnvelope(operation(actual.operation), actual.request, actual.response);
    assert.equal(actual.response.error, null);
    previous = publicCall(value, actual, previous);
    for (const key of ['sessionRef', 'worldRef', 'transactionId']) assert.equal(actual.request[key], mainCall.request[key]);
    assert.deepEqual(actual.request.localContext, mainCall.request.localContext);
  }
  publicCall(value, mainCall, previous);
  const [analyzed, decided, replayed] = observed;
  assert.equal(analyzed.operation, 'AnalyzeAffectedObjects');
  assert.deepEqual(analyzed.request.operations, mainCall.request.operations);
  assert.equal(analyzed.request.operationDigest, mainCall.request.operationDigest);
  assert.equal(analyzed.response.result.worldRevision, mainCall.request.expectedWorldRevision);
  assert.deepEqual(analyzed.response.result.affectedObjectRefs, []);
  assert.deepEqual(analyzed.response.result.orderedSelectedRefs, []);
  assert.equal(mainCall.request.analysisDigest, analysisDigest(analyzed.response.result));
  if (mainCall.request.decisionRevision === null) {
    assert.equal(observed.length, 1, 'The existing null-decision route must not invent a persisted Decision');
    return;
  }
  assert.equal(observed.length, 3); assert.equal(decided.operation, 'DecideAffectedObjectNotification');
  assert.deepEqual(decided.request.analysis, analyzed.response.result);
  assert.equal(decided.request.analysisDigest, mainCall.request.analysisDigest);
  assert.equal(decided.request.analysisRevision, mainCall.request.analysisDigest);
  assert.equal(decided.request.decision, 'NO_NOTIFICATION'); assert.equal(decided.request.expectedDecisionRevision, null);
  assert.equal(decided.response.result.decisionKind, 'NO_NOTIFICATION');
  assert.deepEqual(decided.response.result.affectedObjectRefs, []); assert.deepEqual(decided.response.result.orderedSelectedRefs, []);
  assert.equal(replayed.operation, decided.operation); assert.equal(replayed.mode, 'replay');
  assert.deepEqual(replayed.request, decided.request); assert.deepEqual(replayed.response, decided.response);
  assert.deepEqual(replayed.worldWrites, []); assert.deepEqual(replayed.events, []);
  assert.equal(mainCall.request.decisionRevision, replayed.response.result.decisionRevision,
    'Apply must consume the real durable NO_NOTIFICATION revision independently observed through exact public replay');
}

for (const item of examples.cases) for (const mode of ['ok', 'reject'])
test(`actual installed client ${item.wire}/${item.id} ${mode}`, async () => {
  const { value } = await browser.run(item.id, mode);
  provider(value, item.wire === 'canvas/v7' ? 'hanaworldsCanvasV5' : 'hanaworldsCanvasRegionV1');
  checkActual(item, mode, value);
  const main = { operation: item.id, request: value.request, response: value.response };
  if (item.wire === 'canvas/v7') publicCall(value, main);
  if (item.id === 'ApplyRecoverableCommit' && mode === 'ok') prepareChain(item, value, main);
});

for (const item of examples.events) for (const mode of ['ok', 'reject', 'replay'])
test(`actual installed event ${item.id} ${mode}`, async () => {
  const { value } = await browser.run('event/' + item.id, mode);
  provider(value); assert.equal(value.caseId, item.id); assert.equal(value.mode, mode);
  checkSnapshot(value.before); checkSnapshot(value.after);
  const sample = item[mode === 'ok' ? 'success' : mode === 'reject' ? 'refusal' : 'replay'];
  const expected = bind({ request: sample.request, response: sample.response, events: sample.events }, value.bindings, item.bindings);
  assert.deepEqual(value.request, expected.request); assert.deepEqual(value.response, expected.response);
  assert.deepEqual(value.events, expected.events, 'Only the exact durable success emits the documented event');
  const trigger = value.actualTrigger;
  assert.ok(trigger, 'Capture the actual complete public call for success, refusal and replay');
  assert.equal(trigger.operation, item.name === 'TransactionVerified' ? 'ApplyRecoverableCommit' : item.trigger);
  assert.deepEqual(trigger.request, value.request); assert.deepEqual(trigger.response, value.response);
  publicCall(value, trigger);
  if (mode === 'reject') validateResponse('canvas/v7', trigger.operation, trigger.response);
  else checkEnvelope(operation(trigger.operation), trigger.request, trigger.response);
  if (item.name === 'AffectedObjectNotificationRequired') {
    assert.equal(trigger.operation, 'AnalyzeAffectedObjects');
    if (mode === 'reject') assert.equal(value.internalDecision ?? null, null, 'Decode refusal cannot manufacture an internal Decision');
    else {
      assert.deepEqual(Object.keys(value.internalDecision).sort(), ['operation', 'response'], 'The internal receipt has no invented public Decision request');
      const internal = value.internalDecision;
      assert.equal(internal.operation, 'DecideAffectedObjectNotification');
      const decision = bind({ response: sample.internalDecision.response }, value.internalDecisionBindings, item.internalDecisionBindings);
      assert.deepEqual(internal.response, decision.response, 'Keep every field of the actual internal Decision receipt');
      validateResponse('canvas/v7', internal.operation, internal.response);
      assert.equal(internal.response.requestId, trigger.request.requestId);
      assert.equal(internal.response.result.transactionId, trigger.request.transactionId);
      assert.equal(internal.response.result.analysisDigest, analysisDigest(trigger.response.result));
      assert.equal(internal.response.result.decisionKind, 'BLOCK_AND_NOTIFY');
      for (const key of ['affectedObjectRefs', 'orderedSelectedRefs']) assert.deepEqual(internal.response.result[key], trigger.response.result[key]);
      assert.notDeepEqual(trigger.response, internal.response, 'Actual Analyzer return cannot be replaced by an internal Decision receipt');
      if (mode === 'ok') {
        assert.equal(value.events.length, 1); assert.deepEqual(value.events[0].receipt, internal.response);
      } else {
        assert.equal(value.internalDecisionSource, 'PRIOR_DURABLE_RECEIPT_NOT_ANALYZER_RETURN');
        assert.deepEqual(internal, successfulEvents.get(item.id)?.internalDecision, 'Replay must retain the real previously captured durable Decision receipt');
      }
    }
  }
  for (const event of value.events) validateCanvasEvent(event.event, event);
  for (const event of value.events) {
    const receipt = item.name === 'AffectedObjectNotificationRequired' ? value.internalDecision.response : value.response;
    assert.equal(event.receipt.requestId, receipt.requestId); assert.deepEqual(event.receipt.result, receipt.result);
  }
  if (mode === 'ok' && item.name === 'TransactionVerified') prepareChain(item, value, trigger);
  if (mode === 'replay') {
    const original = successfulEvents.get(item.id);
    assert.ok(original, 'Exact replay requires the actual earlier success in this run');
    assert.deepEqual(value.request, original.request); assert.deepEqual(value.response, original.response);
    assert.deepEqual(value.events, []);
  }
  if (mode !== 'ok') { assert.deepEqual(value.before, value.after); assert.deepEqual(value.worldWrites, []); }
  if (mode === 'ok') successfulEvents.set(item.id, value);
});

for (const item of examples.scenarios) for (const mode of ['ok', 'reject', 'replay'])
test(`actual installed Q-178 scenario ${item.kind}/${item.id} ${mode}`, async () => {
  const { value } = await browser.run('scenario/' + item.id, mode);
  provider(value); assert.equal(value.caseId, item.id); assert.equal(value.mode, mode);
  checkSnapshot(value.before); checkSnapshot(value.after);
  const sample = item[mode === 'ok' ? 'success' : mode === 'reject' ? 'refusal' : 'replay'];
  const expected = bind({ request: sample.request, response: sample.response, events: sample.events }, value.bindings, item.bindings);
  assert.deepEqual(value.request, expected.request); assert.deepEqual(value.response, expected.response); assert.deepEqual(value.events, expected.events);
  const main = { operation: item.operation, request: value.request, response: value.response };
  publicCall(value, main);
  if (mode === 'reject') validateResponse(item.wire, item.operation, value.response);
  else checkEnvelope(operation(item.operation), value.request, value.response);
  for (const event of value.events) {
    validateCanvasEvent(event.event, event);
    assert.equal(event.receipt.requestId, value.response.requestId); assert.deepEqual(event.receipt.result, value.response.result);
    if (item.kind === 'DIRECT_DECISION') assert.deepEqual(event.receipt, value.response);
  }
  if (item.kind === 'DIRECT_DECISION' && mode !== 'reject') {
    assert.equal(value.response.result.decisionKind, 'BLOCK_AND_NOTIFY');
    assert.equal(value.response.result.analysisDigest, analysisDigest(value.request.analysis));
  }
  if (item.kind === 'APPLY_NULL_DECISION' && mode === 'ok') {
    assert.equal(value.request.decisionRevision, null); prepareChain(item, value, main);
  }
  if (mode !== 'ok') {
    assert.deepEqual(value.before, value.after); assert.deepEqual(value.worldWrites, []); assert.deepEqual(value.events, []);
  }
  if (mode === 'replay') {
    const original = successfulScenarios.get(item.id);
    assert.ok(original); assert.deepEqual(value.request, original.request); assert.deepEqual(value.response, original.response);
  }
  if (mode === 'ok') successfulScenarios.set(item.id, value);
});

for (const item of examples.business) test(`actual installed business refusal ${item.id}`, async () => {
  const { value } = await browser.run('business/' + item.id, 'reject');
  provider(value, item.wire === 'canvas/v7' ? 'hanaworldsCanvasV5' : 'hanaworldsCanvasRegionV1');
  assert.equal(value.caseId, item.id); assert.equal(value.mode, 'reject');
  checkSnapshot(value.before); checkSnapshot(value.after);
  const expected = bind({ request: item.request, response: item.response }, value.bindings, item.bindings);
  assert.deepEqual(value.request, expected.request); assert.deepEqual(value.response, expected.response);
  if (item.wire === 'canvas/v7') publicCall(value, { operation: item.id, request: value.request, response: value.response });
  assert.deepEqual(value.before, value.after); assert.deepEqual(value.worldWrites, []); assert.deepEqual(value.events, []);
});

for (const item of examples.local) for (const mode of ['ok', 'reject'])
test(`actual installed additive surface ${item.id} ${mode}`, async () => {
  const { value } = await browser.run('local/' + item.id, mode);
  provider(value, ['readScopedState', 'Error.source'].includes(item.id) ? 'hanaworldsWorldFacts' : 'hanaworldsCanvasV5');
  checkLocal(item, mode, value);
});

for (const id of ['navigation', 'populated-history', 'undo-redo', 'configuration-reload', 'region', 'visible-error', 'unload'])
test(`actual official Web product UI ${id}`, async () => {
  const { value, dom } = await browser.run('ui/' + id, 'ok');
  assert.equal(value.execution, 'ACTUAL_PRODUCT_UI');
  assert.equal(value.origin, 'OFFICIAL_LOADER');
  if (id === 'navigation') {
    assert.equal(value.sidebarTarget, value.mainKey); assert.equal(value.selectedPanelId, value.mainKey);
    assert.ok(dom.canvasPanels > 0); assert.match(dom.text, /对象/); assert.match(dom.text, /历史/);
  } else if (id === 'populated-history') {
    assert.ok(value.view.objects.length > 0 && value.view.history.length > 0);
    assert.ok(value.view.history.every(x => x.mode === 'CELL' || x.mode === 'REGION'));
    assert.ok(dom.text.includes(value.view.objects[0].name));
  } else if (id === 'undo-redo') {
    assert.equal(value.undo.status, 'VERIFIED'); assert.equal(value.redo.status, 'VERIFIED');
    assert.notEqual(value.beforeWorldDigest, value.undoWorldDigest); assert.equal(value.beforeWorldDigest, value.redoWorldDigest);
    assert.ok(value.undoView.history.some(x => x.status === 'UNDONE'));
    assert.ok(value.redoView.history.some(x => x.status === 'COMMITTED'));
    assert.deepEqual(value.events.map(e => e.operation), ['Undo', 'Redo']);
    assert.match(dom.text, /重做/);
  } else if (id === 'configuration-reload') {
    assert.notDeepEqual(value.beforeSettings, value.afterSettings); assert.notEqual(value.beforeProviderRef, value.afterProviderRef);
    assert.deepEqual(value.historyBefore, value.historyAfter); assert.deepEqual(value.requestedSettings, value.afterSettings);
    assert.equal(value.staleInspectionAccepted, false);
  } else if (id === 'region') {
    assert.equal(value.commit.status, 'VERIFIED'); assert.equal(value.undo.status, 'VERIFIED');
    assert.deepEqual(value.partition, value.sourcePartition); assert.equal(value.rejected.error.code, 'CAPABILITY_GAP');
    assert.equal(value.rejected.error.mutationState, 'NONE');
  } else if (id === 'visible-error') {
    checkSnapshot(value.before); checkSnapshot(value.after);
    assert.ok(value.publicError.code); assert.ok(dom.text.includes(value.publicError.code));
    assert.deepEqual(value.before, value.after); assert.equal(value.placeholderSubstituted, false);
  } else {
    assert.equal(value.unloadVia, 'NORMAL_PLUGIN_MANAGER'); assert.equal(value.canvasProviderPresent, false);
    assert.equal(value.mainEntryPresent, false); assert.equal(value.sidebarEntryPresent, false);
    assert.equal(value.remoteNamespacePresent, false); assert.equal(value.oldTargetAccepted, false);
    assert.equal(dom.canvasPanels, 0);
  }
});
