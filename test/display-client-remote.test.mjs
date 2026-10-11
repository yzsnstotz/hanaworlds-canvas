import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Context, Service } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';

// Public DSH composition only: the shipped Canvas client bundle runs against the official
// Client registry and Client Remote service; an explicit in-process FIXTURE carrier hands each
// call to the official Host Gateway serving the real single Canvas entry on an isolated profile.
const require = createRequire(import.meta.url);
const sdkPackage = async name => dirname(await realpath(require.resolve(`@deepseek-ai/${name}/package.json`)));
const clientFace = async name => import(pathToFileURL(join(await sdkPackage(name), 'lib/types/client/index.js')).href);
const artifact = process.env.CANVAS_CLIENT_ARTIFACT ??
  fileURLToPath(new URL('../lib/client.js', import.meta.url));

function loadClientBundle(source, sharedReact) {
  // React is external to the bundle; this stub only builds element records (no rendering).
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'), useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }) };
  let factory;
  const sandbox = { window: { __ModuleLoader__: { load: entry => { factory = entry.factory; } },
    localStorage: { getItem: () => null, setItem: () => {} } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) } };
  vm.runInNewContext(source, sandbox, { filename: artifact });
  return factory(id => { if (id === 'react') return sharedReact ?? react; throw new Error(`unexpected require ${id}`); });
}

async function compose(seed, { fixtureWorld = false, mountFailure, panelFailure,
  panelFailureSlot = 'main', cleanupFailure, sharedReact } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'canvas-client-remote-'));
  const store = join(profile, 'data', 'hanaworlds-canvas-v2');
  if (seed) await seed(store);
  const host = new Context();
  await host.plugin(TypertRegistry);
  host.provide('dshHomePath', (...parts) => join(profile, ...parts));
  // FIXTURE: the isolated example world file stands in for the Adapter and native facts.
  let world = null;
  if (fixtureWorld) {
    const { openUndoFixtureWorld } = await import('./support/undo-fixture-world.mjs');
    const { undoWorldFile } = await import('./support/undo-host.mjs');
    world = await openUndoFixtureWorld(undoWorldFile(store));
    host.provide('hanaworldsWorldAdapterV6', world.adapter);
    host.provide('hanaworldsLuantiNativeFacts', world.nativeFacts);
  }
  const { default: canvasPlugin } = await import(process.env.CANVAS_ENTRY ?? new URL('../src/index.mjs', import.meta.url).href);
  await host.plugin(canvasPlugin);
  const canvas = host.get('hanaworldsCanvasV5');
  await canvas.ready;
  if (world) world.readWorldRevision = () => canvas.readWorldRevision('undo-fixture-world');
  const gateway = new TypertGatewayService(host, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const wire = [];
  const connection = { isLoopback: true, generation: { getSnapshot: () => undefined },
    registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
    // Remote streams of the Canvas display reach the official Host Gateway; the internal
    // $events pump stays an empty FIXTURE stream.
    rpc: { open: (path, endpoint, body, signal) => {
      const [namespace, method] = endpoint.split('/');
      if (namespace !== 'hanaworldsCanvasDisplay') return (async function* () {})();
      wire.push({ path, endpoint, args: body.args, stream: true });
      return (async function* () { yield* await gateway.stream({ namespace, method, args: body.args, signal }); })();
    }, call: async (path, endpoint, body) => {
      const [namespace, method] = endpoint.split('/');
      try {
        const value = await gateway.invoke({ namespace, method, args: body.args });
        wire.push({ path, endpoint, args: body.args, ok: true, value });
        return { ok: true, value };
      } catch (error) {
        wire.push({ path, endpoint, args: body.args, ok: false, code: error.code });
        return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
      }
    } } };
  const client = new Context();
  await client.plugin(await clientFace('dsh-typert-registry'));
  client.provide('connection', connection);
  await client.plugin(await clientFace('dsh-api-gateway'));
  if (mountFailure) client.get('remote').$mount = async () => { throw mountFailure; };
  if (cleanupFailure) {
    const remote = client.get('remote'), mount = remote.$mount;
    remote.$mount = async function (contribution) {
      const dispose = await mount.call(this, contribution);
      return async () => { await dispose(); throw cleanupFailure; };
    };
  }
  const registered = [];
  let failPanel = !!panelFailure;
  // FIXTURE declared slots, with the public renderer's synchronous setup and
  // caller-fiber effect ownership; registration cleanup is real Cordis.
  new class extends Service {
    constructor() { super(client, 'slots'); }
    inject(_name, register) {
      const dispose = this.ctx.effect(register);
      return () => { void dispose(); };
    }
    register(meta, component) {
      return this.ctx.effect(() => {
        if (failPanel && meta.name === panelFailureSlot) { failPanel = false; throw panelFailure; }
        const entry = { meta, component };
        registered.push(entry);
        return () => { registered.splice(registered.indexOf(entry), 1); };
      });
    }
  }();
  client.provide('layout', {});
  client.provide('sessions', {});
  const bundle = loadClientBundle(await readFile(artifact, 'utf8'), sharedReact);
  const fiber = client.plugin({ name: bundle.name, inject: bundle.inject, apply: bundle.apply });
  const close = async () => { await fiber.dispose(); await client.fiber.dispose(); await host.fiber.dispose();
    await rm(profile, { recursive: true, force: true }); };
  try { await fiber; } catch (error) { await close(); throw error; }
  return { gateway, wire, registered, close, world, canvas, client, fiber };
}

