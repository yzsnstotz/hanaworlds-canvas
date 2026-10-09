import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateResponse } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, CanvasRegionV1 } from '../src/index.mjs';

// Public rc.4 fixture skill-site-rules#/engineGuards/relay: the exact set of responses that carry
// guardRefusal. Canvas answers every canvas/v6 and canvas-region/v2 one of them with the field
// present (null here: no guard decision), even for an operation Canvas refuses or does not serve.
const relay = createRequire(import.meta.url)('hanaworlds-contracts/fixtures/skill-site-rules')
  .engineGuards.relay.responses;
const own = relay.filter(([wire]) => wire === 'canvas/v6' || wire === 'canvas-region/v2');

test('rc.4 relay closure: every Canvas relay envelope carries guardRefusal', async () => {
  assert.deepEqual(own.map(([wire, operation]) => `${wire} ${operation}`).sort(), [
    'canvas-region/v2 ApplyRegionCommit', 'canvas-region/v2 UndoRegionCommit',
    'canvas/v6 ApplyRecoverableCommit', 'canvas/v6 InspectPlacementRegion',
    'canvas/v6 ReadPendingUndoResult', 'canvas/v6 RecoverPendingUndo', 'canvas/v6 Redo',
    'canvas/v6 Undo']);
  const directory = await mkdtemp(join(tmpdir(), 'canvas-relay-closure-'));
  try {
    const canvas = new CanvasV5({ store: await CanvasStore.open(directory) });
    const region = new CanvasRegionV1(canvas, null);
    for (const [wire, operation] of own) {
      const port = wire === 'canvas/v6' ? canvas : region;
      const response = await port.call(operation, { contractVersion: wire, requestId: `closure-${operation}` });
      assert.equal(Object.hasOwn(response, 'guardRefusal'), true, `${wire} ${operation}`);
      assert.equal(response.guardRefusal, null, `${wire} ${operation}`);
      assert.notEqual(response.error, null);
      validateResponse(wire, operation, response);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
