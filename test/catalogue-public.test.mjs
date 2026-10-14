import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Context, Service } from '@deepseek-ai/cordis';
import canvasPlugin, { STORE_ROOT } from '../src/index.mjs';
import { validateCatalogueFacts, validateType, digestValue, canonicalJSON } from '../src/protocol/local/index.mjs';
import { supplyFixturePeers, supplySessionRef as sessionRef, supplyWorldRef as worldRef }
  from '../scripts/config-supply-fixture.mjs';

// Q-285 formal C-world-facts v2 Host input; Canvas entry is real.
// The original wire is intentionally not a fallback for provider-bearing facts.
// This suite proves component behavior, never source authenticity or real Loader/UI.
const runRoot = process.env.CANVAS_CATALOGUE_TEST_ROOT ?? fileURLToPath(new URL('../../tmp/', import.meta.url));
const scope = { worldRef, connectionRef: 'supply-fixture-connection',
  connectionIncarnationRef: 'supply-fixture-incarnation-1' };
const input = extra => ({ sessionRef, ...extra });
const refusal = code => error => error.publicError?.code === code &&
  error.publicError.mutationState === 'NONE' && error.publicError.transactionRef === null;
const errorBody = (code = 'TARGET_FACTS_INCOMPLETE') => ({ code, phase: 'validate',
  retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE', transactionRef: null,
  causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN', worldRef,
  source: { owner: 'world-source', operation: 'ReadCatalogue', resource: worldRef,
    kind: 'IO', nativeCode: 'EIO' } });
