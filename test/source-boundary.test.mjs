import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import canvasPlugin from '../src/index.mjs';

const state = { worldRef: 'scope-world', stateProfile: { profileVersion: 'state-profile/v3',
  derivedFields: ['light'], preservedFields: ['inventory', 'metadata', 'timer'], clearedFields: [] },
  cells: [{ position: [0, 1, 3], availability: 'KNOWN', stateDigest: 'a'.repeat(64) }] };
async function boot(t, facts) {
  const directory = await mkdtemp(fileURLToPath(new URL('../../q127-source-profile-', import.meta.url)));
  const ctx = new Context();
  ctx.provide('dshHomePath', (...parts) => join(directory, ...parts));
  const calls = [];
  ctx.provide('hanaworldsLuantiNativeFacts', { readScopedState() { assert.fail('retired service consumed'); } });
  const provider = ctx.plugin({ name: 'renamed-world-source', apply(c) {
    c.provide('hanaworldsWorldFacts', facts ?? { readScopedState(ref, positions) {
      calls.push({ ref, positions }); return structuredClone(state);
    } });
  } });
  await provider;
  const fiber = ctx.plugin(canvasPlugin); await fiber;
  const canvas = ctx.get('hanaworldsCanvasV5'); await canvas.ready;
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { ctx, provider, fiber, canvas, calls };
}
test('Canvas consumes documented neutral scoped state on its official Host root with zero writes', async t => {
  const env = await boot(t);
  assert.deepEqual(await env.canvas.nativeFacts.readScopedState('connection', [[0, 1, 3]]), state);
  assert.deepEqual(env.calls, [{ ref: 'connection', positions: [[0, 1, 3]] }]);
  assert.deepEqual(env.canvas.store.snapshot.pending, {});
  assert.deepEqual(env.canvas.store.snapshot.transactions, {});
  await env.provider.dispose();
  assert.throws(() => env.canvas.nativeFacts.readScopedState('connection', [[0, 1, 3]]),
    e => e.publicError?.code === 'CAPABILITY_UNAVAILABLE');
});
test('all dependency categories omit the retired protocol package and unscoped runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  for (const section of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) {
    assert.ok(!manifest[section]?.['hanaworlds-contracts'], section);
    assert.ok(!manifest[section]?.cordis, `old runtime in ${section}`);
  }
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
  assert.ok(!lock.packages['node_modules/hanaworlds-contracts']);
  assert.ok(!lock.packages['node_modules/cordis']);
});
test('normal build provenance names Canvas-owned document structures, not an external SDK supplier', async () => {
  const build = JSON.parse(await readFile(new URL('../lib/build-source.json', import.meta.url)));
  assert.equal(build.supplier.name, 'hanaworlds-canvas');
  const inputs = Object.keys(build.inputs);
  assert.ok(inputs.some(path => path.startsWith('src/protocol/')), 'Owned protocol must be an actual normal build input');
  assert.ok(inputs.every(path => !path.startsWith('node_modules/hanaworlds-contracts/')));
});

test('neutral service retains the real Canvas caller through official Cordis tracking', async t => {
  const { Service } = await import('@deepseek-ai/cordis');
  const env = await boot(t);
  await env.provider.dispose();
  let caller;
  await env.ctx.plugin({ name: 'other-legal-source-name', apply(c) {
    new class extends Service {
      constructor() { super(c, 'hanaworldsWorldFacts'); }
      readScopedState() { caller = this.ctx; return structuredClone(state); }
    }();
  } });
  assert.deepEqual(await env.canvas.nativeFacts.readScopedState('connection', [[0, 1, 3]]), state);
  assert.equal(caller.root, env.ctx.root);
  assert.equal(caller.get('hanaworldsCanvasV5'), env.canvas);
  assert.notEqual(caller.fiber, env.ctx.fiber, 'must use the Canvas plugin caller, not the root');
});

