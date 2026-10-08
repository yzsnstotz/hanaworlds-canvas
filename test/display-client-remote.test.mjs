import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
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

function loadClientBundle(source) {
  // React is external to the bundle; this stub only builds element records (no rendering).
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'), useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }) };
  let factory;
  const sandbox = { window: { __ModuleLoader__: { load: entry => { factory = entry.factory; } },
    localStorage: { getItem: () => null, setItem: () => {} } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) } };
  vm.runInNewContext(source, sandbox, { filename: artifact });
  return factory(id => { if (id === 'react') return react; throw new Error(`unexpected require ${id}`); });
}

async function compose(seed) {
  const profile = await mkdtemp(join(tmpdir(), 'canvas-client-remote-'));
  if (seed) await seed(join(profile, 'data', 'hanaworlds-canvas'));
  const host = new Context();
  await host.plugin(TypertRegistry);
  host.provide('dshHomePath', (...parts) => join(profile, ...parts));
  const { default: canvasPlugin } = await import(process.env.CANVAS_ENTRY ?? new URL('../src/index.mjs', import.meta.url).href);
  await host.plugin(canvasPlugin);
  await host.get('hanaworldsCanvasV5').ready;
  const gateway = new TypertGatewayService(host, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const wire = [];
  const connection = { isLoopback: true, generation: { getSnapshot: () => undefined },
    registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
    rpc: { open: async function* () {}, call: async (path, endpoint, body) => {
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
  const registered = [];
  client.provide('slots', { inject: (_name, register) => register(),
    register: (meta, component) => { registered.push({ meta, component }); return () => {}; } });
  client.provide('layout', {});
  client.provide('sessions', {});
  const bundle = loadClientBundle(await readFile(artifact, 'utf8'));
  const fiber = client.plugin({ name: bundle.name, inject: bundle.inject, apply: bundle.apply });
  await fiber;
  const close = async () => { await fiber.dispose(); await client.fiber.dispose(); await host.fiber.dispose();
    await rm(profile, { recursive: true, force: true }); };
  return { gateway, wire, registered, close };
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
  const { createUndoExample } = await import('../scripts/undo-example.mjs');
  const { undoSessionRef } = await import('../scripts/undo-fixture-world.mjs');
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
