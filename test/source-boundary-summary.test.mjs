import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import canonicalize from 'canonicalize';
import { Context, Service } from '@deepseek-ai/cordis';
import canvasPlugin, { STORE_ROOT } from '../src/index.mjs';
import { createUndoExample } from './support/undo-example.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef } from './support/undo-fixture-world.mjs';
import { undoWorldFile } from './support/undo-host.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';

// C-world-facts readCanvasFacts example data, not native/world-source success evidence.
// Fixtures supply only documented peer data. The summary is always the real Canvas method.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scope = Object.fromEntries(['worldRef', 'connectionRef', 'connectionIncarnationRef']
  .map(key => [key, undoConnection[key]]));
const seal = body => ({ ...body, sourceRevision:sha(canonicalize(body)) });
const createdProfiles = new Set(); // This process's exact ownership, not a directory-name guess.
function sourceFacts(variant = 0) {
  const declaration = field => ({ kind:'LOADED_WORLD_DECLARATION', factRef:`decl:${variant}:${field}`,
    revision:sha(`loaded declaration bytes ${variant}`) });
  const unit = { name:variant ? 'declared-span' : 'declared-cell', metersPerGridUnit:variant ? null : 0.625 };
  return seal({ profileVersion:'canvas-source-facts/v1', connection:structuredClone(scope),
    provider:{ providerRef:'opaque-source-instance:A', providerRevision:'opaque-source-generation:A' },
    tools:[{ toolRef:'tool:fill', purpose:{value:variant ? '覆盖声明指定区域' : '填充声明指定区域',source:declaration('fill-purpose')},
      typicalScale:{value:{size:variant ? [13,17,19] : [7,5,9],unit:unit.name},source:declaration('fill-scale')} },
    { toolRef:'tool:line', purpose:{value:'沿声明轴绘制',source:declaration('line-purpose')},
      typicalScale:{value:{size:[3,11,2],unit:unit.name},source:declaration('line-scale')} }],
    unit:{value:unit,source:declaration('unit')},
    frame:{value:{profileVersion:'frame/v2',frameId:`opaque-frame:${variant}`,
      origin:variant ? [19,-5,7] : [-7,11,23],axes:variant ? ['-Y','+Z','-X'] : ['+Z','-X','+Y'],
      handedness:variant ? 'left' : 'right',gridUnit:structuredClone(unit),transformRevision:`transform:${variant}`},
      source:declaration('frame')},
    partition:{value:{edge:variant ? [32,32,32] : [16,16,16]},
      source:{kind:'NATIVE_OBSERVATION',factRef:`native-partition:${variant}`,revision:sha(`native edge ${variant}`)}} });
}
function changed(body, change) {
  const value = structuredClone(body); delete value.sourceRevision;
  change(value); return seal(value);
}
async function fileDigests(directory) {
  const result = {};
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), {withFileTypes:true})) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else { assert.ok(entry.isFile(), 'Fixture audit has no symlink escape'); result[path] = sha(await readFile(join(directory,path))); }
    }
  }
  await visit(); return result;
}
async function boot(t, { body = sourceFacts(), read, absent = false,
  pairedPartition = undoConnection.capabilities.worldGeometry.partition.edge } = {}) {
  const directory = await mkdtemp(fileURLToPath(new URL('../../q142-summary-profile-', import.meta.url)));
  createdProfiles.add(directory);
  let ctx, env, before, setupError;
  // Register immediately: even a mkdir/fixture/plugin setup failure must not
  // retain a whole temporary profile. Audits outlive it in the run evidence.
  t.after(async () => {
    const auditRoot = fileURLToPath(new URL('../../evidence/maintenance/summary-audits/', import.meta.url));
    try {
      await mkdir(auditRoot, { recursive: true });
      if (before) {
        const after = {snapshot:canonicalize(env.canvas.store.snapshot),files:await fileDigests(directory)};
        await writeFile(join(auditRoot, basename(directory) + '.json'), JSON.stringify({directory,before,after,effects:env.effects},null,2));
        assert.deepEqual(env.effects,{storeCommits:0,worldMutations:0,sessionMutations:0,legacyReads:0}, 'Summary read has zero durable/session/world effects');
        assert.equal(after.snapshot,before.snapshot,'History/projections/observations/binding remain unchanged');
        assert.deepEqual(after.files,before.files,'All durable world and Canvas files remain byte-identical');
      } else {
        await writeFile(join(auditRoot, basename(directory) + '.json'), JSON.stringify({directory,stage:'SETUP',
          error:setupError ? {name:setupError.name,message:setupError.message,code:setupError.code ?? null} : null},null,2));
      }
    } finally {
      try { await ctx?.fiber.dispose(); }
      finally {
        await rm(directory,{recursive:true,force:true});
        createdProfiles.delete(directory);
        await assert.rejects(lstat(directory),{code:'ENOENT'},'This exact owned temporary profile was removed');
      }
    }
  });
  try {
  const storeDirectory = join(directory, 'data', STORE_ROOT);
  await mkdir(storeDirectory, {recursive:true});
  const world = await openUndoFixtureWorld(undoWorldFile(storeDirectory), {create:true});
  const originalAdapter = world.adapter;
  const effects = {storeCommits:0, worldMutations:0, sessionMutations:0, legacyReads:0};
  // A different declared partition is paired through the existing public selection path.
  // It is never substituted for purpose, typicalScale or units.
  world.adapter = { ...originalAdapter, async call(operation, request) {
    const response = await originalAdapter.call(operation, request);
    if (operation !== 'ReadLocalConnection' || !response.result) return response;
    const value = structuredClone(response);
    value.result.capabilities.worldGeometry.partition.edge = [...pairedPartition];
    return value;
  } };
  await createUndoExample(storeDirectory, {world});
  ctx = new Context();
  env = {ctx, directory, body:structuredClone(body), effects, calls:[], receivers:[], owner:null, canvas:null};
  ctx.provide('dshHomePath', (...parts) => join(directory,...parts));
  ctx.provide('hanaworldsWorldAdapterV6', { ...world.adapter, async call(operation, request) {
    if (!/^(Read|Discover|List|Inspect)/.test(operation)) effects.worldMutations++;
    return world.adapter.call(operation, request);
  } });
  const sessions = fixtureSessions();
  ctx.provide('hanaworldsWorkshopV3', { async call(operation, request) {
    if (operation !== 'ReadSessionIdentity') effects.sessionMutations++;
    return sessions.call(operation, request);
  } });
  ctx.provide('hanaworldsLuantiNativeFacts', { readCanvasFacts() {
    effects.legacyReads++; assert.fail('Summary consumed retired engine-named service');
  } });
  if (!absent) {
    env.provider = ctx.plugin({ name:'legitimately-renamed-world-source', apply(owner) {
      env.owner = owner;
      new class extends Service {
        constructor() { super(owner,'hanaworldsWorldFacts'); this.fixtureMarker = 'original-source'; }
        call() { assert.fail('Summary used a wire fallback instead of readCanvasFacts'); }
        async readCanvasFacts(input) {
          env.receivers.push(this.ctx);
          assert.equal(this.ctx.root, ctx.root, 'Source receives the official shared root');
          assert.equal(this.ctx.get('hanaworldsCanvasV5'), env.canvas, 'Source receives the actual Canvas caller');
          assert.notEqual(this.ctx.fiber, owner.fiber, 'World-source owner is not the consuming Canvas fiber');
          env.calls.push(structuredClone(input));
          return read ? read(input, env) : structuredClone(env.body);
        }
      }();
    } });
    await env.provider;
  }
  env.fiber = ctx.plugin(canvasPlugin); await env.fiber;
  env.canvas = ctx.get('hanaworldsCanvasV5'); await env.canvas.ready;
  assert.equal(env.canvas.storageState,'READY');
  env.display = await env.canvas.readObjectsHistory(undoSessionRef);
  const commit = env.canvas.store.commit.bind(env.canvas.store);
  env.canvas.store.commit = (...args) => { effects.storeCommits++; return commit(...args); };
  before = {snapshot:canonicalize(env.canvas.store.snapshot),files:await fileDigests(directory)};
  return env;
  } catch (error) { setupError = error; throw error; }
}
const request = extras => ({sessionRef:undoSessionRef,...extras});
const refusal = code => error => error.publicError?.code === code &&
  error.publicError.mutationState === 'NONE' && error.publicError.transactionRef === null;

