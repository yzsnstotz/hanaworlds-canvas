import { open, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { digestValue, encodeRegionBlock, expandRegionBlock, regionChunksOfBox, guardRefusalError }
  from 'hanaworlds-contracts';
import { fixtureEngineGuards, guardSlot } from '../../scripts/fixture-engine-guards.mjs';

// Explicit, isolated fixture world for the /undo development page. Only the world and
// its Adapter are fixtures: Canvas decides, verifies, reads back and stores every
// transaction. The world file is durable so Canvas history and world cells agree
// across a normal service restart. It is never a real world.
export const undoSessionRef = 'undo-fixture-session';
export const undoWorldRef = 'undo-fixture-world';
const D = (kind, value) => digestValue(kind, value).sha256;
export const undoStateProfile = { profileVersion: 'state-profile/v3', derivedFields: ['light'], preservedFields: ['inventory', 'metadata', 'timer'], clearedFields: [] };
export const undoConnection = { connectionRef:'undo-fixture-connection', connectionIncarnationRef:'undo-fixture-incarnation',
  worldRef:undoWorldRef, payloadVersion:'local-world/v1', payloadDigest:'1'.repeat(64), capabilities:{ providerRef:'undo-fixture-adapter',
    capabilityRevision:'undo-fixture-cap-1', worldRef:undoWorldRef, engineBounds:{min:[-64,-64,-64],max:[64,64,64]}, limits:[],
    worldGeometry: { profileVersion: 'world-geometry/v1', geometryProfiles: ['voxel-grid/v1'], partition: { edge: [16, 16, 16] }, postWriteLighting: 'REQUIRED' }, recoveryGuarantee:'RECOVERABLE_VERIFIED', stateProfile:undoStateProfile, sessionDeleteSupported:true, imageMediaTypes:[], model:null,
    engineGuards: fixtureEngineGuards() } };
const key = p => p.join(',');
const fresh = () => ({ profileVersion:'undo-fixture-world/v1', worldRef:undoWorldRef, revisionCounter:0, nodes:{}, images:{} });

async function durableWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force:true }); throw error; }
}

