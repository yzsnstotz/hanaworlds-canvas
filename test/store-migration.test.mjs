import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasStore } from '../src/store.mjs';

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-q5-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const file = directory => join(directory, 'canvas-v2.json');
const preV4 = directory => join(directory, 'canvas-v2.pre-v4.json');
const preV3 = directory => join(directory, 'canvas-v2.pre-v3.json');

test('fresh schema 3 persists author-scoped state across reopen', async t => {
  const directory = await profile(t);
  const store = await CanvasStore.open(directory);
  assert.equal(store.snapshot.schemaVersion, 3);
  await store.commit(state => {
    state.authorHistory = { world: { author: { object: { undo: ['tx'], redo: [] } } } };
    state.pending = { tx: { phase: 'prepared' } };
  });
  const reopened = await CanvasStore.open(directory);
  assert.equal(reopened.snapshot.schemaVersion, 3);
  assert.deepEqual(reopened.snapshot.authorHistory.world.author.object.undo, ['tx']);
  assert.equal(reopened.snapshot.pending.tx.phase, 'prepared');
  assert.equal(JSON.parse(await readFile(file(directory), 'utf8')).schemaVersion, 3);
});

test('schema 2 receives exact pre-v4 backup and preserves all v4 state on idempotent reopen', async t => {
  const directory = await profile(t);
  const old = { schemaVersion: 2, objects: { world: { object: { name: '家' } } },
    names: { world: { object: '家' } }, authorHistory: { world: { author: ['tx'] } },
    pending: { tx: { phase: 'prepared' } }, replay: { req: { result: 'ok' } },
    transactions: { tx: { objectRef: 'object' } },
    placementSettings: { world: { settingsRevision: '7' } },
    placementInspections: { inspection: { worldRef: 'world' } } };
  const bytes = `\n${JSON.stringify(old, null, 2)}\n`;
  await writeFile(file(directory), bytes);
  const store = await CanvasStore.open(directory);
  assert.equal(await readFile(preV4(directory), 'utf8'), bytes);
  assert.equal(store.snapshot.schemaVersion, 3);
  for (const key of ['objects', 'names', 'authorHistory', 'pending', 'replay',
    'transactions', 'placementSettings', 'placementInspections'])
    assert.deepEqual(JSON.parse(JSON.stringify(store.snapshot[key])), old[key], key);
  const upgraded = await readFile(file(directory), 'utf8');
  await CanvasStore.open(directory);
  assert.equal(await readFile(file(directory), 'utf8'), upgraded);
  assert.equal(await readFile(preV4(directory), 'utf8'), bytes);
});

test('schema 1 keeps exact pre-v3 and intermediate pre-v4 backup chain', async t => {
  const directory = await profile(t);
  const old = { schemaVersion: 1, objects: { world: { object: {} } },
    authorHistory: { world: { author: ['tx'] } }, pending: { tx: {} },
    replay: { req: {} }, transactions: { tx: {} },
    placementSettings: { world: {} }, placementInspections: { inspection: {} } };
  const bytes = ` ${JSON.stringify(old)}\n`;
  await writeFile(file(directory), bytes);
  const store = await CanvasStore.open(directory);
  assert.equal(await readFile(preV3(directory), 'utf8'), bytes);
  const intermediate = JSON.parse(await readFile(preV4(directory), 'utf8'));
  assert.equal(intermediate.schemaVersion, 2);
  for (const key of ['objects', 'authorHistory', 'pending', 'replay', 'transactions',
    'placementSettings', 'placementInspections']) {
    assert.deepEqual(intermediate[key], old[key], key);
    assert.deepEqual(JSON.parse(JSON.stringify(store.snapshot[key])), old[key], key);
  }
  assert.equal(store.snapshot.schemaVersion, 3);
});

test('pre-v4 conflict and backup write failure leave schema-2 source byte-exact', async t => {
  for (const mode of ['conflict', 'write-failure']) {
    const directory = await profile(t);
    const bytes = ' { "schemaVersion": 2, "pending": { "tx": {} } }\n';
    await writeFile(file(directory), bytes);
    if (mode === 'conflict') await writeFile(preV4(directory), 'other');
    else await mkdir(preV4(directory));
    await assert.rejects(() => CanvasStore.open(directory),
      new RegExp(mode === 'conflict' ? 'CANVAS_MIGRATION_BACKUP_CONFLICT' : 'CANVAS_MIGRATION_BACKUP_UNAVAILABLE'));
    assert.equal(await readFile(file(directory), 'utf8'), bytes);
  }
});

test('schema-1 later-backup conflict stops before intermediate write', async t => {
  const directory = await profile(t);
  const bytes = JSON.stringify({ schemaVersion: 1, objects: { object: {} } });
  await writeFile(file(directory), bytes);
  await writeFile(preV4(directory), 'conflicting');
  await assert.rejects(() => CanvasStore.open(directory), /CANVAS_MIGRATION_BACKUP_CONFLICT/);
  assert.equal(await readFile(file(directory), 'utf8'), bytes);
});

test('backup-only interruption recovers; unsupported schema and writer field do not bypass migration', async t => {
  const directory = await profile(t);
  const old = { schemaVersion: 2, canvasWriter: 'canvas/v4', pending: { tx: {} } };
  const bytes = JSON.stringify(old);
  await writeFile(file(directory), bytes);
  await writeFile(preV4(directory), bytes); // durable backup exists; upgrade not yet committed
  const store = await CanvasStore.open(directory);
  assert.equal(store.snapshot.schemaVersion, 3);
  assert.equal(await readFile(preV4(directory), 'utf8'), bytes);
  for (const version of [0, 4, 999]) {
    const unsupported = JSON.stringify({ schemaVersion: version, pending: { tx: {} } });
    await writeFile(file(directory), unsupported);
    await assert.rejects(() => CanvasStore.open(directory), /CANVAS_STORAGE_VERSION_UNSUPPORTED/);
    assert.equal(await readFile(file(directory), 'utf8'), unsupported);
  }
});