for (const [label, raw, code] of [
  ['missing world', { ...state, worldRef: undefined }, 'SCHEMA_INVALID'],
  ['bad profile', { ...state, stateProfile: {} }, 'SCHEMA_INVALID'],
  ['bad digest', { ...state, cells: [{ ...state.cells[0], stateDigest: 'broken' }] }, 'SCHEMA_INVALID'],
  ['missing coverage', { ...state, cells: [] }, 'SCHEMA_INVALID'],
  ['wrong position', { ...state, cells: [{ ...state.cells[0], position: [1,1,3] }] }, 'TARGET_FACTS_INCOMPLETE'],
  ['unknown cell', { ...state, cells: [{ ...state.cells[0], availability: 'UNKNOWN', stateDigest: null }] }, 'TARGET_FACTS_INCOMPLETE'],
]) test(`neutral scoped read refuses ${label} without transaction effects`, async t => {
  const env = await boot(t, { readScopedState: () => raw });
  await assert.rejects(() => env.canvas.nativeFacts.readScopedState('connection', [[0,1,3]]),
    e => e.publicError?.code === code && e.publicError.mutationState === 'NONE');
  assert.deepEqual(env.canvas.store.snapshot.pending, {});
  assert.deepEqual(env.canvas.store.snapshot.transactions, {});
});
for (const positions of [[], [[0,1,3],[0,1,3]], [[1,1,3],[0,1,3]], [[0.1,1,3]]])
  test(`neutral input refusal precedes native read: ${JSON.stringify(positions)}`, async t => {
    const env = await boot(t);
    assert.throws(() => env.canvas.nativeFacts.readScopedState('connection', positions),
      e => e.publicError?.code === 'SCHEMA_INVALID');
    assert.equal(env.calls.length, 0);
  });
for (const code of ['WORLD_NOT_BOUND','ADAPTER_UNAVAILABLE','READBACK_MISMATCH','CURRENT_WORLD_MISMATCH','UNKNOWN_REQUIRED_FIELD'])
  test(`independent provider refusal ${code} retains protocol fields and identity`, async t => {
    const error = Object.assign(new Error(code), { publicError: { code, phase:'validate',
      retryability:'AFTER_NEW_FACTS', mutationState:'NONE', transactionRef:null,
      causeCode:null, reason:'REQUIRED_FACT_UNKNOWN', worldRef:'scope-world' } });
    const env = await boot(t, { readScopedState() { throw error; } });
    assert.throws(() => env.canvas.nativeFacts.readScopedState('connection', [[0,1,3]]), e => e === error);
  });
test('inactive and same-name replacement Canvas cannot retain captured source access', async t => {
  const env = await boot(t);
  const read = env.canvas.nativeFacts.readScopedState;
  await env.fiber.dispose();
  await env.ctx.plugin({ name:'hanaworlds-canvas', apply(c) { c.provide('hanaworldsCanvasV5', {}); } });
  assert.throws(() => read('connection', [[0,1,3]]), e => e.publicError?.code === 'CAPABILITY_UNAVAILABLE');
  assert.equal(env.calls.length, 0);
});
test('source replacement during an awaited read cannot report stale success', async t => {
  let finish;
  const env = await boot(t, { readScopedState: () => new Promise(resolve => { finish = resolve; }) });
  const reading = env.canvas.nativeFacts.readScopedState('connection', [[0,1,3]]);
  await env.provider.dispose();
  await env.ctx.plugin({ name:'renamed-world-source', apply(c) {
    c.provide('hanaworldsWorldFacts', { readScopedState: () => state });
  } });
  finish(state);
  await assert.rejects(() => reading, e => e.publicError?.code === 'CAPABILITY_UNAVAILABLE');
});
test('a second official framework instance cannot successfully consume the scoped port', async t => {
  // Distinct module evaluation of the identical approved release, with the same public dependencies.
  const { pathToFileURL } = await import('node:url');
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(fileURLToPath(new URL('../../q127-second-runtime-', import.meta.url)));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/cordis')), 'utf8');
  const file = join(directory, 'cordis.mjs');
  await writeFile(file, source.replace('"@deepseek-ai/cosmokit"', JSON.stringify(import.meta.resolve('@deepseek-ai/cosmokit'))));
  const { Context: OtherContext } = await import(pathToFileURL(file));
  assert.notEqual(OtherContext, Context);
  const profile = join(directory, 'profile');
  const { mkdir } = await import('node:fs/promises'); await mkdir(profile);
  const ctx = new OtherContext();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('dshHomePath', (...parts) => join(profile, ...parts));
  ctx.provide('hanaworldsWorldFacts', { readScopedState() { assert.fail('dual runtime read'); } });
  ctx.provide('hanaworldsLuantiNativeFacts', { readScopedState() { return structuredClone(state); } });
  await ctx.plugin(canvasPlugin);
  const canvas = ctx.get('hanaworldsCanvasV5'); await canvas.ready;
  assert.throws(() => canvas.nativeFacts.readScopedState('connection', [[0,1,3]]),
    e => e.publicError?.code === 'CAPABILITY_UNAVAILABLE');
});

