import assert from 'node:assert/strict';
import { readFile, realpath, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { prepareSummaryPeers } from './production-summary-fixture.mjs';
import { Context, Service } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import * as canvas from 'hanaworlds-canvas';
import * as display from 'hanaworlds-canvas/display';
import * as consumer from 'hanaworlds-canvas/examples/native-facts-consumer.mjs';
const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('hanaworlds-contracts'), error => error.code === 'MODULE_NOT_FOUND');
assert.throws(() => require.resolve('cordis'), error => error.code === 'MODULE_NOT_FOUND');
const entry = await realpath(fileURLToPath(import.meta.resolve('hanaworlds-canvas')));
assert.ok(entry.startsWith(await realpath('node_modules') + '/'), 'entry must be installed, not development');
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.resolve('hanaworlds-canvas'))));
for (const [key, target] of Object.entries(manifest.exports)) {
  const specifier = key === '.' ? manifest.name : manifest.name + key.slice(1);
  if (typeof target === 'string' && target.endsWith('.json'))
    JSON.parse(await readFile(new URL(import.meta.resolve(specifier))));
  else if (key !== './client') await import(specifier);
}
assert.equal(new canvas.CanvasV5({ store: null }).status().version, manifest.version);
assert.equal(canvas.canvasProtocolHandshake.provenance.packageVersion, manifest.version);
assert.equal(canvas.Config.type, 'object');
const port = await consumer.createFixtureNativeFactsPort();
const facts = await port.readScopedState('local-connection', [[0, 1, 3]]);
assert.equal(consumer.validateNativeFactsScopedState(facts).worldRef, 'fixture-world');
assert.throws(() => consumer.validateNativeFactsScopedState({ cells: [] }), e => e.publicError?.code === 'SCHEMA_INVALID');
await assert.rejects(() => port.readScopedState('different', [[0, 1, 3]]), /NATIVE_FACTS_FIXTURE_ARGUMENT_MISMATCH/);
const missing = Object.fromEntries(Object.keys(facts.stateProfile).map(name => [name, { status: 'MISSING', reason: 'REQUIRED_FACT_UNKNOWN' }]));
assert.equal(canvas.assembleProfile('compilationConfig', missing, {}).status, 'SOURCE_MISSING');
const ctx = new Context();
try {
  const directory = join(process.cwd(), 'host-profile'); await mkdir(directory, { recursive: true });
  ctx.provide('dshHomePath', (...parts) => join(directory, ...parts));
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(canvas.default);
  const service = ctx.get('hanaworldsCanvasV5'); await service.ready;
  assert.equal(service.storageState, 'READY');
  let scopedReads = 0, scopedCaller;
  const provider = ctx.plugin({ name:'renamed-public-world-source', apply(c) {
    new class extends Service {
      constructor() { super(c, 'hanaworldsWorldFacts'); }
      readScopedState(connectionRef, positions) {
        scopedCaller = this.ctx; scopedReads++;
        assert.equal(this.ctx.get('hanaworldsCanvasV5'), service);
        assert.equal(connectionRef, 'local-connection');
        assert.deepEqual(positions, [[0,1,3]]);
        return structuredClone(facts);
      }
    }();
  } });
  await provider;
  assert.deepEqual(await service.nativeFacts.readScopedState('local-connection', [[0,1,3]]), facts);
  assert.equal(scopedReads, 1);
  assert.equal(scopedCaller.root, ctx.root);
  assert.notEqual(scopedCaller.fiber, ctx.fiber);
  assert.deepEqual(service.store.snapshot.pending, {});
  assert.deepEqual(service.store.snapshot.transactions, {});
  await provider.dispose();
  assert.throws(() => service.nativeFacts.readScopedState('local-connection', [[0,1,3]]),
    error => error.publicError?.code === 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(await service.readObjectsHistory(null), { state: 'NO_SESSION', worldRef: null, objects: [], history: [] });
  const reply = await service.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v7',
    sessionRef: 'absent-session', worldRef: 'fixture-world', requestId: 'absent' });
  assert.equal(reply.error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(reply.error.mutationState, 'NONE');
  assert.equal(reply.error.worldRef, 'fixture-world');
  assert.ok(ctx.get('hanaworldsCanvasDisplay'), 'normal Host entry registers its own display service');
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const invoke = (method, args) => gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method, args });
  assert.deepEqual(await invoke('read', { sessionRef: null }), { state: 'NO_SESSION', worldRef: null, objects: [], history: [] });
  assert.deepEqual(await invoke('actions', { sessionRef: null }), { state: 'NO_SESSION', worldRef: null, objects: [] });
  await assert.rejects(() => invoke('read', { sessionRef: {}, worldRef: 'extra-input' }));
  await assert.rejects(() => invoke('undo', { sessionRef: 'absent-session', objectRef: 'absent-object', historyTransactionId: 'absent-history' }));
  assert.equal(typeof display.CanvasDisplayService.prototype.read, 'function');
} finally { await ctx.fiber.dispose(); }

