/** Pure provider/consumer evidence checks. Authentic origin evidence is supplied from the
 * provider's retained successful transaction, never reconstructed from the new request. */
import { contractMetadata } from './generated/contracts.mjs';
import { canonicalJSON, validateType, validateRequest, validateResponse, validateDigestBinding,
  digestValue, deepFreeze, comparePosition } from './runtime.mjs';
import { requireFact } from '../errors.mjs';
import { expandRegionBlock, encodeRegionBlock, expectedRegionState, expectedRegionSummary,
  summarizeRegionStates, validateRegionCommit, validateRegionSnapshotContent } from './region.mjs';
export const scopedRegionUndo = contractMetadata.scopedRegionUndo;
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const D = (k,v) => digestValue(k,v).sha256;
const conflict = ok => requireFact(ok,'UNDO_CONFLICT','PAYLOAD_CHANGED');
const world = ok => requireFact(ok,'CURRENT_WORLD_MISMATCH','SCOPE_DENIED');
const profile = ok => requireFact(ok,'CAPABILITY_GAP','GEOMETRY_PROFILE_UNSUPPORTED');
const summary = c => summarizeRegionStates(c.worldRef,c.partition,c.chunks);
const content = (base,states) => validateType('RegionSnapshotContent', {...base,
  chunks: base.chunks.map((c,i) => ({chunkPos:c.chunkPos,state:states[i],stateDigest:D('region-state',states[i])}))});
function cells(state) {
  const b = expandRegionBlock(state.block), [sx,sy] = b.size;
  const extras = new Map(state.extras.map(e=>[e.position.join(','),e.state]));
  return Array.from(b.indices,(v,i)=>{
    const position = [b.box.min[0]+i%sx,b.box.min[1]+Math.floor(i/sx)%sy,b.box.min[2]+Math.floor(i/(sx*sy))];
    return {position,material:b.palette[v],state:extras.get(position.join(','))??{}};
  });
}
function requireLayout(c,origin) {
  world(c.worldRef===origin.request.worldRef);
  conflict(same([c.partition,c.chunks.map(x=>[x.chunkPos,expandRegionBlock(x.state.block).box])],
    [origin.before.partition,origin.before.chunks.map(x=>[x.chunkPos,expandRegionBlock(x.state.block).box])]));
  for(const c1 of c.chunks)validateDigestBinding('region-state',c1.state,c1.stateDigest);
}
export function deriveConfirmedRegionUndoScope(input) {
  const o = validateType('RegionUndoOriginEvidence',input), q=o.request, r=o.result;
  conflict(r.status==='VERIFIED');
  validateRegionCommit(q,{contractVersion:q.contractVersion,requestId:q.requestId,result:r,error:null,guardRefusal:null,applyFailure:null});
  validateRegionSnapshotContent(o.before,r.snapshot,r.beforeSummary);
  requireLayout(o.after,o);
  conflict(same(summary(o.after),r.actualSummary) && same(expectedRegionSummary(o.before,q.operations),r.actualSummary));
  const positions=[];
  q.operations.chunks.forEach((c,i)=>{
    const before=o.before.chunks[i].state, after=o.after.chunks[i].state;
    profile(same(before.stateProfile,after.stateProfile));
    conflict(same(expectedRegionState(before,c.block),after));
    const b=expandRegionBlock(c.block), [sx,sy]=b.size;
    b.indices.forEach((v,j)=>{if(v!==-1)positions.push([b.box.min[0]+j%sx,b.box.min[1]+Math.floor(j/sx)%sy,b.box.min[2]+Math.floor(j/(sx*sy))]);});
  });
  positions.sort(comparePosition);
  return validateType('ConfirmedRegionUndoScope',{profileVersion:scopedRegionUndo.scopeProfile,
    originTransactionId:q.transactionId,sessionRef:q.sessionRef,worldRef:q.worldRef,localContext:q.localContext,
    operationDigest:q.operationDigest,beforeContentDigest:D('region-snapshot-content',o.before),
    afterContentDigest:D('region-snapshot-content',o.after),positions});
}
export function validateScopedRegionUndoRequest(raw,originInput) {
  const q=validateRequest(scopedRegionUndo.wire,scopedRegionUndo.operation,raw);
  const o=validateType('RegionUndoOriginEvidence',originInput), scope=deriveConfirmedRegionUndoScope(o);
  world(q.worldRef===scope.worldRef && q.sessionRef===scope.sessionRef && same(q.localContext,scope.localContext));
  conflict(q.originTransactionId===scope.originTransactionId && q.undoTransactionId!==q.originTransactionId &&
    q.expectedHistoryRevision===o.result.historyRevision && q.expectedScopeDigest===D('confirmed-region-undo-scope',scope));
  return q;
}
/** True full snapshots stay intact. Only the specified origin cells may be restored. */
export function composeScopedRegionUndoTarget(originInput,currentInput) {
  const o=validateType('RegionUndoOriginEvidence',originInput);deriveConfirmedRegionUndoScope(o);
  const current=validateType('RegionSnapshotContent',currentInput);requireLayout(current,o);
  const states=current.chunks.map((c,i)=>{
    const before=o.before.chunks[i].state,after=o.after.chunks[i].state;
    profile(same(c.state.stateProfile,after.stateProfile));
    const mask=expandRegionBlock(o.request.operations.chunks[i].block).indices;
    const prior=cells(before),verified=cells(after),now=cells(c.state);
    requireFact(now.every((v,j)=>mask[j]===-1||same(v,verified[j])),
      'UNDO_CONFLICT','EXTERNAL_EDIT_CONFLICT','readback');
    const target=now.map((v,j)=>mask[j]===-1?v:prior[j]);
    const palette=target.map(v=>v.material);
    return validateType('RegionState',{...c.state,block:encodeRegionBlock({origin:c.state.block.origin,
      size:c.state.block.size,palette,indices:Int32Array.from(target,(_,j)=>j)}),
      extras:target.filter(v=>Object.keys(v.state).length).map(v=>({position:v.position,state:v.state})).sort((a,b)=>comparePosition(a.position,b.position))});
  });
  return content(current,states);
}
export function validateScopedRegionUndo(raw,responseInput,originInput) {
  const q=validateScopedRegionUndoRequest(raw,originInput);
  const response=validateResponse(scopedRegionUndo.wire,scopedRegionUndo.operation,responseInput);
  conflict(response.requestId===q.requestId);
  if(response.undoFailure)conflict(response.undoFailure.error.transactionRef===null || response.undoFailure.error.transactionRef===q.undoTransactionId);
  if(response.error)return response;
  const r=response.result, o=validateType('RegionUndoOriginEvidence',originInput);
  conflict(same(r.scope,deriveConfirmedRegionUndoScope(o)));
  const v=r.outcome;
  conflict((v.status==='VERIFIED')===(response.undoFailure===null));
  world(v.worldRef===q.worldRef && same(v.localContext,q.localContext));
  conflict(v.originTransactionId===q.originTransactionId && v.undoTransactionId===q.undoTransactionId &&
    v.originBeforeSummaryDigest===D('region-summary',o.result.beforeSummary) && v.originAfterSummaryDigest===D('region-summary',o.result.actualSummary));
  requireLayout(r.preUndoContent,o);requireLayout(r.actualContent,o);
  conflict(same(summary(r.preUndoContent),v.preUndoSummary)&&same(summary(r.actualContent),v.actualSummary));
  const target=composeScopedRegionUndoTarget(o,r.preUndoContent);
  requireLayout(r.preRestoreContent,o);
  if(v.status==='VERIFIED')conflict(same(r.preRestoreContent,r.preUndoContent));
  const expected=v.status==='VERIFIED'?target:composeScopedRegionUndoRecoveryTarget(o,r.preUndoContent,r.preRestoreContent);
  requireFact(same(r.actualContent,expected),
    'READBACK_MISMATCH','READBACK_ERROR','readback');
  return response;
}
/** Static exchange simulator: no engine facts, writes or product evidence. */
export function createScopedRegionUndoMock(fixture) {
  const origin=validateType('RegionUndoOriginEvidence',fixture.origin);
  return Object.freeze({evidence:'FIXTURE_ONLY',async call(operation,q){
    requireFact(operation===scopedRegionUndo.operation,'UNSUPPORTED_OPERATION','INVALID_SHAPE');
    const r={...fixture.response,requestId:q.requestId};
    return validateScopedRegionUndo(q,r,origin);
  }});
}

