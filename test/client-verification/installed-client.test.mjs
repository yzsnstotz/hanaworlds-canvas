import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { productBrowser } from './browser.mjs';
import { examples, bind, checkActual, checkLocal, checkEnvelope, checkSnapshot } from './contracts.mjs';
import { validateCanvasEvent } from '../../src/protocol/local/index.mjs';

let browser;
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

for (const item of examples.cases) for (const mode of ['ok', 'reject'])
test(`actual installed client ${item.wire}/${item.id} ${mode}`, async () => {
  const { value } = await browser.run(item.id, mode);
  provider(value, item.wire === 'canvas/v7' ? 'hanaworldsCanvasV5' : 'hanaworldsCanvasRegionV1');
  checkActual(item, mode, value);
});

for (const item of examples.events) for (const mode of ['ok', 'reject', 'replay'])
test(`actual installed event ${item.id} ${mode}`, async () => {
  const { value } = await browser.run('event/' + item.id, mode);
  provider(value); assert.equal(value.caseId, item.id); assert.equal(value.mode, mode);
  checkSnapshot(value.before); checkSnapshot(value.after);
  const expected = bind(item[mode === 'ok' ? 'success' : mode === 'reject' ? 'refusal' : 'replay'], value.bindings, item.bindings);
  assert.deepEqual(value.request, expected.request); assert.deepEqual(value.response, expected.response);
  assert.deepEqual(value.events, expected.events, 'Only the exact durable success emits the documented event');
  if (mode !== 'reject') {
    const trigger = value.actualTrigger;
    assert.ok(trigger, 'Capture the actual public call as well as its event receipt');
    if (item.name === 'AffectedObjectNotificationRequired' && trigger.operation === 'AnalyzeAffectedObjects') {
      checkEnvelope(examples.cases.find(c => c.id === trigger.operation), trigger.request, trigger.response);
      assert.deepEqual(trigger.response.result, value.request.analysis);
      for (const key of ['requestId', 'sessionRef', 'worldRef', 'transactionId']) assert.equal(trigger.request[key], value.request[key]);
    } else {
      assert.equal(trigger.operation, item.name === 'TransactionVerified' ? 'ApplyRecoverableCommit' : item.trigger);
      assert.deepEqual(trigger.request, value.request); assert.deepEqual(trigger.response, value.response);
      checkEnvelope(examples.cases.find(c => c.id === trigger.operation), trigger.request, trigger.response);
    }
  }
  for (const event of value.events) validateCanvasEvent(event.event, event);
  for (const event of value.events) { assert.equal(event.receipt.requestId, value.response.requestId); assert.deepEqual(event.receipt.result, value.response.result); }
  if (mode !== 'ok') { assert.deepEqual(value.before, value.after); assert.deepEqual(value.worldWrites, []); }
});

for (const item of examples.business) test(`actual installed business refusal ${item.id}`, async () => {
  const { value } = await browser.run('business/' + item.id, 'reject');
  provider(value, item.wire === 'canvas/v7' ? 'hanaworldsCanvasV5' : 'hanaworldsCanvasRegionV1');
  assert.equal(value.caseId, item.id); assert.equal(value.mode, 'reject');
  checkSnapshot(value.before); checkSnapshot(value.after);
  const expected = bind({ request: item.request, response: item.response }, value.bindings, item.bindings);
  assert.deepEqual(value.request, expected.request); assert.deepEqual(value.response, expected.response);
  assert.deepEqual(value.before, value.after); assert.deepEqual(value.worldWrites, []); assert.deepEqual(value.events, []);
});

for (const item of examples.local) for (const mode of ['ok', 'reject'])
test(`actual installed additive surface ${item.id} ${mode}`, async () => {
  const { value } = await browser.run('local/' + item.id, mode);
  provider(value, ['readScopedState', 'Error.source'].includes(item.id) ? 'hanaworldsWorldFacts' : 'hanaworldsCanvasV5');
  checkLocal(item, mode, value);
});

for (const id of ['navigation', 'populated-history', 'undo-redo', 'configuration-reload', 'region', 'visible-error', 'unload'])
test(`actual product UI ${id}`, async () => {
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