test('documented world-source failure provenance is consumed without a shared constructor', async t => {
  const failure = { code:'TARGET_FACTS_INCOMPLETE', phase:'validate', retryability:'AFTER_NEW_FACTS',
    mutationState:'NONE', transactionRef:null, causeCode:null, reason:'REQUIRED_FACT_UNKNOWN',
    source: { owner:'world-source', operation:'readScopedState', resource:'scope-world', kind:'IO', nativeCode:'EIO' } };
  const thrown = Object.assign(new Error('independent provider'), { publicError: failure });
  const env = await boot(t, { readScopedState() { throw thrown; } });
  assert.throws(() => env.canvas.nativeFacts.readScopedState('connection', [[0,1,3]]), e => e.publicError === failure);
});

test('document-protocol source fixture refuses cross-root, root and forged receiver identities', async t => {
  const { Service, symbols } = await import('@deepseek-ai/cordis');
  const env = await boot(t);
  await env.provider.dispose();
  let original, reads = 0;
  const expectedFiber = env.fiber.ctx.fiber;
  const refuse = () => { throw Object.assign(new Error('CAPABILITY_UNAVAILABLE'), { publicError: {
    code:'CAPABILITY_UNAVAILABLE', phase:'validate', retryability:'AFTER_NEW_FACTS',
    mutationState:'NONE', transactionRef:null, causeCode:null, reason:'REQUIRED_FACT_UNKNOWN' } }); };
  await env.ctx.plugin({ name:'independent-renamed-source', apply(c) {
    original = new class extends Service {
      constructor() { super(c, 'hanaworldsWorldFacts'); }
      readScopedState() {
        if (!(this.ctx instanceof Context) || this.ctx.root !== env.ctx.root ||
            this.ctx.fiber !== expectedFiber || this.ctx.get('hanaworldsCanvasV5') !== env.canvas)
          refuse();
        reads++; return structuredClone(state);
      }
    }();
  } });
  assert.deepEqual(await env.canvas.nativeFacts.readScopedState('connection', [[0,1,3]]), state);
  const other = new Context(); t.after(() => other.fiber.dispose());
  other.provide('hanaworldsWorldFacts', original);
  other.provide('hanaworldsCanvasV5', env.canvas); // a copied value does not transfer root/fiber authority
  for (const read of [
    () => other.get('hanaworldsWorldFacts').readScopedState('connection', [[0,1,3]]),
    () => env.ctx.get('hanaworldsWorldFacts').readScopedState('connection', [[0,1,3]]),
    () => original.readScopedState.call({ ctx: { root:env.ctx.root, fiber:expectedFiber,
      get: () => env.canvas } }, 'connection', [[0,1,3]]),
  ]) assert.throws(read, e => e.publicError?.code === 'CAPABILITY_UNAVAILABLE');
  assert.equal(reads, 1);
  assert.equal(original[symbols.original] ?? original, original);
});

test('offline Canvas constructor remains importable when optional Host Cordis is absent', async t => {
  const { build } = await import('esbuild');
  const { writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const directory = await mkdtemp(fileURLToPath(new URL('../../q127-offline-', import.meta.url)));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const file = join(directory, 'canvas.mjs');
  await build({ entryPoints:[new URL('../src/index.mjs', import.meta.url).pathname], outdir:directory,
    splitting:true, entryNames:'canvas', outExtension:{'.js':'.mjs'},
    bundle:true, format:'esm', platform:'node', target:'node24', external:['@deepseek-ai/cordis'],
    plugins:[{ name:'current-version', setup(builder) {
      builder.onResolve({filter:/^\.\.\/package\.json$/}, () => ({path:import.meta.resolve('../package.json'), external:true}));
    } }] });
  const offline = await import(pathToFileURL(file));
  assert.equal(new offline.CanvasV5({store:null}).status().version, '0.16.0');
});
