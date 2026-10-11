import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digestValue } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore } from '../../src/index.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef, undoWorldRef } from './undo-fixture-world.mjs';
import { undoWorldFile } from './undo-host.mjs';
import { fixtureSessions } from '../../scripts/fixture-sessions.mjs';

const D = (kind, value) => digestValue(kind, value).sha256;

/**
 * Test fixture: an isolated durable Canvas store with two per-cell commits made through
 * Canvas's public operations against the FIXTURE world. Refuses an existing directory.
 */
export async function createUndoExample(directory, { world: preparedWorld } = {}) {
  try { await readFile(join(directory, 'canvas-v7.json')); throw new Error('EXAMPLE_ALREADY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const store = await CanvasStore.open(directory);
  const world = preparedWorld ?? await openUndoFixtureWorld(undoWorldFile(directory), { create: true });
  const canvas = new CanvasV5({ store, adapter: world.adapter, nativeFacts: world.nativeFacts,
    sessions: fixtureSessions() });
  world.readWorldRevision = () => canvas.readWorldRevision(undoWorldRef);
  const trace = [];
  const call = async (service, operation, body) => {
    const response = await service.call(operation, body); trace.push({ operation, request: body, response });
    if (response.error) throw new Error(`EXAMPLE_TRANSACTION_FAILED:${JSON.stringify(response.error)}`);
    return response.result;
  };
  const base = { contractVersion: 'canvas/v7', sessionRef: undoSessionRef, worldRef: undoWorldRef };
  const context = await call(canvas, 'ReadWorldSelectionContext', { ...base, requestId: 'undo-fixture-context' });
  const selected = await call(canvas, 'SelectWorldConnection', { ...base, requestId: 'undo-fixture-select',
    connectionRef: undoConnection.connectionRef, connectionIncarnationRef: undoConnection.connectionIncarnationRef,
    expectedRevision: context.selection.sessionRevision, expectedContext: null });
  const localContext = selected.localContext;
  // Two per-cell commits through canvas/v7's reversible public path. Every Undo Canvas
  // offers here has a Redo for the same entry; no region example (canvas-region/v3 has no Redo).
  const commitCells = async (transactionId, materialRef, positions) => {
    const operations = { contractVersion: 'operations/v4', buildDigest: 'b'.repeat(64), compilerRevision: 'undo-fixture-brush-cell-1',
      compilationConfigDigest: 'a'.repeat(64), worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64),
      targetFactsDigest: 'd'.repeat(64), effects: positions.map(position => ({ position, geometryProfile: 'voxel-grid/v1', materialRef, orientation: 0 })) };
    const operationDigest = D('operations', operations);
    const worldRevision = await canvas.readWorldRevision(undoWorldRef);
    const listed = await call(canvas, 'ListObjects', { ...base, requestId: `${transactionId}-objects`, localContext, expectedRevision: null });
    const analyzed = await call(canvas, 'AnalyzeAffectedObjects', { ...base, requestId: `${transactionId}-analysis`,
      transactionId, operations, operationDigest, expectedRevision: worldRevision,
      expectedRegistryRevision: listed.registryRevision, expectedSelectionRevision: selected.selectionRevision, localContext });
    await call(canvas, 'ApplyRecoverableCommit', { ...base, requestId: transactionId, transactionId,
      operations, operationDigest, analysisDigest: D('affected-analysis', analyzed), decisionRevision: null,
      expectedWorldRevision: worldRevision, expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED',
      regionInspectionBinding: null, localContext });
  };
  await commitCells('undo-fixture-cell-1', 'fixture:stone', [[4, 2, 4], [5, 2, 4]]);
  // The latest world change: the entry Canvas lets the page undo and redo.
  await commitCells('undo-fixture-cell-2', 'fixture:brick', [[8, 2, 8], [9, 2, 8], [10, 2, 8]]);
  await world.flush();
  return { classification: 'REAL_RUNTIME + FIXTURE', sessionRef: undoSessionRef, worldRef: undoWorldRef, storeDirectory: directory,
    inputs: 'Adapter/world/Brush inputs are explicit fixtures in an isolated durable world file; no real world connection',
    records: 'Public Canvas selection and two per-cell analysis/commits; no direct Store record insertion',
    trace, adapterCalls: world.calls, actions: await canvas.readHistoryActions(undoSessionRef) };
}
