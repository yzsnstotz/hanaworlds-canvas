import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigSupplyServer } from '../scripts/config-supply-web-server.mjs';

// In-process /supply page (port 0, closed at the end; not a resident service). Peers are the
// page's FIXTURE inputs: a world-adapter 7.0 port advertising no engine safety capability.
test('/supply page: no Safety supply, and every write operation names its missing engine safety', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-supply-page-'));
  const server = await createConfigSupplyServer(directory);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await (await fetch(`${base}/supply`)).text();
    assert.match(page, /Safety 规则不由 Canvas 声明或供给/);
    const data = await (await fetch(`${base}/api/supply?worldRef=supply-fixture-world`)).json();
    assert.deepEqual(Object.keys(data.report.current.profiles), ['compilationConfig']);
    assert.deepEqual(Object.keys(data.ports), ['compilerConfig']);
    assert.deepEqual(data.engine.map(row => row.operation), ['ApplyRecoverableCommit', 'Undo',
      'Redo', 'ApplyRegionCommit', 'UndoRegionCommit']);
    for (const row of data.engine) {
      assert.equal(row.status, 'CAPABILITY_UNAVAILABLE', row.operation);
      assert.deepEqual(row.unmet.map(u => u.id), row.required, row.operation);
      assert.ok(row.unmet.every(u => /_UNAVAILABLE$|_UNCHECKED$/.test(u.cause)), row.operation);
    }
    assert.ok(data.engine.slice(0, 3).every(row => row.port === 'world-adapter/v7'));
    assert.ok(data.engine.slice(3).every(row => row.port === 'world-adapter-region/v1'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
