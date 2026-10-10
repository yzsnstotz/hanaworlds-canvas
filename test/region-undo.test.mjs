import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { canonicalJSON, checkProtocolCompatibility, comparePosition, contractHandshake, digestValue,
  guardRefusalError, validateResponse,
  encodeRegionBlock, expandRegionBlock, protocolRequirement, regionChunksOfBox,
  validateRegionSnapshotContent, createPlacementProposal, confirmedPlacementBinding,
  validateRegionCommitSubmission, regionRollbackCauseOf } from 'hanaworlds-contracts';
import { restoreFailedResponse as regionRestoreFailedResponse } from '../src/region-v1.mjs';
import { CanvasV5, CanvasStore, CanvasRegionV1, canvasProtocolHandshake,
  ADAPTER_REGION_REQUIREMENT, ADAPTER_CELL_REQUIREMENT, apply as applyCanvas } from '../src/index.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';
import { fixtureEngineGuards, guardSlot } from '../scripts/fixture-engine-guards.mjs';

/*
 * FIXTURE: the Adapter below (world-adapter/v7 connection reads plus a
 * world-adapter-region/v2 ReadRegion/WriteRegion port and its ProtocolHandshake)
 * is an explicit in-memory peer fixture built from the public Contracts 0.5.0
 * shapes, not the real Luanti Adapter. Its two ProtocolHandshakes advertise what a
 * G3 Adapter publishes (Contracts 0.5.1+): world-adapter-region 1.1 with its six
 * region capabilities on the region port (world-adapter-region 2.0), world-adapter 7.0 with
 * callback-free-write and write-path-state-facts on the per-cell port, and a FIXTURE
 * engine-guards/v1 declaration on the connection. It says nothing about a real engine. Brush compilation is likewise a test
 * helper over public encodeRegionBlock. Canvas, its durable store, compressed
 * snapshot files and reopen path are the real component runtime.
 */
const D = (kind, value) => digestValue(kind, value).sha256;
const stateProfile = { profileVersion: 'state-profile/v2',
  nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
  inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
const WORLD = 'local-world';
const worldRef = WORLD;
const connectionOf = worldRef => ({ connectionRef: 'local-connection', connectionIncarnationRef: 'socket-open-1',
  worldRef, payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
  capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef,
    engineBounds: { min: [-64, -64, -64], max: [64, 64, 64] }, limits: [],
    recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    sessionDeleteSupported: true, imageMediaTypes: [], model: null,
    engineGuards: fixtureEngineGuards() } });
const connection = connectionOf(WORLD);
const ADAPTER_CAPS = ['world-adapter-region/v2:callback-free-write',
  'world-adapter-region/v2:chunked-read', 'world-adapter-region/v2:chunked-write',
  'world-adapter-region/v2:lighting-complete', 'world-adapter-region/v2:load-then-know',
  'world-adapter-region/v2:restore-state'];
const CELL_CAPS = ['world-adapter/v7:callback-free-write', 'world-adapter/v7:write-path-state-facts'];
const handshake = (major = 2, minor = 0, capabilities = ADAPTER_CAPS, version = '0.4.9',
  protocol = 'world-adapter-region') => ({
  profileVersion: 'protocol-handshake/v1', component: 'fixture-adapter',
  protocols: [{ protocol, major, minor }], capabilities: [...capabilities].sort(),
  provenance: { packageName: 'fixture-adapter', packageVersion: version,
    sourceRevision: null, artifactDigest: null } });
const cellHandshake = (major = 7, minor = 0, capabilities = CELL_CAPS) =>
  handshake(major, minor, capabilities, '0.4.9', 'world-adapter');
const k = p => p.join(',');
const REGION_G1 = { guard: 'BODY_CLEARANCE', stage: 'REGION_RESTORE', finding: 'BODY_OCCUPIED' };

