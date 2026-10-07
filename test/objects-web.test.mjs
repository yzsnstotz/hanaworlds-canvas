import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CanvasStore } from '../src/store-v5.mjs';
import { createObjectsWebServer } from '../scripts/objects-web-server.mjs';
import { createUndoExample } from '../scripts/undo-example.mjs';

test('independent objects web reads Canvas durable records, separates samples and rejects writes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'objects-http-fixture-'));
  let server;
  try {
    const data = join(scratch, 'data'); const assets = join(scratch, 'assets');
    await mkdir(assets); await writeFile(join(assets, 'objects.js'), '// fixture browser artifact');
    await writeFile(join(assets, 'objects.css'), '/* fixture style */');
    const store = await CanvasStore.open(data);
    // Explicit test fixture in own scratch, never copied to the live development store.
    await store.commit(state => {
      state.sessions['fixture-session'] = { activeWorldRef: 'fixture-world', localContext: {} };
      state.objects['fixture-world'] = { house: { objectRef: 'house', worldRef: 'fixture-world', displayName: 'Fixture house', creationSequence: 0 } };
      state.footprints['fixture-world'] = { house: { positions: [[1,2,3]], footprintRevision: 'footprint-1' } };
      state.history.house = [{ transactionId: 'fixture-build', originTransactionId: null }];
      state.transactions['fixture-build'] = { objectRef: 'house', worldRef: 'fixture-world', displayMetadata: { committedAt: '2026-10-07T08:00:00Z', mode: 'CELL', affectedCells: 1 } };
    });
    const before = await readFile(join(data, 'canvas-v5.json'));
    server = await createObjectsWebServer({ storeDirectory: data, assetsDirectory: assets });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/objects')).status, 200);
    assert.equal((await fetch(base + '/api/objects')).status, 200);
    assert.equal((await (await fetch(base + '/api/objects')).json()).state, 'NO_SESSION');
    assert.deepEqual(await (await fetch(base + '/api/sessions')).json(), ['fixture-session']);
    const live = await (await fetch(base + '/api/objects?session=fixture-session')).json();
    assert.equal(live.objects[0].name, 'Fixture house');
    assert.deepEqual(live.objects[0].bounds.size, [1,1,1]);
    assert.equal(live.history[0].affectedCells, 1);
    assert.equal(live.history[0].mode, 'CELL');
    assert.equal(live.history[0].status, 'COMMITTED');
    assert.equal((await fetch(base + '/api/objects', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(base + '/api/objects?session=a&session=b')).status, 400);
    assert.equal((await fetch(base + '/api/sample')).status, 404, 'sample is client-only, not live Canvas data');
    assert.equal((await fetch(base + '/data/canvas-v5.json')).status, 404);
    assert.deepEqual(await readFile(join(data, 'canvas-v5.json')), before, 'all web reads must leave durable bytes unchanged');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});

test('shared host keeps /objects read-only and runs /undo actions only for same-origin page clicks', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'undo-http-fixture-'));
  let server;
  try {
    const data = join(scratch, 'data'); const assets = join(scratch, 'assets'); const example = join(scratch, 'undo');
    await mkdir(assets);
    for (const name of ['objects.js', 'objects.css', 'undo.js', 'undo.css']) await writeFile(join(assets, name), '/* fixture asset */');
    await createUndoExample(example);
    server = await createObjectsWebServer({ storeDirectory: data, assetsDirectory: assets, undoDirectory: example });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/objects')).status, 200);
    assert.equal((await fetch(base + '/undo')).status, 200);
    assert.equal((await fetch(base + '/api/objects', { method: 'POST', body: '{}' })).status, 405);
    const view = await (await fetch(base + '/api/undo')).json();
    assert.equal(view.source, 'ISOLATED_DURABLE_FIXTURE');
    const cell = view.entries.find(entry => entry.undo.available);
    assert.equal(view.entries.filter(entry => entry.undo.available).length, 1, 'only the latest change is offered');
    const post = (action, body, headers = { Origin: base, 'Content-Type': 'application/json' }) =>
      fetch(`${base}/api/undo/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post('undo', { objectRef: cell.objectRef }, { Origin: 'http://evil.example', 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post('undo', { objectRef: cell.objectRef }, { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await post('undo', { objectRef: cell.objectRef, extra: 1 })).status, 400);
    assert.equal((await fetch(base + '/api/undo/delete', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/undo')).status, 200);
    assert.equal((await (await fetch(base + '/api/undo')).json()).entries.find(e => e.objectRef === cell.objectRef).state, 'APPLIED', 'refused requests change nothing');
    const undone = await post('undo', { objectRef: cell.objectRef });
    assert.equal(undone.status, 200);
    const undoneBody = await undone.json();
    assert.equal(undoneBody.status, 'VERIFIED');
    assert.equal(undoneBody.request, undefined);
    assert.equal(undoneBody.view.entries.find(e => e.objectRef === cell.objectRef).state, 'UNDONE');
    const again = await post('undo', { objectRef: cell.objectRef });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, 'NOTHING_TO_UNDO');
    const redone = await (await post('redo', { objectRef: cell.objectRef })).json();
    assert.equal(redone.status, 'VERIFIED');
    assert.ok(redone.view.entries.find(e => e.objectRef === cell.objectRef).cells.every(c => c.nodeName === 'fixture:brick'));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