test('partial sidebar setup and a rejecting remote cleanup still show the original Canvas fault', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const failure = Object.assign(new Error('sidebar setup failed'), { code: 'FIXTURE_PANEL_FAILED' });
  const cleanup = Object.assign(new Error('remote cleanup failed'), { code: 'FIXTURE_CLEANUP_FAILED' });
  const { registered, close, client, fiber } = await compose(null, { panelFailure: failure,
    panelFailureSlot: 'sidebar.panellist', cleanupFailure: cleanup, sharedReact: React });
  try {
    assert.equal(fiber.state, 2);
    assert.equal(registered.length, 2, 'the partial normal panel is removed before fault registration');
    const main = registered.find(entry => entry.meta.name === 'main');
    const html = renderToStaticMarkup(React.createElement(main.component));
    assert.match(html, /FIXTURE_PANEL_FAILED/);
    assert.match(html, /FIXTURE_CLEANUP_FAILED/);
    assert.match(html, /remote cleanup failed/);
    assert.equal(client.get('remote.hanaworldsCanvasDisplay'), undefined);
  } finally { await close(); }
  assert.equal(registered.length, 0, 'unloading the failed client removes its fault slots');
});

for (const [failurePoint, stage] of [['mountFailure', 'REMOTE_MOUNT'], ['panelFailure', 'PANEL_REGISTER']]) {
  test(`client apply isolates ${failurePoint} in a named Canvas fault card`, async () => {
    const React = (await import('react')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const failure = Object.assign(new Error('fixture initialization failed <script>'), { code: 'FIXTURE_INIT_FAILED' });
    const { registered, close, client, fiber, wire } = await compose(null,
      { [failurePoint]: failure, sharedReact: React });
    try {
      assert.equal(fiber.state, 2, 'the Canvas client remains ACTIVE after apply fails');
      const main = registered.find(entry => entry.meta.name === 'main');
      assert.ok(main, 'failed Canvas retains a main panel');
      assert.ok(registered.find(entry => entry.meta.name === 'sidebar.panellist'));
      const html = renderToStaticMarkup(React.createElement(main.component));
      assert.match(html, /role="alert"/);
      assert.match(html, /Canvas.*初始化失败/);
      assert.match(html, new RegExp(stage));
      assert.match(html, /FIXTURE_INIT_FAILED/);
      assert.match(html, /fixture initialization failed &lt;script&gt;/);
      assert.doesNotMatch(html, /<script>/);
      assert.equal(client.get('remote.hanaworldsCanvasDisplay'), undefined,
        'a failed initialization releases the mounted remote namespace');
      assert.equal(wire.length, 0, 'the fault panel makes no world call');
    } finally { await close(); }
  });
}

test('shipped Canvas client reads hanaworldsCanvasDisplay through the public DSH Remote (FIXTURE carrier)', async () => {
  const { gateway, wire, registered, close } = await compose();
  try {
    const main = registered.find(entry => entry.meta.name === 'main');
    assert.ok(main, 'panel registers its main slot');
    assert.ok(registered.find(entry => entry.meta.name === 'sidebar.panellist' && entry.meta.label() === '对象与历史（Canvas）'));
    const useSessions = select => select({ byId: { 'fixture-session': { id: 'fixture-session', retainedBy: { mainView: 1 } } } });
    const element = main.component({ useSessions });
    assert.equal(element.props.sessionRef, 'fixture-session');
    const direct = await gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method: 'read', args: { sessionRef: 'fixture-session' } });
    assert.deepEqual(await element.props.read('fixture-session'), direct);
    assert.deepEqual(await element.props.read(null), { state: 'NO_SESSION', worldRef: null, objects: [], history: [] });
    assert.deepEqual(wire.map(({ endpoint, args, ok }) => ({ endpoint, args: { ...args }, ok })), [
      { endpoint: 'hanaworldsCanvasDisplay/read', args: { sessionRef: 'fixture-session' }, ok: true },
      { endpoint: 'hanaworldsCanvasDisplay/read', args: { sessionRef: null }, ok: true }]);
    if (process.env.CANVAS_CLIENT_WIRE_OUT) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(process.env.CANVAS_CLIENT_WIRE_OUT, JSON.stringify({ fixture: true, artifact, direct, wire }, null, 2));
    }
  } finally { await close(); }
});

