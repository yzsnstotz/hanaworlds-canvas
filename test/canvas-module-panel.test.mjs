import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openCanvasModuleFixture } from './support/canvas-module-fixture.mjs';
import { openModuleBrowser } from './support/canvas-module-browser.mjs';

// Q259: the actual installed Canvas service + shipped Client + headless DOM.
// External world/compiler/session data are CONTRACT_DOCUMENT_PEERS. This does
// not attest official Loader/real-world/App/owner acceptance; the ten old locks
// and the original 134-case official-composite suite remain unchanged.
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = fileURLToPath(new URL('../../evidence/q259/', import.meta.url));
const budget = Number(process.env.CANVAS_MODULE_PANEL_WAIT_MS ?? 30000);
const stopBudget = Number(process.env.CANVAS_MODULE_PANEL_STOP_MS ?? 10000);
const chromium = process.env.CANVAS_MODULE_PANEL_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Envelopes are JSON contracts: object prototype identity is not a wire field.
// Keep every serialized key/value, including nulls and nested errors.
const wire = value => JSON.parse(JSON.stringify(value));
let directory, packageRoot;
async function command(file, args, cwd, name) {
  const child = spawn(file, args, { cwd, env: { PATH: process.env.PATH, HOME: directory,
    TMPDIR: join(directory, 'tmp'), CI: 'true', npm_config_cache: join(directory, 'npm-cache'),
    NPM_CONFIG_CACHE: join(directory, 'npm-cache'), CANVAS_BOUNDARY_EVIDENCE: join(directory, 'boundary') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(directory, name + '.log'), output);
  assert.equal(exit, 0, `SETUP, not business RED: ${file} ${args.join(' ')}; see ${directory}/${name}.log\n${output.slice(-2000)}`);
  return output;
}
before(async () => {
  assert.ok(Number.isSafeInteger(budget) && budget > 0, 'Named DOM budget must be positive');
  assert.ok(Number.isSafeInteger(stopBudget) && stopBudget > 0, 'Named stop budget must be positive');
  await mkdir(evidenceRoot, { recursive: true }); directory = await mkdtemp(join(evidenceRoot, 'module-'));
  for (const name of ['tmp', 'npm-cache', 'consumer']) await mkdir(join(directory, name));
  const output = await command('npm', ['pack', '--json', '--pack-destination', directory], sourceRoot, 'production-pack');
  const packed = JSON.parse(output.slice(output.indexOf('[\n'), output.lastIndexOf('\n]') + 2))[0];
  const consumer = join(directory, 'consumer');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'canvas-module-panel-consumer', private: true,
    type: 'module', dependencies: { 'hanaworlds-canvas': `file:${join(directory, packed.filename)}`,
      '@deepseek-ai/cordis': '4.0.5-alpha.1', '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2',
      '@deepseek-ai/dsh-typert-registry': '0.2.1-alpha.2', '@deepseek-ai/dsh-api-gateway': '0.2.1-alpha.2',
      '@deepseek-ai/dsh-util-crypto': '0.2.1-alpha.2',
      zod: '4.4.3', react: '18.3.1', 'react-dom': '18.3.1' } }, null, 2));
  await command('npm', ['install', '--strict-peer-deps', '--no-audit', '--no-fund'], consumer, 'normal-install');
  packageRoot = await realpath(join(consumer, 'node_modules/hanaworlds-canvas'));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
  assert.equal(manifest.version, JSON.parse(await readFile(join(sourceRoot, 'package.json'))).version);
  for (const file of ['lib/client.js', 'lib/src/index.mjs', 'lib/src/local-v5.mjs', 'lib/src/display-host.mjs'])
    assert.equal(sha(await readFile(join(packageRoot, file))), sha(await readFile(join(sourceRoot, file))), `Normal tgz installed exact production bytes: ${file}`);
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ classification: 'NORMAL_TGZ_MODULE_CONSUMER',
    packageRoot, tgz: join(directory, packed.filename), tgzSHA256: sha(await readFile(join(directory, packed.filename))),
    fixedPeers: manifest.peerDependencies }, null, 2));
  console.log(`CANVAS_MODULE_PANEL_EVIDENCE ${directory}`);
});

