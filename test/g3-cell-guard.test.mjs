import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestValue, encodeRegionBlock, regionChunksOfBox, guardRefusalError, validateResponse,
  unmetEngineGuards } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, CanvasRegionV1, ADAPTER_CELL_REQUIREMENT,
  ADAPTER_REGION_REQUIREMENT, ENGINE_GUARD_REQUIREMENTS, apply as applyCanvas } from '../src/index.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef,
  undoWorldRef } from './support/undo-fixture-world.mjs';
import { undoWorldFile } from './support/undo-host.mjs';
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';
import { fixtureEngineGuards } from '../scripts/fixture-engine-guards.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';

/*
 * G3 write-before guard on the per-cell port (world-adapter/v8) for BUILD, Undo and
 * Redo, and on both ports for a region write. FIXTURE: the isolated undo fixture
 * world and its two port handshakes stand in for the Adapter; Canvas, its durable
 * Store and the public canvas/v7 / canvas-region/v3 calls are the real component.
 * "Before any write" is checked as: no mutating Adapter call (Prepare/Apply/Restore,
 * WriteRegion) during the refused call, only the named read-only admission reads,
 * no pending row, unchanged history, and the fixture world file bytes unchanged.
 */
const MUTATING = new Set(['PrepareRecoverableTransaction', 'ApplyCompiledTransaction',
  'RestoreTransaction', 'PrepareHistoryTransaction', 'ApplyHistoryTransaction', 'WriteRegion']);
// Canvas's current-world admission (#bound) reads the connection before the guard.
const ADMISSION_READS = new Set(['ReadLocalConnection']);
const D = (kind, value) => digestValue(kind, value).sha256;
const base = { contractVersion: 'canvas/v7', sessionRef: undoSessionRef, worldRef: undoWorldRef };
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
  const operations = { contractVersion: 'operations/v4', buildDigest: 'b'.repeat(64),
    compilerRevision: 'g3-fixture-brush-1', compilationConfigDigest: 'a'.repeat(64),
    worldRef: undoWorldRef, frameDigest: 'f'.repeat(64), catalogueDigest: 'c'.repeat(64),
    targetFactsDigest: 'd'.repeat(64),
    effects: positions.map(position => ({ position, geometryProfile: 'voxel-grid/v1', materialRef: 'fixture:brick', orientation: 0 })) };
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
  return response;
}
const regionAsCell = { ...g3CellHandshake(), protocols: [{ protocol: 'world-adapter-region',
  major: 3, minor: 0 }], capabilities: [...ADAPTER_REGION_REQUIREMENT.capabilities] };
const refusals = () => [
  ['no per-cell handshake', undefined, 'UNSUPPORTED_VERSION'],
  ['0.x Adapter major', g3CellHandshake({ major: 6, minor: 1 }), 'UNSUPPORTED_VERSION'],
  ['region handshake on the per-cell port', regionAsCell, 'UNSUPPORTED_VERSION'],
  ...(g3 ? [
    ['missing callback-free-write', g3CellHandshake({ capabilities:
      ['world-adapter/v8:write-path-state-facts'] }), 'CAPABILITY_UNAVAILABLE'],
    ['missing write-path-state-facts', g3CellHandshake({ capabilities:
      ['world-adapter/v8:callback-free-write'] }), 'CAPABILITY_UNAVAILABLE'],
    ['region callback-free-write in place of the v7 one', g3CellHandshake({ capabilities:
      ['world-adapter-region/v3:callback-free-write', 'world-adapter/v8:write-path-state-facts'] }),
    'CAPABILITY_UNAVAILABLE'],
  ] : []),
];
// Contracts 1.0.0-rc.2 engine guards (PublicCapabilities.engineGuards of the current connection):
// every guard x stage the operation needs, dropped alone from the declaration, refuses with
// guardRefusalError(GUARD_UNAVAILABLE, preflight) = CAPABILITY_UNAVAILABLE/validate before any write;
// a null declaration refuses too. Rows are [label, declaration].
const guardRefusals = operation => [['no declaration', null],
  ...ENGINE_GUARD_REQUIREMENTS[operation].map(row => [`${row.guard}@${row.stage} uncovered`,
    fixtureEngineGuards({ without: [row] })])];
