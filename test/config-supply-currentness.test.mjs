import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CanvasV5, CanvasStore, CanvasConfigSupply } from '../src/index.mjs';
import { supplyFixturePeers, supplySessionRef, supplyWorldRef } from '../scripts/config-supply-fixture.mjs';
import { configHandoffFixture, attachConfigFixture } from './support/config-handoff-fixture.mjs';

async function select(canvas, peers, incarnation = peers.incarnation) {
  const current = canvas.current(supplySessionRef);
  const response = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v7',
    requestId: `currentness-select-${incarnation}`, sessionRef: supplySessionRef,
    worldRef: supplyWorldRef, connectionRef: 'supply-fixture-connection',
    connectionIncarnationRef: incarnation, expectedRevision: current?.selectionRevision ?? 'session-0',
    expectedContext: current?.localContext ?? null });
  assert.equal(response.error, null, JSON.stringify(response.error));
}

test('D179 queued real selection is checked inside the configuration commit callback', async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env);
  const store = env.canvas.store, commit = store.commit;
  let pending = true;
  store.commit = async function (change) {
    if (pending) {
      pending = false;
      env.peers.incarnation = 'queued-reopened-incarnation';
      await select(env.canvas, env.peers);
      env.auditBaseline = structuredClone(store.snapshot);
    }
    return Reflect.apply(commit, this, [change]);
  };
  await assert.rejects(() => env.compiler.read(env.worldRef), error => error.publicError?.code === 'STALE_REVISION');
  assert.equal(store.snapshot.configSupply?.[env.worldRef], undefined,
    'A queued selection must not allow an old SUPPLIED observation to be committed');
});

for (const kind of ['detach', 'bridge-dispose', 'source-dispose', 'adapter-withdrawal', 'canvas-dispose'])
  test(`D179 trusted ${kind} during observation durability cannot return compiler configuration`, async t => {
    const env = await configHandoffFixture(t);
    const release = attachConfigFixture(env);
    const store = env.canvas.store, commit = store.commit;
    let pending = true;
    store.commit = function (change) {
      return Reflect.apply(commit, this, [async state => {
        const result = await change(state);
        if (pending) {
          pending = false;
          if (kind === 'detach') release();
          if (kind === 'bridge-dispose') await env.bridgeFiber.dispose();
          if (kind === 'source-dispose') await env.sourceFiber.dispose();
          if (kind === 'adapter-withdrawal') env.ctx.set('hanaworldsWorldAdapterV6', undefined);
          if (kind === 'canvas-dispose') await env.canvasFiber.dispose();
        }
        return result;
      }]);
    };
    await assert.rejects(() => env.compiler.read(env.worldRef), error => {
      assert.equal(error.publicError?.code, 'CAPABILITY_UNAVAILABLE');
      assert.ok(error.missingSources.some(row => row.field === 'writeBackend'));
      assert.equal(error.cause?.publicError?.code, 'CAPABILITY_UNAVAILABLE');
      return true;
    });
  });

test('D179 trusted detach before observation callback cannot persist a SUPPLIED observation', async t => {
  const env = await configHandoffFixture(t); const release = attachConfigFixture(env);
  const store = env.canvas.store, commit = store.commit;
  store.commit = function (change) {
    release();
    return Reflect.apply(commit, this, [change]);
  };
  await assert.rejects(() => env.compiler.read(env.worldRef), error => {
    assert.equal(error.publicError?.code, 'CAPABILITY_UNAVAILABLE');
    assert.ok(error.missingSources.some(row => row.field === 'writeBackend'));
    assert.equal(error.cause?.cause, 'BRIDGE_CONFIG_SOURCE_ABSENT');
    return true;
  });
  assert.equal(store.snapshot.configSupply?.[env.worldRef], undefined);
});

test('D179 offline compiler retains complete UNKNOWN envelope and original raw response identity', async t => {
  const root = fileURLToPath(new URL('../../tmp/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'd179-currentness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const peers = await supplyFixturePeers({ backendDeclared: true });
  let raw;
  const originalCall = peers.worldFacts.call;
  peers.worldFacts.call = async function (operation, request) {
    if (operation !== 'ReadWriteProfile') return Reflect.apply(originalCall, this, [operation, request]);
    raw = { contractVersion: 'world-facts/v1', requestId: request.requestId, result: null,
      error: { code: 'ADAPTER_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_MANUAL_RECOVERY',
        mutationState: 'UNKNOWN', transactionRef: 'offline-uncertain-source', causeCode: null,
        reason: 'REQUIRED_FACT_UNKNOWN', worldRef: supplyWorldRef,
        source: { owner: 'world-source', operation, resource: supplyWorldRef, kind: 'IO', nativeCode: 'EIO' } } };
    return raw;
  };
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: peers.adapter,
    worldFacts: peers.worldFacts, sessions: peers.sessions });
  await select(canvas, peers);
  const supply = new CanvasConfigSupply(canvas);
  await assert.rejects(() => supply.readCompilerConfig(supplyWorldRef), error => {
    assert.equal(error.publicError.code, 'CAPABILITY_UNAVAILABLE');
    assert.ok(error.missingSources.some(row => row.field === 'writeBackend'));
    assert.deepEqual(error.cause.publicError, raw.error);
    assert.equal(error.cause.cause, raw);
    return true;
  });
  const report = await supply.read(supplyWorldRef);
  assert.equal(report.current.sources.writeProfile.cause, 'ADAPTER_UNAVAILABLE');
});