/** Opens (or with create:true, starts) the isolated fixture world file. */
export async function openUndoFixtureWorld(file, { create = false } = {}) {
  let world;
  try { world = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    world = fresh(); await durableWrite(file, world);
  }
  if (world.profileVersion !== 'undo-fixture-world/v1' || world.worldRef !== undoWorldRef)
    throw new Error('UNDO_FIXTURE_WORLD_UNSUPPORTED');
  let chain = Promise.resolve();
  const save = () => (chain = chain.then(() => durableWrite(file, world)));
  const prepared = new Set();
  const record = p => world.nodes[key(p)] ?? { position:p, geometryProfile:'voxel-grid/v1', materialRef:'air',  orientation:0, state:{ inventory:{}, metadata:{}, timer:null } };
  const put = r => { if (r.materialRef === 'air') delete world.nodes[key(r.position)]; else world.nodes[key(r.position)] = r; };
  const projection = positions => ({ worldRef:undoWorldRef, coveredPositions:positions, records:positions.map(record), stateProfile:undoStateProfile });
  const nextRevision = () => `undo-fixture-world-${++world.revisionCounter}`;
  const boxPositions = box => {
    const result = [];
    for (let z=box.min[2];z<=box.max[2];z++) for (let y=box.min[1];y<=box.max[1];y++)
      for (let x=box.min[0];x<=box.max[0];x++) result.push([x,y,z]);
    return result;
  };
  const regionState = box => {
    const palette = [], seen = new Map();
    const indices = Int32Array.from(boxPositions(box), p => {
      const r = record(p); const id = `${r.materialRef}\0${r.orientation}`;
      if (!seen.has(id)) { seen.set(id,palette.length); palette.push({materialRef:r.materialRef,orientation:r.orientation}); }
      return seen.get(id);
    });
    return { profileVersion:'region-state/v2', worldRef:undoWorldRef, block:encodeRegionBlock({origin:box.min,
      size:box.max.map((v,a)=>v-box.min[a]+1), palette, indices}), extras:[], stateProfile:undoStateProfile };
  };
  const env = { file, readWorldRevision:null, calls:[] };
  env.readCells = positions => structuredClone(positions.map(record));
  env.nativeFacts = { async readScopedState(ref, positions) {
    if (ref !== undoConnection.connectionRef) throw new Error('FIXTURE_CONNECTION_MISMATCH');
    return { worldRef:undoWorldRef, stateProfile:undoStateProfile, cells:positions.map(p => ({ position:p, availability:'KNOWN',
      stateDigest:createHash('sha256').update('HanaWorlds|contracts@0.4.0|adapter-scoped-cell/v1\n')
        .update(canonicalize({ profile:undoStateProfile, record:record(p) })).digest('hex') })) };
  } };
  // FIXTURE per-cell port handshake: what a G3 Adapter advertises on world-adapter/v8.
  env.adapter = { protocolHandshake:{ profileVersion:'protocol-handshake/v1', component:'undo-fixture-adapter',
    protocols:[{ protocol:'world-adapter', major:8, minor:0 }],
    capabilities:['world-adapter/v8:callback-free-write','world-adapter/v8:write-path-state-facts'].sort(),
    provenance:{ packageName:'undo-fixture-adapter', packageVersion:'1.0.0', sourceRevision:null, artifactDigest:null } },
    async call(operation, request) {
    env.calls.push({ port:'world-adapter/v8', operation, transactionId:request.transactionId ?? null });
    const answer = result => guardSlot('world-adapter/v8', operation, { contractVersion: 'world-adapter/v8', requestId:request.requestId, result, error:null });
    const refuse = (code, reason) => ({ contractVersion:'world-adapter/v8', requestId:request.requestId, result:null,
      error:{ code, phase:'validate', retryability:'AFTER_NEW_FACTS', mutationState:'NONE', transactionRef:null, causeCode:null, reason } });
    if (operation === 'DiscoverConnections') return answer({ capabilityRevision:'undo-fixture-cap-1', connections:[{
      adapterId:'hanaworlds-world-adapter', connectionRef:undoConnection.connectionRef, worldRef:undoWorldRef,
      displayName:'隔离示例世界（撤回与重做）', capabilityRevision:'undo-fixture-cap-1', payloadVersion:undoConnection.payloadVersion,
      readiness:'READY', connectionIncarnationRef:undoConnection.connectionIncarnationRef }] });
    // env.refuse = { operation, refusal } (FIXTURE): that operation is refused by an engine guard
    // with the Contracts error beside the GuardRefusal, and writes nothing.
    if (env.refuse?.operation === operation)
      return { contractVersion:'world-adapter/v8', requestId:request.requestId, result:null,
        error:guardRefusalError(env.refuse.refusal, { transactionRef:request.transactionId ?? null }),
        guardRefusal:env.refuse.refusal };
    // env.engineGuards (FIXTURE) replaces the declared engine guards when a test sets it.
    if (operation === 'ReadLocalConnection') return answer(env.engineGuards === undefined ? undoConnection :
      { ...undoConnection, capabilities: { ...undoConnection.capabilities, engineGuards: env.engineGuards } });
    if (operation === 'Readback') {
      if (!prepared.has(request.transactionId) && !world.images[request.transactionId]) throw new Error('FIXTURE_UNPREPARED_READ');
      const p = projection(request.coveredPositions);
      return answer({ projection:p, readbackDigest:D('readback', p), adapterExecutionRevision:`undo-fixture-read-${world.revisionCounter}` });
    }
    if (operation === 'PrepareRecoverableTransaction') {
      prepared.add(request.transactionId);
      const positions = request.scope.checkedPositions;
      world.images[request.transactionId] = { positions, before:positions.map(record), after:null };
      await save();
      const payload = { contractVersion:'world-adapter/v8', transactionId:request.transactionId, worldRef:undoWorldRef,
        operationDigest:request.operationDigest, scopeDigest:request.scopeDigest, beforeImageDigest:D('readback', projection(positions)),
        localContext:request.localContext };
      return answer({ payload, transactionPayloadDigest:D('scoped-transaction-payload', payload), beforeImageDigest:payload.beforeImageDigest,
        scopeDigest:request.scopeDigest, guarantee:'RECOVERABLE_VERIFIED', stateProfile:undoStateProfile,
        adapterExecutionRevision:`undo-fixture-prepare-${world.revisionCounter}`, beforeStateReadbackDigest:D('readback', projection(positions)) });
    }
    if (operation === 'ApplyCompiledTransaction') {
      const previousWorldRevision = await env.readWorldRevision();
      for (const effect of request.operations.effects) put({ ...record(effect.position), materialRef:effect.materialRef, orientation:effect.orientation });
      const image = world.images[request.transactionId];
      image.after = image.positions.map(record);
      const observedWorldRevision = nextRevision();
      await save();
      return answer({ contractVersion:'canvas/v7', transactionId:request.transactionId, operationDigest:request.operationDigest,
        transactionPayloadDigest:request.preparedTransaction.transactionPayloadDigest, status:'VERIFIED', previousWorldRevision,
        observedWorldRevision, readbackDigest:D('readback', projection(image.positions)), restoreStatus:'NOT_REQUIRED', error:null,guardRefusal:null,applyFailure:null,
        localContext:request.localContext });
    }
    if (operation === 'RestoreTransaction') {
      const image = world.images[request.originTransactionId];
      if (!image) throw new Error('FIXTURE_UNKNOWN_RESTORE');
      const previousWorldRevision = await env.readWorldRevision();
      image.before.forEach(put);
      const observedWorldRevision = nextRevision();
      await save();
      return answer({ contractVersion:'canvas/v7', transactionId:request.originTransactionId, operationDigest:request.operationDigest,
        transactionPayloadDigest:'5'.repeat(64), status:'ROLLED_BACK', previousWorldRevision, observedWorldRevision,
        readbackDigest:D('readback', projection(image.positions)), restoreStatus:'VERIFIED_RESTORED', error:null,guardRefusal:null,applyFailure:null, localContext:request.localContext });
    }
    if (operation === 'PrepareHistoryTransaction') {
      const origin = world.images[request.originTransactionId];
      if (!origin?.after) return refuse(request.direction === 'REDO' ? 'REDO_CONFLICT' : 'UNDO_CONFLICT', 'REQUIRED_FACT_UNKNOWN');
      const target = request.direction === 'UNDO' ? origin.before : origin.after;
      const p = projection(origin.positions);
      // The fixture world checks Canvas's digests against its own cells before preparing.
      if (D('readback', p) !== request.expectedCurrentStateDigest ||
          D('readback', { ...p, records:target }) !== request.targetStateDigest)
        return refuse(request.direction === 'REDO' ? 'REDO_CONFLICT' : 'UNDO_CONFLICT', 'EXTERNAL_EDIT_CONFLICT');
      prepared.add(request.transactionId);
      world.images[request.transactionId] = { positions:origin.positions, before:p.records, after:null, target,
        direction:request.direction, originTransactionId:request.originTransactionId };
      await save();
      return answer({ originTransactionId:request.originTransactionId, transactionId:request.transactionId, direction:request.direction,
        historyOperationDigest:request.historyOperationDigest, transactionPayloadDigest:createHash('sha256').update(`undo-fixture-history|${request.historyOperationDigest}`).digest('hex'),
        beforeImageDigest:D('readback', p), targetStateDigest:request.targetStateDigest, stateProfile:undoStateProfile,
        adapterExecutionRevision:`undo-fixture-prepare-${world.revisionCounter}`, guarantee:'RECOVERABLE_VERIFIED', status:'PREPARED',
        localContext:request.localContext });
    }
    if (operation === 'ApplyHistoryTransaction') {
      const image = world.images[request.transactionId];
      if (!image?.target) throw new Error('FIXTURE_UNPREPARED_HISTORY');
      image.target.forEach(put);
      image.after = image.positions.map(record);
      const observedWorldRevision = nextRevision();
      await save();
      return answer({ contractVersion:'canvas/v7', transactionId:request.transactionId, operationDigest:request.historyOperationDigest,
        transactionPayloadDigest:request.preparedHistoryTransaction.transactionPayloadDigest, status:'VERIFIED',
        previousWorldRevision:await env.readWorldRevision(), observedWorldRevision,
        readbackDigest:D('readback', projection(image.positions)), restoreStatus:'NOT_REQUIRED', error:null,guardRefusal:null,applyFailure:null, localContext:request.localContext });
    }
    throw new Error(`FIXTURE_UNSUPPORTED_CELL_OPERATION:${operation}`);
  } };
  env.regionAdapter = { protocolHandshake:{ profileVersion:'protocol-handshake/v1', component:'undo-fixture-adapter',
    protocols:[{ protocol:'world-adapter-region', major:3, minor:0 }], capabilities:[
      'world-adapter-region/v3:callback-free-write',
      'world-adapter-region/v3:chunked-read','world-adapter-region/v3:chunked-write','world-adapter-region/v3:lighting-complete',
      'world-adapter-region/v3:load-then-know','world-adapter-region/v3:restore-state'].sort(),
    provenance:{ packageName:'undo-fixture-adapter', packageVersion:'1.0.0', sourceRevision:null, artifactDigest:null } },
    async call(operation, request) {
      env.calls.push({ port:'world-adapter-region/v3', operation, transactionId:request.transactionId ?? null });
      const answer = result => guardSlot('world-adapter-region/v3', operation, { contractVersion: 'world-adapter-region/v3', requestId:request.requestId, result, error:null });
      if (operation === 'ReadRegion') return answer({ worldRef:undoWorldRef, box:request.box, partition:request.partition, localContext:request.localContext,
        chunks:regionChunksOfBox(request.box, request.partition).map(({ chunkPos, box }) => {
          const state = regionState(box);
          return { chunkPos, box, availability:'KNOWN', loadMethod:'ALREADY_LOADED', unknownReason:null, state, stateDigest:D('region-state', state) };
        }) });
      if (operation === 'WriteRegion') {
        const boxes = [];
        const chunks = request.writes.map(w => {
          const { box, indices, palette } = expandRegionBlock(w.ops ?? w.state.block);
          boxes.push(box);
          if (D('region-state', regionState(box)) !== w.expectedCurrentDigest) throw new Error('FIXTURE_REGION_DIGEST_MISMATCH');
          boxPositions(box).forEach((p, i) => { if (indices[i] !== -1)
            put({ ...record(p), materialRef:palette[indices[i]].materialRef, orientation:palette[indices[i]].orientation }); });
          return { chunkPos:w.chunkPos, status:'WRITTEN', readbackDigest:D('region-state', regionState(box)) };
        });
        world.revisionCounter++;
        await save();
        const box = { min:[0,1,2].map(a => Math.min(...boxes.map(b => b.min[a]))), max:[0,1,2].map(a => Math.max(...boxes.map(b => b.max[a]))) };
        return answer({ transactionId:request.transactionId, worldRef:undoWorldRef, purpose:request.purpose, chunks, postWriteLighting:'REQUIRED',
          lighting:{ status:'COMPLETE', box, method:'fixture:in-memory-relight' }, localContext:request.localContext });
      }
      throw new Error(`FIXTURE_UNSUPPORTED_REGION_OPERATION:${operation}`);
    } };
  env.flush = () => chain;
  return env;
}
