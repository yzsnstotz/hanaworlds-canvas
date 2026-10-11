import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigSupplyServer } from '../scripts/config-supply-web-server.mjs';

// In-process /supply page (port 0, closed at the end; not a resident service). Peers are the
// page's FIXTURE inputs: a world-adapter 7.0 connection declaring no engine guards (engineGuards null).
test('/supply page: no Safety supply, and every write operation names its uncovered engine guards', async () => {
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
    assert.equal(data.engine.bound, true);
    assert.equal(data.engine.declaration, null);
    assert.deepEqual(data.engine.operations.map(row => row.operation), ['ApplyRecoverableCommit',
      'Undo', 'Redo', 'ApplyRegionCommit', 'UndoRegionCommit', 'RecoverRegion']);
    for (const row of data.engine.operations) {
      assert.equal(row.status, 'CAPABILITY_UNAVAILABLE', row.operation);
      assert.deepEqual(row.unmet.map(u => `${u.guard}@${u.stage}`),
        row.required.map(r => `${r.guard}@${r.stage}`), row.operation);
      assert.ok(row.unmet.every(u => u.finding === 'GUARD_UNAVAILABLE'), row.operation);
    }
    // FIXTURE world source: nothing declared → named refusal; declared → the source's own config.
    assert.equal(data.report.current.profiles.compilationConfig.fields.writeBackend.cause,
      'NOT_DECLARED_BY_PAYLOAD');
    assert.doesNotMatch(JSON.stringify(data), /worldedit|modRevisions|MOD_NOT_LOADED/i);
    const toggled = await fetch(`${base}/api/fixture/backend`, { method: 'POST',
      headers: { origin: base } });
    assert.equal(toggled.status, 200);
    const declared = await (await fetch(`${base}/api/supply?worldRef=supply-fixture-world`)).json();
    const row = declared.report.current.profiles.compilationConfig.fields.writeBackend;
    assert.equal(row.status, 'SUPPLIED');
    assert.equal(row.provenance.kind, 'WORLD_SOURCE_FACT');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