function fixtureWorld({ protocolHandshake = handshake(), worldRef = WORLD, inspection = null } = {}) {
  const connection = connectionOf(worldRef);
  const nodes = new Map(); // "x,y,z" -> {nodeName, param2, extra?}
  const loaded = new Set(['0,-1,0', '0,0,0']);
  const world = { nodes, loaded, unloadable: new Set(), calls: [], writes: [],
    failApply: null, corruptAfterApply: false, failRestore: false,
    incarnation: connection.connectionIncarnationRef };
  const ground = p => p[1] < 0 ? { nodeName: 'mcl_core:stone', param2: 0 } :
    { nodeName: 'air', param2: 0 };
  world.get = p => nodes.get(k(p)) ?? ground(p);
  const cellsOf = box => {
    const out = [];
    for (let z = box.min[2]; z <= box.max[2]; z++) for (let y = box.min[1]; y <= box.max[1]; y++)
      for (let x = box.min[0]; x <= box.max[0]; x++) out.push([x, y, z]);
    return out;
  };
  world.state = box => {
    const cells = cellsOf(box);
    const palette = [], seen = new Map();
    const indices = Int32Array.from(cells, p => {
      const { nodeName, param2 } = world.get(p); const id = `${nodeName}\0${param2}`;
      if (!seen.has(id)) { seen.set(id, palette.length); palette.push({ nodeName, param2 }); }
      return seen.get(id);
    });
    const extras = cells.filter(p => world.get(p).extra).sort(comparePosition)
      .map(p => ({ position: p, ...world.get(p).extra }));
    return { profileVersion: 'region-state/v1', worldRef,
      block: encodeRegionBlock({ origin: box.min, size: box.max.map((v, a) => v - box.min[a] + 1),
        palette, indices }), extras, derivedLightMode: 'recompute-with-readback' };
  };
  const setBlock = block => {
    const { box, indices, palette } = expandRegionBlock(block);
    cellsOf(box).forEach((p, i) => { if (indices[i] !== -1)
      nodes.set(k(p), { nodeName: palette[indices[i]].nodeName,
        param2: palette[indices[i]].param2 }); });
  };
  world.adapter = { protocolHandshake: cellHandshake(), async call(operation, request) {
    world.calls.push(operation);
    const respond = result => guardSlot('world-adapter/v7', operation, { contractVersion: 'world-adapter/v7', requestId: request.requestId, result, error: null });
    if (operation === 'DiscoverConnections') return respond({ capabilityRevision: 'cap-1',
      connections: [{ adapterId: 'hanaworlds-world-adapter', connectionRef: connection.connectionRef,
        worldRef, displayName: 'Fixture local world', capabilityRevision: 'cap-1',
        payloadVersion: connection.payloadVersion, readiness: 'READY',
        connectionIncarnationRef: world.incarnation }] });
    if (operation === 'ReadLocalConnection')
      return respond({ ...connection, connectionIncarnationRef: world.incarnation });
    if (operation === 'InspectRegion' && inspection) {
      const targetFacts = { ...inspection.targetFacts, worldRef, worldRevision: request.expectedWorldRevision };
      return respond({ outcome: 'REGION_INSPECTED', inspection: { ...inspection,
        inspectionId: request.inspectionId, placementSettings: request.placementSettings,
        targetFacts, targetFactsDigest: D('target-facts', targetFacts),
        evidence: { ...inspection.evidence, worldRef, worldRevision: request.expectedWorldRevision } } });
    }

    throw new Error(`unexpected v6 operation ${operation}`);
  } };
  world.region = { protocolHandshake, async call(operation, request) {
    world.calls.push(`${operation}:${request.purpose}`);
    const respond = result => guardSlot('world-adapter-region/v2', operation, { contractVersion: 'world-adapter-region/v2', requestId: request.requestId, result, error: null });
    if (operation === 'ReadRegion') return respond({ worldRef, box: request.box,
      localContext: request.localContext,
      chunks: regionChunksOfBox(request.box).map(({ chunkPos, box }) => {
        const id = k(chunkPos);
        if (world.unloadable.has(id)) return { chunkPos, box, availability: 'UNKNOWN',
          loadMethod: null, unknownReason: 'LOAD_FAILED', state: null, stateDigest: null };
        const loadMethod = loaded.has(id) ? 'ALREADY_LOADED' : 'LOADED_BY_EMERGE';
        loaded.add(id);
        const state = world.state(box);
        return { chunkPos, box, availability: 'KNOWN', loadMethod, unknownReason: null,
          state, stateDigest: D('region-state', state) };
      }) });
    if (operation === 'WriteRegion') {
      world.writes.push({ purpose: request.purpose, chunks: request.writes.length });
      // FIXTURE: an engine guard refuses the APPLY write (world.guardApply), writing nothing.
      if (request.purpose === 'APPLY' && world.guardApply) return { contractVersion:
        'world-adapter-region/v2', requestId: request.requestId, result: null,
        guardRefusal: world.guardApply, error: guardRefusalError(world.guardApply,
          { transactionRef: request.transactionId }) };
      // G1 FIXTURE: an engine guard refuses the stateless region restore in the Contracts engine
      // form (no cause, nothing written); world.guardRestore is the GuardRefusal to use.
      if (request.purpose === 'RESTORE' && world.guardRestore) return { contractVersion:
        'world-adapter-region/v2', requestId: request.requestId, result: null,
        guardRefusal: world.guardRestore, error: guardRefusalError(world.guardRestore,
          { transactionRef: request.transactionId }) };
      const boxes = [];
      const chunks = request.writes.map((w, i) => {
        const block = w.ops ?? w.state.block;
        const { box } = expandRegionBlock(block); boxes.push(box);
        if (D('region-state', world.state(box)) !== w.expectedCurrentDigest)
          return { chunkPos: w.chunkPos, status: 'NOT_WRITTEN', readbackDigest: null };
        if (request.purpose === 'RESTORE' && world.failRestore)
          return { chunkPos: w.chunkPos, status: 'UNKNOWN', readbackDigest: null };
        if (request.purpose === 'APPLY' && world.failApply === i) {
          // Partial write of this chunk, then an unknown transport outcome.
          const { indices } = expandRegionBlock(block);
          const first = indices.findIndex(v => v !== -1);
          const [sx, sy] = [0, 1].map(a => box.max[a] - box.min[a] + 1);
          nodes.set(k([box.min[0] + first % sx, box.min[1] + Math.floor(first / sx) % sy,
            box.min[2] + Math.floor(first / (sx * sy))]), { nodeName: 'mcl_core:glass', param2: 0 });
          return { chunkPos: w.chunkPos, status: 'UNKNOWN', readbackDigest: null };
        }
        if (request.purpose === 'APPLY' && world.failApply !== null && i > world.failApply)
          return { chunkPos: w.chunkPos, status: 'NOT_WRITTEN', readbackDigest: null };
        setBlock(block);
        for (const { position, ...extra } of w.state?.extras ?? [])
          nodes.set(k(position), { ...world.get(position), extra });
        return { chunkPos: w.chunkPos, status: 'WRITTEN',
          readbackDigest: D('region-state', world.state(box)) };
      });
      if (request.purpose === 'APPLY' && world.corruptAfterApply) {
        world.corruptAfterApply = false;
        nodes.set('9,-1,0', { nodeName: 'mcl_core:gravel', param2: 0 });
      }
      const lightingBox = { min: [0, 1, 2].map(a => Math.min(...boxes.map(b => b.min[a]))),
        max: [0, 1, 2].map(a => Math.max(...boxes.map(b => b.max[a]))) };
      return respond({ transactionId: request.transactionId, worldRef, purpose: request.purpose,
        chunks, lighting: { status: 'COMPLETE', box: lightingBox,
          method: 'fixture:in-memory-relight' }, localContext: request.localContext });
    }
    throw new Error(`unexpected region operation ${operation}`);
  } };
  return world;
}

/** Test-side Brush: whole-box indices -> mapblock chunks, omitting chunks with nothing specified. */
function compile(origin, size, palette, indices) {
  const box = { min: origin, max: origin.map((o, a) => o + size[a] - 1) };
  const chunks = [];
  for (const { chunkPos, box: cb } of regionChunksOfBox(box)) {
    const sub = [];
    for (let z = cb.min[2]; z <= cb.max[2]; z++) for (let y = cb.min[1]; y <= cb.max[1]; y++)
      for (let x = cb.min[0]; x <= cb.max[0]; x++)
        sub.push(indices[(x - origin[0]) + size[0] * ((y - origin[1]) + size[1] * (z - origin[2]))]);
    if (sub.every(v => v === -1)) continue;
    chunks.push({ chunkPos, block: encodeRegionBlock({ origin: cb.min,
      size: cb.max.map((v, a) => v - cb.min[a] + 1), palette, indices: Int32Array.from(sub) }) });
  }
  const operations = { contractVersion: 'region-operations/v1', buildDigest: 'b'.repeat(64),
    compilerRevision: 'fixture-brush-region-1', worldRef, catalogueDigest: 'c'.repeat(64),
    chunkEdge: 16, chunks };
  return { operations, operationDigest: D('region-operations', operations) };
}
/** 40x3x4 box over mapblocks x0..2, y-1..0: carve air at y=-2, fill dirt, stairs with
 * param2 on one row, x%7==3 unspecified, and the whole middle mapblock x16..31 unspecified. */
function terrain() {
  const origin = [8, -2, 0], size = [40, 3, 4];
  const palette = [{ nodeName: 'air', param2: 0 }, { nodeName: 'mcl_core:dirt_with_grass', param2: 0 },
    { nodeName: 'mcl_stairs:stair_stone', param2: 3 }];
  const indices = [];
  for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++)
    for (let x = 0; x < size[0]; x++) {
      const wx = origin[0] + x;
      if (x % 7 === 3 || (wx >= 16 && wx <= 31)) indices.push(-1);
      else if (y === 0) indices.push(0);
      else if (y === 1 && z === 0) indices.push(2);
      else indices.push(1);
    }
  return compile(origin, size, palette, indices);
}
const BOX = { min: [8, -2, 0], max: [47, 0, 3] };
function picture(world) {
  const out = [];
  for (let z = BOX.min[2]; z <= BOX.max[2]; z++) for (let y = BOX.min[1]; y <= BOX.max[1]; y++)
    for (let x = BOX.min[0]; x <= BOX.max[0]; x++) out.push([k([x, y, z]), world.get([x, y, z])]);
  return canonicalJSON(out);
}
async function boot(directory, world) {
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: world.adapter,
    sessions: fixtureSessions() });
  return { canvas, region: new CanvasRegionV1(canvas, world.region) };
}
async function select(canvas, selectedWorld = WORLD) {
  // Normal caller path: read the public UNBOUND fact, bind with its published revision.
  const context = await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v6',
    sessionRef: 'session-1', requestId: 'context-1', worldRef: selectedWorld });
  assert.equal(context.result.selection.status, 'UNBOUND');
  const selected = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v6',
    sessionRef: 'session-1', requestId: 'select-1', worldRef: selectedWorld,
    connectionRef: connection.connectionRef,
    connectionIncarnationRef: connection.connectionIncarnationRef,
    expectedRevision: context.result.selection.sessionRevision, expectedContext: null });
  assert.equal(selected.error, null);
  return selected.result.localContext;
}
const commit = (localContext, compiled, extra = {}) => ({ contractVersion: 'canvas-region/v2',
  sessionRef: 'session-1', requestId: 'region-1', worldRef, transactionId: 'region-tx-1',
  ...compiled, guarantee: 'RECOVERABLE_VERIFIED', localContext, ...extra });
