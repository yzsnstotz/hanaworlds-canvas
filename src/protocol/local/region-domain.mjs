// region-voxels/v2 declarative domain rules. Pure: no digest, world, compression
// or transaction logic. Called from validateDomain after the closed shape check.
import { requireFact } from '../errors.mjs';
import { compareUTF16 } from '../geometry.mjs';
const shape = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_SHAPE');
const geometry = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const comparePalette = (a, b) => compareUTF16(a.materialRef, b.materialRef) || (a.orientation - b.orientation);
/** Inclusive cell box of a block; BigInt guards the max corner against overflow. */
export function blockBox(block) {
  const max = block.origin.map((o, a) => BigInt(o) + BigInt(block.size[a]) - 1n);
  geometry(max.every(v => v <= BigInt(Number.MAX_SAFE_INTEGER)));
  return { min: [...block.origin], max: max.map(Number) };
}
export function blockCellCount(block) {
  const n = block.size.reduce((acc, s) => acc * BigInt(s), 1n);
  geometry(n <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(n);
}
// The partition is the world source's declaration (Partition.edge per axis), never a constant here.
export const floorDiv = (v, edge) => Math.floor(v / edge);
export const chunkOfPosition = (p, partition) => p.map((v, a) => floorDiv(v, partition.edge[a]));
export const chunkBox = (c, partition) => ({ min: c.map((v, a) => v * partition.edge[a]), max: c.map((v, a) => v * partition.edge[a] + partition.edge[a] - 1) });
export const boxWithin = (inner, outer) => inner.min.every((v, a) => v >= outer.min[a] && inner.max[a] <= outer.max[a]);
export function intersectBox(a, b) {
  const min = a.min.map((v, i) => Math.max(v, b.min[i])); const max = a.max.map((v, i) => Math.min(v, b.max[i]));
  return min.every((v, i) => v <= max[i]) ? { min, max } : null;
}
/** Every partition chunk intersecting box, ascending x,y,z, with the clipped cell box. */
export function chunksOfBox(box, partition) {
  const lo = chunkOfPosition(box.min, partition), hi = chunkOfPosition(box.max, partition); const out = [];
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
    const chunkPos = [x, y, z]; out.push({ chunkPos, box: intersectBox(chunkBox(chunkPos, partition), box) });
  }
  return out;
}
function regionBlock(v) {
  // Palette legality (the empty material included) is read from the Catalogue where one is
  // supplied (validateRegionPalette); a block alone names no material specially.
  const total = blockCellCount(v); blockBox(v);
  let sum = 0, previous, specified = false; const used = new Set();
  for (const [count, index] of v.runs) {
    // Canonical run-length form: adjacent runs never repeat a value.
    shape(index !== previous); previous = index; sum += count;
    if (index !== null) { shape(index < v.palette.length); used.add(index); specified = true; }
  }
  shape(Number.isSafeInteger(sum) && sum === total);
  shape(specified && used.size === v.palette.length);
}
function regionState(v) {
  shape(v.block.runs.every(([, index]) => index !== null));
  const box = blockBox(v.block);
  // A region summary compares whole states, so engine-derived fields are never carried in one.
  const derived = new Set(v.stateProfile.derivedFields);
  for (const extra of v.extras) {
    shape(Object.keys(extra.state).every(k => !derived.has(k)));
    geometry(extra.position.every((p, a) => p >= box.min[a] && p <= box.max[a]));
    shape(Object.keys(extra.state).length > 0);
  }
}
const inChunk = (partition, chunkPos, box) => geometry(boxWithin(box, chunkBox(chunkPos, partition)));
// A world source that declares postWriteLighting NONE has no lighting fact; REQUIRED always has one.
const lightingDeclared = v => shape((v.postWriteLighting === 'NONE') === (v.lighting === null));
const lit = v => v.postWriteLighting === 'NONE' || v.lighting.status === 'COMPLETE';
const world = (v, ...refs) => requireFact(refs.every(r => r === v.worldRef) && v.localContext.worldRef === v.worldRef, 'CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
function summaryCoherent(worldRef, ...summaries) {
  requireFact(summaries.every(s => s.worldRef === worldRef), 'CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
  const layout = s => JSON.stringify([s.partition, s.chunks.map(c => [c.chunkPos, c.box])]);
  shape(summaries.every(s => layout(s) === layout(summaries[0])));
}
export function validateRegionDomain(name, v) {
  if (name === 'RegionVoxelBlock') regionBlock(v);
  else if (name === 'WorldGeometry') shape((v.partition !== null) === v.geometryProfiles.includes('voxel-grid/v1'));
  else if (name === 'RegionState') regionState(v);
  else if (name === 'RegionOperationsProjection') for (const c of v.chunks) inChunk(v.partition, c.chunkPos, blockBox(c.block));
  else if (name === 'RegionBuildProjection') shape(same(blockBox(v.block), v.declaredBounds));
  else if (name === 'CompiledRegionSet') {
    const boxes = v.projection.chunks.map(c => blockBox(c.block));
    const min = [0, 1, 2].map(a => Math.min(...boxes.map(b => b.min[a]))), max = [0, 1, 2].map(a => Math.max(...boxes.map(b => b.max[a])));
    geometry(same({ min, max }, v.writeBounds));
  } else if (name === 'CompileRegionBuildRequest') {
    world(v, v.build.worldRef); shape(v.build.catalogueDigest === v.catalogueDigest);
  } else if (name === 'ValidateRegionProposalRequest') {
    world(v, v.intent.intendedWorldRef);
    shape(v.referenceBrief.sessionRef === v.sessionRef && v.referenceBrief.turnRevision === v.turnRevision && v.intent.referenceBriefDigest === v.referenceBriefDigest);
  } else if (name === 'ReadRegionRequest') world(v);
  else if (name === 'RegionChunkRead') {
    if (v.availability === 'KNOWN') {
      shape(v.state !== null && v.stateDigest !== null && v.loadMethod !== null && v.unknownReason === null);
      shape(same(blockBox(v.state.block), v.box));
    } else shape(v.state === null && v.stateDigest === null && v.unknownReason !== null);
  } else if (name === 'RegionReadResult') {
    world(v, ...v.chunks.filter(c => c.state).map(c => c.state.worldRef));
    shape(same(chunksOfBox(v.box, v.partition), v.chunks.map(c => ({ chunkPos: c.chunkPos, box: c.box }))));
  } else if (name === 'RegionChunkWrite') shape((v.ops === null) !== (v.state === null));
  else if (name === 'WriteRegionRequest') {
    shape(v.writes.every(w => (v.purpose === 'APPLY') === (w.ops !== null)));
    for (const w of v.writes) inChunk(v.partition, w.chunkPos, blockBox(w.ops ?? w.state.block));
    world(v, ...v.writes.filter(w => w.state).map(w => w.state.worldRef));
  } else if (name === 'RegionChunkWriteResult') shape((v.status === 'WRITTEN') === (v.readbackDigest !== null));
  else if (name === 'RegionWriteResult') { world(v); lightingDeclared(v); }
  else if (name === 'RegionSummary') for (const c of v.chunks) inChunk(v.partition, c.chunkPos, c.box);
  else if (name === 'RegionSnapshotContent') {
    requireFact(v.chunks.every(c => c.state.worldRef === v.worldRef), 'CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    for (const c of v.chunks) inChunk(v.partition, c.chunkPos, blockBox(c.state.block));
  }
  else if (name === 'ApplyRegionCommitRequest') world(v, v.operations.worldRef);
  else if (name === 'RegionCommitResult') {
    world(v); summaryCoherent(v.worldRef, v.beforeSummary, v.expectedAfterSummary, v.actualSummary); lightingDeclared(v);
    if (v.status === 'VERIFIED') shape(same(v.actualSummary, v.expectedAfterSummary) && lit(v));
    else shape(same(v.actualSummary, v.beforeSummary));
    // 1.2: the failure that made Canvas restore, only on a rollback, of this transaction, before restore.
    if (Object.hasOwn(v, 'rollbackCause')) {
      const e = v.rollbackCause.error;
      shape(v.status === 'ROLLED_BACK' && e.phase !== 'restore' && ['NONE', 'PARTIAL', 'UNKNOWN'].includes(e.mutationState) &&
        (e.transactionRef === null || e.transactionRef === v.transactionId));
    }
  } else if (name === 'UndoRegionCommitRequest' || name === 'UndoScopedRegionCommitRequest') { world(v); shape(v.originTransactionId !== v.undoTransactionId); }
  else if (name === 'RegionUndoResult' || name === 'ScopedRegionUndoOutcome') {
    world(v); summaryCoherent(v.worldRef, v.preUndoSummary, v.actualSummary); lightingDeclared(v);
    shape(v.originTransactionId !== v.undoTransactionId);
    if (v.status === 'VERIFIED') shape(lit(v));
    else if (name === 'RegionUndoResult') shape(same(v.actualSummary, v.preUndoSummary));
  }
  if (name === 'UndoScopedRegionCommitResponse' && v.result) shape((v.result.outcome.status === 'VERIFIED') === (v.undoFailure === null));
}