async function files(root) {
  const result = {};
  async function visit(path = '') {
    for (const item of await readdir(join(root, path), { withFileTypes: true })) {
      const next = join(path, item.name);
      if (item.isDirectory()) await visit(next);
      else {
        assert.ok(item.isFile());
        result[next] = createHash('sha256').update(await readFile(join(root, next))).digest('hex');
      }
    }
  }
  await visit(); return result;
}
async function boot(t, { absent = false, unbound = false } = {}) {
  await mkdir(runRoot, { recursive: true });
  const directory = await mkdtemp(join(runRoot, 'q282-catalogue-'));
  const ctx = new Context();
  let verify;
  t.after(async () => {
    try { await verify?.(); }
    finally { try { await ctx.fiber.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  const peers = await supplyFixturePeers();
  const original = await peers.worldFacts.call('ReadCatalogue', {
    contractVersion: 'world-facts/v1', requestId: 'example-before-call', worldRef });
  const env = { ctx, directory, peers, body: structuredClone(original.result),
    provider: { providerRef: 'fixture-provider', providerRevision: 'fixture-generation-1' },
    reads: [], adapterReads: [], duringRead: null, duringConnection: null, peerError: null, thrown: null };
  validateCatalogueFacts(env.body, scope);
  ctx.provide('dshHomePath', (...parts) => join(directory, ...parts));
  ctx.provide('hanaworldsWorkshopV3', peers.sessions);
  env.adapterFiber = ctx.plugin({ name: 'q282-example-adapter', apply(owner) {
    new class extends Service {
      constructor() { super(owner, 'hanaworldsWorldAdapterV6'); }
      get protocolHandshake() { return peers.adapter.protocolHandshake; }
      async call(operation, request) {
        env.adapterReads.push(operation);
        const response = await peers.adapter.call(operation, request);
        await env.duringConnection?.(operation, request, env);
        return response;
      }
    }();
  } }); await env.adapterFiber;
  env.registerSource = async () => {
    const fiber = ctx.plugin({ name: 'q282-renamed-world-source', apply(owner) {
      new class extends Service {
        constructor() { super(owner, 'hanaworldsWorldFacts'); }
        get protocolHandshake() { return peers.worldFacts.protocolHandshake; }
        call() { assert.fail('Catalogue transfer must use the formal provider-bearing Host read'); }
        async readCatalogue(request) {
          validateType('MaterialSourceConnection', request);
          assert.equal(this.ctx.root, ctx.root);
          assert.equal(this.ctx.get('hanaworldsCanvasV5'), env.canvas);
          assert.notEqual(this.ctx.fiber, owner.fiber, 'Source read uses Canvas consuming context');
          env.reads.push(structuredClone(request));
          const result = { provider: structuredClone(env.provider), facts: structuredClone(env.body) };
          await env.duringRead?.(env);
          if (env.thrown) throw env.thrown;
          if (env.peerError) {
            env.sourceFailure = Object.assign(new Error('formal source refusal', { cause: new Error('original I/O') }),
              { publicError: env.peerError });
            throw env.sourceFailure;
          }
          return result;
        }
      }();
    } }); await fiber; return fiber;
  };
  if (!absent) env.sourceFiber = await env.registerSource();
  env.canvasFiber = ctx.plugin(canvasPlugin); await env.canvasFiber;
  env.canvas = ctx.get('hanaworldsCanvasV5'); await env.canvas.ready;
  assert.equal(env.canvas.storageState, 'READY', JSON.stringify(env.canvas.storageFailure));
  if (!unbound) {
    const selected = await env.canvas.call('SelectWorldConnection', {
      contractVersion: 'canvas/v7', sessionRef, requestId: 'q282-select', ...scope,
      expectedRevision: 'session-0', expectedContext: null });
    assert.equal(selected.error, null, JSON.stringify(selected.error));
  }
  env.adapterReads.length = 0;
  // Compare immutable, complete JSON values: structuredClone changes null prototypes.
  const before = { snapshot: canonicalJSON(env.canvas.store.snapshot), files: await files(directory) };
  let commits = 0;
  const commit = env.canvas.store.commit.bind(env.canvas.store);
  env.canvas.store.commit = (...args) => { commits++; return commit(...args); };
  verify = async () => {
    assert.equal(commits, 0, 'Catalogue read cannot persist observations, history, binding or Session');
    assert.equal(canonicalJSON(env.canvas.store.snapshot), before.snapshot);
    assert.deepEqual(await files(directory), before.files, 'All Canvas durable files remain byte-identical');
    assert.ok(env.adapterReads.every(op => op === 'ReadLocalConnection'), 'No world write, prepare or connection action');
  };
  return env;
}
function read(env, request = input(), receiver = env.canvas) {
  assert.equal(typeof env.canvas.readCatalogue, 'function',
    'Q-282: registered Canvas must expose the current Catalogue to Workshop/Host');
  return env.canvas.readCatalogue.call(receiver, request);
}
function revise(env) {
  env.body.catalogue.engineRevisions['fixture-source'] = 'fixture-source-2';
  env.body.catalogueDigest = digestValue('catalogue', env.body.catalogue).sha256;
  env.body.presentation['fixture:stone'].displayName = 'Changed source display';
}

test('Q291 Catalogue audit accepts idle boot and detects value and key changes', async t => {
  const env = await boot(t); // The normal after hook runs with no Catalogue call.
  const snapshot = env.canvas.store.snapshot;
  const baseline = canonicalJSON(snapshot);
  assert.equal(canonicalJSON(structuredClone(snapshot)), baseline);
  const changed = structuredClone(snapshot);
  assert.equal(typeof changed.sessions[sessionRef].selectionRevision, 'string');
  changed.sessions[sessionRef].selectionRevision = 'session-audit-change';
  assert.throws(() => assert.equal(canonicalJSON(changed), baseline), { code: 'ERR_ASSERTION' });
  const removed = structuredClone(snapshot);
  const key = Object.keys(removed)[0];
  assert.ok(key);
  delete removed[key];
  assert.throws(() => assert.equal(canonicalJSON(removed), baseline), { code: 'ERR_ASSERTION' });
  const added = structuredClone(snapshot);
  added.auditUnexpectedKey = null;
  assert.throws(() => assert.equal(canonicalJSON(added), baseline), { code: 'ERR_ASSERTION' });
  // Strict admission must not silently drop an existing undefined-valued key.
  added.auditUnexpectedKey = undefined;
  assert.throws(() => canonicalJSON(added));
});

test('Q282 current Catalogue is complete, source-bound, copied and forwarded through Canvas', async t => {
  const env = await boot(t);
  const actual = await read(env);
  assert.deepEqual(actual, { provider: env.provider, facts: env.body });
  assert.ok(env.reads.length >= 2, 'Return requires a fresh source recheck');
  assert.ok(env.adapterReads.length >= 2, 'Return requires a fresh connection recheck');
  assert.ok(env.reads.every(request => request.worldRef === worldRef));
  actual.facts.presentation['fixture:stone'].displayName = 'Consumer edit';
  assert.notEqual(env.body.presentation['fixture:stone'].displayName, 'Consumer edit');
  const next = await read(env, input({ expectedConnection: scope, expectedCatalogueDigest: env.body.catalogueDigest }));
  assert.deepEqual(next, { provider: env.provider, facts: env.body });
});
test('Q282 next read returns stable new source values and rejects the previous digest', async t => {
  const env = await boot(t); const prior = await read(env); revise(env);
  const next = await read(env); assert.deepEqual(next, { provider: env.provider, facts: env.body });
  assert.notEqual(next.facts.catalogueDigest, prior.facts.catalogueDigest);
  await assert.rejects(() => read(env, input({ expectedCatalogueDigest: prior.facts.catalogueDigest })), refusal('CATALOGUE_MISMATCH'));
});
for (const [name, request, code] of [
  ['missing Session', {}, 'SCHEMA_INVALID'],
  ['empty Session', { sessionRef: '' }, 'SCHEMA_INVALID'],
  ['partial connection', input({ expectedConnection: { worldRef } }), 'SCHEMA_INVALID'],
  ['extra authority', input({ worldRef: 'other-world' }), 'UNKNOWN_REQUIRED_FIELD'],
  ['wrong world', input({ expectedConnection: { ...scope, worldRef: 'other-world' } }), 'CURRENT_WORLD_MISMATCH'],
  ['wrong connection', input({ expectedConnection: { ...scope, connectionRef: 'other-connection' } }), 'CURRENT_WORLD_MISMATCH'],
  ['old incarnation', input({ expectedConnection: { ...scope, connectionIncarnationRef: 'old' } }), 'CURRENT_WORLD_MISMATCH'],
]) test(`Q282 ${name} is refused before any Catalogue read`, async t => {
  const env = await boot(t); await assert.rejects(() => read(env, request), refusal(code));
  assert.equal(env.reads.length, 0);
});
for (const [name, options, code] of [
  ['unbound Session', { unbound: true }, 'WORLD_NOT_BOUND'],
  ['absent facts provider', { absent: true }, 'CAPABILITY_UNAVAILABLE'],
]) test(`Q282 ${name} cannot return a placeholder Catalogue`, async t => {
  const env = await boot(t, options); await assert.rejects(() => read(env), refusal(code));
  assert.equal(env.reads.length, 0);
});
for (const [name, change, code] of [
  ['wrong returned world', body => { body.connection.worldRef = 'other-world'; }, 'CURRENT_WORLD_MISMATCH'],
  ['wrong returned connection', body => { body.connection.connectionRef = 'other-connection'; }, 'CURRENT_WORLD_MISMATCH'],
  ['missing presentation', body => { delete body.presentation; }, 'SCHEMA_INVALID'],
  ['unknown field', body => { body.extraAuthority = true; }, 'UNKNOWN_REQUIRED_FIELD'],
  ['corrupt Catalogue digest', body => { body.catalogueDigest = '0'.repeat(64); }, 'CATALOGUE_MISMATCH'],
]) test(`Q282 ${name} remains a named refusal`, async t => {
  const env = await boot(t); change(env.body);
  await assert.rejects(() => read(env), refusal(code));
});
test('Q282 complete peer Error/source survives formal Host rejection and same-instance recovery succeeds', async t => {
  const env = await boot(t); env.peerError = errorBody();
  await assert.rejects(() => read(env), error => {
    assert.deepEqual(error.publicError, env.peerError);
    assert.equal(error, env.sourceFailure, 'Formal Host exception stays the original object');
    assert.equal(error.cause, env.sourceFailure.cause);
    return true;
  });
  env.peerError = null; assert.deepEqual(await read(env), { provider: env.provider, facts: env.body });
});
test('Q282 thrown original object, cause and UNKNOWN are not rewritten', async t => {
  const env = await boot(t);
  env.thrown = Object.assign(new Error('original source refusal', { cause: new Error('original I/O') }), {
    publicError: { ...errorBody('ADAPTER_UNAVAILABLE'), mutationState: 'UNKNOWN',
      transactionRef: 'opaque-uncertain', retryability: 'AFTER_MANUAL_RECOVERY' } });
  await assert.rejects(() => read(env), error => error === env.thrown && error.cause === env.thrown.cause);
});
test('Q282 source revision drifting during a read is refused and stable recovery succeeds', async t => {
  const env = await boot(t); let first = true;
  env.duringRead = () => { if (first) { first = false; revise(env); } };
  await assert.rejects(() => read(env), refusal('CURRENT_WORLD_MISMATCH'));
  env.duringRead = null; assert.deepEqual(await read(env), { provider: env.provider, facts: env.body });
});
test('Q282 presentation drifting with an unchanged Catalogue digest is still refused', async t => {
  const env = await boot(t); let first = true;
  const digest = env.body.catalogueDigest;
  env.duringRead = () => { if (first) { first = false;
    env.body.presentation['fixture:stone'].displayName = 'New presentation only'; } };
  await assert.rejects(() => read(env), refusal('CURRENT_WORLD_MISMATCH'));
  assert.equal(env.body.catalogueDigest, digest);
});
test('Q282 connection reopened during a read cannot release old facts', async t => {
  const env = await boot(t); env.duringRead = () => { env.peers.incarnation = 'reopened'; };
  await assert.rejects(() => read(env), refusal('CURRENT_WORLD_MISMATCH'));
});
for (const method of ['dispose', 'replace']) test(`Q282 source ${method} during await invalidates captured authority`, async t => {
  const env = await boot(t); let first = true;
  env.duringRead = async () => {
    if (!first) return; first = false; await env.sourceFiber.dispose();
    if (method === 'replace') env.sourceFiber = await env.registerSource();
  };
  await assert.rejects(() => read(env), refusal('CAPABILITY_UNAVAILABLE'));
});
test('Q282 adapter replacement during await cannot release old connection facts', async t => {
  const env = await boot(t); let first = true;
  env.duringRead = async () => { if (first) { first = false; await env.adapterFiber.dispose();
    env.ctx.provide('hanaworldsWorldAdapterV6', env.peers.adapter); } };
  await assert.rejects(() => read(env), refusal('CAPABILITY_UNAVAILABLE'));
});
test('Q282 inherited receiver cannot borrow current Canvas authority', async t => {
  const env = await boot(t);
  await assert.rejects(() => read(env, input(), Object.create(env.canvas)), refusal('CAPABILITY_UNAVAILABLE'));
  assert.equal(env.reads.length, 0);
});
test('Q282 disposed Canvas rejects a captured public method', async t => {
  const env = await boot(t); await env.canvasFiber.dispose();
  await assert.rejects(() => read(env), refusal('CAPABILITY_UNAVAILABLE'));
  assert.equal(env.reads.length, 0);
});
test('Q282 public declarations admit complete reads and reject incomplete or extra authority', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, [process.env.CANVAS_CATALOGUE_TSC ?? join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'test/catalogue-public-types.mts'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Q285 old provider expectation is refused even when Catalogue bytes are unchanged', async t => {
  const env = await boot(t);
  await assert.rejects(() => read(env, input({ expectedProvider: { ...env.provider, providerRevision: 'old' } })),
    refusal('CURRENT_WORLD_MISMATCH'));
});
test('Q285 provider identity drifting during await cannot release old facts', async t => {
  const env = await boot(t); let first = true;
  env.duringRead = () => { if (first) { first = false; env.provider.providerRevision = 'generation-2'; } };
  await assert.rejects(() => read(env), refusal('CURRENT_WORLD_MISMATCH'));
});
