import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import canvasPlugin from '../../src/index.mjs';
import { validateType, validateRequest } from '../../src/protocol/local/index.mjs';
import { supplyFixturePeers, supplySessionRef, supplyWorldRef } from '../../scripts/config-supply-fixture.mjs';

// Peer facts are documented fixtures. Registration/tracking and Canvas entry are real.
// This is a component harness, not the production Bridge, Loader or native world.
export async function configHandoffFixture(t, { order = 'canvas-first', bridge = true } = {}) {
  const root = process.env.CANVAS_CATALOGUE_TEST_ROOT ?? fileURLToPath(new URL('../../../tmp/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'q288-config-'));
  const ctx = new Context();
  let audit;
  t.after(async () => {
    try { await audit?.(); }
    finally { try { await ctx.fiber.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  const peers = await supplyFixturePeers({ backendDeclared: true });
  const scope = { worldRef: supplyWorldRef, connectionRef: 'supply-fixture-connection',
    connectionIncarnationRef: peers.incarnation };
  const env = { ctx, directory, peers, scope, sessionRef: supplySessionRef, worldRef: supplyWorldRef,
    reads: [], readerCalls: [], provider: { providerRef: 'fixture:provider', providerRevision: 'fixture:generation' },
    duringRead: null, thrown: null, sourceError: null, changeResponse: null };
  const example = await peers.worldFacts.call('ReadCatalogue', {
    contractVersion: 'world-facts/v1', requestId: 'example-input', worldRef: env.worldRef });
  env.catalogue = example.result;
  env.profile = (await peers.worldFacts.call('ReadWriteProfile', {
    contractVersion: 'world-facts/v1', requestId: 'example-profile', worldRef: env.worldRef })).result;
  ctx.provide('dshHomePath', (...parts) => join(directory, ...parts));
  const mutations = [];
  ctx.provide('hanaworldsWorldAdapterV6', { ...peers.adapter, async call(operation, request) {
    assert.ok(['ReadLocalConnection', 'DiscoverConnections'].includes(operation), 'No world write/prepare or connection mutation');
    return peers.adapter.call(operation, request);
  } });
  ctx.provide('hanaworldsWorkshopV3', { async call(operation, request) {
    if (operation !== 'ReadSessionIdentity') mutations.push(operation);
    return peers.sessions.call(operation, request);
  } });
  env.sourceFiber = ctx.plugin({ name: 'q288-facts-example', apply(owner) {
    new class extends Service {
      constructor() { super(owner, 'hanaworldsWorldFacts'); }
      get protocolHandshake() { return peers.worldFacts.protocolHandshake; }
      async readCatalogue(input) {
        validateType('MaterialSourceConnection', input);
        assert.equal(this.ctx.root, ctx.root);
        assert.equal(this.ctx.get('hanaworldsCanvasV5'), env.canvas);
        assert.notEqual(this.ctx.fiber, env.bridgeContext?.fiber, 'Only Canvas reads Catalogue');
        return { provider: structuredClone(env.provider), facts: structuredClone(env.catalogue) };
      }
      async call(operation, request) {
        assert.equal(operation, 'ReadWriteProfile', 'Catalogue must use its provider-bearing Host path');
        assert.equal(this.ctx.fiber, env.bridgeContext?.fiber, 'ReadWriteProfile must execute in the real Bridge context');
        assert.equal(this.ctx.root, ctx.root);
        validateRequest('world-facts/v1', operation, request);
        env.reads.push(structuredClone(request));
        const response = { contractVersion: 'world-facts/v1', requestId: request.requestId,
          result: env.sourceError ? null : structuredClone(env.profile), error: env.sourceError };
        env.lastResponse = response;
        env.changeResponse?.(response);
        await env.duringRead?.(env);
        if (env.thrown) throw env.thrown;
        return response;
      }
    }();
  } }); await env.sourceFiber;
  env.startBridge = async () => {
    const fiber = ctx.plugin({ name: 'q288-bridge-example', apply(owner) {
      env.bridgeContext = owner;
      new class extends Service {
        constructor() { super(owner, 'hanaworldsWorldInspectionContext'); }
      }();
    } }); await fiber; return fiber;
  };
  const startCanvas = async () => {
    env.canvasFiber = ctx.plugin(canvasPlugin); await env.canvasFiber;
    env.canvas = ctx.get('hanaworldsCanvasV5'); await env.canvas.ready;
    assert.equal(env.canvas.storageState, 'READY');
  };
  if (bridge && order === 'bridge-first') env.bridgeFiber = await env.startBridge();
  await startCanvas();
  if (bridge && order === 'canvas-first') env.bridgeFiber = await env.startBridge();
  const selected = await env.canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v7',
    requestId: 'q288-selection', sessionRef: env.sessionRef, ...scope,
    expectedRevision: 'session-0', expectedContext: null });
  assert.equal(selected.error, null, JSON.stringify(selected.error));
  env.compiler = ctx.get('hanaworldsCompilerConfig');
  env.supply = ctx.get('hanaworldsCanvasConfigSupply');
  env.reader = async function (input, request) {
    assert.equal(this, env.bridgeContext, 'Canvas invokes the reader with its captured actual Bridge context');
    assert.deepEqual(input, scope);
    env.readerCalls.push({ scope: structuredClone(input), request: structuredClone(request) });
    const response = await this.get('hanaworldsWorldFacts').call('ReadWriteProfile', request);
    return response;
  };
  env.auditBaseline = structuredClone(env.canvas.store.snapshot);
  audit = () => {
    const { configSupply: oldObservation, ...before } = env.auditBaseline;
    const { configSupply: newObservation, ...after } = env.canvas.store.snapshot;
    assert.deepEqual(after, before, 'Configuration observations cannot change history, Session or bindings');
    assert.deepEqual(mutations, [], 'No extra Session action');
  };
  return env;
}
export function attachConfigFixture(env, { context = env.bridgeContext, reader = env.reader,
  receiver = env.canvas } = {}) {
  assert.equal(typeof env.canvas.attachConfigSource, 'function',
    'Q-288: registered Canvas must expose the trusted Host configuration handoff');
  const release = env.canvas.attachConfigSource.call(receiver, context, reader);
  assert.equal(typeof release, 'function', 'Handoff returns its exact runtime disposer');
  return release;
}
export const configRefusal = code => error => error.publicError?.code === code &&
  Array.isArray(error.missingSources) && error.missingSources.some(row => row.field === 'writeBackend');
