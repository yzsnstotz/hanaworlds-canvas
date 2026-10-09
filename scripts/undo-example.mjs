import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestValue } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef, undoWorldRef } from './undo-fixture-world.mjs';
import { undoWorldFile } from './undo-host.mjs';
import { fixtureSessions } from './fixture-sessions.mjs';

export const undoRunRoot = join(homedir(), '.cache', 'hanaworlds-runs', 'F-CANVAS-UNDO-01', 'undo-web');
const D = (kind, value) => digestValue(kind, value).sha256;

/**
 * One-time producer of the isolated /undo example: two per-cell commits made
 * through Canvas's public canvas/v6 operations. It refuses an existing directory
 * and is never run by the server.
 */
export async function createUndoExample(directory) {
  try { await readFile(join(directory, 'canvas-v6.json')); throw new Error('EXAMPLE_ALREADY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const store = await CanvasStore.open(directory);
  const world = await openUndoFixtureWorld(undoWorldFile(directory), { create: true });
  const canvas = new CanvasV5({ store, adapter: world.adapter, nativeFacts: world.nativeFacts,
    sessions: fixtureSessions() });
  world.readWorldRevision = () => canvas.readWorldRevision(undoWorldRef);
  const trace = [];
  const call = async (service, operation, body) => {
    const response = await service.call(operation, body); trace.push({ operation, request: body, response });
    if (response.error) throw new Error(`EXAMPLE_TRANSACTION_FAILED:${JSON.stringify(response.error)}`);
    return response.result;
  };
  const base = { contractVersion: 'canvas/v6', sessionRef: undoSessionRef, worldRef: undoWorldRef };
  const context = await call(canvas, 'ReadWorldSelectionContext', { ...base, requestId: 'undo-fixture-context' });
  const selected = await call(canvas, 'SelectWorldConnection', { ...base, requestId: 'undo-fixture-select',
    connectionRef: undoConnection.connectionRef, connectionIncarnationRef: undoConnection.connectionIncarnationRef,
    expectedRevision: context.selection.sessionRevision, expectedContext: null });
  const localContext = selected.localContext;
  // Two per-cell commits through canvas/v6's reversible public path. Every Undo Canvas
  // offers here has a Redo for the same entry; no region example (canvas-region/v2 has no Redo).
  const commitCells = async (transactionId, nodeName, positions) => {
    const operations = { contractVersion: 'operations/v3', buildDigest: 'b'.repeat(64), compilerRevision: 'undo-fixture-brush-cell-1',
      compilationConfigDigest: 'a'.repeat(64), worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64),
      targetFactsDigest: 'd'.repeat(64), effects: positions.map(position => ({ position, nodeName, param2: 0 })) };
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = join(undoRunRoot, 'isolated-example');
  const receipt = await createUndoExample(directory);
  await writeFile(join(directory, 'production-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ classification: receipt.classification, storeDirectory: directory,
    entries: receipt.actions.objects.map(row => [row.mode, row.cells.length, row.undo.available, row.redo.available]) }));
}