test('populated isolated FIXTURE Store reads back READY objects/history through the same client path', async () => {
  const { createUndoExample } = await import('./support/undo-example.mjs');
  const { undoSessionRef } = await import('./support/undo-fixture-world.mjs');
  const { gateway, wire, registered, close } = await compose(directory => createUndoExample(directory));
  try {
    const main = registered.find(entry => entry.meta.name === 'main');
    const element = main.component({ useSessions: select => select({ byId: { [undoSessionRef]: { id: undoSessionRef, retainedBy: { mainView: 1 } } } }) });
    const direct = await gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method: 'read', args: { sessionRef: undoSessionRef } });
    const read = await element.props.read(undoSessionRef);
    assert.deepEqual(read, direct);
    assert.equal(read.state, 'READY');
    assert.equal(read.history.length, 2);
    assert.ok(read.history.every(row => row.status === 'COMMITTED' && row.mode === 'CELL'));
    assert.deepEqual(read.history.map(row => row.affectedCells).sort(), [2, 3]);
    assert.equal(wire.length, 1);
    if (process.env.CANVAS_CLIENT_READY_OUT) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(process.env.CANVAS_CLIENT_READY_OUT, JSON.stringify({ fixture: true, artifact, sessionRef: undoSessionRef, read, wire }, null, 2));
    }
  } finally { await close(); }
});

const panel = (registered, sessionRef) => registered.find(entry => entry.meta.name === 'main')
  .component({ useSessions: select => select({ byId: { [sessionRef]: { id: sessionRef, retainedBy: { mainView: 1 } } } }) });
const historyWrites = world => world.calls.filter(call => /History/.test(call.operation)).length;
const reasonOf = async promise => { try { await promise; } catch (error) { return error.details?.reason ?? error.code; } return 'RESOLVED'; };

test('shipped client undoes exactly the clicked latest entry through canvas/v7 Undo (FIXTURE world)', async () => {
  const { createUndoExample } = await import('./support/undo-example.mjs');
  const { undoSessionRef } = await import('./support/undo-fixture-world.mjs');
  const { gateway, wire, registered, close, world, canvas } = await compose(directory => createUndoExample(directory), { fixtureWorld: true });
  try {
    const element = panel(registered, undoSessionRef);
    const actions = await element.props.readActions(undoSessionRef);
    assert.equal(actions.state, 'READY');
    const [first, second] = actions.objects;
    assert.deepEqual(first.undo, { available: false, reason: 'WORLD_CHANGED_SINCE', historyTransactionId: null });
    assert.deepEqual(second.undo, { available: true, reason: null, historyTransactionId: 'undo-fixture-cell-2' });
    const writes0 = historyWrites(world);
    // Not offered, and a row that is not the latest entry: named refusals, no world call.
    assert.equal(await reasonOf(element.props.undo(undoSessionRef, first.objectRef, 'undo-fixture-cell-1')), 'WORLD_CHANGED_SINCE');
    assert.equal(await reasonOf(element.props.undo(undoSessionRef, second.objectRef, 'undo-fixture-cell-1')), 'HISTORY_MOVED');
    assert.equal(historyWrites(world), writes0);
    const brick = [[8, 2, 8], [9, 2, 8], [10, 2, 8]];
    assert.deepEqual(world.readCells(brick).map(cell => cell.materialRef), ['fixture:brick', 'fixture:brick', 'fixture:brick']);
    const result = await element.props.undo(undoSessionRef, second.objectRef, 'undo-fixture-cell-2');
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.originTransactionId, 'undo-fixture-cell-2');
    assert.deepEqual(world.readCells(brick).map(cell => cell.materialRef), ['air', 'air', 'air']);
    // The returned view is Canvas's own public read after commit.
    assert.deepEqual(result.view, await gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method: 'read', args: { sessionRef: undoSessionRef } }));
    const rows = result.view.history.filter(row => row.objectRef === second.objectRef);
    assert.deepEqual(rows.map(row => row.status), ['UNDONE', 'UNDONE']);
    assert.equal(result.view.objects.find(object => object.objectRef === second.objectRef).occupiedCells, 0);
    assert.equal(result.view.objects.find(object => object.objectRef === first.objectRef).occupiedCells, 2);
    const head = canvas.store.snapshot.history[second.objectRef].at(-1);
    assert.equal(head.transactionId, result.transactionId);
    assert.equal(head.originTransactionId, 'undo-fixture-cell-2');
    // A second click on the same row: no second Undo transaction, no world write.
    const writes1 = historyWrites(world);
    assert.equal(await reasonOf(element.props.undo(undoSessionRef, second.objectRef, 'undo-fixture-cell-2')), 'NOTHING_TO_UNDO');
    assert.equal(historyWrites(world), writes1);
    assert.equal(canvas.store.snapshot.history[second.objectRef].length, 2);
    assert.deepEqual((await element.props.readActions(undoSessionRef)).objects[1].undo,
      { available: false, reason: 'NOTHING_TO_UNDO', historyTransactionId: null });
    assert.deepEqual(Object.keys(canvas.store.snapshot.pending), []);
    if (process.env.CANVAS_CLIENT_UNDO_OUT) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(process.env.CANVAS_CLIENT_UNDO_OUT, JSON.stringify({ fixture: true, artifact, sessionRef: undoSessionRef,
        actions, result, worldCalls: world.calls, wire }, null, 2));
    }
  } finally { await close(); }
});

