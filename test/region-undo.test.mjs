import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CanvasV5, CanvasStore, CanvasRegionV1, blockDigest, regionChunks,
  REGION_FORMAT, apply as applyCanvas } from '../src/index.mjs';

/*
 * FIXTURE: the Adapter below (world-adapter/v6 connection reads plus the
 * world-adapter-region/v1 chunk port) is an explicit in-memory peer fixture,
 * not the real Luanti Adapter. Canvas, its durable store, its compressed
 * snapshot files and its reopen path are the real component runtime.
 */
const stateProfile = { profileVersion: 'state-profile/v2',
  nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
  inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
const worldRef = 'local-world';
const connection = { connectionRef: 'local-connection', connectionIncarnationRef: 'socket-open-1',
  worldRef, payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
  capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef,
    engineBounds: { min: [-64, -64, -64], max: [64, 64, 64] }, limits: [],
    recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
    sessionDeleteSupported: true, imageMediaTypes: [], model: null } };
const protocol = { name: 'hanaworlds-region', version: '1.0.0',
  requiredCapabilities: ['region-commit', 'region-undo', 'explicit-air-dig'] };
const block = p => p.map(n => Math.floor(n / 16)).join(',');

function fixtureWorld({ adapterProtocol = { name: 'hanaworlds-region', version: '1.2.7' },
  capabilities = ['chunked-read', 'chunked-write', 'load-before-read', 'lighting-complete'] } = {}) {
  const nodes = new Map(); // "x,y,z" -> {nodeName,param2,param1,extraState}
  const loaded = new Set();
  const unloadable = new Set();
  const world = { nodes, loaded, unloadable, writes: [], failWrite: null, failReadAfter: false,
    incarnation: connection.connectionIncarnationRef, calls: [] };
  const ground = p => p[1] < 0 ? { nodeName: 'mcl_core:stone', param2: 0, param1: 0 } :
    { nodeName: 'air', param2: 0, param1: 15 };
  world.get = p => nodes.get(p.join(',')) ?? ground(p);
  world.adapter = { async call(operation, request) {
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
  world.region = { async call(operation, request) {
    world.calls.push(operation);
    const respond = result => ({ contractVersion: 'world-adapter-region/v1',
      requestId: request.requestId, result, error: null });
    if (operation === 'DescribeRegionIO')
      return respond({ protocol: adapterProtocol, capabilities });
    if (operation === 'ReadRegionChunks') {
      if (world.failReadAfter && request.requestId.endsWith(':after'))
        return respond({ worldRef, chunks: [] });
      return respond({ worldRef, chunks: request.chunks.map(chunk => {
        const id = chunk.blockPos.join(',');
        if (!unloadable.has(id)) loaded.add(id); // load-then-read, like emerge + VoxelManip
        if (!loaded.has(id)) return { blockPos: chunk.blockPos, availability: 'UNKNOWN',
          loaded: false, records: null };
        const records = [];
        for (let z = chunk.min[2]; z <= chunk.max[2]; z++)
          for (let y = chunk.min[1]; y <= chunk.max[1]; y++)
            for (let x = chunk.min[0]; x <= chunk.max[0]; x++) {
              const { nodeName, param2, param1, extraState } = world.get([x, y, z]);
              records.push({ nodeName, param2, param1, extraState: extraState === true });
            }
        return { blockPos: chunk.blockPos, availability: 'KNOWN', loaded: true, records };
      }) });
    }
    if (operation === 'WriteRegionChunk') {
      const { chunk } = request;
      assert.equal(chunk.format, REGION_FORMAT);
      world.writes.push({ requestId: request.requestId, blockPos: chunk.blockPos });
      let i = 0, written = 0;
      for (let z = 0; z < chunk.size[2]; z++) for (let y = 0; y < chunk.size[1]; y++)
        for (let x = 0; x < chunk.size[0]; x++) {
          const index = chunk.cells[i++];
          if (index === -1) continue;
          const p = [chunk.origin[0] + x, chunk.origin[1] + y, chunk.origin[2] + z];
          const entry = chunk.palette[index];
          nodes.set(p.join(','), { nodeName: entry.nodeName, param2: entry.param2,
            param1: entry.nodeName === 'air' ? 15 : 0 });
          written++;
          // Inject a failure half-way through a chunk: partial write, then error.
          if (world.failWrite?.(request, written)) {
            world.failWrite = null;
            return { contractVersion: 'world-adapter-region/v1', requestId: request.requestId,
              result: null, error: { code: 'APPLY_FAILED', phase: 'apply',
                retryability: 'AFTER_NEW_FACTS', mutationState: 'UNKNOWN',
                transactionRef: request.transactionId, causeCode: null, reason: 'APPLY_ERROR' } };
          }
        }
      return respond({ blockPos: chunk.blockPos, writtenCells: written, lightingComplete: true });
    }
    throw new Error(`unexpected region operation ${operation}`);
  } };
  return world;
}

async function boot(directory, world) {
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: world.adapter });
  return { canvas, region: new CanvasRegionV1(canvas, world.region) };
}
async function select(canvas) {
  const selected = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v5',
    sessionRef: 'session-1', requestId: 'select-1', worldRef,
    connectionRef: connection.connectionRef, connectionIncarnationRef: connection.connectionIncarnationRef,
    expectedRevision: 'selection-0', expectedContext: null });
  assert.equal(selected.error, null);
  return selected.result.localContext;
}
/** 20x3x4 box crossing two mapblocks on x and two on y: stone platform, air dig, holes left unspecified. */
function terrainBlock() {
  const origin = [8, -2, 0], size = [20, 3, 4];
  const palette = [{ nodeName: 'mcl_core:dirt_with_grass', param2: 0 },
    { nodeName: 'air', param2: 0 }, { nodeName: 'mcl_stairs:stair_stone', param2: 3 }];
  const cells = [];
  for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++)
    for (let x = 0; x < size[0]; x++) {
      if (x % 7 === 3) cells.push(-1); // unspecified: must stay untouched
      else if (y === 0) cells.push(1); // explicit air: digs stone below ground
      else if (y === 1 && z === 0) cells.push(2);
      else cells.push(0);
    }
  return { format: REGION_FORMAT, axisOrder: 'x-y-z', origin, size, palette, cells };
}
const commitBody = (localContext, region, extra = {}) => ({ contractVersion: 'canvas-region/v1',
  sessionRef: 'session-1', requestId: 'region-1', worldRef, localContext,
  transactionId: 'region-tx-1', protocol, region, regionDigest: blockDigest(region),
  expectedWorldRevision: 'world-0', ...extra });