test('summary setup failure already owns a cleanup hook, retains its error audit and removes its exact profile', async t => {
  const prior = new Set(createdProfiles), hooks = [];
  const harness = { after: hook => hooks.push(hook) };
  // Exercise the real existing setup path with invalid peer partition data.
  // This is resource-lifecycle verification, not Canvas business RED.
  let original;
  try { await boot(harness,{pairedPartition:null}); }
  catch (error) { original = error; }
  t.after(async () => { for (const hook of hooks) if (createdProfiles.size > prior.size) await hook(); });
  assert.ok(original instanceof Error, 'The actual setup exception is preserved');
  assert.match(original.message,/EXAMPLE_TRANSACTION_FAILED/, 'Failure reaches the actual public fixture preparation');
  assert.equal(hooks.length,1,'Cleanup is registered before fixture/plugin preparation');
  const owned = [...createdProfiles].filter(path => !prior.has(path)); assert.equal(owned.length,1);
  await hooks[0]();
  await assert.rejects(lstat(owned[0]),{code:'ENOENT'});
  const auditRoot = fileURLToPath(new URL('../../evidence/maintenance/summary-audits/',import.meta.url));
  const audit = JSON.parse(await readFile(join(auditRoot,basename(owned[0])+'.json'),'utf8'));
  assert.equal(audit.stage,'SETUP'); assert.equal(audit.error.message,original.message);
  assert.equal(audit.error.name,original.name);
});