test('shipped panel follows Canvas changes: a commit made elsewhere reaches it without a refresh (FIXTURE world)', async () => {
  const { createUndoExample } = await import('./support/undo-example.mjs');
  const { undoSessionRef } = await import('./support/undo-fixture-world.mjs');
  const { wire, registered, close, canvas } = await compose(directory => createUndoExample(directory), { fixtureWorld: true });
  try {
    const element = panel(registered, undoSessionRef);
    assert.equal(typeof element.props.changes, 'function', 'the panel is wired to the change feed');
    const handle = element.props.changes(undoSessionRef);
    const notices = [];
    let finalRevision = null;
    // Every durable step is a notice (the reserved pending row too: it changes what Undo
    // offers); read until the committed registry revision has arrived.
    const reading = (async () => { for await (const notice of handle) {
      notices.push(notice); if (notice.registryRevision === finalRevision) return; } })();
    await new Promise(resolve => setTimeout(resolve, 20));
    // Not the panel: a public canvas/v7 Undo issued by another surface (Workshop/skills).
    const actions = await canvas.readHistoryActions(undoSessionRef);
    const step = actions.objects[1].undo;
    const request = { contractVersion: 'canvas/v7', sessionRef: undoSessionRef, requestId: 'elsewhere-undo',
      worldRef: actions.worldRef, objectRef: actions.objects[1].objectRef, transactionId: 'elsewhere-undo',
      historyTransactionId: step.historyTransactionId, expectedHistoryRevision: step.expectedHistoryRevision,
      expectedWorldRevision: step.expectedWorldRevision, expectedObjectRevisions: step.expectedObjectRevisions,
      intentDigest: 'e'.repeat(64), surfaceActionDigest: 'f'.repeat(64), localContext: actions.localContext };
    assert.equal((await canvas.call(step.operation, request)).result.status, 'VERIFIED');
    finalRevision = canvas.store.snapshot.registryRevisions[actions.worldRef];
    if (notices.at(-1)?.registryRevision !== finalRevision) await reading;
    handle.dispose();
    assert.ok(notices.length >= 1);
    assert.ok(notices.every(notice => notice.worldRef === actions.worldRef));
    assert.equal(notices.at(-1).registryRevision, finalRevision);
    assert.ok(wire.some(row => row.endpoint === 'hanaworldsCanvasDisplay/changes' && row.stream));
    const view = await element.props.read(undoSessionRef);
    assert.equal(view.history.find(row => row.transactionId === 'elsewhere-undo').status, 'UNDONE');
  } finally { await close(); }
});

