import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { createObjectsWebServer } from '../scripts/objects-web-server.mjs';
let createObjectsExample;
try { ({ createObjectsExample } = await import('../scripts/objects-example.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const root = '/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01';

test('web example reads public-transaction-produced durable records unchanged after reopening', async () => {
  assert.equal(typeof createObjectsExample, 'function', 'durable public-transaction example producer is missing');
  const scratch = await mkdtemp(join(root, 'objects-example-test-'));
  let server;
  try {
    const exampleDirectory = join(scratch, 'isolated-example');
    const receipt = await createObjectsExample(exampleDirectory);
    assert.equal(receipt.classification, 'REAL_RUNTIME + FIXTURE');
    const persisted = await readFile(join(exampleDirectory, 'canvas-v5.json'));
    const state = JSON.parse(persisted);
    assert.deepEqual(Object.keys(state.pending), []);
    assert.equal(Object.keys(state.transactions).length, 4);
    for (const transaction of Object.values(state.transactions)) {
      assert.equal(transaction.receipt.status, 'VERIFIED');
      assert.ok(Number.isFinite(Date.parse(transaction.displayMetadata.committedAt)));
      assert.ok(transaction.history);
    }
    const session = receipt.sessionRef;
    const canvas = new CanvasV5({ store: await CanvasStore.open(exampleDirectory) });
    const projected = await canvas.readObjectsHistory(session);
    assert.equal(projected.state, 'READY');
    assert.equal(projected.objects.length, 3);
    assert.deepEqual(projected.objects[0].bounds, { min:[12,4,8], max:[13,5,9], size:[2,2,2] });
    assert.equal(projected.objects[0].occupiedCells, 8);
    assert.equal(projected.objects[1].occupiedCells, 1);
    assert.equal(projected.objects[2].bounds, null);
    assert.deepEqual(projected.history.map(row => [row.mode,row.affectedCells,row.status]),
      [['REGION',8,'COMMITTED'],['CELL',1,'COMMITTED'],['REGION',2,'UNDONE'],['REGION',2,'UNDONE']]);
    assert.deepEqual(projected.history.map(row => row.committedAt),
      Object.values(state.transactions).map(row => row.displayMetadata.committedAt));
    assert.ok(projected.objects.every(row => row.name === null), 'do not invent names absent from public production records');
    const assets = join(scratch, 'assets'); await mkdir(assets);
    await writeFile(join(assets,'objects.js'),'// isolated HTTP fixture artifact');
    await writeFile(join(assets,'objects.css'),'/* isolated HTTP fixture style */');
    const options = { storeDirectory:join(scratch,'real-empty'), assetsDirectory:assets, sampleStoreDirectory:exampleDirectory };
    const start = async () => {
      server = await createObjectsWebServer(options);
      await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
      return 'http://127.0.0.1:' + server.address().port;
    };
    let base = await start();
    const first = await (await fetch(base+'/api/example')).json();
    assert.deepEqual(first, { source:'ISOLATED_DURABLE_FIXTURE', ...projected });
    assert.equal((await (await fetch(base+'/api/objects')).json()).state,'NO_SESSION');
    assert.equal((await fetch(base+'/api/example',{method:'POST'})).status,405);
    await new Promise(resolve => server.close(resolve)); server = null;
    base = await start();
    assert.deepEqual(await (await fetch(base+'/api/example')).json(),first);
    assert.deepEqual(await readFile(join(exampleDirectory,'canvas-v5.json')),persisted,'web reads and reopen must not regenerate records or timestamps');
    await assert.rejects(createObjectsExample(exampleDirectory), /EXAMPLE_ALREADY_EXISTS/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(scratch,{recursive:true,force:true});
  }
});