async function scenario(t, name) {
  const root = join(directory, name); await mkdir(root);
  const fixture = await openCanvasModuleFixture(join(root, 'store'), { packageRoot });
  let browser;
  const open = async suffix => {
    const path = join(root, suffix); await mkdir(path);
    browser = await openModuleBrowser({ directory: path, packageRoot, fixture, budget, stopBudget, chromium });
    await browser.click('对象与历史（Canvas）', true);
    await browser.wait("document.querySelector('.hw-canvas-display')?.innerText.includes('对象与历史')");
    return browser;
  };
  t.after(async () => {
    try { await writeFile(join(root, 'actual-observation.json'), JSON.stringify({ classification: fixture.classification,
      trace: fixture.trace, events: fixture.events, peerCalls: fixture.peerCalls, writes: fixture.writes,
      snapshot: await fixture.snapshot(), dom: browser ? await browser.snapshot() : null }, null, 2)); }
    finally { await browser?.close(); await fixture.close(); }
  });
  return { fixture, open, closeBrowser: async () => { await browser.close(); browser = null; } };
}
const has = text => `document.querySelector('.hw-canvas-display')?.innerText.includes(${JSON.stringify(text)})`;
const success = response => { assert.equal(response.error, null); return response.result; };
async function samePublicView(browser, fixture) {
  const expected = await fixture.readObjectsHistory();
  const original = browser.calls.findLast(row => row.endpoint.endsWith('/read') && row.value);
  assert.ok(original, 'Panel must read its complete view from the real Display service');
  const carried = await browser.evaluate("window.moduleCarrierResponses.findLast(row=>row.endpoint.endsWith('/read')&&row.response.ok).response.value");
  assert.deepEqual(carried, original.value, 'Every public view field crosses the real browser carrier unchanged');
  assert.deepEqual(carried, expected, 'The panel reads the actual current durable Canvas view');
}
const stable = (before, after) => {
  for (const field of ['history', 'transactions', 'pending', 'sessions']) assert.deepEqual(after.canvas[field], before.canvas[field], `Persistent ${field} unchanged`);
  assert.deepEqual(after.peerWorld, before.peerWorld);
};

test('module browser: public navigation, empty state and clean-start first verified commit', async t => {
  const env = await scenario(t, 'navigation'), browser = await env.open('browser');
  assert.equal((await env.fixture.snapshot()).objectsHistory.history.length, 0, 'Fresh Canvas has no seeded history');
  assert.equal((await browser.snapshot()).panels, 1);
  const committed = await env.fixture.prepareCommit();
  await browser.wait(has('已提交'));
  const snap = await env.fixture.snapshot();
  assert.equal(committed.response.error, null); assert.ok(snap.objectsHistory.history.length > 0);
  assert.ok(env.fixture.trace.some(row => row.operation === 'Readback' && row.response.error === null));
  assert.ok(browser.calls.some(row => row.endpoint.endsWith('/read') && row.value?.history.length > 0));
  await samePublicView(browser, env.fixture);
});

