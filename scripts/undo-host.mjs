import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { openUndoFixtureWorld, undoSessionRef, undoWorldRef } from './undo-fixture-world.mjs';
import { fixtureSessions } from './fixture-sessions.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const undoWorldFile = directory => join(directory, 'fixture-world.json');

/**
 * Isolated /undo host. Canvas owns every decision and durable record; this host
 * only turns the page's click into the public canvas/v5 Undo or Redo Canvas itself
 * published in readHistoryActions, then reads the result back.
 */
export async function openUndoHost(directory, { world: preparedWorld } = {}) {
  // A missing example is a startup error; reads never create one.
  await readFile(join(directory, 'canvas-v5.json'));
  const world = preparedWorld ?? await openUndoFixtureWorld(undoWorldFile(directory));
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: world.adapter, nativeFacts: world.nativeFacts,
    sessions: fixtureSessions() });
  world.readWorldRevision = () => canvas.readWorldRevision(undoWorldRef);
  let queue = Promise.resolve();
  async function readView() {
    const [history, actions] = await Promise.all([canvas.readObjectsHistory(undoSessionRef),
      canvas.readHistoryActions(undoSessionRef)]);
    const entries = actions.objects.map((object, index) => {
      const rows = history.history.filter(row => row.objectRef === object.objectRef)
        .sort((a, b) => a.sequence - b.sequence);
      const original = rows.find(row => row.transactionId === object.originTransactionId);
      return { objectRef: object.objectRef, label: `示例改动 ${index + 1}`, mode: object.mode,
        committedAt: original?.committedAt ?? null, affectedCells: original?.affectedCells ?? null,
        state: object.applied ? 'APPLIED' : 'UNDONE', footprintCells: object.footprint.length,
        undo: object.undo.available ? { available: true } : object.undo,
        redo: object.redo.available ? { available: true } : object.redo,
        // Actual cells, read from the isolated fixture world after Canvas's own readback.
        cells: world.readCells(object.cells).map(cell => ({ position: cell.position, nodeName: cell.nodeName })),
        moves: rows.map(row => ({ transactionId: row.transactionId, sequence: row.sequence,
          committedAt: row.committedAt, status: row.status })) };
    });
    return { source: 'ISOLATED_DURABLE_FIXTURE', sessionRef: undoSessionRef, worldRef: actions.worldRef,
      worldRevision: actions.worldRevision, entries };
  }
  async function perform(objectRef, action) {
    if (action !== 'undo' && action !== 'redo') return { error: { code: 'UNKNOWN_ACTION' } };
    const run = queue.then(async () => {
      const actions = await canvas.readHistoryActions(undoSessionRef);
      const object = actions.objects.find(row => row.objectRef === objectRef);
      if (!object) return { error: { code: 'OBJECT_NOT_FOUND' } };
      const step = object[action];
      if (!step.available) return { error: { code: step.reason } };
      const id = `undo-web-${action}-${randomUUID()}`;
      const request = { contractVersion: 'canvas/v5', sessionRef: undoSessionRef, requestId: id,
        worldRef: actions.worldRef, objectRef, transactionId: id, historyTransactionId: step.historyTransactionId,
        expectedHistoryRevision: step.expectedHistoryRevision, expectedWorldRevision: step.expectedWorldRevision,
        expectedObjectRevisions: step.expectedObjectRevisions,
        intentDigest: digest({ page: '/undo', action, objectRef }),
        surfaceActionDigest: digest({ page: '/undo', action, objectRef, transactionId: id }),
        localContext: actions.localContext };
      const response = await canvas.call(step.operation, request);
      await world.flush();
      return { operation: step.operation, transactionId: id, status: response.result?.status ?? null,
        error: response.error ?? null, request };
    });
    queue = run.catch(() => {});
    return run;
  }
  return { canvas, world, readView, perform };
}
