import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { configHandoffFixture, attachConfigFixture, configRefusal } from './support/config-handoff-fixture.mjs';

for (const order of ['canvas-first', 'bridge-first']) test(`Q288 ${order}: Canvas alone owns both compatible ports and Bridge supplies full facts`, async t => {
  const env = await configHandoffFixture(t, { order });
  const originalPorts = [env.compiler, env.supply];
  attachConfigFixture(env);
  const value = await env.compiler.read(env.worldRef);
  assert.deepEqual(value.compilationConfig, env.profile.compilationConfig);
  assert.equal(typeof value.compilerRevision, 'string');
  assert.deepEqual(Object.keys(value).sort(), ['compilationConfig', 'compilerRevision']);
  const report = await env.supply.read(env.worldRef);
  assert.equal(report.profileVersion, 'canvas-stage1-config-supply/v2');
  assert.equal(report.authority, 'hanaworlds-canvas');
  assert.equal(report.current.profiles.compilationConfig.status, 'SUPPLIED');
  assert.deepEqual(report.current.profiles.compilationConfig.value, env.profile.compilationConfig);
  assert.deepEqual(report.current.profiles.compilationConfig.missing, []);
  assert.ok(env.readerCalls.length >= 2, 'Use-before-return source recheck occurs through Bridge');
  assert.ok(env.reads.length >= 2);
  assert.equal(env.ctx.get('hanaworldsCompilerConfig'), originalPorts[0]);
  assert.equal(env.ctx.get('hanaworldsCanvasConfigSupply'), originalPorts[1]);
  value.compilationConfig.writeBackend.revision = 'consumer edit';
  assert.notEqual(env.profile.compilationConfig.writeBackend.revision, 'consumer edit');
});
test('Q288 missing Bridge does not permit Canvas to read ReadWriteProfile or default config', async t => {
  const env = await configHandoffFixture(t, { bridge: false });
  await assert.rejects(() => env.compiler.read(env.worldRef), error => {
    assert.ok(configRefusal('CAPABILITY_UNAVAILABLE')(error));
    assert.ok(error.missingSources.some(row => row.cause === 'BRIDGE_CONFIG_SOURCE_ABSENT'));
    return true;
  });
  assert.deepEqual(env.reads, []);
});
test('Q288 Bridge unload keeps both Canvas ports, refuses old source, and same Canvas recovers with a new attachment', async t => {
  const env = await configHandoffFixture(t); const release = attachConfigFixture(env);
  await env.compiler.read(env.worldRef);
  await env.bridgeFiber.dispose();
  assert.equal(env.ctx.get('hanaworldsCompilerConfig'), env.compiler);
  assert.equal(env.ctx.get('hanaworldsCanvasConfigSupply'), env.supply);
  const count = env.reads.length;
  await assert.rejects(() => env.compiler.read(env.worldRef), configRefusal('CAPABILITY_UNAVAILABLE'));
  assert.equal(env.reads.length, count, 'Disposed Bridge cannot execute a captured source reader');
  env.bridgeFiber = await env.startBridge(); attachConfigFixture(env);
  release(); // An old disposer cannot revoke the newer attachment.
  assert.deepEqual((await env.compiler.read(env.worldRef)).compilationConfig, env.profile.compilationConfig);
  const report = await env.supply.read(env.worldRef);
  assert.ok(report.history.some(row => row.profiles.compilationConfig.status === 'SOURCE_MISSING'));
});
test('Q288 explicit detach revokes only its own source and stable reattach restores supply', async t => {
  const env = await configHandoffFixture(t); const release = attachConfigFixture(env);
  await env.compiler.read(env.worldRef); release(); release();
  await assert.rejects(() => env.compiler.read(env.worldRef), configRefusal('CAPABILITY_UNAVAILABLE'));
  attachConfigFixture(env);
  assert.deepEqual((await env.compiler.read(env.worldRef)).compilationConfig, env.profile.compilationConfig);
});
for (const kind of ['json-context', 'foreign-root', 'wrong-fiber', 'forged-canvas']) test(`Q288 ${kind} cannot attach source authority`, async t => {
  const env = await configHandoffFixture(t);
  assert.equal(typeof env.canvas.attachConfigSource, 'function', 'Q-288 trusted handoff must exist');
  const other = new Context(); t.after(() => other.fiber.dispose());
  const context = kind === 'json-context' ? { root: env.ctx.root, fiber: env.bridgeContext.fiber } :
    kind === 'foreign-root' ? other : kind === 'wrong-fiber' ? env.ctx : env.bridgeContext;
  const receiver = kind === 'forged-canvas' ? Object.create(env.canvas) : env.canvas;
  assert.throws(() => env.canvas.attachConfigSource.call(receiver, context, env.reader),
    error => error.publicError?.code === 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(env.reads, []);
});
test('Q288 bad reader is a named schema refusal without invoking Adapter', async t => {
  const env = await configHandoffFixture(t);
  assert.equal(typeof env.canvas.attachConfigSource, 'function', 'Q-288 trusted handoff must exist');
  assert.throws(() => env.canvas.attachConfigSource(env.bridgeContext, {}),
    error => error.publicError?.code === 'SCHEMA_INVALID');
  assert.deepEqual(env.reads, []);
});
for (const [name, change] of [
  ['connection', response => { response.result.connection.connectionIncarnationRef = 'old'; }],
  ['Catalogue', response => { response.result.catalogueDigest = '0'.repeat(64); }],
  ['request binding', response => { response.requestId = 'other-request'; }],
]) test(`Q288 wrong ${name} cannot become usable compiler configuration`, async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env); env.changeResponse = change;
  await assert.rejects(() => env.compiler.read(env.worldRef), error => {
    assert.ok(['CAPABILITY_UNAVAILABLE', 'STALE_REVISION'].includes(error.publicError?.code));
    assert.ok(error.missingSources.some(row => row.field === 'writeBackend')); return true;
  });
});
test('Q288 Bridge replacement during await invalidates full returned facts', async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env); let first = true;
  env.duringRead = async () => { if (first) { first = false; await env.bridgeFiber.dispose();
    env.bridgeFiber = await env.startBridge(); } };
  await assert.rejects(() => env.compiler.read(env.worldRef), configRefusal('CAPABILITY_UNAVAILABLE'));
});
test('Q288 stable new source profile changes revision, while in-read drift is refused', async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env);
  const first = await env.compiler.read(env.worldRef);
  env.profile.writeBackend.writeBackend.revision = 'new-backend';
  env.profile.compilationConfig.writeBackend.revision = 'new-backend';
  const next = await env.compiler.read(env.worldRef);
  assert.notEqual(first.compilerRevision, next.compilerRevision);
  assert.deepEqual(next.compilationConfig, env.profile.compilationConfig);
  let drift = true;
  env.duringRead = () => { if (drift) { drift = false;
    env.profile.writeBackend.writeBackend.revision = 'drift';
    env.profile.compilationConfig.writeBackend.revision = 'drift'; } };
  await assert.rejects(() => env.compiler.read(env.worldRef), configRefusal('STALE_REVISION'));
  env.duringRead = null;
  assert.deepEqual((await env.compiler.read(env.worldRef)).compilationConfig, env.profile.compilationConfig);
});
test('Q288 source callback cannot recursively obtain its own config from the compiler port', async t => {
  const env = await configHandoffFixture(t);
  attachConfigFixture(env, { reader: async function () { return env.compiler.read(env.worldRef); } });
  await assert.rejects(() => env.compiler.read(env.worldRef), error =>
    configRefusal('CAPABILITY_UNAVAILABLE')(error) && error.cause?.cause === 'CONFIG_SOURCE_REENTRANT');
});
test('Q288 complete source error envelope is retained through compiler availability failure and recovery', async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env);
  env.sourceError = { code: 'ADAPTER_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
    mutationState: 'NONE', transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN', worldRef: env.worldRef,
    source: { owner: 'world-source', operation: 'ReadWriteProfile', resource: env.worldRef, kind: 'IO', nativeCode: 'EIO' } };
  await assert.rejects(() => env.compiler.read(env.worldRef), error => {
    assert.ok(configRefusal('CAPABILITY_UNAVAILABLE')(error));
    assert.deepEqual(error.cause.publicError, env.sourceError);
    assert.equal(error.cause.cause, env.lastResponse, 'Original complete response stays as the cause');
    return true;
  });
  env.sourceError = null;
  assert.deepEqual((await env.compiler.read(env.worldRef)).compilationConfig, env.profile.compilationConfig);
});
test('Q288 selecting a reopened connection during source await refuses the old observation', async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env); let first = true;
  env.duringRead = async () => {
    if (!first) return; first = false;
    const selection = await env.canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v7',
      requestId: 'q288-reopen-context', sessionRef: env.sessionRef, worldRef: env.worldRef });
    assert.equal(selection.error, null);
    env.peers.incarnation = 'q288-reopened';
    const context = selection.result.selection.context;
    const selected = await env.canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v7',
      requestId: 'q288-reopen-select', sessionRef: env.sessionRef, ...env.scope,
      connectionIncarnationRef: env.peers.incarnation, expectedRevision: context.selectionRevision,
      expectedContext: context.localContext });
    assert.equal(selected.error, null);
    env.auditBaseline = structuredClone(env.canvas.store.snapshot);
  };
  await assert.rejects(() => env.compiler.read(env.worldRef), error => error.publicError?.code === 'STALE_REVISION');
  assert.equal(env.canvas.store.snapshot.configSupply?.[env.worldRef], undefined);
});
test('Q288 detach during source await cannot publish the captured complete configuration', async t => {
  const env = await configHandoffFixture(t); const release = attachConfigFixture(env);
  env.duringRead = () => release();
  await assert.rejects(() => env.compiler.read(env.worldRef), configRefusal('CAPABILITY_UNAVAILABLE'));
});
test('Q288 public types retain both old ports and admit only a real runtime context plus full response reader', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, [process.env.CANVAS_CATALOGUE_TSC ?? join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'test/config-handoff-types.mts'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
