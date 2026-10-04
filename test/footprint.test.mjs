import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CanvasStore, CanvasV4 } from '../src/index.mjs';

const request = (objectRefs = ['object-a'], objectRevisions = { 'object-a': 'object-1' },
  worldRef = 'world-a') => ({ contractVersion: 'canvas/v4', actorRef: 'actor-a',
  sessionRef: 'session-a', requestId: 'footprint-read', authorizationRef: 'grant-a',
  worldRef, objectRefs, expectedRegistryRevision: 'registry-1',
  expectedObjectRevisions: objectRevisions });

async function fixture(t) {
  const runRoot = join(homedir(), '.cache', 'hanaworlds-runs', 'S1-CANVAS-FOOTPRINT-01');
  await mkdir(runRoot, { recursive: true });
  const directory = await mkdtemp(join(runRoot, 'canvas-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CanvasStore.open(directory);
  await store.commit(state => {
    state.sessions['session-a'] = { activeWorldRef: 'world-a' };
    state.bindings['session-a'] = { adapterId: 'adapter-a', worldRef: 'world-a',
      recoveryGuarantee: 'RECOVERABLE_VERIFIED' };
    state.registryRevisions['world-a'] = 'registry-1';
    state.objects['world-a'] = { 'object-a': { worldRef: 'world-a',
      objectRef: 'object-a', objectRevision: 'object-1', displayName: null,
      nameRevision: null, creationSequence: 1, status: 'READY' },
    'object-b': { worldRef: 'world-a', objectRef: 'object-b',
      objectRevision: 'object-b-1', displayName: null,
      nameRevision: null, creationSequence: 2, status: 'READY' } };
    state.footprints['world-a'] = { 'object-a': [[0, 0, 0], [0, 1, 0]],
      'object-b': [[2, 0, 0]] };
  });
  let current = true;
  let proofs = 0;
  let revokeAt = Infinity;
  const callContext = new AsyncLocalStorage();
  const authority = { async verify(body, operation) {
    proofs++;
    return { current: current && proofs < revokeAt && callContext.getStore() === canvas,
      actorRef: body.actorRef, sessionRef: body.sessionRef,
      authorizationRef: body.authorizationRef, authorRef: 'author-a',
      allowedActions: [operation], currentWorldRevision: 'world-rev-1' };
  } };
  let canvas;
  let rawCall;
  const reopen = async () => {
    canvas = new CanvasV4({ store: await CanvasStore.open(directory), authority });
    const original = canvas.call;
    rawCall = original;
    canvas.call = (...args) => callContext.run(canvas, () => original.apply(canvas, args));
    return canvas;
  };
  await reopen();
  return { directory, store, get canvas() { return canvas; }, reopen,
    removeTrustedHostContext: () => { canvas.call = rawCall; },
    revoke: () => { current = false; },
    revokeAtProof: value => { revokeAt = value; },
    proofCount: () => proofs };
}

test('registered footprint query returns exact ordered positions and survives restart', async t => {
  const f = await fixture(t);
  const input = request(['object-a', 'object-b'],
    { 'object-a': 'object-1', 'object-b': 'object-b-1' });
  const before = JSON.stringify(f.canvas.store.snapshot);
  const result = await f.canvas.readRegisteredFootprints(input);
  assert.deepEqual(result, { worldRef: 'world-a', registryRevision: 'registry-1',
    objects: [
      { objectRef: 'object-a', objectRevision: 'object-1',
        positions: [[0, 0, 0], [0, 1, 0]] },
      { objectRef: 'object-b', objectRevision: 'object-b-1', positions: [[2, 0, 0]] },
    ] });
  assert.equal(JSON.stringify(f.canvas.store.snapshot), before, 'query does not mutate Canvas');
  const restarted = await f.reopen();
  assert.deepEqual(await restarted.readRegisteredFootprints(input), result);
});

test('empty requested set has an explicit empty result for a known authorized world', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.canvas.readRegisteredFootprints(request([], {})),
    { worldRef: 'world-a', registryRevision: 'registry-1', objects: [] });
});

test('footprint update changes the readback and stale object revision fails closed', async t => {
  const f = await fixture(t);
  const old = request();
  await f.canvas.store.commit(state => {
    state.footprints['world-a']['object-a'] = [[0, 0, 0], [0, 1, 0], [1, 1, 0]];
    state.objects['world-a']['object-a'].objectRevision = 'object-2';
  });
  await assert.rejects(f.canvas.readRegisteredFootprints(old), error =>
    error.publicError?.code === 'STALE_REVISION');
  const result = await f.canvas.readRegisteredFootprints(request(['object-a'],
    { 'object-a': 'object-2' }));
  assert.deepEqual(result.objects[0].positions, [[0, 0, 0], [0, 1, 0], [1, 1, 0]]);
});

test('missing, malformed, unknown-world and revoked footprint reads fail without world effects', async t => {
  const f = await fixture(t);
  await assert.rejects(f.canvas.readRegisteredFootprints(request(['missing'],
    { missing: 'revision' })), error => error.publicError?.code === 'OBJECT_NOT_FOUND');
  await assert.rejects(f.canvas.readRegisteredFootprints(request(['object-a'],
    { 'object-a': 'object-1' }, 'world-unknown')),
  error => error.publicError?.code === 'WORLD_NOT_BOUND');
  await f.canvas.store.commit(state => { delete state.footprints['world-a']['object-a']; });
  await assert.rejects(f.canvas.readRegisteredFootprints(request()),
    error => error.publicError?.code === 'SAVED_RESOURCE_UNAVAILABLE');
  await f.canvas.store.commit(state => { state.footprints['world-a']['object-a'] =
    [[1, 0, 0], [0, 0, 0]]; });
  await assert.rejects(f.canvas.readRegisteredFootprints(request()),
    error => error.publicError?.code === 'SAVED_RESOURCE_UNAVAILABLE');
  f.revoke();
  await assert.rejects(f.canvas.readRegisteredFootprints(request([], {})),
    error => error.publicError?.code === 'AUTHORIZATION_REVOKED');
});

test('authorization revoked during release cannot expose a saved footprint', async t => {
  const f = await fixture(t);
  f.revokeAtProof(f.proofCount() + 3);
  await assert.rejects(f.canvas.readRegisteredFootprints(request()),
    error => error.publicError?.code === 'AUTHORIZATION_REVOKED');
});

test('a caller outside the trusted Canvas host context cannot read a footprint', async t => {
  const f = await fixture(t);
  f.removeTrustedHostContext();
  await assert.rejects(f.canvas.readRegisteredFootprints(request()),
    error => error.publicError?.code === 'AUTHORIZATION_REVOKED');
});