/** Sends `request` with the connection declaring `declaration`; proves nothing was written. */
async function guardRefusedBeforeWrite(env, operation, request, declaration, send) {
  env.world.engineGuards = declaration;
  try {
    const response = await refusedBeforeWrite(env, operation, request,
      env.canvas.adapter.protocolHandshake, 'CAPABILITY_UNAVAILABLE', send, 'validate');
    // rc.4: the envelope names the first uncovered guard x stage, explained by its error.
    const [first] = unmetEngineGuards(declaration, ENGINE_GUARD_REQUIREMENTS[operation]);
    assert.deepEqual({ ...response.guardRefusal }, { ...first }, operation);
    assert.deepEqual({ ...response.error }, { ...guardRefusalError(first, { preflight: true }) });
    validateResponse(send ? 'canvas-region/v3' : 'canvas/v7', operation, response);
  } finally { delete env.world.engineGuards; }
}

test('per-cell requirement is world-adapter/v8 at the consumed minimum minor with the G3 write-path ids',
  () => {
    assert.equal(ADAPTER_CELL_REQUIREMENT.protocol, 'world-adapter');
    assert.equal(ADAPTER_CELL_REQUIREMENT.major, 8);
    assert.deepEqual(ADAPTER_CELL_REQUIREMENT.capabilities.filter(c =>
      !c.startsWith('world-adapter/v8:')), []);
    if (g3) {
      assert.equal(ADAPTER_CELL_REQUIREMENT.minMinor, 0);
      assert.deepEqual(ADAPTER_CELL_REQUIREMENT.capabilities, ['world-adapter/v8:callback-free-write',
        'world-adapter/v8:write-path-state-facts']);
    }
  });