/** Rollback/reopen of the same scoped attempt: preserve outside current and refuse any
 * in-scope value not proved to be either that attempt's before or its undo target. */
export function composeScopedRegionUndoRecoveryTarget(originInput,preUndoInput,currentInput) {
  const o=validateType('RegionUndoOriginEvidence',originInput);deriveConfirmedRegionUndoScope(o);
  const pre=validateType('RegionSnapshotContent',preUndoInput),current=validateType('RegionSnapshotContent',currentInput);
  requireLayout(pre,o);requireLayout(current,o);
  const undo=composeScopedRegionUndoTarget(o,pre);
  const states=current.chunks.map((c,i)=>{
    profile(same(c.state.stateProfile,pre.chunks[i].state.stateProfile));
    const mask=expandRegionBlock(o.request.operations.chunks[i].block).indices;
    const a=cells(pre.chunks[i].state),b=cells(undo.chunks[i].state),now=cells(c.state);
    requireFact(now.every((v,j)=>mask[j]===-1||same(v,a[j])||same(v,b[j])),
      'RECOVERY_PENDING','TRANSPORT_OUTCOME_UNKNOWN','restore',{mutationState:'UNKNOWN'});
    const target=now.map((v,j)=>mask[j]===-1?v:a[j]);
    return validateType('RegionState',{...c.state,block:encodeRegionBlock({origin:c.state.block.origin,size:c.state.block.size,
      palette:target.map(v=>v.material),indices:Int32Array.from(target,(_,j)=>j)}),
      extras:target.filter(v=>Object.keys(v.state).length).map(v=>({position:v.position,state:v.state})).sort((a,b)=>comparePosition(a.position,b.position))});
  });
  return content(current,states);
}
/** Envelope binding only. Full state validation additionally requires the trusted origin helper. */
export function validateScopedRegionUndoBinding(wire,operation,q,response) {
  if(wire!==scopedRegionUndo.wire || operation!==scopedRegionUndo.operation)return;
  conflict(response.requestId===q.requestId);
  if(response.undoFailure)conflict(response.undoFailure.error.transactionRef===null||response.undoFailure.error.transactionRef===q.undoTransactionId);
  if(response.error)return;
  const {scope,outcome}=response.result;
  world(scope.worldRef===q.worldRef&&scope.sessionRef===q.sessionRef&&same(scope.localContext,q.localContext)&&outcome.worldRef===q.worldRef&&same(outcome.localContext,q.localContext));
  conflict(scope.originTransactionId===q.originTransactionId&&outcome.originTransactionId===q.originTransactionId&&outcome.undoTransactionId===q.undoTransactionId&&D('confirmed-region-undo-scope',scope)===q.expectedScopeDigest);
}