test('external world edit after the build: panel Undo is refused whole, nothing written (FIXTURE world)', async () => {
  const { createUndoExample } = await import('./support/undo-example.mjs');
  const { undoSessionRef } = await import('./support/undo-fixture-world.mjs');
  const { undoWorldFile } = await import('./support/undo-host.mjs');
  const seed = async directory => {
    await createUndoExample(directory);
    const file = undoWorldFile(directory);
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.nodes['9,2,8'] = { position: [9, 2, 8], geometryProfile: 'voxel-grid/v1', materialRef: 'fixture:external',  orientation: 0, state: { inventory: {}, metadata: {}, timer: null } };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  };
  const { registered, close, world, canvas } = await compose(seed, { fixtureWorld: true });
  try {
    const element = panel(registered, undoSessionRef);
    const before = structuredClone(canvas.store.snapshot);
    const second = (await element.props.readActions(undoSessionRef)).objects[1];
    assert.equal(second.undo.historyTransactionId, 'undo-fixture-cell-2');
    assert.equal(await reasonOf(element.props.undo(undoSessionRef, second.objectRef, 'undo-fixture-cell-2')), 'READBACK_MISMATCH');
    assert.equal(historyWrites(world), 0);
    assert.deepEqual(world.readCells([[8, 2, 8], [9, 2, 8], [10, 2, 8]]).map(cell => cell.materialRef),
      ['fixture:brick', 'fixture:external', 'fixture:brick']);
    assert.deepEqual(canvas.store.snapshot.history, before.history);
    assert.deepEqual(Object.keys(canvas.store.snapshot.pending), []);
  } finally { await close(); }
});

test('client view offers Undo only on the published latest row with an action handler', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ObjectsHistoryView } = await import('../src/display-view.mjs');
  const view = { state: 'READY', worldRef: 'w', objects: [{ objectRef: 'a', name: '小屋', occupiedCells: 3, bounds: null },
    { objectRef: 'b', name: null, occupiedCells: 2, bounds: null }],
    history: [{ transactionId: 'b-1', objectRef: 'b', objectName: null, sequence: 1, committedAt: null, mode: 'CELL', affectedCells: 2, status: 'COMMITTED' },
      { transactionId: 'a-1', objectRef: 'a', objectName: '小屋', sequence: 1, committedAt: null, mode: 'CELL', affectedCells: 3, status: 'COMMITTED' }] };
  const actions = { state: 'READY', worldRef: 'w', objects: [
    { objectRef: 'a', mode: 'CELL', applied: true, undo: { available: true, reason: null, historyTransactionId: 'a-1' } },
    { objectRef: 'b', mode: 'CELL', applied: true, undo: { available: false, reason: 'WORLD_CHANGED_SINCE', historyTransactionId: null } }] };
  const undo = { confirming: null, busy: false, message: null, error: null, request() {}, cancel() {}, confirm() {} };
  const render = props => renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view, ...props }));
  const live = render({ actions, undo });
  assert.equal(live.split('撤回这笔').length - 1, 1);
  assert.match(live, /只撤回世界最近一次改动/);
  assert.match(render({ actions, undo: { ...undo, confirming: 'a-1' } }), /确认撤回/);
  assert.doesNotMatch(render({}), /撤回这笔/);
  assert.match(render({}), /当前世界 · 只读/);
  assert.doesNotMatch(render({ actions }), /撤回这笔/);
});


test('shipped client redoes the clicked origin through the public gateway and rejects stale clicks', async () => {
  const { createUndoExample } = await import('./support/undo-example.mjs');
  const { undoSessionRef } = await import('./support/undo-fixture-world.mjs');
  const { registered, close, world, canvas } = await compose(directory => createUndoExample(directory), { fixtureWorld: true });
  try {
    const element = panel(registered, undoSessionRef);
    let object = (await element.props.readActions(undoSessionRef)).objects[1];
    const origin = object.undo.historyTransactionId;
    await element.props.undo(undoSessionRef, object.objectRef, origin);
    object = (await element.props.readActions(undoSessionRef)).objects[1];
    assert.equal(object.redo.available, true);
    assert.equal(object.redo.historyTransactionId, origin);
    const writes = historyWrites(world);
    assert.equal(await reasonOf(element.props.redo(undoSessionRef, object.objectRef, 'stale-origin')), 'HISTORY_MOVED');
    assert.equal(historyWrites(world), writes);
    const result = await element.props.redo(undoSessionRef, object.objectRef, origin);
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.originTransactionId, origin);
    assert.equal(canvas.store.snapshot.transactions[result.transactionId].direction, 'REDO');
    assert.deepEqual(world.readCells([[8, 2, 8], [9, 2, 8], [10, 2, 8]]).map(cell => cell.materialRef),
      ['fixture:brick', 'fixture:brick', 'fixture:brick']);
    assert.equal(await reasonOf(element.props.redo(undoSessionRef, object.objectRef, origin)), 'NOTHING_TO_REDO');
  } finally { await close(); }
});