test('BUILD, Undo and Redo refuse an incompatible per-cell port before any Adapter write; a G3 port writes',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-g3-cell-'));
    try {
      const env = await boot(directory);
      // BUILD: every refusal before reservation / Prepare / Apply.
      const build = await buildRequest(env, 'g3-build-1', [[8, 2, 8], [9, 2, 8]]);
      for (const [label, handshake, code] of refusals())
        await refusedBeforeWrite(env, 'ApplyRecoverableCommit',
          { ...build, requestId: `g3-build-1-${label}` }, handshake, code);
      for (const [label, declaration] of guardRefusals('ApplyRecoverableCommit'))
        await guardRefusedBeforeWrite(env, 'ApplyRecoverableCommit',
          { ...build, requestId: `g3-build-1-${label}` }, declaration);
      // An uncovered stage the operation never reaches (region / inspection) does not refuse it.
      env.world.engineGuards = fixtureEngineGuards({ without: [
        { guard: 'PLAYER_ENCLOSURE', stage: 'REGION_RESTORE' },
        { guard: 'CELL_PROTECTION', stage: 'INSPECT_REGION' }] });
      // A higher minor and extra ids are accepted (provenance never decides).
      env.canvas.adapter = { ...env.canvas.adapter, protocolHandshake: g3CellHandshake({ minor: 4,
        capabilities: ['world-adapter/v8:callback-free-write', 'world-adapter/v8:future-id',
          'world-adapter/v8:write-path-state-facts'] }) };
      const built = await env.canvas.call('ApplyRecoverableCommit', build);
      delete env.world.engineGuards;
      assert.equal(built.error, null, JSON.stringify(built.error));
      assert.equal(built.result.status, 'VERIFIED');
      assert.deepEqual(env.world.readCells([[8, 2, 8], [9, 2, 8]]).map(c => c.materialRef),
        ['fixture:brick', 'fixture:brick']);

      // Undo, then Redo: the same guard, same refusals, then the real move.
      for (const operation of ['Undo', 'Redo']) {
        const request = await historyRequest(env, operation, `g3-${operation}`);
        for (const [label, handshake, code] of refusals())
          await refusedBeforeWrite(env, operation, { ...request, requestId: `g3-${operation}-${label}` },
            handshake, code);
        for (const [label, declaration] of guardRefusals(operation))
          await guardRefusedBeforeWrite(env, operation,
            { ...request, requestId: `g3-${operation}-${label}` }, declaration);
        const moved = await env.canvas.call(operation, request);
        assert.equal(moved.error, null, JSON.stringify(moved.error));
        assert.equal(moved.result.status, 'VERIFIED');
        assert.deepEqual(env.world.readCells([[8, 2, 8], [9, 2, 8]]).map(c => c.materialRef),
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
      const palette = [{ materialRef: 'fixture:stone', orientation: 0 }];
      const chunks = regionChunksOfBox({ min: origin, max: origin.map((o, a) => o + size[a] - 1) }, { edge: [16, 16, 16] })
        .map(({ chunkPos, box }) => ({ chunkPos, block: encodeRegionBlock({ origin: box.min,
          size: box.max.map((v, a) => v - box.min[a] + 1), palette,
          indices: Int32Array.from({ length: 2 }, () => 0) }) }));
      const operations = { contractVersion: 'region-operations/v2', buildDigest: 'b'.repeat(64),
        compilerRevision: 'g3-region-1', worldRef: undoWorldRef, catalogueDigest: 'c'.repeat(64),
        partition: { edge: [16, 16, 16] }, chunks };
      const request = { contractVersion: 'canvas-region/v3', sessionRef: undoSessionRef,
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
          protocolHandshake: { ...preG3, protocols: [{ protocol: 'world-adapter-region', major: 3,
            minor: 0 }] } }));
      // Contracts 1.0.0-rc.2 engine guards for a region write (REGION_APPLY / REGION_RESTORE).
      for (const [label, declaration] of guardRefusals('ApplyRegionCommit'))
        await guardRefusedBeforeWrite(env, 'ApplyRegionCommit',
          { ...request, requestId: `g3-region-${label}` }, declaration, send);
      // Per-cell coverage never stands in for the region stages.
      await guardRefusedBeforeWrite(env, 'ApplyRegionCommit', { ...request, requestId: 'g3-region-cell-only' },
        fixtureEngineGuards({ without: ['BODY_CLEARANCE', 'CELL_PROTECTION', 'PLAYER_ENCLOSURE']
          .flatMap(guard => ['REGION_APPLY', 'REGION_RESTORE'].map(stage => ({ guard, stage }))) }), send);
      const committed = await send(request);
      assert.equal(committed.error, null, JSON.stringify(committed.error));
      assert.equal(committed.result.status, 'VERIFIED');
      assert.deepEqual(env.world.readCells([[16, 2, 16], [17, 2, 16]]).map(c => c.materialRef),
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
  protocols: [{ protocol: 'world-adapter', major: 8, minor: 0 }],
  capabilities: ['world-adapter/v8:callback-free-write', 'world-adapter/v8:write-path-state-facts'],
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
        protocols: [{ protocol: 'world-adapter-region', major: 3, minor: 0 }] }, call }))
        .error.code, 'UNSUPPORTED_VERSION');
      if (g3) assert.equal((await run({ protocolHandshake: { ...publicV6Handshake(),
        capabilities: ['world-adapter/v8:callback-free-write'] }, call })).error.code,
      'CAPABILITY_UNAVAILABLE');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('rc.4 relay: canvas/v7 envelopes carry engine guard refusals unchanged, null otherwise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-relay-'));
  try {
    const env = await boot(directory);
    const before = await readFile(env.file);
    // Prepare refused by the engine (G3): forwarded with its error, nothing written or pending.
    const prepareRefusal = { guard: 'PLAYER_ENCLOSURE', stage: 'PREPARE_RECOVERABLE', finding: 'PLAYER_ENCLOSED' };
    env.world.refuse = { operation: 'PrepareRecoverableTransaction', refusal: prepareRefusal };
    const build = await buildRequest(env, 'relay-build-1', [[8, 2, 8]]);
    const prepared = await env.canvas.call('ApplyRecoverableCommit', build);
    validateResponse('canvas/v7', 'ApplyRecoverableCommit', prepared);
    assert.equal(prepared.result, null);
    assert.deepEqual({ ...prepared.guardRefusal }, prepareRefusal);
    assert.deepEqual({ ...prepared.error, transactionRef: null },
      { ...guardRefusalError(prepareRefusal), transactionRef: null });
    assert.deepEqual(Object.keys(env.canvas.store.snapshot.pending), []);
    assert.ok(before.equals(await readFile(env.file)));
    // Apply refused by the engine (G2, zero writes): Canvas rolls back and the ROLLED_BACK
    // receipt keeps the refusal and its error.
    const applyRefusal = { guard: 'CELL_PROTECTION', stage: 'APPLY_COMPILED', finding: 'PROTECTED_CELL' };
    env.world.refuse = { operation: 'ApplyCompiledTransaction', refusal: applyRefusal };
    const build2 = await buildRequest(env, 'relay-build-2', [[8, 2, 8]]);
    const applied = await env.canvas.call('ApplyRecoverableCommit', build2);
    validateResponse('canvas/v7', 'ApplyRecoverableCommit', applied);
    assert.equal(applied.error, null, JSON.stringify(applied));
    assert.equal(applied.guardRefusal, null);
    assert.equal(applied.result.status, 'ROLLED_BACK');
    assert.deepEqual({ ...applied.result.guardRefusal }, applyRefusal);
    assert.equal(applied.result.error.code, 'SAFETY_INVARIANT_FAILED');
    assert.deepEqual(env.world.readCells([[8, 2, 8]]).map(c => c.materialRef), ['air']);
    delete env.world.refuse;
    // A normal BUILD: guardRefusal null on the envelope and the receipt.
    const ok = await env.canvas.call('ApplyRecoverableCommit',
      await buildRequest(env, 'relay-build-3', [[8, 2, 8]]));
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    assert.equal(ok.guardRefusal, null);
    assert.equal(ok.result.guardRefusal, null);
    // Pending-Undo envelopes (Canvas does not provide these operations): null, valid shape.
    const recovery = await env.canvas.call('RecoverPendingUndo', { contractVersion: 'canvas/v7',
      sessionRef: undoSessionRef, requestId: 'relay-recover', worldRef: undoWorldRef });
    assert.equal(recovery.guardRefusal, null);
    assert.notEqual(recovery.error, null);
    validateResponse('canvas/v7', 'RecoverPendingUndo', recovery);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a NativeFacts read that throws a plain coded Error keeps its code (never SCHEMA_INVALID)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-native-error-'));
  try {
    const env = await boot(directory);
    const build = await buildRequest(env, 'native-error-1', [[8, 2, 8]]);
    const original = env.canvas.nativeFacts.readScopedState;
    for (const [thrown, code] of [['TARGET_FACTS_INCOMPLETE', 'TARGET_FACTS_INCOMPLETE'],
      ['CURRENT_WORLD_MISMATCH', 'CURRENT_WORLD_MISMATCH'], ['engine said no', 'TARGET_FACTS_INCOMPLETE']]) {
      env.canvas.nativeFacts.readScopedState = async () => { throw new Error(thrown); };
      const response = await env.canvas.call('ApplyRecoverableCommit', { ...build, requestId: `native-${thrown}` });
      assert.equal(response.error.code, code, thrown);
      assert.equal(response.error.reason, 'REQUIRED_FACT_UNKNOWN');
      assert.deepEqual(Object.keys(env.canvas.store.snapshot.pending), []);
    }
    env.canvas.nativeFacts.readScopedState = original;
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('missing current world geometry refuses analysis, apply and history before a write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-cell-geometry-'));
  try {
    const env = await boot(directory);
    const request = await buildRequest(env, 'geometry-first', [[1, 2, 1]]);
    await env.ok('ApplyRecoverableCommit', request);
    const history = await historyRequest(env, 'Undo', 'geometry-undo');
    const second = await buildRequest(env, 'geometry-next', [[2, 2, 1]]);
    const call = env.world.adapter.call.bind(env.world.adapter);
    env.world.adapter.call = async (operation, body) => {
      const response = await call(operation, body);
      if (operation === 'ReadLocalConnection') {
        response.result = structuredClone(response.result);
        response.result.capabilities.worldGeometry = null;
      }
      return response;
    };
    const writes = env.world.calls.filter(row => MUTATING.has(row.operation)).length;
    await assert.rejects(buildRequest(env, 'geometry-analysis', [[3, 2, 1]]), /CAPABILITY_GAP/);
    for (const [operation, body] of [['ApplyRecoverableCommit', second], ['Undo', history]]) {
      const response = await env.canvas.call(operation, body);
      assert.equal(response.error?.code, 'CAPABILITY_GAP', JSON.stringify(response));
      assert.equal(response.error.mutationState, 'NONE');
    }
    assert.equal(env.world.calls.filter(row => MUTATING.has(row.operation)).length, writes);
    assert.deepEqual(env.canvas.store.snapshot.pending, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('affected-object analysis replays exactly without repeating connection reads', async () => {
 const directory=await mkdtemp(join(tmpdir(),'canvas-analysis-replay-'));
 try {
  const env=await boot(directory);
  const first=await buildRequest(env,'replay-analysis',[[3,2,1]]);
  const reads=env.world.calls.length;
  const second=await buildRequest(env,'replay-analysis',[[3,2,1]]);
  assert.deepEqual(second,first);
  assert.equal(env.world.calls.length,reads);
 } finally {await rm(directory,{recursive:true,force:true});}
});
