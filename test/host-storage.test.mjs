import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../src/index.mjs';

async function profile(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvas-native-home-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function load(homePath) {
  let service;
  apply({ get(key) { return key === 'dshHomePath' ? homePath : undefined; },
    provide(key, value) { if (key === 'hanaworldsCanvasV5') service = value; } });
  await service.ready;
  return service;
}

const directory = root => join(root, 'data', 'hanaworlds-canvas-v2');
const native = root => (...parts) => join(root, ...parts);
async function withHome(root, work) {
  const original = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try { return await work(); }
  finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
}

test('Canvas uses native DSH home path for durable schema-7 state across reload', async t => {
  const root = await profile(t);
  await withHome(root, async () => {
    const first = await load(native(root));
    assert.equal(first.storageState, 'READY');
    assert.equal(first.store.directory, directory(root));
    await first.store.commit(state => {
      state.objects.world = { object: { objectRef: 'object' } };
      state.placementSettings = { world: { ...Config({}).placement, settingsRevision: '7' } };
      state.placementInspections = { inspect: { worldRef: 'world' } };
    });
    const restarted = await load(native(root));
    assert.equal(restarted.storageState, 'READY');
    assert.equal(restarted.store.snapshot.schemaVersion, 7);
    assert.equal(restarted.store.snapshot.objects.world.object.objectRef, 'object');
    assert.equal(restarted.store.snapshot.placementSettings.world.settingsRevision, '7');
    assert.equal(restarted.store.snapshot.placementInspections.inspect.worldRef, 'world');
  });
});

test('native home accepts a normalized path through the host filesystem alias', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-native-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withHome(root, async () => {
    const service = await load(native(root));
    assert.equal(service.storageState, 'READY');
    assert.equal(service.store.directory, directory(root));
  });
});

test('native home accepts DSH_HOME tilde expansion under an isolated HOME', async t => {
  const home = await profile(t);
  const outside = await profile(t);
  const root = join(home, 'canvas-profile');
  await mkdir(root);
  const priorHome = process.env.HOME;
  const priorDshHome = process.env.DSH_HOME;
  process.env.HOME = home;
  process.env.DSH_HOME = '~/canvas-profile';
  try {
    const service = await load(native(root));
    assert.equal(service.storageState, 'READY');
    assert.equal(service.store.directory, directory(root));
    const rejected = await load(native(outside));
    assert.equal(rejected.storageState, 'UNAVAILABLE');
    await assert.rejects(() => lstat(directory(outside)), { code: 'ENOENT' });
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorDshHome;
  }
});

test('Canvas ignores legacy state without migration or backup', async t => {
  const root = await profile(t);
  await mkdir(directory(root), { recursive: true });
  const bytes = Buffer.from(` ${JSON.stringify({ schemaVersion: 2,
    authorHistory: { author: ['tx'] }, placementInspections: { inspect: {} } })}\n`);
  await writeFile(join(directory(root), 'canvas-v2.json'), bytes);
  await withHome(root, async () => {
    const service = await load(native(root));
    assert.equal(service.storageState, 'READY');
    assert.equal(service.store.snapshot.schemaVersion, 7);
    assert.deepEqual(await readFile(join(directory(root), 'canvas-v2.json')), bytes);
    assert.deepEqual(service.store.snapshot.objects, {});
    await assert.rejects(() => lstat(join(directory(root), 'canvas-v2.pre-v4.json')), { code: 'ENOENT' });
  });
});

test('missing or invalid native path fails closed before creating outside-profile storage', async t => {
  const root = await profile(t);
  const outside = await profile(t);
  await withHome(root, async () => {
    for (const homePath of [undefined, () => 'relative',
      (...parts) => parts.length ? join(outside, ...parts) : root]) {
      const service = await load(homePath);
      assert.equal(service.storageState, 'UNAVAILABLE');
      assert.equal(service.store, null);
    }
    await assert.rejects(() => lstat(directory(root)), { code: 'ENOENT' });
    await assert.rejects(() => lstat(directory(outside)), { code: 'ENOENT' });
  });
});

test('symlinked native path component cannot redirect Canvas state outside DSH home', async t => {
  const root = await profile(t);
  const outside = await profile(t);
  await symlink(outside, join(root, 'data'));
  await withHome(root, async () => {
    const service = await load(native(root));
    assert.equal(service.storageState, 'UNAVAILABLE');
    assert.equal(service.store, null);
    await assert.rejects(() => lstat(join(outside, 'hanaworlds-canvas')), { code: 'ENOENT' });
  });
});

test('native root inconsistent with configured DSH_HOME fails without a write', async t => {
  const configured = await profile(t);
  const outside = await profile(t);
  const original = process.env.DSH_HOME;
  process.env.DSH_HOME = configured;
  try {
    const service = await load(native(outside));
    assert.equal(service.storageState, 'UNAVAILABLE');
    assert.equal(service.store, null);
    await assert.rejects(() => lstat(directory(outside)), { code: 'ENOENT' });
    await assert.rejects(() => lstat(directory(configured)), { code: 'ENOENT' });
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});