for (const variant of [0,1]) test(`public Canvas tool summary preserves every real-source field and own objects/history: ${variant}`, async t => {
  const body = sourceFacts(variant);
  const env = await boot(t,{body,pairedPartition:body.partition.value.edge});
  assert.equal(typeof env.canvas.readToolSummary,'function','Canvas must actually publish its summary read');
  const result = await env.canvas.readToolSummary(request());
  assert.deepEqual(result,{profileVersion:'canvas-tool-summary/v1',sessionRef:undoSessionRef,
    source:env.body,objectsHistory:env.display});
  assert.deepEqual(env.calls,[scope]);
  assert.equal(env.receivers.length,1);
  assert.notEqual(env.receivers[0].fiber,env.ctx.fiber,'Caller must be the registered Canvas fiber');
  assert.equal(result.objectsHistory.objects.length,2);
  assert.equal(result.objectsHistory.history.length,2);
  assert.notDeepEqual(result.source.tools[0].typicalScale.value.size,[2,2,2],'Own statistics cannot stand in for declared typical scale');
  result.source.tools[0].purpose.value = 'consumer-local edit';
  assert.notEqual(env.body.tools[0].purpose.value,'consumer-local edit','Readback does not alias provider-owned data');
});
test('summary follows a new complete declaration on the next read without persisting an observation', async t => {
  const env = await boot(t);
  const first = await env.canvas.readToolSummary(request());
  env.body = changed(sourceFacts(1),body => { body.partition = structuredClone(first.source.partition); });
  const next = await env.canvas.readToolSummary(request({expectedProvider:first.source.provider}));
  assert.deepEqual(next.source,env.body);
  assert.notEqual(first.source.sourceRevision,next.source.sourceRevision);
  assert.deepEqual(next.objectsHistory,first.objectsHistory);
  assert.equal(env.calls.length,2);
});
for (const [field,value] of [['worldRef','other-world'],['connectionRef','other-connection'],['connectionIncarnationRef','other-incarnation']]) {
  test(`summary rejects wrong returned ${field} even with a correctly recomputed source digest`, async t => {
    const env = await boot(t,{body:changed(sourceFacts(),body => { body.connection[field] = value; })});
    await assert.rejects(() => env.canvas.readToolSummary(request()),refusal('CURRENT_WORLD_MISMATCH'));
  });
  test(`summary rejects stale expected ${field} before source read`, async t => {
    const env = await boot(t);
    await assert.rejects(() => env.canvas.readToolSummary(request({expectedConnection:{...scope,[field]:value}})),refusal('CURRENT_WORLD_MISMATCH'));
    assert.equal(env.calls.length,0);
  });
}
for (const field of ['providerRef','providerRevision']) test(`summary rejects changed expected ${field}`, async t => {
  const env = await boot(t);
  const first = await env.canvas.readToolSummary(request());
  env.body = changed(env.body,body => { body.provider[field] = `new-${field}`; });
  await assert.rejects(() => env.canvas.readToolSummary(request({expectedProvider:first.source.provider})),refusal('CURRENT_WORLD_MISMATCH'));
});
for (const path of ['tools.0.purpose','tools.0.purpose.source','tools.0.typicalScale','tools.0.typicalScale.source',
  'unit','unit.source','frame','frame.source','partition','partition.source'])
