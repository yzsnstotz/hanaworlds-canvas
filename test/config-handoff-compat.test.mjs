import test from 'node:test';
import assert from 'node:assert/strict';
import { configHandoffFixture, attachConfigFixture } from './support/config-handoff-fixture.mjs';
import { canonicalJSON } from '../src/protocol/local/index.mjs';

const requestFor = env => ({ contractVersion: 'world-facts/v1',
  requestId: 'retained-compatibility-request', worldRef: env.worldRef });
const read = env => env.canvas.worldFacts.call('ReadWriteProfile', requestFor(env));
const refusal = code => error => error.publicError?.code === code;

test('D179 original Host WorldFactsPort retains caller request and complete Bridge response without committing', async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env);
  const request = requestFor(env), before = canonicalJSON(env.canvas.store.snapshot);
  const commit = env.canvas.store.commit;
  let commits = 0;
  env.canvas.store.commit = function (...args) { commits++; return Reflect.apply(commit, this, args); };
  const response = await env.canvas.worldFacts.call('ReadWriteProfile', request);
  assert.deepEqual(request, requestFor(env));
  assert.deepEqual(response, { contractVersion: 'world-facts/v1', requestId: request.requestId,
    result: env.profile, error: null });
  assert.ok(env.readerCalls.length >= 2);
  for (const call of env.readerCalls) assert.deepEqual(call.request, request);
  assert.equal(canonicalJSON(env.canvas.store.snapshot), before);
  assert.equal(commits, 0);
});

test('D179 original Host WorldFactsPort refuses missing Bridge before a source call', async t => {
  const env = await configHandoffFixture(t, { bridge: false });
  await assert.rejects(() => read(env), refusal('CAPABILITY_UNAVAILABLE'));
  assert.deepEqual(env.reads, []);
});

for (const kind of ['detach', 'bridge-dispose', 'source-dispose', 'provider-drift', 'catalogue-drift'])
  test(`D179 original Host WorldFactsPort refuses ${kind} during source read`, async t => {
    const env = await configHandoffFixture(t); const release = attachConfigFixture(env);
    env.duringRead = async () => {
      if (kind === 'detach') release();
      if (kind === 'bridge-dispose') await env.bridgeFiber.dispose();
      if (kind === 'source-dispose') await env.sourceFiber.dispose();
      if (kind === 'provider-drift') env.provider.providerRevision = 'next-provider';
      if (kind === 'catalogue-drift') env.catalogue.catalogue.engineRevisions.engineRevision = 'next-engine';
    };
    await assert.rejects(() => read(env), error =>
      ['CAPABILITY_UNAVAILABLE', 'CURRENT_WORLD_MISMATCH', 'CATALOGUE_MISMATCH'].includes(error.publicError?.code));
  });

for (const [kind, change] of [
  ['request correlation', response => { response.requestId = 'other-request'; }],
  ['connection', response => { response.result.connection.connectionIncarnationRef = 'old'; }],
  ['Catalogue digest', response => { response.result.catalogueDigest = '0'.repeat(64); }],
]) test(`D179 original Host WorldFactsPort validates ${kind}`, async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env); env.changeResponse = change;
  await assert.rejects(() => read(env), error => typeof error.publicError?.code === 'string');
});

test('D179 original Host WorldFactsPort preserves complete error envelope and original source exception', async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env);
  env.sourceError = { code: 'ADAPTER_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_MANUAL_RECOVERY',
    mutationState: 'UNKNOWN', transactionRef: 'uncertain-source', causeCode: null,
    reason: 'REQUIRED_FACT_UNKNOWN', worldRef: env.worldRef,
    source: { owner: 'world-source', operation: 'ReadWriteProfile', resource: env.worldRef, kind: 'IO', nativeCode: 'EIO' } };
  const response = await read(env);
  assert.deepEqual(response.error, env.sourceError);
  assert.equal(response.result, null);
  assert.equal(response.requestId, requestFor(env).requestId);
  env.sourceError = null;
  const original = new Error('original source I/O', { cause: new Error('native cause') });
  env.thrown = original;
  await assert.rejects(() => read(env), error => error === original);
});

test('D179 original Host WorldFactsPort rejects its recursive source callback', async t => {
  const env = await configHandoffFixture(t);
  attachConfigFixture(env, { reader: () => read(env) });
  await assert.rejects(() => read(env), error => refusal('CAPABILITY_UNAVAILABLE')(error) &&
    error.cause === 'CONFIG_SOURCE_REENTRANT');
});

for (const kind of ['unbound', 'ambiguous']) test(`D179 original Host WorldFactsPort rejects ${kind} World`, async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env);
  const state = env.canvas.store.snapshot;
  if (kind === 'unbound') delete state.sessions[env.sessionRef];
  else {
    state.sessions['other-session'] = structuredClone(state.sessions[env.sessionRef]);
    state.connections['other-session'] = { ...state.connections[env.sessionRef], connectionRef: 'other-connection' };
  }
  env.auditBaseline = structuredClone(state);
  await assert.rejects(() => read(env), refusal(kind === 'unbound' ? 'WORLD_NOT_BOUND' : 'CURRENT_WORLD_MISMATCH'));
  assert.deepEqual(env.reads, []);
});