test('module browser: populated history, Name/Rename feed, persistent history and CAS rejection', async t => {
  const env = await scenario(t, 'history'), committed = await env.fixture.prepareCommit();
  const browser = await env.open('browser'); await browser.wait(has('已提交'));
  for (const [operation, name] of [['NameObject', '画布当前名字'], ['RenameObject', '画布重命名']]) {
    const before = await env.fixture.snapshot(), writes = env.fixture.writes.length;
    const named = success(await env.fixture.rename(name, { operation }));
    await browser.wait(has(name));
    const after = await env.fixture.snapshot(); stable(before, after); assert.equal(env.fixture.writes.length, writes);
    await samePublicView(browser, env.fixture);
    assert.deepEqual(after.objectsHistory, { ...before.objectsHistory,
      objects: before.objectsHistory.objects.map(row => row.objectRef === named.objectRef ? { ...row, name } : row),
      history: before.objectsHistory.history.map(row => row.objectRef === named.objectRef ? { ...row, objectName: name } : row) });
    assert.deepEqual((await browser.snapshot()).labels, [
      ...after.objectsHistory.objects.map((row, index) => row.name ?? `未命名对象 ${index + 1}`),
      ...after.objectsHistory.history.map(row => row.objectName ?? '未命名对象') ],
    'Every current object label and every history label updates without clicking Refresh');
    const actual = env.fixture.trace.findLast(row => row.operation === operation);
    const replay = await env.fixture.call(operation, actual.request); assert.deepEqual(wire(replay), actual.response);
    stable(after, await env.fixture.snapshot());
    const bad = await env.fixture.call(operation, { ...actual.request, requestId: actual.request.requestId + '-stale',
      expectedRegistryRevision: actual.request.expectedRegistryRevision });
    assert.equal(bad.error?.code, 'STALE_REVISION'); assert.deepEqual(await env.fixture.snapshot(), after);
  }
  assert.ok(committed.request.decisionRevision, 'Non-null Apply uses real persisted NO_NOTIFICATION receipt');
});

test('module browser: actual Undo and Redo confirmation controls read back each committed result', async t => {
  const env = await scenario(t, 'undo-redo'); await env.fixture.prepareCommit();
  const browser = await env.open('browser'); await browser.wait(has('已提交'));
  for (const [action, status] of [['撤回', '已撤回'], ['重做', '已重做']]) {
    const before = env.fixture.trace.length;
    await browser.click(action + '这笔'); await browser.wait(has('确认' + action)); await browser.click('确认' + action);
    await browser.wait(has(status));
    const row = env.fixture.trace.slice(before).find(row => row.operation === (action === '撤回' ? 'Undo' : 'Redo'));
    assert.ok(row, 'Click must reach production public history call'); assert.equal(row.response.error, null);
    assert.ok(browser.calls.some(row => row.endpoint.endsWith(action === '撤回' ? '/undo' : '/redo') && row.value?.status === 'VERIFIED'));
    const durable = await env.fixture.snapshot(); assert.ok(durable.objectsHistory.history.length >= 2);
    await samePublicView(browser, env.fixture);
  }
});

test('module browser: configuration remount preserves history and reads new public settings', async t => {
  const env = await scenario(t, 'configuration'); await env.fixture.prepareCommit();
  let browser = await env.open('browser-before'); await browser.wait(has('已提交'));
  const before = await env.fixture.snapshot(); await env.closeBrowser();
  const prior = success(await env.fixture.call('ReadPlacementSettings', env.fixture.request('ReadPlacementSettings', { localContext: env.fixture.context() })));
  await env.fixture.remount({ placement: { frontGapCells: prior.placementSettings.frontGapCells + 1,
    forwardSearchCells: prior.placementSettings.forwardSearchCells,
    lateralSearchCells: prior.placementSettings.lateralSearchCells,
    verticalSearchCells: prior.placementSettings.verticalSearchCells } });
  const after = await env.fixture.snapshot(); assert.deepEqual(after.canvas.history, before.canvas.history);
  const settings = success(await env.fixture.call('ReadPlacementSettings', env.fixture.request('ReadPlacementSettings', { localContext: env.fixture.context() })));
  assert.equal(settings.placementSettings.frontGapCells, prior.placementSettings.frontGapCells + 1);
  assert.notEqual(settings.placementSettings.settingsRevision, prior.placementSettings.settingsRevision);
  browser = await env.open('browser-after'); await browser.wait(has('已提交'));
  assert.equal((await browser.snapshot()).panels, 1);
  await samePublicView(browser, env.fixture);
});

test('module browser: region commit and scoped undo are observed through actual controls', async t => {
  const env = await scenario(t, 'region'); await env.fixture.prepareRegion();
  const browser = await env.open('browser'); await browser.wait(has('批量区域'));
  await browser.click('撤回这笔'); await browser.wait(has('确认撤回')); await browser.click('确认撤回');
  await browser.wait(has('已撤回'));
  const row = env.fixture.trace.findLast(row => row.operation === 'UndoScopedRegionCommit');
  assert.ok(row); assert.equal(row.response.error, null);
  assert.deepEqual(row.events, [], 'The published six event directions contain CELL Undo/Redo, not a REGION history event');
  await samePublicView(browser, env.fixture);
});