test(`summary refuses missing sourced field ${path}`, async t => {
  const body = changed(sourceFacts(),value => { const keys = path.split('.'); const last = keys.pop();
    delete keys.reduce((object,key) => object[key],value)[last]; });
  const env = await boot(t,{body});
  await assert.rejects(() => env.canvas.readToolSummary(request()),refusal('TARGET_FACTS_INCOMPLETE'));
});
for (const [label,change] of [
  ['invalid declared size',body => { body.tools[0].typicalScale.value.size = [7,0,9]; }],
  ['wrong scale unit',body => { body.tools[0].typicalScale.value.unit = 'other-unit'; }],
  ['wrong Frame unit',body => { body.frame.value.gridUnit.name = 'other-unit'; }],
  ['invented source kind',body => { body.unit.source.kind = 'PACKAGE_DEFAULT'; }],
  ['declared partition instead of native observation',body => { body.partition.source.kind = 'LOADED_WORLD_DECLARATION'; }],
  ['duplicate tool',body => { body.tools.push(structuredClone(body.tools[0])); }],
  ['unsorted tool list',body => { body.tools.reverse(); }],
  ['empty tool list',body => { body.tools = []; }],
]) test(`summary rejects ${label}`, async t => {
  const env = await boot(t,{body:changed(sourceFacts(),change)});
  await assert.rejects(() => env.canvas.readToolSummary(request()),refusal('SCHEMA_INVALID'));
});
test('summary rejects a valid-shaped digest of different source values', async t => {
  const env = await boot(t,{body:{...sourceFacts(),sourceRevision:'a'.repeat(64)}});
  await assert.rejects(() => env.canvas.readToolSummary(request()),refusal('READBACK_MISMATCH'));
});
test('summary rejects unknown returned facts rather than silently dropping them', async t => {
  const env = await boot(t,{body:changed(sourceFacts(),body => { body.unknownFact = true; })});
  await assert.rejects(() => env.canvas.readToolSummary(request()),refusal('UNKNOWN_REQUIRED_FIELD'));
});
for (const input of [null,{}, {sessionRef:''}, {sessionRef:undoSessionRef,providerIdentity:'forged'}])
test(`summary validates its own request without reading the source: ${JSON.stringify(input)}`, async t => {
  const env = await boot(t);
  await assert.rejects(() => env.canvas.readToolSummary(input),refusal(input?.providerIdentity ? 'UNKNOWN_REQUIRED_FIELD' : 'SCHEMA_INVALID'));
  assert.equal(env.calls.length,0);
});
test('summary cannot create a binding for an unselected session', async t => {
  const env = await boot(t);
  await assert.rejects(() => env.canvas.readToolSummary({sessionRef:'unselected-fixture-session'}),refusal('WORLD_NOT_BOUND'));
  assert.equal(env.calls.length,0);
});
test('summary names absence of the documented source capability, with no wire or retired-service fallback', async t => {
  const env = await boot(t,{absent:true});
  await assert.rejects(() => env.canvas.readToolSummary(request()),refusal('CAPABILITY_UNAVAILABLE'));
});
for (const code of ['TARGET_FACTS_INCOMPLETE','ADAPTER_UNAVAILABLE','PAYLOAD_VERSION_MISMATCH','CURRENT_WORLD_MISMATCH'])
test(`summary preserves independent source refusal ${code} and provenance`, async t => {
  const publicError = {code,phase:'validate',retryability:'AFTER_NEW_FACTS',mutationState:'NONE',transactionRef:null,
    causeCode:null,reason:'REQUIRED_FACT_UNKNOWN',worldRef:scope.worldRef,
    source:{owner:'world-source',operation:'readCanvasFacts',resource:scope.worldRef,kind:'IO',nativeCode:'EIO'}};
  const error = Object.assign(new Error('independent source error'),{publicError});
  const env = await boot(t,{read:() => { throw error; }});
  await assert.rejects(() => env.canvas.readToolSummary(request()),failure => {
    assert.deepEqual(failure.publicError,publicError); return true;
  });
});
test('actual same-owner source replacement during await refuses stale summary even if public identity is reused', async t => {
  let finish, started;
  const reached = new Promise(resolve => { started = resolve; });
  const env = await boot(t,{read:() => { started(); return new Promise(resolve => { finish = resolve; }); }});
  const reading = env.canvas.readToolSummary(request());
  assert.equal(await Promise.race([reached.then(() => true),reading.then(() => false,() => false)]),true,
    'Replacement must occur after the actual source read starts');
  env.owner.set('hanaworldsWorldFacts',{fixtureMarker:'replacement-source',readCanvasFacts:async () => structuredClone(env.body)});
  assert.equal(env.ctx.get('hanaworldsWorldFacts').fixtureMarker,'replacement-source','Official owner replacement really took effect');
  finish(structuredClone(env.body));
  await assert.rejects(() => reading,refusal('CAPABILITY_UNAVAILABLE'));
});
test('a disposed Canvas cannot use its captured public summary read', async t => {
  const env = await boot(t);
  const read = env.canvas.readToolSummary.bind(env.canvas);
  await env.fiber.dispose();
  await env.ctx.plugin({name:'hanaworlds-canvas',apply(c) { c.provide('hanaworldsCanvasV5',{}); }});
  await assert.rejects(() => read(request()),refusal('CAPABILITY_UNAVAILABLE'));
  assert.equal(env.calls.length,0);
});
test('an actual other Host root carrying an inherited Canvas receiver cannot read its source', async t => {
  const env = await boot(t);
  const other = new Context();
  t.after(() => other.fiber.dispose());
  await other.plugin({name:'same-name-forged-canvas',apply(c) {
    c.provide('hanaworldsCanvasV5',Object.create(env.canvas));
  } });
  assert.notEqual(other.root,env.ctx.root);
  await assert.rejects(() => env.canvas.readToolSummary.call(other.get('hanaworldsCanvasV5'),request()),
    refusal('CAPABILITY_UNAVAILABLE'));
  assert.equal(env.calls.length,0);
});
test('actual Canvas disposal and same-name replacement during await cannot publish an old summary', async t => {
  let finish, started;
  const reached = new Promise(resolve => { started = resolve; });
  const env = await boot(t,{read:() => { started(); return new Promise(resolve => { finish = resolve; }); }});
  const reading = env.canvas.readToolSummary(request());
  assert.equal(await Promise.race([reached.then(() => true),reading.then(() => false,() => false)]),true);
  await env.fiber.dispose();
  await env.ctx.plugin({name:'hanaworlds-canvas',apply(c) { c.provide('hanaworldsCanvasV5',{}); }});
  assert.notEqual(env.ctx.get('hanaworldsCanvasV5'),env.canvas,'Replacement Canvas is actually registered');
  finish(structuredClone(env.body));
  await assert.rejects(() => reading,refusal('CAPABILITY_UNAVAILABLE'));
});
test('normal public declaration entry gives the summary precise owned request and result types', async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('./q142-summary-types-',import.meta.url)));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const file = join(directory,'consumer.mts');
  await writeFile(file, `import { CanvasV5, type CanvasToolSummaryRequest, type CanvasToolSummary } from 'hanaworlds-canvas';
declare const canvas: CanvasV5;
const input: CanvasToolSummaryRequest = {sessionRef:'session'};
const value: CanvasToolSummary = await canvas.readToolSummary(input);
const purpose: string = value.source.tools[0].purpose.value;
const edge: number = value.source.partition.value.edge[0];
const unit: number | null = value.source.unit.value.metersPerGridUnit;
const revision: string = value.source.provider.providerRevision;
const history: string = value.objectsHistory.history[0].transactionId;
// @ts-expect-error sessionRef is mandatory
const missing: CanvasToolSummaryRequest = {};
// @ts-expect-error identity assertions do not grant authority
await canvas.readToolSummary({sessionRef:'session',providerIdentity:'forged'});
// @ts-expect-error complete expected provider identity is required
await canvas.readToolSummary({sessionRef:'session',expectedProvider:{providerRef:'provider'}});
`);
  const result = spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/typescript/bin/tsc',import.meta.url)),
    '--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--skipLibCheck',file],
    {cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8'});
  assert.equal(result.status,0,`Public summary declaration consumption failed:\n${result.stdout}${result.stderr}`);
});
