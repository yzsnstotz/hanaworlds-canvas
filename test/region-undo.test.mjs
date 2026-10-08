import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { canonicalJSON, checkProtocolCompatibility, comparePosition, contractHandshake, digestValue,
  encodeRegionBlock, expandRegionBlock, protocolRequirement, regionChunksOfBox,
  validateRegionSnapshotContent } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, CanvasRegionV1, canvasProtocolHandshake,
  ADAPTER_REGION_REQUIREMENT, ADAPTER_CELL_REQUIREMENT, apply as applyCanvas } from '../src/index.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';

/*
 * FIXTURE: the Adapter below (world-adapter/v6 connection reads plus a
 * world-adapter-region/v1 ReadRegion/WriteRegion port and its ProtocolHandshake)
 * is an explicit in-memory peer fixture built from the public Contracts 0.5.0
 * shapes, not the real Luanti Adapter. Its two ProtocolHandshakes advertise what a
 * G3 Adapter publishes (Contracts 0.5.1+): world-adapter-region 1.1 with its six
 * region capabilities on the region port, world-adapter 6.1 with callback-free-write
 * and write-path-state-facts on the per-cell port. Brush compilation is likewise a test
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
    sessionDeleteSupported: true, imageMediaTypes: [], model: null } });
const connection = connectionOf(WORLD);
const ADAPTER_CAPS = ['world-adapter-region/v1:callback-free-write',
  'world-adapter-region/v1:chunked-read', 'world-adapter-region/v1:chunked-write',
  'world-adapter-region/v1:lighting-complete', 'world-adapter-region/v1:load-then-know',
  'world-adapter-region/v1:restore-state'];
const CELL_CAPS = ['world-adapter/v6:callback-free-write', 'world-adapter/v6:write-path-state-facts'];
const handshake = (major = 1, minor = 1, capabilities = ADAPTER_CAPS, version = '0.4.9',
  protocol = 'world-adapter-region') => ({
  profileVersion: 'protocol-handshake/v1', component: 'fixture-adapter',
  protocols: [{ protocol, major, minor }], capabilities,
  provenance: { packageName: 'fixture-adapter', packageVersion: version,
    sourceRevision: null, artifactDigest: null } });
const cellHandshake = (major = 6, minor = 1, capabilities = CELL_CAPS) =>
  handshake(major, minor, capabilities, '0.4.9', 'world-adapter');
const k = p => p.join(',');

function fixtureWorld({ protocolHandshake = handshake(), worldRef = WORLD } = {}) {
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
    const respond = result => ({ contractVersion: 'world-adapter/v6',
      requestId: request.requestId, result, error: null });
    if (operation === 'DiscoverConnections') return respond({ capabilityRevision: 'cap-1',
      connections: [{ adapterId: 'hanaworlds-world-adapter', connectionRef: connection.connectionRef,
        worldRef, displayName: 'Fixture local world', capabilityRevision: 'cap-1',
        payloadVersion: connection.payloadVersion, readiness: 'READY',
        connectionIncarnationRef: world.incarnation }] });
    if (operation === 'ReadLocalConnection')
      return respond({ ...connection, connectionIncarnationRef: world.incarnation });
    throw new Error(`unexpected v6 operation ${operation}`);
  } };
  world.region = { protocolHandshake, async call(operation, request) {
    world.calls.push(`${operation}:${request.purpose}`);
    const respond = result => ({ contractVersion: 'world-adapter-region/v1',
      requestId: request.requestId, result, error: null });
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
  const context = await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v5',
    sessionRef: 'session-1', requestId: 'context-1', worldRef: selectedWorld });
  assert.equal(context.result.selection.status, 'UNBOUND');
  const selected = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v5',
    sessionRef: 'session-1', requestId: 'select-1', worldRef: selectedWorld,
    connectionRef: connection.connectionRef,
    connectionIncarnationRef: connection.connectionIncarnationRef,
    expectedRevision: context.result.selection.sessionRevision, expectedContext: null });
  assert.equal(selected.error, null);
  return selected.result.localContext;
}
const commit = (localContext, compiled, extra = {}) => ({ contractVersion: 'canvas-region/v1',
  sessionRef: 'session-1', requestId: 'region-1', worldRef, transactionId: 'region-tx-1',
  ...compiled, guarantee: 'RECOVERABLE_VERIFIED', localContext, ...extra });
const undo = (localContext, historyRevision, extra = {}) => ({ contractVersion: 'canvas-region/v1',
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
      const history = await canvas.call('HistoryQuery', { contractVersion: 'canvas/v5',
        sessionRef: 'session-1', requestId: 'history-1', worldRef, localContext, objectRef,
        expectedHistoryRevision: null });
      assert.equal(history.error, null, JSON.stringify(history.error));
      assert.equal(history.result.historyRevision, result.historyRevision);
      const cellUndo = await canvas.call('Undo', { contractVersion: 'canvas/v5',
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
      const blocked = await region.call('ApplyRegionCommit', commit(localContext, terrain(),
        { requestId: 'region-9', transactionId: 'region-tx-9' }));
      assert.equal(blocked.error.code, 'TRANSACTION_CONFLICT');
      assert.deepEqual(await region.recoverPending(),
        [{ transactionId: 'region-tx-1', status: 'ROLLED_BACK' }]);
      assert.equal(picture(world), before);
      assert.deepEqual(canvas.store.snapshot.pending, {});
    } finally { await rm(directory, { recursive: true, force: true }); }
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
      assert.equal((await run(handshake(2))).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await run(undefined)).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await run(contractHandshake)).error.code, 'UNSUPPORTED_VERSION');
      const lacking = await run(handshake(1, 1, ADAPTER_CAPS.filter(c => !c.endsWith('restore-state'))));
      assert.equal(lacking.error.code, 'CAPABILITY_UNAVAILABLE');
      // G3 write-path scope: region port needs callback-free-write at the declared minor,
      // the per-cell port needs its own two ids; v6 ids are never asked of the region port.
      const regionG3 = ADAPTER_REGION_REQUIREMENT.capabilities.includes(
        'world-adapter-region/v1:callback-free-write');
      if (regionG3) {
        assert.equal((await run(handshake(1, 1, ADAPTER_CAPS.filter(c =>
          !c.endsWith('callback-free-write'))))).error.code, 'CAPABILITY_UNAVAILABLE');
        assert.equal((await run(handshake(1, 0))).error.code, 'UNSUPPORTED_VERSION');
      }
      assert.deepEqual(ADAPTER_REGION_REQUIREMENT.capabilities.filter(c =>
        !c.startsWith('world-adapter-region/v1:')), []);
      assert.deepEqual(ADAPTER_CELL_REQUIREMENT.capabilities.filter(c =>
        !c.startsWith('world-adapter/v6:')), []);
      const cellPort = canvas.adapter;
      const runCell = async protocolHandshake => {
        canvas.adapter = { ...cellPort, protocolHandshake };
        try { return await run(handshake()); } finally { canvas.adapter = cellPort; }
      };
      assert.equal((await runCell(undefined)).error.code, 'UNSUPPORTED_VERSION');
      assert.equal((await runCell(cellHandshake(5))).error.code, 'UNSUPPORTED_VERSION');
      if (ADAPTER_CELL_REQUIREMENT.capabilities.length) {
        assert.equal((await runCell(cellHandshake(6, 1, CELL_CAPS.filter(c =>
          !c.endsWith('write-path-state-facts'))))).error.code, 'CAPABILITY_UNAVAILABLE');
        assert.equal((await runCell(cellHandshake(6, 0))).error.code, 'UNSUPPORTED_VERSION');
      }
      assert.equal((await run(handshake(), { contractVersion: 'canvas-region/v2' })).error.code,
        'UNSUPPORTED_VERSION');
      assert.equal(world.writes.length, 0);
      const ok = await run(handshake(1, 3, ADAPTER_CAPS, '0.9.7-other-patch'));
      assert.equal(ok.error, null, JSON.stringify(ok.error));
      assert.equal(ok.result.status, 'VERIFIED');

      // Canvas's own handshake for its consumers
      const requirement = protocolRequirement('canvas-region/v1', ['canvas-region/v1:compressed-before-snapshot',
        'canvas-region/v1:rollback-on-failure', 'canvas-region/v1:single-logical-transaction',
        'canvas-region/v1:whole-region-undo']);
      assert.equal(checkProtocolCompatibility(canvasProtocolHandshake, [requirement]).result,
        'PROTOCOL_COMPATIBLE');
      assert.throws(() => checkProtocolCompatibility(canvasProtocolHandshake,
        [protocolRequirement('canvas-region/v2')]), e => e.code === 'UNSUPPORTED_VERSION');
      assert.equal(canvas.status().version, '0.6.8');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('host provides the region port, its handshake and tool description beside canvas/v5',
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