function snapshotOfBox(world, region) {
  const out = [];
  for (let z = 0; z < region.size[2]; z++) for (let y = 0; y < region.size[1]; y++)
    for (let x = 0; x < region.size[0]; x++) {
      const p = [region.origin[0] + x, region.origin[1] + y, region.origin[2] + z];
      out.push([p.join(','), world.get(p).nodeName, world.get(p).param2]);
    }
  return JSON.stringify(out);
}

test('cross-chunk fill and explicit air dig commit once, survive reopen and undo as a whole region',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-'));
    try {
      const world = fixtureWorld();
      const untouched = [3 + 8, -2, 0];
      world.nodes.set(untouched.join(','), { nodeName: 'mcl_core:gold_block', param2: 0, param1: 0 });
      let { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas);
      const tool = await region.call('DescribeRegionTool', { requestId: 'describe-1' });
      assert.match(tool.result.typicalScale, /mapblocks/);
      assert.ok(tool.result.prerequisites.length >= 5);
      assert.equal(tool.result.shapeSource, 'canvas-explicit-fixture');

      const terrain = terrainBlock();
      assert.equal(regionChunks(terrain).length, 4);
      const before = snapshotOfBox(world, terrain);
      const committed = await region.call('ApplyRegionCommit', commitBody(localContext, terrain));
      assert.equal(committed.error, null, JSON.stringify(committed.error));
      const receipt = committed.result;
      assert.equal(receipt.status, 'VERIFIED');
      assert.equal(receipt.chunkCount, 4);
      // one write per chunk, never a repeated chunk write
      assert.equal(world.writes.length, 4);
      assert.equal(new Set(world.writes.map(w => w.blockPos.join(','))).size, 4);
      // dig, fill, param2 and untouched-unspecified are all in the world
      assert.equal(world.get([8, -2, 0]).nodeName, 'air');
      assert.equal(world.get([9, -1, 0]).nodeName, 'mcl_stairs:stair_stone');
      assert.equal(world.get([9, -1, 0]).param2, 3);
      assert.equal(world.get([20, 0, 3]).nodeName, 'mcl_core:dirt_with_grass');
      assert.equal(world.get(untouched).nodeName, 'mcl_core:gold_block');
      assert.equal(world.get([18, -2, 0]).nodeName, 'mcl_core:stone');
      const replay = await region.call('ApplyRegionCommit', commitBody(localContext, terrain));
      assert.deepEqual(replay, committed);
      assert.equal(world.writes.length, 4);

      // compressed durable before-snapshot: gzip, 0600, content addressed
      const snapDir = join(directory, 'region-snapshots');
      const [file] = await readdir(snapDir);
      assert.equal(file, `${receipt.snapshot.compressedSha256}.json.gz`);
      assert.equal((await stat(join(snapDir, file))).mode & 0o777, 0o600);
      const raw = gunzipSync(await readFile(join(snapDir, file)));
      assert.ok(receipt.snapshot.compressedBytes < raw.length);
      const image = JSON.parse(raw);
      assert.equal(image.indexes.length, 240);
      assert.ok(image.palette.some(([name, , light]) => name === 'mcl_core:stone' && light === 0));

      // history row is shared with cell BUILD history; cell Undo refuses a region object
      const history = await canvas.call('HistoryQuery', { contractVersion: 'canvas/v5',
        sessionRef: 'session-1', requestId: 'history-1', worldRef, localContext,
        objectRef: receipt.objectRef, expectedHistoryRevision: null });
      assert.equal(history.error, null, JSON.stringify(history.error));
      assert.equal(history.result.undoAvailable, true);
      const cellUndo = await canvas.call('Undo', { contractVersion: 'canvas/v5',
        sessionRef: 'session-1', requestId: 'cell-undo-1', worldRef, localContext,
        transactionId: 'cell-undo-tx', historyTransactionId: 'region-tx-1',
        objectRef: receipt.objectRef, expectedHistoryRevision: history.result.historyRevision,
        expectedWorldRevision: receipt.observedWorldRevision,
        expectedObjectRevisions: { [receipt.objectRef]:
          canvas.store.snapshot.objects[worldRef][receipt.objectRef].objectRevision },
        intentDigest: '7'.repeat(64), surfaceActionDigest: '8'.repeat(64) });
      assert.equal(cellUndo.error?.code, 'UNDO_CONFLICT');

      // normal reopen: a fresh Canvas over the same durable directory
      ({ canvas, region } = await boot(directory, world));
      const object = canvas.store.snapshot.objects[worldRef][receipt.objectRef];
      const footprint = await canvas.readFootprints(worldRef, [receipt.objectRef],
        { sessionRef: 'session-1', worldRef, localContext });
      assert.equal(footprint.objects[0].positions.length, terrain.cells.filter(c => c !== -1).length);
      const undoBody = { contractVersion: 'canvas-region/v1', sessionRef: 'session-1',
        requestId: 'region-undo-1', worldRef, localContext, transactionId: 'region-undo-tx-1',
        protocol, historyTransactionId: 'region-tx-1', objectRef: receipt.objectRef,
        expectedHistoryRevision: history.result.historyRevision,
        expectedWorldRevision: receipt.observedWorldRevision,
        expectedObjectRevision: object.objectRevision };
      const undone = await region.call('UndoRegion', undoBody);
      assert.equal(undone.error, null, JSON.stringify(undone.error));
      assert.equal(undone.result.status, 'VERIFIED');
      assert.equal(snapshotOfBox(world, terrain), before);
      assert.equal(world.get(untouched).nodeName, 'mcl_core:gold_block');
      assert.equal(world.writes.length, 8);
      const again = await region.call('UndoRegion', { ...undoBody, requestId: 'region-undo-2',
        transactionId: 'region-undo-tx-2' });
      assert.equal(again.error?.code, 'UNDO_CONFLICT');
      const reopened = await boot(directory, world);
      assert.equal(reopened.canvas.store.snapshot.history[receipt.objectRef].length, 2);
      assert.deepEqual(reopened.canvas.store.snapshot.footprints[worldRef][receipt.objectRef].positions, []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('failure in a later chunk rolls the whole region back with no residue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-region-fail-'));
  try {
    const world = fixtureWorld();
    const { canvas, region } = await boot(directory, world);
    const localContext = await select(canvas);
    const terrain = terrainBlock();
    const before = snapshotOfBox(world, terrain);
    // third chunk fails after 5 of its cells were actually written
    world.failWrite = (request, written) => request.requestId.includes(':apply:') &&
      world.writes.length === 3 && written === 5;
    const result = await region.call('ApplyRegionCommit', commitBody(localContext, terrain));
    assert.equal(result.error, null, JSON.stringify(result.error));
    assert.equal(result.result.status, 'ROLLED_BACK');
    assert.equal(result.result.restoreStatus, 'VERIFIED_RESTORED');
    assert.equal(result.result.causeCode, 'APPLY_FAILED');
    assert.equal(snapshotOfBox(world, terrain), before);
    // restore touched only the three started chunks, the fourth was never written
    const restores = world.writes.filter(w => w.requestId.includes(':restore:'));
    assert.equal(restores.length, 3);
    const state = canvas.store.snapshot;
    assert.deepEqual(state.pending, {});
    assert.deepEqual(state.objects[worldRef] ?? {}, {});
    assert.equal(state.worldRevisions[worldRef], 'world-0');

    // readback mismatch after all writes also rolls back as a whole
    world.failReadAfter = true;
    const second = await region.call('ApplyRegionCommit', commitBody(localContext, terrain,
      { requestId: 'region-2', transactionId: 'region-tx-2' }));
    assert.equal(second.result.status, 'ROLLED_BACK');
    assert.equal(second.result.causeCode, 'TARGET_FACTS_INCOMPLETE');
    assert.equal(snapshotOfBox(world, terrain), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restore failure stays durably pending and normal reopen recovers from the snapshot',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-recover-'));
    try {
      const world = fixtureWorld();
      let { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas);
      const terrain = terrainBlock();
      const before = snapshotOfBox(world, terrain);
      world.failWrite = (request, written) => request.requestId.includes(':apply:') &&
        world.writes.length === 2 && written === 3;
      const brokenRestore = world.region.call;
      world.region.call = async (operation, request) => {
        if (operation === 'WriteRegionChunk' && request.requestId.includes(':restore:'))
          throw new Error('transport lost');
        return brokenRestore(operation, request);
      };
      const result = await region.call('ApplyRegionCommit', commitBody(localContext, terrain));
      assert.equal(result.error.code, 'RECOVERY_PENDING');
      assert.equal(result.error.mutationState, 'UNKNOWN');
      assert.notEqual(snapshotOfBox(world, terrain), before);
      world.region.call = brokenRestore;
      ({ canvas, region } = await boot(directory, world));
      assert.equal(canvas.store.snapshot.pending['region-tx-1'].phase, 'RESTORE_PENDING');
      const blocked = await region.call('ApplyRegionCommit', commitBody(localContext, terrain,
        { requestId: 'region-while-pending', transactionId: 'region-tx-9' }));
      assert.equal(blocked.error.code, 'TRANSACTION_CONFLICT');
      assert.deepEqual(await region.recoverPending(),
        [{ transactionId: 'region-tx-1', status: 'ROLLED_BACK' }]);
      assert.equal(snapshotOfBox(world, terrain), before);
      assert.deepEqual(canvas.store.snapshot.pending, {});
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('unknown, wrong world, footprint conflict, external edit and metadata reject before writes',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-region-reject-'));
    try {
      const world = fixtureWorld();
      const { canvas, region } = await boot(directory, world);
      const localContext = await select(canvas);
      const terrain = terrainBlock();
      const body = extra => commitBody(localContext, terrain, extra);

      world.unloadable.add('1,0,0');
      const unknown = await region.call('ApplyRegionCommit', body({ requestId: 'r-unknown' }));
      assert.equal(unknown.error.code, 'TARGET_FACTS_INCOMPLETE');
      world.unloadable.clear();

      const wrongWorld = await region.call('ApplyRegionCommit', body({ requestId: 'r-world',
        worldRef: 'other-world' }));
      assert.equal(wrongWorld.error.code, 'CURRENT_WORLD_MISMATCH');
      world.incarnation = 'socket-open-2';
      const wrongConnection = await region.call('ApplyRegionCommit', body({ requestId: 'r-conn' }));
      assert.equal(wrongConnection.error.code, 'CURRENT_WORLD_MISMATCH');
      world.incarnation = connection.connectionIncarnationRef;

      const stale = await region.call('ApplyRegionCommit', body({ requestId: 'r-stale',
        expectedWorldRevision: 'world-9' }));
      assert.equal(stale.error.code, 'STALE_REVISION');
      const digest = await region.call('ApplyRegionCommit', body({ requestId: 'r-digest',
        regionDigest: '0'.repeat(64) }));
      assert.equal(digest.error.code, 'MEDIA_DIGEST_MISMATCH');
      const noOp = await region.call('ApplyRegionCommit', commitBody(localContext,
        { ...terrain, cells: terrain.cells.map(() => -1) }, { requestId: 'r-empty' }));
      assert.equal(noOp.error.code, 'BUILD_INVALID');

      world.nodes.set('9,0,1', { nodeName: 'mcl_chests:chest', param2: 0, param1: 0,
        extraState: true });
      const meta = await region.call('ApplyRegionCommit', body({ requestId: 'r-meta' }));
      assert.equal(meta.error.code, 'UNSUPPORTED_MUTATION_SEMANTICS');
      world.nodes.delete('9,0,1');
      assert.equal(world.writes.length, 0);

      // a registered region footprint blocks an overlapping second region
      const first = await region.call('ApplyRegionCommit', body({ requestId: 'r-first' }));
      assert.equal(first.result.status, 'VERIFIED');
      const overlap = await region.call('ApplyRegionCommit', body({ requestId: 'r-overlap',
        transactionId: 'region-tx-2', expectedWorldRevision: first.result.observedWorldRevision }));
      assert.equal(overlap.error.code, 'OTHER_OBJECTS_AFFECTED');

      // an external edit inside the written cells makes whole Undo refuse to overwrite
      world.nodes.set('9,0,0', { nodeName: 'mcl_core:glass', param2: 0, param1: 0 });
      const object = canvas.store.snapshot.objects[worldRef][first.result.objectRef];
      const undoBody = { contractVersion: 'canvas-region/v1', sessionRef: 'session-1',
        requestId: 'u-1', worldRef, localContext, transactionId: 'undo-tx-1', protocol,
        historyTransactionId: 'region-tx-1', objectRef: first.result.objectRef,
        expectedHistoryRevision: canvas.store.snapshot.history[first.result.objectRef][0].historyRevision,
        expectedWorldRevision: first.result.observedWorldRevision,
        expectedObjectRevision: object.objectRevision };
      const writesBefore = world.writes.length;
      const edited = await region.call('UndoRegion', undoBody);
      assert.equal(edited.error.code, 'READBACK_MISMATCH');
      assert.equal(world.writes.length, writesBefore);
      world.nodes.set('9,0,0', { nodeName: 'mcl_core:dirt_with_grass', param2: 0, param1: 0 });
      const wrongWorldUndo = await region.call('UndoRegion', { ...undoBody, requestId: 'u-2',
        worldRef: 'other-world' });
      assert.equal(wrongWorldUndo.error.code, 'CURRENT_WORLD_MISMATCH');
      const staleUndo = await region.call('UndoRegion', { ...undoBody, requestId: 'u-3',
        expectedWorldRevision: 'world-0' });
      assert.equal(staleUndo.error.code, 'STALE_REVISION');
      const ok = await region.call('UndoRegion', { ...undoBody, requestId: 'u-4',
        transactionId: 'undo-tx-4' });
      assert.equal(ok.error, null, JSON.stringify(ok.error));
      // exact replay returns the stored answer; same requestId with another body is refused
      const writesAfterUndo = world.writes.length;
      assert.deepEqual(await region.call('UndoRegion', { ...undoBody, requestId: 'u-4',
        transactionId: 'undo-tx-4' }), ok);
      const conflict = await region.call('UndoRegion', { ...undoBody, requestId: 'u-4',
        transactionId: 'undo-tx-5' });
      assert.equal(conflict.error.code, 'REPLAY_MISMATCH');
      assert.equal(world.writes.length, writesAfterUndo);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('protocol major and required capabilities decide compatibility, not patch or hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-region-proto-'));
  try {
    const world = fixtureWorld();
    const { canvas, region } = await boot(directory, world);
    const localContext = await select(canvas);
    const terrain = terrainBlock();
    const run = async (extra, adapterWorld = world) => {
      const r = new CanvasRegionV1(canvas, adapterWorld.region);
      return r.call('ApplyRegionCommit', commitBody(localContext, terrain,
        { requestId: `p-${Math.random()}`, ...extra }));
    };
    for (const version of ['2.0.0', '0.9.0', '1.0', 'v1.0.0'])
      assert.equal((await run({ protocol: { ...protocol, version } })).error.code,
        'UNSUPPORTED_VERSION', version);
    const missing = await run({ protocol: { ...protocol,
      requiredCapabilities: ['region-commit', 'region-teleport'] } });
    assert.equal(missing.error.code, 'CAPABILITY_UNAVAILABLE');
    assert.deepEqual(missing.missingCapabilities, ['region-teleport']);
    const wrongMajorAdapter = fixtureWorld({ adapterProtocol: { name: 'hanaworlds-region',
      version: '2.0.0' } });
    wrongMajorAdapter.nodes = world.nodes;
    assert.equal((await run({}, wrongMajorAdapter)).error.code, 'UNSUPPORTED_VERSION');
    const noLight = fixtureWorld({ capabilities: ['chunked-read', 'chunked-write',
      'load-before-read'] });
    const lacking = await run({}, noLight);
    assert.equal(lacking.error.code, 'CAPABILITY_UNAVAILABLE');
    assert.deepEqual(lacking.missingCapabilities, ['lighting-complete']);
    assert.equal(world.writes.length + wrongMajorAdapter.writes.length + noLight.writes.length, 0);
    // a later 1.x minor/patch on either side is accepted
    const ok = await run({ protocol: { ...protocol, version: '1.4.2' } });
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    assert.equal(ok.result.status, 'VERIFIED');
    assert.equal(canvas.status().version, '0.4.0');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host provides the region port beside canvas/v5', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-region-host-'));
  try {
    const ports = new Map();
    const ctx = { get: name => name === 'dshHomePath' ? (...p) => join(directory, ...p) : null,
      provide: (name, port) => ports.set(name, port) };
    const canvas = applyCanvas(ctx);
    await canvas.ready;
    const tool = await ports.get('hanaworldsCanvasRegionV1').call('DescribeRegionTool',
      { requestId: 'd' });
    assert.deepEqual(tool.result.operations, ['ApplyRegionCommit', 'UndoRegion']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