// A second normal Host uses document-shaped fixture peers and the installed Canvas's
// public selection/transaction path. No direct store insertion or source Canvas import.
const summaryCtx = new Context();
try {
  const directory = await mkdtemp(join(process.cwd(), 'summary-host-profile-'));
  const peers = await prepareSummaryPeers(join(directory, 'data', canvas.STORE_ROOT));
  summaryCtx.provide('dshHomePath', (...parts) => join(directory,...parts));
  summaryCtx.provide('hanaworldsWorldAdapterV6', peers.world.adapter);
  summaryCtx.provide('hanaworldsWorkshopV3', peers.sessions);
  const declaration = field => ({kind:'LOADED_WORLD_DECLARATION',factRef:`opaque-declaration:${field}`,revision:'opaque-revision:17'});
  const unit = {name:'declared-span',metersPerGridUnit:null};
  const body = {profileVersion:'canvas-source-facts/v1',connection:peers.scope,
    provider:{providerRef:'opaque-source-instance:1',providerRevision:'opaque-generation:1'},
    tools:[{toolRef:'tool:fill',purpose:{value:'填充公开声明区域',source:declaration('purpose')},
      typicalScale:{value:{size:[7,5,9],unit:unit.name},source:declaration('scale')}}],
    unit:{value:unit,source:declaration('unit')},
    frame:{value:{profileVersion:'frame/v2',frameId:'opaque-frame:1',origin:[-7,11,23],
      axes:['+Z','-X','+Y'],handedness:'right',gridUnit:unit,transformRevision:'opaque-transform:7'},source:declaration('frame')},
    partition:{value:{edge:[16,16,16]},source:{kind:'NATIVE_OBSERVATION',factRef:'opaque-native-partition:1',revision:'opaque-revision:9'}}};
  let supplied = {...body,sourceRevision:createHash('sha256').update(canonicalize(body)).digest('hex')};
  let failure, service, sourceReads=0;
  const provider = summaryCtx.plugin({name:'renamed-document-world-source',apply(owner) {
    new class extends Service {
      constructor() {super(owner,'hanaworldsWorldFacts');}
      async readCanvasFacts(scope) {
        assert.deepEqual(scope,peers.scope);
        assert.equal(this.ctx.get('hanaworldsCanvasV5'),service);
        assert.equal(this.ctx.root,summaryCtx.root);
        assert.notEqual(this.ctx.fiber,owner.fiber);
        sourceReads++;
        if (failure) throw Object.assign(new Error('peer refusal'),{publicError:failure});
        return structuredClone(supplied);
      }
    }();
  }}); await provider;
  await summaryCtx.plugin(canvas.default);
  service = summaryCtx.get('hanaworldsCanvasV5'); await service.ready;
  assert.equal(typeof service.readToolSummary,'function');
  const before = canonicalize(service.store.snapshot);
  let commits=0;
  const commit = service.store.commit.bind(service.store);
  service.store.commit = (...args) => {commits++;return commit(...args);};
  const callsBefore = peers.world.calls.length;
  const result = await service.readToolSummary({sessionRef:peers.sessionRef});
  assert.deepEqual(result.source,supplied);
  assert.deepEqual(result.objectsHistory,await service.readObjectsHistory(peers.sessionRef));
  assert.equal(result.objectsHistory.objects.length,2);
  assert.equal(result.objectsHistory.history.length,2);
  assert.equal(sourceReads,1);
  result.source.tools[0].purpose.value = 'consumer change';
  assert.equal(supplied.tools[0].purpose.value,'填充公开声明区域','consumer result has no mutable source alias');
  await assert.rejects(() => service.readToolSummary({sessionRef:peers.sessionRef,
    expectedProvider:{providerRef:'other-source',providerRevision:'other-generation'}}),
    error => error.publicError?.code==='CURRENT_WORLD_MISMATCH' && error.publicError.mutationState==='NONE');
  failure = {code:'TARGET_FACTS_INCOMPLETE',phase:'validate',retryability:'AFTER_NEW_FACTS',mutationState:'NONE',
    transactionRef:null,causeCode:null,reason:'REQUIRED_FACT_UNKNOWN',worldRef:peers.scope.worldRef,
    source:{owner:'world-source',operation:'readCanvasFacts',resource:'opaque-declaration:missing',kind:'NOT_FOUND',nativeCode:'SOURCE_MISSING'}};
  await assert.rejects(() => service.readToolSummary({sessionRef:peers.sessionRef}),
    error => {assert.deepEqual(error.publicError,failure);return true;});
  failure = undefined;
  supplied = structuredClone(supplied); delete supplied.tools[0].typicalScale.source;
  await assert.rejects(() => service.readToolSummary({sessionRef:peers.sessionRef}),
    error => error.publicError?.code==='TARGET_FACTS_INCOMPLETE' && error.publicError.mutationState==='NONE');
  await provider.dispose();
  await assert.rejects(() => service.readToolSummary({sessionRef:peers.sessionRef}),
    error => error.publicError?.code==='CAPABILITY_UNAVAILABLE' && error.publicError.mutationState==='NONE');
  assert.equal(commits,0);
  assert.equal(canonicalize(service.store.snapshot),before);
  assert.ok(peers.world.calls.slice(callsBefore).every(row => /^(Read|Discover|Inspect)/.test(row.operation)), 'summary has zero fixture world writes');
  console.log('PRODUCTION_TOOL_SUMMARY_PASS: actual installed Cordis Host, complete sourced values, history, scope/source/refusal envelopes, zero writes; FIXTURE peers');
} finally {await summaryCtx.fiber.dispose();}

let factory;
vm.runInNewContext(await readFile(new URL(import.meta.resolve('hanaworlds-canvas/client')), 'utf8'), {
  window: { __ModuleLoader__: { load: entry => { factory = entry.factory; } } },
});
const client = factory(id => { assert.equal(id, 'react'); return require('react'); });
assert.equal(typeof client.apply, 'function');
console.log('PRODUCTION_CAPABILITIES_PASS: all public entries, schemas, Config, durable official Cordis Host, fail-closed session/world errors, native consumer, shared React client');