test('module browser: UNKNOWN is durable, read-only pending/recovery and complete visible RemoteError', async t => {
  const env = await scenario(t, 'visible-error-pending'); await env.fixture.prepareCommit();
  const browser = await env.open('browser'); await browser.wait(has('已提交'));
  await env.fixture.armPending();
  await browser.click('撤回这笔'); await browser.wait(has('确认撤回')); await browser.click('确认撤回');
  await browser.wait("!!document.querySelector('.hw-canvas-error')");
  await env.fixture.capturePending();
  assert.ok((await env.fixture.snapshot()).canvas.pending[env.fixture.pending.request.transactionId]);
  const before = await env.fixture.snapshot(), eventCount = env.fixture.events.length;
  const pending = await env.fixture.readPending(); assert.ok(pending.result); stable(before, await env.fixture.snapshot());
  assert.equal(env.fixture.events.length, eventCount, 'ReadPending emits nothing');
  const failure = browser.faults.findLast(error => error.code === 'canvas/undo-failed');
  assert.ok(failure, 'Actual Display RemoteError, never an injected Canvas output');
  const carried = await browser.evaluate("window.moduleCarrierResponses.findLast(row=>row.endpoint.endsWith('/undo')&&!row.response.ok).response.error");
  assert.deepEqual(carried, { name: failure.name, code: failure.code, message: failure.message, details: failure.details },
    'Actual browser carrier preserves the entire original Display RemoteError');
  const dom = await browser.snapshot();
  await writeFile(join(directory, 'visible-error-pending', 'actual-visible-error.json'), JSON.stringify({
    original: { code: failure.code, message: failure.message, details: failure.details }, dom }, null, 2));
  // This is a real functional RED on the current client: it collapses the
  // complete returned error into one reason label, losing actionable identity.
  // Recovery still runs before asserting visibility, so red cannot hide it.
  // Restart the real installed Canvas owner; reopen the client onto that owner.
  // Peer answer configuration survives; no pending/history record is inserted.
  await env.closeBrowser(); await env.fixture.remount();
  assert.deepEqual(await env.fixture.snapshot(), before, 'Pending and all history survive a normal owner reopen');
  const recovered = await env.fixture.recover(); assert.equal(recovered.error, null);
  const recoveryCall = env.fixture.trace.findLast(row => row.operation === 'RecoverPendingUndo');
  const recoveredAgain = await env.fixture.call('RecoverPendingUndo', recoveryCall.request);
  assert.deepEqual(wire(recoveredAgain), wire(recovered));
  assert.equal(env.fixture.pending.fault.applyCount, 1); assert.equal(env.fixture.pending.fault.restoreCount, 0);
  const resumed = await env.open('browser-recovered'); await resumed.wait(has('已撤回'));
  await samePublicView(resumed, env.fixture);
  for (const value of [failure.code, failure.message, ...Object.values(failure.details).filter(value => value !== null)])
    assert.ok(dom.text.includes(String(value)), `Visible error must preserve actual ${JSON.stringify(value)}; got ${dom.text}`);
});

test('module browser: normal client disposal releases DOM, subscriptions and public slots', async t => {
  const env = await scenario(t, 'unload'); await env.fixture.prepareCommit();
  const browser = await env.open('browser'); await browser.wait(has('已提交')); await browser.dispose();
  await browser.waitStreamsClosed(); assert.equal(browser.streams.size, 0, 'Normal client disposal cancels its actual Display subscriptions before server shutdown');
  const dom = await browser.snapshot(); assert.equal(dom.panels, 0); assert.equal(dom.slots, 0); assert.equal(dom.styles, 0);
  await browser.wait("document.querySelectorAll('.hw-canvas-display').length===0");
  assert.equal(env.fixture.events.filter(row => row.event === 'HistoryPositionChanged').length, 0, 'Unload creates no history operation');
});
