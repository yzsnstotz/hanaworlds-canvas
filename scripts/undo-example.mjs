import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestValue, encodeRegionBlock, regionChunksOfBox } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, CanvasRegionV1 } from '../src/index.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef, undoWorldRef } from './undo-fixture-world.mjs';
import { undoWorldFile } from './undo-host.mjs';

export const undoRunRoot = join(homedir(), '.cache', 'hanaworlds-runs', 'F-CANVAS-UNDO-01', 'undo-web');
const D = (kind, value) => digestValue(kind, value).sha256;

/**
 * One-time producer of the isolated /undo example: a region commit and a per-cell
 * commit made through Canvas's public operations. It refuses an existing directory
 * and is never run by the server.
 */
export async function createUndoExample(directory) {
  try { await readFile(join(directory, 'canvas-v5.json')); throw new Error('EXAMPLE_ALREADY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const store = await CanvasStore.open(directory);
  const world = await openUndoFixtureWorld(undoWorldFile(directory), { create: true });
  const canvas = new CanvasV5({ store, adapter: world.adapter, nativeFacts: world.nativeFacts });
  const region = new CanvasRegionV1(canvas, world.regionAdapter);
  world.readWorldRevision = () => canvas.readWorldRevision(undoWorldRef);
  const trace = [];
  const call = async (service, operation, body) => {
    const response = await service.call(operation, body); trace.push({ operation, request: body, response });
    if (response.error) throw new Error(`EXAMPLE_TRANSACTION_FAILED:${JSON.stringify(response.error)}`);
    return response.result;
  };
  const base = { contractVersion: 'canvas/v5', sessionRef: undoSessionRef, worldRef: undoWorldRef };
  const context = await call(canvas, 'ReadWorldSelectionContext', { ...base, requestId: 'undo-fixture-context' });
  const selected = await call(canvas, 'SelectWorldConnection', { ...base, requestId: 'undo-fixture-select',
    connectionRef: undoConnection.connectionRef, connectionIncarnationRef: undoConnection.connectionIncarnationRef,
    expectedRevision: context.selection.sessionRevision, expectedContext: null });
  const localContext = selected.localContext;
  // Example 1: a 2×1×2 region fill (whole-region Undo is public; region Redo is not).
  const origin = [20, 2, 20], size = [2, 1, 2];
  const block = encodeRegionBlock({ origin, size, palette: [{ nodeName: 'fixture:stone', param2: 0 }],
    indices: new Int32Array(size.reduce((a, b) => a * b, 1)) });
  const chunks = regionChunksOfBox({ min: origin, max: origin.map((o, a) => o + size[a] - 1) });
  const regionOperations = { contractVersion: 'region-operations/v1', buildDigest: 'b'.repeat(64),
    compilerRevision: 'undo-fixture-brush-region-1', worldRef: undoWorldRef, catalogueDigest: 'c'.repeat(64),
    chunkEdge: 16, chunks: [{ chunkPos: chunks[0].chunkPos, block }] };
  await call(region, 'ApplyRegionCommit', { contractVersion: 'canvas-region/v1', sessionRef: undoSessionRef,
    worldRef: undoWorldRef, localContext, guarantee: 'RECOVERABLE_VERIFIED', requestId: 'undo-fixture-region',
    transactionId: 'undo-fixture-region', operations: regionOperations, operationDigest: D('region-operations', regionOperations) });
  // Example 2: a three-cell per-cell commit, the latest world change (Undo and Redo both public).
  const operations = { contractVersion: 'operations/v3', buildDigest: 'b'.repeat(64), compilerRevision: 'undo-fixture-brush-cell-1',
    compilationConfigDigest: 'a'.repeat(64), worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64),
    targetFactsDigest: 'd'.repeat(64), effects: [[8, 2, 8], [9, 2, 8], [10, 2, 8]].map(position =>
      ({ position, nodeName: 'fixture:brick', param2: 0 })) };
  const operationDigest = D('operations', operations);
  const worldRevision = await canvas.readWorldRevision(undoWorldRef);
  const listed = await call(canvas, 'ListObjects', { ...base, requestId: 'undo-fixture-objects', localContext, expectedRevision: null });
  const analyzed = await call(canvas, 'AnalyzeAffectedObjects', { ...base, requestId: 'undo-fixture-analysis',
    transactionId: 'undo-fixture-cell', operations, operationDigest, expectedRevision: worldRevision,
    expectedRegistryRevision: listed.registryRevision, expectedSelectionRevision: selected.selectionRevision, localContext });
  await call(canvas, 'ApplyRecoverableCommit', { ...base, requestId: 'undo-fixture-cell', transactionId: 'undo-fixture-cell',
    operations, operationDigest, analysisDigest: D('affected-analysis', analyzed), decisionRevision: null,
    expectedWorldRevision: worldRevision, expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED',
    regionInspectionBinding: null, localContext });
  await world.flush();
  return { classification: 'REAL_RUNTIME + FIXTURE', sessionRef: undoSessionRef, worldRef: undoWorldRef, storeDirectory: directory,
    inputs: 'Adapter/world/Brush inputs are explicit fixtures in an isolated durable world file; no real world connection',
    records: 'Public Canvas selection, region commit, per-cell analysis/commit; no direct Store record insertion',
    trace, adapterCalls: world.calls, actions: await canvas.readHistoryActions(undoSessionRef) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = join(undoRunRoot, 'isolated-example');
  const receipt = await createUndoExample(directory);
  await writeFile(join(directory, 'production-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ classification: receipt.classification, storeDirectory: directory,
    entries: receipt.actions.objects.map(row => [row.mode, row.cells.length, row.undo.available, row.redo.available]) }));
}