const undo = (localContext, historyRevision, extra = {}) => ({ contractVersion: 'canvas-region/v2',
  sessionRef: 'session-1', requestId: 'undo-1', worldRef, originTransactionId: 'region-tx-1',
  undoTransactionId: 'region-undo-1', expectedHistoryRevision: historyRevision, localContext,
  ...extra });
const sign = { metadata: { infotext: 'fixture sign' }, inventory: {}, timer: null };

test('cross-mapblock fill and air carve commit once, survive reopen and undo the whole region',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-'));
    try {
      const world = fixtureWorld();
      world.nodes.set('9,-1,1', { nodeName: 'mcl_signs:wall_sign', param2: 2, extra: sign });
      world.nodes.set('11,-2,0', { nodeName: 'mcl_core:gold_block', param2: 0, extra: sign });
      let { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas);
      const compiled = terrain();
      assert.deepEqual(compiled.operations.chunks.map(c => c.chunkPos),
        [[0, -1, 0], [0, 0, 0], [2, -1, 0], [2, 0, 0]]);
      const before = picture(world);
      const committed = await region.call('ApplyRegionCommit', commit(localContext, compiled));
      assert.equal(committed.error, null, JSON.stringify(committed.error));
      const result = committed.result;
      assert.equal(result.status, 'VERIFIED');
      assert.deepEqual(result.actualSummary, result.expectedAfterSummary);
      assert.equal(result.lighting.status, 'COMPLETE');
      assert.equal(result.snapshot.compression, 'gzip');
      // one APPLY write for all chunks; mapblock x=2 was loaded by emerge first
      assert.deepEqual(world.writes, [{ purpose: 'APPLY', chunks: 4 }]);
      assert.equal(world.loaded.has('2,-1,0'), true);
      assert.equal(world.get([8, -2, 0]).nodeName, 'air');
      assert.equal(world.get([9, -1, 0]).nodeName, 'mcl_stairs:stair_stone');
      assert.equal(world.get([9, -1, 0]).param2, 3);
      assert.equal(world.get([9, -1, 1]).extra, undefined); // specified cell loses extras
      assert.deepEqual(world.get([11, -2, 0]).extra, sign); // unspecified keeps everything
      assert.equal(world.get([20, -2, 0]).nodeName, 'mcl_core:stone'); // omitted middle mapblock
      assert.deepEqual(await region.call('ApplyRegionCommit', commit(localContext, compiled)),
        committed);
      assert.equal(world.writes.length, 1);

      // durable compressed before snapshot: gzip, 0600, content addressed, extras included
      const dir = join(directory, 'region-snapshots');
      const [file] = await readdir(dir);
      assert.equal(file, `${result.snapshot.compressedSha256}.json.gz`);
      assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
      const raw = gunzipSync(await readFile(join(dir, file)));
      assert.ok(result.snapshot.compressedByteLength < raw.length);
      const content = validateRegionSnapshotContent(JSON.parse(raw), result.snapshot,
        result.beforeSummary);
      assert.ok(content.chunks.some(c => c.state.extras.some(e => k(e.position) === '9,-1,1')));

      // shared history; per-cell Undo refuses a region transaction
      const objectRef = Object.keys(canvas.store.snapshot.objects[worldRef])[0];
      const history = await canvas.call('HistoryQuery', { contractVersion: 'canvas/v6',
        sessionRef: 'session-1', requestId: 'history-1', worldRef, localContext, objectRef,
        expectedHistoryRevision: null });
      assert.equal(history.error, null, JSON.stringify(history.error));
      assert.equal(history.result.historyRevision, result.historyRevision);
      const cellUndo = await canvas.call('Undo', { contractVersion: 'canvas/v6',
        sessionRef: 'session-1', requestId: 'cell-undo', worldRef, localContext,
        transactionId: 'cell-undo-tx', historyTransactionId: 'region-tx-1', objectRef,
        expectedHistoryRevision: result.historyRevision,
        expectedWorldRevision: canvas.store.snapshot.worldRevisions[worldRef],
        expectedObjectRevisions: { [objectRef]:
          canvas.store.snapshot.objects[worldRef][objectRef].objectRevision },
        intentDigest: '7'.repeat(64), surfaceActionDigest: '8'.repeat(64) });
      assert.equal(cellUndo.error?.code, 'UNDO_CONFLICT');
      const footprint = await canvas.readFootprints(worldRef, [objectRef],
        { sessionRef: 'session-1', worldRef, localContext });
      assert.ok(footprint.objects[0].positions.length > 0);
      const display = canvas.store.snapshot.transactions['region-tx-1'].displayMetadata;
      assert.equal(display.mode, 'REGION');
      assert.equal(display.affectedCells, footprint.objects[0].positions.length);
      assert.ok(Number.isFinite(Date.parse(display.committedAt)));

      // normal reopen over the same directory, then whole-region Undo
      ({ canvas, region } = await boot(directory, world));
      const undone = await region.call('UndoRegionCommit', undo(localContext, result.historyRevision));
      assert.equal(undone.error, null, JSON.stringify(undone.error));
      assert.equal(undone.result.status, 'VERIFIED');
      assert.equal(picture(world), before);
      assert.equal(canonicalJSON(world.get([9, -1, 1]).extra), canonicalJSON(sign)); // extras restored from snapshot
      assert.deepEqual(world.writes.map(w => w.purpose), ['APPLY', 'RESTORE']);
      const again = await region.call('UndoRegionCommit', undo(localContext, result.historyRevision,
        { requestId: 'undo-2', undoTransactionId: 'region-undo-2' }));
      assert.equal(again.error?.code, 'UNDO_CONFLICT');
      const reopened = await boot(directory, world);
      assert.equal(reopened.canvas.store.snapshot.history[objectRef].length, 2);
      assert.deepEqual(reopened.canvas.store.snapshot.transactions['region-tx-1'].displayMetadata, display);
      assert.equal(reopened.canvas.store.snapshot.transactions['region-undo-1'].displayMetadata.mode, 'REGION');
      assert.equal(reopened.canvas.store.snapshot.transactions['region-undo-1'].displayMetadata.affectedCells, display.affectedCells);
      assert.deepEqual(reopened.canvas.store.snapshot.footprints[worldRef][objectRef].positions, []);
      const panel = await reopened.canvas.readObjectsHistory('session-1');
      assert.equal(panel.objects[0].occupiedCells, 0);
      assert.equal(panel.history[0].mode, 'REGION');
      assert.equal(panel.history[0].affectedCells, display.affectedCells);
      assert.ok(panel.history.every(row => row.status === 'UNDONE'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('partial chunk write or readback mismatch rolls the whole region back without residue',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-fail-'));
    try {
      const world = fixtureWorld();
      world.nodes.set('9,-1,1', { nodeName: 'mcl_signs:wall_sign', param2: 2, extra: sign });
      const { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas);
      const before = picture(world);
      world.failApply = 2; // chunks 0,1 written, chunk 2 partial/UNKNOWN, chunk 3 not written
      const failed = await region.call('ApplyRegionCommit', commit(localContext, terrain()));
      assert.equal(failed.error, null, JSON.stringify(failed.error));
      assert.equal(failed.result.status, 'ROLLED_BACK');
      assert.equal(regionRollbackCauseOf(commit(localContext, terrain()), failed).cause, 'REPORTED');
      assert.equal(failed.result.rollbackCause.error.code, 'APPLY_FAILED');
      assert.equal(failed.result.rollbackCause.error.phase, 'apply');
      assert.equal(failed.result.rollbackCause.error.mutationState, 'UNKNOWN');
      assert.equal(failed.result.rollbackCause.guardRefusal, null);
      assert.deepEqual(failed.result.actualSummary, failed.result.beforeSummary);
      assert.equal(picture(world), before);
      assert.equal(canonicalJSON(world.get([9, -1, 1]).extra), canonicalJSON(sign));
      // restore rewrote only the three chunks that differ from the snapshot
      assert.deepEqual(world.writes, [{ purpose: 'APPLY', chunks: 4 }, { purpose: 'RESTORE', chunks: 3 }]);
      const state = canvas.store.snapshot;
      assert.deepEqual(state.pending, {});
      assert.deepEqual(state.objects[worldRef] ?? {}, {});
      assert.equal(state.worldRevisions[worldRef], 'world-0');

      world.failApply = null;
      world.corruptAfterApply = true;
      const mismatch = await region.call('ApplyRegionCommit', commit(localContext, terrain(),
        { requestId: 'region-2', transactionId: 'region-tx-2' }));
      assert.equal(mismatch.result.status, 'ROLLED_BACK');
      assert.equal(mismatch.result.rollbackCause.error.code, 'READBACK_MISMATCH');
      assert.equal(mismatch.result.rollbackCause.error.phase, 'readback');
      assert.equal(mismatch.result.rollbackCause.error.mutationState, 'PARTIAL');
      assert.equal(canvas.store.snapshot.transactions['region-tx-2'].causeCode, 'READBACK_MISMATCH');
      assert.equal(picture(world), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('unverified restore stays durably pending and normal reopen recovers from the snapshot',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-recover-'));
    try {
      const world = fixtureWorld();
      let { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas);
      const before = picture(world);
      world.failApply = 1;
      world.failRestore = true;
      const result = await region.call('ApplyRegionCommit', commit(localContext, terrain()));
      assert.equal(result.error.code, 'RECOVERY_PENDING');
      assert.equal(result.error.mutationState, 'UNKNOWN');
      assert.notEqual(picture(world), before);
      world.failApply = null;
      world.failRestore = false;
      ({ canvas, region } = await boot(directory, world));
      assert.equal(canvas.store.snapshot.pending['region-tx-1'].phase, 'RESTORE_PENDING');
      // G1: the failed rollback is durably named and readable, never reported as success.
      assert.equal(result.error.causeCode, 'RESTORE_FAILED');
      assert.equal(canvas.store.snapshot.pending['region-tx-1'].restoreCode, 'RESTORE_FAILED');
      assert.equal(canvas.store.snapshot.transactions['region-tx-1'], undefined);
      const blocked = await region.call('ApplyRegionCommit', commit(localContext, terrain(),
        { requestId: 'region-9', transactionId: 'region-tx-9' }));
      assert.equal(blocked.error.code, 'TRANSACTION_CONFLICT');
      assert.deepEqual(await region.recoverPending(),
        [{ transactionId: 'region-tx-1', status: 'ROLLED_BACK' }]);
      assert.equal(picture(world), before);
      assert.deepEqual(canvas.store.snapshot.pending, {});
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('a region rollback refused in the engine form becomes RESTORE_FAILED pending with both causes',
  async () => {
    // Public rc.3 fixture: every engine-form REGION_RESTORE refusal, wrapped by Canvas.
    const examples = createRequire(import.meta.url)('hanaworlds-contracts/fixtures/skill-site-rules')
      .engineGuards.regionRestore.engine;
    assert.equal(examples.length, 3);
    for (const [index, example] of examples.entries()) {
      const directory = await mkdtemp(join(tmpdir(), 'canvas-region-g1-'));
      try {
        const world = fixtureWorld();
        const { canvas, region } = await boot(directory, world);
        const localContext = await select(canvas);
        world.failApply = 1;
        world.guardRestore = example.refusal;
        const body = commit(localContext, terrain());
        const result = await region.call('ApplyRegionCommit', body);
        assert.equal(result.result, null, example.name);
        assert.deepEqual({ ...result.guardRefusal }, example.refusal, example.name);
        // causeCode = the failure that made the restore necessary, kept in full in applyFailure.
        assert.equal(result.applyFailure.error.code, 'APPLY_FAILED');
        assert.deepEqual({ ...result.error }, { ...guardRefusalError(example.refusal,
          { transactionRef: 'region-tx-1', cause: 'APPLY_FAILED' }) }, example.name);
        assert.equal(result.error.retryability, 'AFTER_MANUAL_RECOVERY');
        const row = canvas.store.snapshot.pending['region-tx-1'];
        assert.equal(row.phase, 'RESTORE_PENDING');
        assert.equal(row.receiptStatus, 'RESTORE_FAILED');
        assert.deepEqual(row.guardRefusal, example.refusal);
        assert.equal(canvas.store.snapshot.transactions['region-tx-1'], undefined);
        if (index) continue;
        // Exact replay, no second write; the World stays blocked.
        const writes = world.writes.length;
        assert.deepEqual(await region.call('ApplyRegionCommit', body), result);
        assert.equal(world.writes.length, writes);
        const blocked = await region.call('ApplyRegionCommit', commit(localContext, terrain(),
          { requestId: 'region-g1-2', transactionId: 'region-tx-g1-2' }));
        assert.equal(blocked.error.code, 'TRANSACTION_CONFLICT');
        const actions = await canvas.readHistoryActions('session-1');
        assert.equal(actions.recovery[0].receiptStatus, 'RESTORE_FAILED');
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

test('rc.4 relay: a region APPLY the engine guard refuses is forwarded unchanged, nothing written',
  async () => {
    const fixture = createRequire(import.meta.url)('hanaworlds-contracts/fixtures/skill-site-rules');
    const refusal = fixture.engineGuards.regionRestore.rollbackApplyRefusal;
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-apply-refused-'));
    try {
      const world = fixtureWorld();
      const { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas);
      const before = picture(world);
      world.guardApply = refusal;
      const body = commit(localContext, terrain());
      const refused = await region.call('ApplyRegionCommit', body);
      validateResponse('canvas-region/v2', 'ApplyRegionCommit', refused);
      assert.equal(refused.result, null);
      assert.deepEqual({ ...refused.guardRefusal }, refusal);
      assert.deepEqual({ ...refused.error }, { ...guardRefusalError(refusal,
        { transactionRef: 'region-tx-1' }) });
      assert.equal(refused.applyFailure, null);
      assert.equal(picture(world), before);
      assert.deepEqual(canvas.store.snapshot.pending, {});
      assert.equal(world.writes.filter(w => w.purpose === 'RESTORE').length, 0);
      // Exact replay; a VERIFIED commit has guardRefusal null.
      assert.deepEqual(await region.call('ApplyRegionCommit', body), refused);
      world.guardApply = null;
      const ok = await region.call('ApplyRegionCommit', commit(localContext, terrain(),
        { requestId: 'region-ok', transactionId: 'region-tx-ok' }));
      assert.equal(ok.result.status, 'VERIFIED', JSON.stringify(ok.error));
      assert.equal(ok.guardRefusal, null);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('a region Undo the engine guard refuses is returned unchanged, writes nothing, is not pending',
  async () => {
    const examples = createRequire(import.meta.url)('hanaworlds-contracts/fixtures/skill-site-rules')
      .engineGuards.regionRestore.engine;
    for (const example of examples) {
      const directory = await mkdtemp(join(tmpdir(), 'canvas-region-g1-undo-'));
      try {
        const world = fixtureWorld();
        const { canvas, region } = await boot(directory, world);
        const localContext = await select(canvas);
        const committed = await region.call('ApplyRegionCommit', commit(localContext, terrain()));
        assert.equal(committed.result.status, 'VERIFIED', JSON.stringify(committed.error));
        const after = picture(world);
        const historyBefore = structuredClone(canvas.store.snapshot.history);
        world.guardRestore = example.refusal;
        const request = undo(localContext, committed.result.historyRevision);
        const undone = await region.call('UndoRegionCommit', request);
        // Engine form unchanged (rc.3): no cause, nothing written, applyFailure null.
        assert.equal(undone.result, null, example.name);
        assert.deepEqual({ ...undone.error, transactionRef: null }, { ...example.error,
          transactionRef: null }, example.name);
        assert.deepEqual({ ...undone.guardRefusal }, example.refusal);
        assert.equal(undone.applyFailure, null);
        assert.equal(picture(world), after);
        assert.deepEqual(canvas.store.snapshot.history, historyBefore);
        assert.deepEqual(canvas.store.snapshot.pending, {});
        // Exact replay without another write.
        const writes = world.writes.length;
        assert.deepEqual(await region.call('UndoRegionCommit', request), undone);
        assert.equal(world.writes.length, writes);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

test('a refused restore whose causing failure is itself a restore is not repaired into a receipt', () => {
  // rc.2: applyFailure.error.phase must not be restore. Canvas returns null (RECOVERY_PENDING)
  // and names the rejection instead of reshaping the errors.
  const body = { requestId: 'r', transactionId: 't' };
  const restoreError = Object.assign(new Error('RESTORE_FAILED'), { guardRefusal: REGION_G1,
    publicError: guardRefusalError(REGION_G1, { transactionRef: 't', cause: 'RESTORE_FAILED' }) });
  const cause = Object.assign(new Error('RESTORE_FAILED'), { guardRefusal: REGION_G1,
    publicError: guardRefusalError(REGION_G1, { transactionRef: 't', cause: 'APPLY_FAILED' }) });
  assert.equal(regionRestoreFailedResponse(body, 'UndoRegionCommit', restoreError, cause), null);
  assert.equal(typeof restoreError.receiptRejected, 'string');
  // The expressible case: an apply failure as cause.
  const applyCause = Object.assign(new Error('APPLY_FAILED'), { publicError: { code: 'APPLY_FAILED',
    phase: 'apply', retryability: 'AFTER_NEW_FACTS', mutationState: 'UNKNOWN', transactionRef: 't',
    causeCode: null, reason: 'APPLY_ERROR' } });
  const fresh = Object.assign(new Error('RESTORE_FAILED'), { guardRefusal: REGION_G1,
    publicError: guardRefusalError(REGION_G1, { transactionRef: 't', cause: 'RESTORE_FAILED' }) });
  const response = regionRestoreFailedResponse(body, 'ApplyRegionCommit', fresh, applyCause);
  assert.equal(response.error.causeCode, 'APPLY_FAILED');
  assert.deepEqual({ ...response.guardRefusal }, REGION_G1);
  // rc.3 engine form (no cause, nothing written) is wrapped into the same transaction form.
  const engine = Object.assign(new Error('SAFETY_INVARIANT_FAILED'), { guardRefusal: REGION_G1,
    publicError: guardRefusalError(REGION_G1, { transactionRef: 't' }) });
  assert.equal(engine.publicError.causeCode, null);
  assert.deepEqual(regionRestoreFailedResponse(body, 'ApplyRegionCommit', engine, applyCause), response);
  // A non-restore error is never turned into a RESTORE_FAILED.
  const other = Object.assign(new Error('X'), { publicError: { ...applyCause.publicError } });
  assert.equal(regionRestoreFailedResponse(body, 'ApplyRegionCommit', other, applyCause), null);
});

test('unknown, wrong world, footprint conflict and external edits never write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-region-reject-'));
  try {
    const world = fixtureWorld();
    const { canvas, region } = await boot(directory, world);
    const localContext = await select(canvas);
    const compiled = terrain();
    const body = extra => commit(localContext, compiled, extra);

    world.unloadable.add('2,0,0');
    assert.equal((await region.call('ApplyRegionCommit', body({ requestId: 'r-unknown' })))
      .error.code, 'TARGET_FACTS_INCOMPLETE');
    world.unloadable.clear();
    assert.equal((await region.call('ApplyRegionCommit', body({ requestId: 'r-world',
      worldRef: 'other-world', localContext: { ...localContext, worldRef: 'other-world' } })))
      .error.code, 'CURRENT_WORLD_MISMATCH');
    world.incarnation = 'socket-open-2';
    assert.equal((await region.call('ApplyRegionCommit', body({ requestId: 'r-conn' })))
      .error.code, 'CURRENT_WORLD_MISMATCH');
    world.incarnation = connection.connectionIncarnationRef;
    const badDigest = await region.call('ApplyRegionCommit', body({ requestId: 'r-digest',
      operationDigest: '0'.repeat(64) }));
    assert.notEqual(badDigest.error, null);
    assert.equal(world.writes.length, 0);

    const first = await region.call('ApplyRegionCommit', body({ requestId: 'r-first' }));
    assert.equal(first.result.status, 'VERIFIED');
    const overlap = await region.call('ApplyRegionCommit', body({ requestId: 'r-overlap',
      transactionId: 'region-tx-2' }));
    assert.equal(overlap.error.code, 'OTHER_OBJECTS_AFFECTED');

    // an external edit anywhere in the region makes whole Undo refuse to overwrite
    const committedCell = world.nodes.get('40,0,2');
    world.nodes.set('40,0,2', { nodeName: 'mcl_core:glass', param2: 0 });
    const writes = world.writes.length;
    const edited = await region.call('UndoRegionCommit', undo(localContext,
      first.result.historyRevision));
    assert.equal(edited.error.code, 'UNDO_CONFLICT');
    assert.equal(edited.error.reason, 'EXTERNAL_EDIT_CONFLICT');
    assert.equal(world.writes.length, writes);
    world.nodes.set('40,0,2', committedCell);
    assert.equal((await region.call('UndoRegionCommit', undo(localContext,
      first.result.historyRevision, { requestId: 'u-world', worldRef: 'other-world',
        localContext: { ...localContext, worldRef: 'other-world' } }))).error.code,
    'CURRENT_WORLD_MISMATCH');
    assert.equal((await region.call('UndoRegionCommit', undo(localContext, 'history-stale',
      { requestId: 'u-stale' }))).error.code, 'UNDO_CONFLICT');
    const ok = await region.call('UndoRegionCommit', undo(localContext,
      first.result.historyRevision, { requestId: 'u-ok' }));
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    const afterUndo = world.writes.length;
    assert.deepEqual(await region.call('UndoRegionCommit', undo(localContext,
      first.result.historyRevision, { requestId: 'u-ok' })), ok);
    assert.equal((await region.call('UndoRegionCommit', undo(localContext,
      first.result.historyRevision, { requestId: 'u-ok', undoTransactionId: 'region-undo-x' })))
      .error.code, 'REPLAY_MISMATCH');
    assert.equal(world.writes.length, afterUndo);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('protocol major + capabilities decide compatibility; patch and provenance do not',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-proto-'));
    try {
      const world = fixtureWorld();
      const { canvas } = await boot(directory, world);
      const localContext = await select(canvas);
      const run = async (protocolHandshake, extra = {}) => new CanvasRegionV1(canvas,
        { ...world.region, protocolHandshake }).call('ApplyRegionCommit',
        commit(localContext, terrain(), { requestId: `p-${Math.random()}`, ...extra }));
      assert.equal((await run(handshake(1, 1))).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await run(handshake(3))).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await run(undefined)).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await run(contractHandshake)).error.code, 'UNSUPPORTED_VERSION');
      const lacking = await run(handshake(2, 0, ADAPTER_CAPS.filter(c => !c.endsWith('restore-state'))));
      assert.equal(lacking.error.code, 'CAPABILITY_UNAVAILABLE');
      // G3 write-path scope: region port needs callback-free-write at the declared minor,
      // the per-cell port needs its own two ids; v6 ids are never asked of the region port.
      const regionG3 = ADAPTER_REGION_REQUIREMENT.capabilities.includes(
        'world-adapter-region/v2:callback-free-write');
      if (regionG3) {
        assert.equal((await run(handshake(2, 0, ADAPTER_CAPS.filter(c =>
          !c.endsWith('callback-free-write'))))).error.code, 'CAPABILITY_UNAVAILABLE');
        assert.equal((await run(handshake(1, 0))).error.code, 'UNSUPPORTED_VERSION'); // the 0.x major
      }
      assert.deepEqual(ADAPTER_REGION_REQUIREMENT.capabilities.filter(c =>
        !c.startsWith('world-adapter-region/v2:')), []);
      assert.deepEqual(ADAPTER_CELL_REQUIREMENT.capabilities.filter(c =>
        !c.startsWith('world-adapter/v7:')), []);
      const cellPort = canvas.adapter;
      const runCell = async protocolHandshake => {
        canvas.adapter = { ...cellPort, protocolHandshake };
        try { return await run(handshake()); } finally { canvas.adapter = cellPort; }
      };
      assert.equal((await runCell(undefined)).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await runCell(cellHandshake(5))).error.code, 'UNSUPPORTED_VERSION');
      if (ADAPTER_CELL_REQUIREMENT.capabilities.length) {
        assert.equal((await runCell(cellHandshake(7, 0, CELL_CAPS.filter(c =>
          !c.endsWith('write-path-state-facts'))))).error.code, 'CAPABILITY_UNAVAILABLE');
        assert.equal((await runCell(cellHandshake(6, 1))).error.code, 'UNSUPPORTED_VERSION');
      }
      assert.equal((await run(handshake(), { contractVersion: 'canvas-region/v3' })).error.code,
        'UNSUPPORTED_VERSION');
      assert.equal(world.writes.length, 0);
      const ok = await run(handshake(2, 3, ADAPTER_CAPS, '0.9.7-other-patch'));
      assert.equal(ok.error, null, JSON.stringify(ok.error));
      assert.equal(ok.result.status, 'VERIFIED');

      // Canvas's own handshake for its consumers
      const requirement = protocolRequirement('canvas-region/v2', ['canvas-region/v2:compressed-before-snapshot',
        'canvas-region/v2:rollback-on-failure', 'canvas-region/v2:single-logical-transaction',
        'canvas-region/v2:whole-region-undo']);
      assert.equal(checkProtocolCompatibility(canvasProtocolHandshake, [requirement]).result,
        'PROTOCOL_COMPATIBLE');
      assert.throws(() => checkProtocolCompatibility(canvasProtocolHandshake,
        [protocolRequirement('canvas-region/v3')]), e => e.code === 'UNSUPPORTED_VERSION');
      assert.equal(canvas.status().version, '0.13.2');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('host provides the region port, its handshake and tool description beside canvas/v6',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-host-'));
    try {
      const ports = new Map();
      const adapterPort = { protocolHandshake: handshake(), call: async () => null };
      const ctx = { get: name => name === 'dshHomePath' ? (...p) => join(directory, ...p) :
        name === 'hanaworldsWorldAdapterRegionV1' ? adapterPort : null,
      provide: (name, port) => ports.set(name, port) };
      const canvas = applyCanvas(ctx);
      await canvas.ready;
      const port = ports.get('hanaworldsCanvasRegionV1');
      assert.deepEqual(port.describe().operations, ['ApplyRegionCommit', 'UndoRegionCommit']);
      assert.match(port.describe().typicalScale, /mapblocks/);
      assert.equal(port.protocolHandshake.protocols[0].protocol, 'canvas-region');
      assert.equal(port.regionAdapter.protocolHandshake.component, 'fixture-adapter');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('Contracts public region fixture operations reproduce the contract summaries exactly',
  async () => {
    const fixture = createRequire(import.meta.url)('hanaworlds-contracts/fixtures/region');
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-public-'));
    try {
      const world = fixtureWorld({ worldRef: 'fixture-world' });
      // Seed the in-memory world with the contract's before-image states (extras included).
      for (const chunk of fixture.readResponse.result.chunks) {
        const { box, indices, palette } = expandRegionBlock(chunk.state.block);
        const [sx, sy] = [0, 1].map(a => box.max[a] - box.min[a] + 1);
        indices.forEach((v, i) => world.nodes.set(k([box.min[0] + i % sx,
          box.min[1] + Math.floor(i / sx) % sy, box.min[2] + Math.floor(i / (sx * sy))]),
        { ...palette[v] }));
        for (const { position, ...extra } of chunk.state.extras)
          world.nodes.set(k(position), { ...world.get(position), extra });
      }
      const { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas, 'fixture-world');
      const request = { ...fixture.commitRequest, sessionRef: 'session-1', localContext };
      const committed = await region.call('ApplyRegionCommit', request);
      assert.equal(committed.error, null, JSON.stringify(committed.error));
      const expected = fixture.commitResponse.result;
      assert.equal(committed.result.status, 'VERIFIED');
      assert.equal(canonicalJSON(committed.result.beforeSummary), canonicalJSON(expected.beforeSummary));
      assert.equal(canonicalJSON(committed.result.expectedAfterSummary), canonicalJSON(expected.expectedAfterSummary));
      assert.equal(canonicalJSON(committed.result.actualSummary), canonicalJSON(expected.actualSummary));
      assert.equal(committed.result.snapshot.contentDigest, expected.snapshot.contentDigest);
      assert.equal(committed.result.snapshot.beforeSummaryDigest,
        expected.snapshot.beforeSummaryDigest);
      const undone = await region.call('UndoRegionCommit', { ...fixture.undoRequest,
        sessionRef: 'session-1', localContext,
        expectedHistoryRevision: committed.result.historyRevision });
      assert.equal(undone.error, null, JSON.stringify(undone.error));
      assert.equal(undone.result.originBeforeSummaryDigest,
        fixture.undoResponse.result.originBeforeSummaryDigest);
      assert.equal(undone.result.originAfterSummaryDigest,
        fixture.undoResponse.result.originAfterSummaryDigest);
      assert.equal(canonicalJSON(undone.result.actualSummary), canonicalJSON(fixture.undoResponse.result.actualSummary));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

// Real Canvas/store decisions over explicit official-contract Adapter/Session/engine FIXTURES.
test('confirmed REGION: own source is retained, A-to-B and stale/missing/foreign sources refuse before snapshots or writes', async () => {
  const fx=JSON.parse(await readFile(new URL(import.meta.resolve('hanaworlds-contracts/fixtures/confirmed-placement'))));
  const official=fx.canvasRegion.accept[0], selectedWorld=official.commit.worldRef;
  const directory=await mkdtemp(join(tmpdir(),'canvas-confirmed-region-'));
  const results=[];
  try {
    const world=fixtureWorld({worldRef:selectedWorld,inspection:fx.inspections.regionView});
    const {canvas,region}=await boot(directory,world),localContext=await select(canvas,selectedWorld);
    const inspected=await canvas.call('InspectPlacementRegion',{contractVersion:'canvas/v6',
      sessionRef:'session-1',requestId:'region-source-inspection',worldRef:selectedWorld,
      anchor:{kind:'CURRENT_VIEW',invocationId:'region-confirmation-fixture'},footprint:{widthCells:20,heightCells:2,depthCells:3},localContext});
    assert.equal(inspected.error,null,JSON.stringify(inspected));
    const source=inspected.result.inspection, sourceId=source.inspectionId;
    const placement=createPlacementProposal(source,official.intent.confirmedIntent.placement.target);
    const brief={...official.brief,controls:{...official.brief.controls,placement}};
    const intent={...official.intent,referenceBriefDigest:D('reference-brief',brief),
      confirmedIntent:{...official.intent.confirmedIntent,placement}};
    const good={...official.commit,sessionRef:'session-1',worldRef:selectedWorld,localContext,
      confirmedPlacement:confirmedPlacementBinding(intent)};
    validateRegionCommitSubmission(intent,brief,good);
    const saved=structuredClone(canvas.store.snapshot.placementInspections[sourceId]);
    const files=await readdir(directory), initialRevision=await canvas.readWorldRevision(selectedWorld);
    let serial=0;
    const refuse=async(name,request,code,reason)=>{
      const beforeWrites=world.writes.length,beforeReads=world.calls.filter(x=>x.startsWith('ReadRegion:')).length;
      const beforeFiles=(await readdir(directory)).sort();
      const raw={...request,requestId:`confirmed-refusal-${++serial}`,transactionId:`confirmed-refusal-tx-${serial}`};
      const response=await region.call('ApplyRegionCommit',raw);
      if(process.env.CANVAS_PLACEMENT_EVIDENCE && (response.error?.code!==code || world.writes.length!==beforeWrites))
        await (await import('node:fs/promises')).writeFile(join(process.env.CANVAS_PLACEMENT_EVIDENCE,'region-negative-observed.json'),
          JSON.stringify({level:'SOURCE/FIXTURE',name,request:raw,response,writes:world.writes,
          calls:world.calls,files:await readdir(directory),expectedCode:code},null,2));

      assert.equal(response.error?.code,code,JSON.stringify({name,response}));
      if(reason)assert.equal(response.error.reason,reason,name);
      assert.equal(world.writes.length,beforeWrites,name+' no Adapter write');
      assert.equal(world.calls.filter(x=>x.startsWith('ReadRegion:')).length,beforeReads,name+' no before-image read');
      assert.deepEqual((await readdir(directory)).sort(),beforeFiles,name+' no snapshot');
      assert.equal(canvas.store.snapshot.pending[raw.transactionId],undefined,name+' no reservation');
      results.push({name,request:raw,response,writes:0,beforeImageReads:0,snapshots:0});
    };
    await refuse('CR exact confirmed A / east-shifted B',{...good,operations:fx.canvasRegion.reject[0].commit.operations,
      operationDigest:fx.canvasRegion.reject[0].commit.operationDigest},'INTENT_UNCONFIRMED','INVALID_GEOMETRY');
    await refuse('one confirmed cell missing',{...good,operations:fx.canvasRegion.reject[1].commit.operations,
      operationDigest:fx.canvasRegion.reject[1].commit.operationDigest},'INTENT_UNCONFIRMED','INVALID_GEOMETRY');
    const extent=createPlacementProposal(source,fx.canvasRegion.reject[2].commit.confirmedPlacement.placement.target);
    const extentIntent={...intent,confirmedIntent:{...intent.confirmedIntent,placement:extent}};
    await refuse('extent boundary crossed',{...good,confirmedPlacement:confirmedPlacementBinding(extentIntent),
      operations:fx.canvasRegion.reject[2].commit.operations,operationDigest:fx.canvasRegion.reject[2].commit.operationDigest},'INTENT_UNCONFIRMED','INVALID_GEOMETRY');
    await refuse('null is invalid',{...good,confirmedPlacement:null},'SCHEMA_INVALID');
    await canvas.store.commit(next=>{next.placementInspections[sourceId].inspection.inspectionId='changed-source';});
    await refuse('own source inspection changed',good,'TARGET_FACTS_STALE','PAYLOAD_CHANGED');
    await canvas.store.commit(next=>{next.placementInspections[sourceId]=structuredClone(saved);next.worldRevisions[selectedWorld]='changed-world-revision';});
    await refuse('current revision changed',good,'TARGET_FACTS_STALE','REVISION_CHANGED');
    await canvas.store.commit(next=>{next.worldRevisions[selectedWorld]=initialRevision;delete next.placementInspections[sourceId];});
    await refuse('source missing',good,'INSPECTION_FAILED','REQUIRED_FACT_UNKNOWN');
    await canvas.store.commit(next=>{next.placementInspections[sourceId]={...structuredClone(saved),sessionRef:'another-session'};});
    await refuse('source owned by another Session',good,'INSPECTION_FAILED','REQUIRED_FACT_UNKNOWN');
    await canvas.store.commit(next=>{next.placementInspections[sourceId]={...structuredClone(saved),localContext:{...localContext,connectionIncarnationRef:'old-incarnation'}};});
    await refuse('source context changed',good,'INSPECTION_FAILED','REQUIRED_FACT_UNKNOWN');
    await canvas.store.commit(next=>{next.placementInspections[sourceId]=structuredClone(saved);});
    const {confirmedPlacement:omitted,...missingBinding}=good;
    assert.throws(()=>validateRegionCommitSubmission(intent,brief,missingBinding),error=>error.code==='INTENT_UNCONFIRMED'&&error.reason==='IDENTITY_UNVERIFIED');
    assert.equal(world.writes.length,0,'Workshop omission refuses before calling Canvas');
    const committed=await region.call('ApplyRegionCommit',{...good,requestId:'confirmed-A',transactionId:'confirmed-A-tx'});
    assert.equal(committed.result?.status,'VERIFIED',JSON.stringify(committed));
    assert.deepEqual(world.writes,[{purpose:'APPLY',chunks:6}]);
    const writeCount=world.writes.length;
    const replay=await region.call('ApplyRegionCommit',{...good,requestId:'confirmed-A',transactionId:'confirmed-A-tx'});
    assert.deepEqual(replay,committed);assert.equal(world.writes.length,writeCount);
    const undone=await region.call('UndoRegionCommit',undo(localContext,committed.result.historyRevision,{
      worldRef:selectedWorld,originTransactionId:'confirmed-A-tx',undoTransactionId:'confirmed-A-undo',requestId:'confirmed-A-undo-request'}));
    assert.equal(undone.result?.status,'VERIFIED',JSON.stringify(undone));
    assert.deepEqual(undone.result.actualSummary,committed.result.beforeSummary);
    assert.deepEqual(canvas.store.snapshot.pending,{});
    if(process.env.CANVAS_PLACEMENT_EVIDENCE)await (await import('node:fs/promises')).writeFile(
      join(process.env.CANVAS_PLACEMENT_EVIDENCE,'region-own-placement-results.json'),JSON.stringify({level:'SOURCE/FIXTURE',ownPublicInspection:inspected,
      negative:results,workshopMissingBindingRefused:true,committed,replay,undone,rawOriginalCR:'confirmed A 112 cells / east-shifted B',newRealWorld:false},null,2));
  } finally {await rm(directory,{recursive:true,force:true});}
});

// SOURCE/FIXTURE: public Adapter failures and raw lost transport, no real engine or writer attribution.
test('rollback reports observed Adapter cause or UNKNOWN and replays the stored response after reopen', async () => {
  for (const mode of ['error', 'error-none', 'guard', 'unreported', 'restore-phase', 'foreign-transaction', 'invalid-mutation', 'invalid-guard']) {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-cause-'));
    try {
      const world = fixtureWorld();
      const originalCall = world.region.call.bind(world.region);
      const guard = { guard: 'BODY_CLEARANCE', stage: 'REGION_APPLY', finding: 'BODY_OCCUPIED' };
      const observed = mode === 'guard' ? guardRefusalError(guard, {transactionRef: 'region-tx-1'}) :
        {code: 'APPLY_FAILED', phase: 'apply', retryability: 'AFTER_NEW_FACTS', mutationState: 'PARTIAL',
          transactionRef: 'region-tx-1', causeCode: null, reason: 'APPLY_ERROR'};
      if (mode === 'error-none') observed.mutationState = 'NONE';
      world.region.call = async (operation, request) => {
        if (operation === 'WriteRegion' && request.purpose === 'APPLY') {
          world.writes.push({purpose: 'APPLY', chunks: request.writes.length});
          world.nodes.set('9,-1,0', {nodeName: 'mcl_core:glass', param2: 0});
          if (mode === 'unreported') throw new Error('fixture lost transport without public failure detail');
          if (mode === 'restore-phase') throw Object.assign(new Error('fixture wrong phase'),
            {publicError: {...observed, phase: 'restore'}});
          if (mode === 'foreign-transaction') throw Object.assign(new Error('fixture wrong binding'),
            {publicError: {...observed, transactionRef: 'other-tx'}});
          if (mode === 'invalid-mutation') throw Object.assign(new Error('fixture invalid mutation'),
            {publicError: {...observed, mutationState: 'VERIFIED'}});
          if (mode === 'invalid-guard') throw Object.assign(new Error('fixture unrelated guard'),
            {publicError: observed, guardRefusal: guard});
          return {contractVersion: 'world-adapter-region/v2', requestId: request.requestId,
            result: null, error: observed, guardRefusal: mode === 'guard' ? guard : null};
        }
        return originalCall(operation, request);
      };
      let {canvas, region} = await boot(directory, world);
      const localContext = await select(canvas), body = commit(localContext, terrain());
      const before = picture(world);
      const response = await region.call('ApplyRegionCommit', body);
      assert.equal(response.error, null, JSON.stringify(response.error));
      assert.equal(response.result.status, 'ROLLED_BACK');
      assert.equal(picture(world), before);
      const read = regionRollbackCauseOf(body, response);
      if (!['error', 'error-none', 'guard'].includes(mode)) {
        assert.equal(read.cause, 'UNKNOWN');assert.equal(read.failure, null);
        assert.ok(!Object.hasOwn(response.result, 'rollbackCause'));
      } else {
        assert.equal(read.cause, 'REPORTED');
        assert.equal(canonicalJSON(read.failure),
          canonicalJSON({error: observed, guardRefusal: mode === 'guard' ? guard : null}));
      }
      assert.equal(canonicalJSON(canvas.store.snapshot.transactions[body.transactionId].result), canonicalJSON(response.result));
      const calls = world.calls.length, writes = world.writes.length;
      assert.equal(canonicalJSON(await region.call('ApplyRegionCommit', body)), canonicalJSON(response));
      ({canvas, region} = await boot(directory, world));
      assert.equal(canonicalJSON(await region.call('ApplyRegionCommit', body)), canonicalJSON(response));
      assert.equal(world.calls.length, calls);assert.equal(world.writes.length, writes);
      assert.ok(region.protocolHandshake.capabilities.includes('canvas-region/v2:rollback-cause'));
    } finally { await rm(directory, {recursive: true, force: true}); }
  }
});


// Public interrupted-result shape projected from I-K3 E23/E26; no real Adapter/World.
test('Canvas incomplete APPLY cause states its validated write progress, not default NONE', async () => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/captured-region-interrupted-apply.json', import.meta.url), 'utf8'));
  for (const [mode, expected] of [['captured-partial', 'PARTIAL'], ['not-written', 'NONE'],
    ['unknown', 'UNKNOWN'], ['written-no-change', 'UNKNOWN']]) {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-progress-'));
    try {
      const world = fixtureWorld();
      for (const state of captured.beforeStates) {
        const {box, indices, palette} = expandRegionBlock(state.block);
        const [sx, sy] = state.block.size;
        for (let i = 0; i < indices.length; i++) {
          const position = [box.min[0] + i % sx, box.min[1] + Math.floor(i / sx) % sy,
            box.min[2] + Math.floor(i / (sx * sy))];
          world.nodes.set(k(position), {...palette[indices[i]]});
        }
      }
      const originalCall = world.region.call.bind(world.region);
      let observed = null;
      world.region.call = async (operation, request) => {
        if (operation !== 'WriteRegion' || request.purpose !== 'APPLY') return originalCall(operation, request);
        let first = null;
        if (['captured-partial', 'written-no-change'].includes(mode)) {
          const writes = [structuredClone(request.writes[0])];
          if (mode === 'written-no-change') writes[0].ops = captured.beforeStates[0].block;
          first = (await originalCall(operation, {...request, writes})).result;
        } else world.writes.push({purpose:'APPLY', chunks:request.writes.length});
        const response = {contractVersion:'world-adapter-region/v2', requestId:request.requestId,
          error:null, guardRefusal:null, result:{transactionId:request.transactionId,
            worldRef:request.worldRef, purpose:'APPLY', localContext:request.localContext,
            chunks:request.writes.map((w,i) => i === 0 && first ? first.chunks[0] :
              {chunkPos:w.chunkPos, status:mode === 'unknown' && i === 0 ? 'UNKNOWN' : 'NOT_WRITTEN', readbackDigest:null}),
            lighting:{status:'NOT_COMPLETE',box:{min:[-18,8,3],max:[21,8,6]}, method:'FIXTURE:captured-interruption-shape'}}};
        observed = {request, response}; return response;
      };
      let {canvas,region} = await boot(directory,world);
      const localContext = await select(canvas), operations = structuredClone(captured.operations);
      const body = commit(localContext,{operations,operationDigest:D('region-operations',operations)});
      const before = canonicalJSON([...world.nodes]);
      const response = await region.call('ApplyRegionCommit',body);
      assert.equal(response.result?.status,'ROLLED_BACK',JSON.stringify(response));
      const cause = regionRollbackCauseOf(body,response);
      assert.equal(cause.cause,'REPORTED');assert.equal(cause.failure.error.code,'APPLY_FAILED');
      assert.equal(cause.failure.error.mutationState,expected);
      assert.equal(cause.failure.error.transactionRef,body.transactionId);
      assert.equal(cause.failure.guardRefusal,null);
      assert.equal(observed.response.error,null);assert.equal(observed.response.guardRefusal,null);
      if (mode === 'captured-partial') {
        assert.deepEqual(observed.response.result.chunks.map(c=>c.status),captured.interruptedStatuses);
        assert.notEqual(observed.response.result.chunks[0].readbackDigest,observed.request.writes[0].expectedCurrentDigest);
      }
      assert.equal(canonicalJSON([...world.nodes]),before);
      assert.equal(canonicalJSON(response.result.actualSummary),canonicalJSON(response.result.beforeSummary));
      const calls = world.calls.length, writes = world.writes.length;
      assert.equal(canonicalJSON(await region.call('ApplyRegionCommit',body)),canonicalJSON(response));
      ({canvas,region} = await boot(directory,world));
      assert.equal(canonicalJSON(await region.call('ApplyRegionCommit',body)),canonicalJSON(response));
      assert.equal(world.calls.length,calls);assert.equal(world.writes.length,writes);
      assert.deepEqual(canvas.store.snapshot.pending,{});
    } finally {await rm(directory,{recursive:true,force:true});}
  }
});
