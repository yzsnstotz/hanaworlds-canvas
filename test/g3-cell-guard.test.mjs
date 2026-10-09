import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestValue, encodeRegionBlock, regionChunksOfBox } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, CanvasRegionV1, ADAPTER_CELL_REQUIREMENT,
  ADAPTER_REGION_REQUIREMENT, apply as applyCanvas } from '../src/index.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef,
  undoWorldRef } from '../scripts/undo-fixture-world.mjs';
import { undoWorldFile } from '../scripts/undo-host.mjs';
import { g3CellHandshake, CELL_SAFETY_CAPABILITIES, G3_CELL_CAPABILITIES }
  from './support/g3-adapter-handshake.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';

/*
 * G3 write-before guard on the per-cell port (world-adapter/v7) for BUILD, Undo and
 * Redo, and on both ports for a region write. FIXTURE: the isolated undo fixture
 * world and its two port handshakes stand in for the Adapter; Canvas, its durable
 * Store and the public canvas/v6 / canvas-region/v1 calls are the real component.
 * "Before any write" is checked as: no mutating Adapter call (Prepare/Apply/Restore,
 * WriteRegion) during the refused call, only the named read-only admission reads,
 * no pending row, unchanged history, and the fixture world file bytes unchanged.
 */
const MUTATING = new Set(['PrepareRecoverableTransaction', 'ApplyCompiledTransaction',
  'RestoreTransaction', 'PrepareHistoryTransaction', 'ApplyHistoryTransaction', 'WriteRegion']);
// Canvas's current-world admission (#bound) reads the connection before the guard.
const ADMISSION_READS = new Set(['ReadLocalConnection']);
const D = (kind, value) => digestValue(kind, value).sha256;
const base = { contractVersion: 'canvas/v6', sessionRef: undoSessionRef, worldRef: undoWorldRef };
const g3 = ADAPTER_CELL_REQUIREMENT.capabilities.length > 0;

async function boot(directory) {
  const store = await CanvasStore.open(directory);
  const world = await openUndoFixtureWorld(undoWorldFile(directory), { create: true });
  const canvas = new CanvasV5({ store, adapter: world.adapter, nativeFacts: world.nativeFacts,
    sessions: fixtureSessions() });
  world.readWorldRevision = () => canvas.readWorldRevision(undoWorldRef);
  const ok = async (operation, body) => {
    const response = await canvas.call(operation, body);
    assert.equal(response.error, null, `${operation}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const context = await ok('ReadWorldSelectionContext', { ...base, requestId: 'g3-context' });
  const selected = await ok('SelectWorldConnection', { ...base, requestId: 'g3-select',
    connectionRef: undoConnection.connectionRef,
    connectionIncarnationRef: undoConnection.connectionIncarnationRef,
    expectedRevision: context.selection.sessionRevision, expectedContext: null });
  return { canvas, world, ok, localContext: selected.localContext,
    selectionRevision: selected.selectionRevision, file: undoWorldFile(directory) };
}
/** Analyze (read-only) then the public BUILD request; the caller sends it. */
async function buildRequest(env, transactionId, positions) {
  const operations = { contractVersion: 'operations/v3', buildDigest: 'b'.repeat(64),
    compilerRevision: 'g3-fixture-brush-1', compilationConfigDigest: 'a'.repeat(64),
    worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64),
    targetFactsDigest: 'd'.repeat(64),
    effects: positions.map(position => ({ position, nodeName: 'fixture:brick', param2: 0 })) };
  const operationDigest = D('operations', operations);
  const worldRevision = await env.canvas.readWorldRevision(undoWorldRef);
  const listed = await env.ok('ListObjects', { ...base, requestId: `${transactionId}-objects`,
    localContext: env.localContext, expectedRevision: null });
  const analyzed = await env.ok('AnalyzeAffectedObjects', { ...base,
    requestId: `${transactionId}-analysis`, transactionId, operations, operationDigest,
    expectedRevision: worldRevision, expectedRegistryRevision: listed.registryRevision,
    expectedSelectionRevision: env.selectionRevision, localContext: env.localContext });
  return { ...base, requestId: transactionId, transactionId, operations, operationDigest,
    analysisDigest: D('affected-analysis', analyzed), decisionRevision: null,
    expectedWorldRevision: worldRevision, expectedObjectRevisions: {},
    guarantee: 'RECOVERABLE_VERIFIED', regionInspectionBinding: null,
    localContext: env.localContext };
}
async function historyRequest(env, operation, id) {
  const actions = await env.canvas.readHistoryActions(undoSessionRef);
  const object = actions.objects.at(-1);
  const step = object[operation === 'Undo' ? 'undo' : 'redo'];
  assert.equal(step.available, true, JSON.stringify(step));
  return { ...base, requestId: id, worldRef: actions.worldRef, objectRef: object.objectRef,
    transactionId: id, historyTransactionId: step.historyTransactionId,
    expectedHistoryRevision: step.expectedHistoryRevision,
    expectedWorldRevision: step.expectedWorldRevision,
    expectedObjectRevisions: step.expectedObjectRevisions,
    intentDigest: '1'.repeat(64), surfaceActionDigest: '2'.repeat(64),
    localContext: actions.localContext };
}
/** Sends `request` with the per-cell port advertising `handshake`; proves nothing was written. */
async function refusedBeforeWrite(env, operation, request, handshake, code, send, phase = 'decode') {
  await env.world.flush();
  const port = env.canvas.adapter;
  const calls = env.world.calls.length;
  const bytes = await readFile(env.file);
  const history = structuredClone(env.canvas.store.snapshot.history);
  env.canvas.adapter = { ...port, protocolHandshake: handshake };
  let response;
  try { response = await (send ?? (body => env.canvas.call(operation, body)))(request); }
  finally { env.canvas.adapter = port; }
  await env.world.flush();
  assert.equal(response.error?.code, code, `${operation}: ${JSON.stringify(response.error)}`);
  assert.equal(response.error.mutationState, 'NONE');
  assert.equal(response.error.phase, phase);
  const reached = env.world.calls.slice(calls).map(call => call.operation);
  assert.deepEqual(reached.filter(name => MUTATING.has(name)), [], `${operation} wrote`);
  assert.deepEqual(reached.filter(name => !ADMISSION_READS.has(name)), [],
    `${operation} reached the Adapter beyond admission reads: ${reached}`);
  assert.deepEqual(Object.keys(env.canvas.store.snapshot.pending), []);
  assert.deepEqual(env.canvas.store.snapshot.history, history);
  assert.ok(bytes.equals(await readFile(env.file)), `${operation} changed the world`);
}
const regionAsCell = { ...g3CellHandshake(), protocols: [{ protocol: 'world-adapter-region',
  major: 1, minor: 1 }], capabilities: [...ADAPTER_REGION_REQUIREMENT.capabilities] };
const refusals = () => [
  ['no per-cell handshake', undefined, 'UNSUPPORTED_VERSION'],
  ['0.x Adapter major', g3CellHandshake({ major: 6, minor: 1 }), 'UNSUPPORTED_VERSION'],
  ['region handshake on the per-cell port', regionAsCell, 'UNSUPPORTED_VERSION'],
  ...(g3 ? [
    ['missing callback-free-write', g3CellHandshake({ capabilities:
      ['world-adapter/v7:write-path-state-facts', ...CELL_SAFETY_CAPABILITIES] }),
    'CAPABILITY_UNAVAILABLE'],
    ['missing write-path-state-facts', g3CellHandshake({ capabilities:
      ['world-adapter/v7:callback-free-write', ...CELL_SAFETY_CAPABILITIES] }),
    'CAPABILITY_UNAVAILABLE'],
    ['region callback-free-write in place of the v7 one', g3CellHandshake({ capabilities:
      ['world-adapter-region/v1:callback-free-write', 'world-adapter/v7:write-path-state-facts',
        ...CELL_SAFETY_CAPABILITIES] }), 'CAPABILITY_UNAVAILABLE'],
  ] : []),
];
// Contracts 1.x engine safety on the per-cell port (BUILD, Undo, Redo): each capability missing
// alone, or the region wire's ids in their place, refuses with the Contracts absent-capability
// error (phase validate) before any write.
const safetyRefusals = () => [
  ...CELL_SAFETY_CAPABILITIES.map(id => [`missing ${id}`, g3CellHandshake({ capabilities:
    [...G3_CELL_CAPABILITIES, ...CELL_SAFETY_CAPABILITIES.filter(other => other !== id)] }),
  'CAPABILITY_UNAVAILABLE', 'validate']),
  ['region safety ids in place of the per-cell ones', g3CellHandshake({ capabilities:
    [...G3_CELL_CAPABILITIES, ...CELL_SAFETY_CAPABILITIES.map(id =>
      id.replace('world-adapter/v7:', 'world-adapter-region/v1:'))] }),
  'CAPABILITY_UNAVAILABLE', 'validate'],
];

test('per-cell requirement is world-adapter/v7 at the declared minor with the G3 write-path ids',
  () => {
    assert.equal(ADAPTER_CELL_REQUIREMENT.protocol, 'world-adapter');
    assert.equal(ADAPTER_CELL_REQUIREMENT.major, 7);
    assert.deepEqual(ADAPTER_CELL_REQUIREMENT.capabilities.filter(c =>
      !c.startsWith('world-adapter/v7:')), []);
    if (g3) {
      assert.equal(ADAPTER_CELL_REQUIREMENT.minMinor, 0);
      assert.deepEqual(ADAPTER_CELL_REQUIREMENT.capabilities, ['world-adapter/v7:callback-free-write',
        'world-adapter/v7:write-path-state-facts']);
    }
  });

test('BUILD, Undo and Redo refuse an incompatible per-cell port before any Adapter write; a G3 port writes',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-g3-cell-'));
    try {
      const env = await boot(directory);
      // BUILD: every refusal before reservation / Prepare / Apply.
      const build = await buildRequest(env, 'g3-build-1', [[8, 2, 8], [9, 2, 8]]);
      for (const [label, handshake, code, phase] of [...refusals(), ...safetyRefusals()]) {
        await refusedBeforeWrite(env, 'ApplyRecoverableCommit',
          { ...build, requestId: `g3-build-1-${label}` }, handshake, code, undefined, phase);
      }
      // A higher minor and extra ids are accepted (provenance never decides).
      env.canvas.adapter = { ...env.canvas.adapter, protocolHandshake: g3CellHandshake({ minor: 4,
        capabilities: ['world-adapter/v7:callback-free-write', 'world-adapter/v7:future-id',
          'world-adapter/v7:write-path-state-facts', ...CELL_SAFETY_CAPABILITIES] }) };
      const built = await env.canvas.call('ApplyRecoverableCommit', build);
      assert.equal(built.error, null, JSON.stringify(built.error));
      assert.equal(built.result.status, 'VERIFIED');
      assert.deepEqual(env.world.readCells([[8, 2, 8], [9, 2, 8]]).map(c => c.nodeName),
        ['fixture:brick', 'fixture:brick']);

      // Undo, then Redo: the same guard, same refusals, then the real move.
      for (const operation of ['Undo', 'Redo']) {
        const request = await historyRequest(env, operation, `g3-${operation}`);
        for (const [label, handshake, code, phase] of [...refusals(), ...safetyRefusals()])
          await refusedBeforeWrite(env, operation, { ...request, requestId: `g3-${operation}-${label}` },
            handshake, code, undefined, phase);
        const moved = await env.canvas.call(operation, request);
        assert.equal(moved.error, null, JSON.stringify(moved.error));
        assert.equal(moved.result.status, 'VERIFIED');
        assert.deepEqual(env.world.readCells([[8, 2, 8], [9, 2, 8]]).map(c => c.nodeName),
          operation === 'Undo' ? ['air', 'air'] : ['fixture:brick', 'fixture:brick']);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('a region write needs both ports compatible and is refused before any region read or write',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-g3-region-'));
    try {
      const env = await boot(directory);
      const region = new CanvasRegionV1(env.canvas, env.world.regionAdapter);
      const origin = [16, 2, 16], size = [2, 1, 1];
      const palette = [{ nodeName: 'fixture:stone', param2: 0 }];
      const chunks = regionChunksOfBox({ min: origin, max: origin.map((o, a) => o + size[a] - 1) })
        .map(({ chunkPos, box }) => ({ chunkPos, block: encodeRegionBlock({ origin: box.min,
          size: box.max.map((v, a) => v - box.min[a] + 1), palette,
          indices: Int32Array.from({ length: 2 }, () => 0) }) }));
      const operations = { contractVersion: 'region-operations/v1', buildDigest: 'b'.repeat(64),
        compilerRevision: 'g3-region-1', worldRef: undoWorldRef, catalogueDigest: 'c'.repeat(64),
        chunkEdge: 16, chunks };
      const request = { contractVersion: 'canvas-region/v1', sessionRef: undoSessionRef,
        worldRef: undoWorldRef, localContext: env.localContext, guarantee: 'RECOVERABLE_VERIFIED',
        requestId: 'g3-region', transactionId: 'g3-region', operations,
        operationDigest: D('region-operations', operations) };
      const send = body => region.call('ApplyRegionCommit', body);
      for (const [label, handshake, code] of refusals())
        await refusedBeforeWrite(env, 'ApplyRegionCommit', { ...request, requestId: `g3-region-${label}` },
          handshake, code, send);
      // Region port: missing handshake or a pre-G3 region handshake, with a G3 per-cell port.
      const regionPort = env.world.regionAdapter;
      const preG3 = { ...regionPort.protocolHandshake, protocols: [{ protocol: 'world-adapter-region',
        major: 1, minor: 0 }], capabilities: regionPort.protocolHandshake.capabilities
        .filter(c => !c.endsWith('callback-free-write')) };
      const sendWith = port => body => new CanvasRegionV1(env.canvas, port).call('ApplyRegionCommit', body);
      await refusedBeforeWrite(env, 'ApplyRegionCommit', { ...request, requestId: 'g3-region-none' },
        env.canvas.adapter.protocolHandshake, 'UNSUPPORTED_VERSION',
        sendWith({ ...regionPort, protocolHandshake: undefined }));
      if (g3) await refusedBeforeWrite(env, 'ApplyRegionCommit', { ...request, requestId: 'g3-region-pre' },
        env.canvas.adapter.protocolHandshake, 'UNSUPPORTED_VERSION', sendWith({ ...regionPort,
          protocolHandshake: preG3 }));
      if (g3) await refusedBeforeWrite(env, 'ApplyRegionCommit', { ...request, requestId: 'g3-region-cap' },
        env.canvas.adapter.protocolHandshake, 'CAPABILITY_UNAVAILABLE', sendWith({ ...regionPort,
          protocolHandshake: { ...preG3, protocols: [{ protocol: 'world-adapter-region', major: 1,
            minor: 1 }] } }));
      // Contracts 1.x engine safety on the region port: each region capability missing alone,
      // or the per-cell ids in their place, refuses before any region read or write.
      const regionSafety = regionPort.protocolHandshake.capabilities.filter(c =>
        /:(restore-body-recheck|cell-protection|no-body-enclosure)$/.test(c));
      assert.equal(regionSafety.length, 3);
      const regionWithout = capabilities => ({ ...regionPort, protocolHandshake: {
        ...regionPort.protocolHandshake, capabilities: [...capabilities].sort() } });
      const plain = regionPort.protocolHandshake.capabilities.filter(c => !regionSafety.includes(c));
      for (const id of regionSafety)
        await refusedBeforeWrite(env, 'ApplyRegionCommit', { ...request, requestId: `g3-region-no-${id}` },
          env.canvas.adapter.protocolHandshake, 'CAPABILITY_UNAVAILABLE',
          sendWith(regionWithout([...plain, ...regionSafety.filter(other => other !== id)])), 'validate');
      await refusedBeforeWrite(env, 'ApplyRegionCommit', { ...request, requestId: 'g3-region-cell-ids' },
        env.canvas.adapter.protocolHandshake, 'CAPABILITY_UNAVAILABLE',
        sendWith(regionWithout([...plain, ...CELL_SAFETY_CAPABILITIES])), 'validate');
      const committed = await send(request);
      assert.equal(committed.error, null, JSON.stringify(committed.error));
      assert.equal(committed.result.status, 'VERIFIED');
      assert.deepEqual(env.world.readCells([[16, 2, 16], [17, 2, 16]]).map(c => c.nodeName),
        ['fixture:stone', 'fixture:stone']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

/*
 * FIXTURE in the public location the Adapter documents (F-AD-WORLD-MANAGE-01 REPORT,
 * SOURCE_PUBLIC_PROVIDER): Host service hanaworldsWorldAdapterV6, `protocolHandshake` is a
 * property (not a method), provenance source/digest null, and `contractHandshake` a separate
 * property naming the Adapter's own package. The protocol row is the Contracts 1.x per-cell
 * wire (world-adapter 7.0 with its two write-path ids). Not the real Adapter; it proves
 * Canvas's apply() reads that public location.
 */
const publicV6Handshake = () => ({ profileVersion: 'protocol-handshake/v1',
  component: 'hanaworlds-adapter-luanti',
  protocols: [{ protocol: 'world-adapter', major: 7, minor: 0 }],
  capabilities: ['world-adapter/v7:callback-free-write', 'world-adapter/v7:write-path-state-facts'],
  provenance: { packageName: 'hanaworlds-adapter-luanti', packageVersion: '0.7.4',
    sourceRevision: null, artifactDigest: null } });
const otherPackage = { contracts: 'hanaworlds-contracts@1.0.0-rc.1' };

test('apply() reads the per-cell handshake from the public hanaworldsWorldAdapterV6 property',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-g3-public-'));
    try {
      const run = async port => {
        const ctx = { get: name => name === 'dshHomePath' ? (...p) => join(directory, ...p) :
          name === 'hanaworldsWorldAdapterV6' ? port : null, provide: () => {} };
        const canvas = applyCanvas(ctx);
        await canvas.ready;
        try { return { ok: canvas.adapterCompatible() }; }
        catch (error) { return { error: error.publicError ?? error }; }
      };
      const call = async () => null;
      const accepted = await run({ protocolHandshake: publicV6Handshake(),
        contractHandshake: otherPackage, call });
      assert.equal(accepted.ok?.result, 'PROTOCOL_COMPATIBLE', JSON.stringify(accepted.error));
      assert.equal(accepted.ok.component, 'hanaworlds-adapter-luanti');
      // The Adapter's contractHandshake is another package identity; it never decides.
      assert.equal(accepted.ok.provenance.sourceRevision, null);
      // Wrong places are not read: no service, only contractHandshake, a method, the region port.
      assert.equal((await run(null)).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await run({ contractHandshake: otherPackage, call })).error.code,
        'UNSUPPORTED_VERSION');
      assert.equal((await run({ protocolHandshake: undefined,
        handshake: () => publicV6Handshake(), call })).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await run({ protocolHandshake: { ...publicV6Handshake(),
        protocols: [{ protocol: 'world-adapter-region', major: 1, minor: 1 }] }, call }))
        .error.code, 'UNSUPPORTED_VERSION');
      if (g3) assert.equal((await run({ protocolHandshake: { ...publicV6Handshake(),
        capabilities: ['world-adapter/v7:callback-free-write'] }, call })).error.code,
      'CAPABILITY_UNAVAILABLE');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
