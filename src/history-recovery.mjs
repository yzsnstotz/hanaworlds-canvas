import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { digestValue, requestDigest, validateBoundResponse, validateResponse,
 validateCommitReadback } from 'hanaworlds-contracts';
const same = (a, b) => canonicalize(a) === canonicalize(b);
const D = (kind, value) => digestValue(kind, value).sha256;
function pendingError(transactionId, causeCode) {
 return Object.assign(new Error('RECOVERY_PENDING'), { publicError: {
  code:'RECOVERY_PENDING',phase:'apply',retryability:'SAME_TRANSACTION_QUERY',
  mutationState:'UNKNOWN',transactionRef:transactionId,causeCode,reason:'TRANSPORT_OUTCOME_UNKNOWN' } });
}
/** Resolve a History outcome by exact public query and readback.
 * Query and Abort keep the original transaction/payload/context. No Restore or new write.
 * A changed/missing query, context or readback leaves the reservation intact. */
export async function resolveHistoryOutcome(canvas, { sessionRef, transactionId }) {
 await canvas.ready;
 const state=canvas.store.snapshot;
 const row=state.pending[transactionId], completedRow=state.transactions[transactionId];
 const body=row?.body??completedRow?.body, prepared=row?.prepared;
 const current=canvas.current(sessionRef);
 if(!body || body.sessionRef!==sessionRef || state.retiredSessions?.[sessionRef] ||
    !current || current.activeWorldRef!==body.worldRef || !same(current.localContext,body.localContext))
  throw pendingError(transactionId,'CURRENT_WORLD_MISMATCH');
 if(!completedRow?.recoveryResolution && (!row?.direction || !prepared))
  throw pendingError(transactionId,'STALE_TRANSACTION');
 canvas.adapterCompatible();
 const call=async (op, extras) => {
  const q={contractVersion:'world-adapter/v7',sessionRef,requestId:`${body.requestId}:resolve:${op}:${randomUUID()}`,
   worldRef:body.worldRef,localContext:body.localContext,...extras};
  const reply=validateBoundResponse('world-adapter/v7',op,q,await canvas.adapter.call(op,q));
  if(reply.error) throw Object.assign(new Error(reply.error.code),{publicError:reply.error,guardRefusal:reply.guardRefusal??null});
  return reply.result;
 };
 const connectionRequest={contractVersion:'world-adapter/v7',sessionRef,
  requestId:`${body.requestId}:resolve-connection:${randomUUID()}`,connectionRef:body.localContext.connectionRef};
 const connection=validateBoundResponse('world-adapter/v7','ReadLocalConnection',connectionRequest,
  await canvas.adapter.call('ReadLocalConnection',connectionRequest));
 if(connection.error || connection.result.worldRef!==body.worldRef ||
    connection.result.connectionIncarnationRef!==body.localContext.connectionIncarnationRef)
  throw pendingError(transactionId,'CURRENT_WORLD_MISMATCH');
 if(completedRow?.recoveryResolution) return structuredClone(completedRow.recoveryResolution);
 const receipt=await call('QueryTransaction',{transactionId,transactionPayloadDigest:prepared.transactionPayloadDigest});
 if(receipt.transactionId!==transactionId || receipt.transactionPayloadDigest!==prepared.transactionPayloadDigest ||
    receipt.operationDigest!==prepared.historyOperationDigest || !same(receipt.localContext,body.localContext))
  throw pendingError(transactionId,'REPLAY_MISMATCH');
 if(receipt.previousWorldRevision!==body.expectedWorldRevision)
  throw pendingError(transactionId,'STALE_REVISION');
 if(receipt.status==='RESTORE_FAILED') {
  const response=validateResponse('canvas/v7',row.direction==='REDO'?'Redo':'Undo',
   {contractVersion:'canvas/v7',requestId:body.requestId,result:receipt,error:null,guardRefusal:null});
  await canvas.store.commit(next=>{
   const pending=next.pending[transactionId];
   if(!same(pending?.prepared,prepared)) throw pendingError(transactionId,'STALE_TRANSACTION');
   Object.assign(pending,{queriedReceipt:receipt,guardRefusal:receipt.guardRefusal,
    applyFailure:receipt.applyFailure,restoreCode:receipt.error.code,
    causeCode:receipt.applyFailure.error.code,receiptStatus:'RESTORE_FAILED',phase:'RESTORE_PENDING'});
   const operation=row.direction==='REDO'?'Redo':'Undo';
   next.replay[`${sessionRef}\0${operation}\0${body.requestId}`]={digest:requestDigest('canvas/v7',operation,body),response};
  });
  return {transactionId,status:'RESTORE_FAILED',recoveryPending:true,receipt,response};
 }
 if(receipt.status==='VERIFIED' || receipt.status==='ROLLED_BACK') {
  const actual=await call('Readback',{transactionId,coveredPositions:row.before.coveredPositions,stateProfile:row.before.stateProfile});
  const verified=receipt.status==='VERIFIED', expected=verified?row.expected:row.before;
  const history=verified?{transactionId,originTransactionId:row.originTransactionId,
   affectedObjectRefs:[body.objectRef],operationDigest:prepared.historyOperationDigest,
   beforeImageDigest:prepared.beforeImageDigest,expectedAfterReadbackDigest:actual.readbackDigest,
   receiptDigest:D('receipt',receipt),historyRevision:`history-${randomUUID()}`,status:'VERIFIED'}:null;
  if(D('readback',actual.projection)!==actual.readbackDigest || receipt.readbackDigest!==actual.readbackDigest)
   throw pendingError(transactionId,'READBACK_MISMATCH');
  validateCommitReadback(receipt,expected,actual.projection,history);
  const operation=row.direction==='REDO'?'Redo':'Undo';
  const response=validateResponse('canvas/v7',operation,{contractVersion:'canvas/v7',requestId:body.requestId,result:receipt,error:null,guardRefusal:null});
  const resolution={transactionId,status:receipt.status,mutationState:verified?'VERIFIED':'ROLLED_BACK',readbackDigest:actual.readbackDigest,receipt,response};
  await canvas.store.commit(next=>{
   if(!same(next.pending[transactionId]?.prepared,prepared) || !same(next.sessions[sessionRef]?.localContext,body.localContext))
    throw pendingError(transactionId,'CURRENT_WORLD_MISMATCH');
   if(verified) {
    if(next.history[body.objectRef]?.at(-1)?.historyRevision!==body.expectedHistoryRevision ||
       next.objects[body.worldRef]?.[body.objectRef]?.objectRevision!==body.expectedObjectRevisions[body.objectRef])
     throw pendingError(transactionId,'STALE_REVISION');
    next.history[body.objectRef].push(history);
    next.objects[body.worldRef][body.objectRef].objectRevision=`object-${randomUUID()}`;
    next.footprints[body.worldRef][body.objectRef].positions=row.direction==='REDO'?expected.coveredPositions:[];
    next.footprints[body.worldRef][body.objectRef].footprintRevision=`footprint-${randomUUID()}`;
    next.registryRevisions[body.worldRef]=`registry-${randomUUID()}`;
   }
   next.transactions[transactionId]={receipt,history,direction:row.direction,body,
    objectRef:body.objectRef,worldRef:body.worldRef,before:row.before,after:actual.projection,
    originTransactionId:row.originTransactionId,displayMetadata:{committedAt:new Date().toISOString(),mode:'CELL',affectedCells:expected.coveredPositions.length},recoveryResolution:resolution};
   next.worldRevisions[body.worldRef]=receipt.observedWorldRevision;
   next.replay[`${sessionRef}\0${operation}\0${body.requestId}`]={digest:requestDigest('canvas/v7',operation,body),response};
   delete next.pending[transactionId];
  });
  return resolution;
 }
 if(receipt.status!=='REJECTED' || receipt.error!==null)
  throw pendingError(transactionId,receipt.error?.code??'TRANSACTION_CONFLICT');
 let confirmation=row.abortConfirmation;
 if(!confirmation) {
  const queried=await call('QueryPreparedHistoryTransaction',{transactionId,originTransactionId:row.originTransactionId,
   direction:row.direction,historyOperationDigest:prepared.historyOperationDigest});
  if(!same(queried,prepared)) throw pendingError(transactionId,'REPLAY_MISMATCH');
  const abortRequest=row.abortRequest??{contractVersion:'world-adapter/v7',sessionRef,
   requestId:`${body.requestId}:resolve-abort:${randomUUID()}`,worldRef:body.worldRef,localContext:body.localContext,
   transactionId,originTransactionId:row.originTransactionId,historyOperationDigest:prepared.historyOperationDigest};
  if(!row.abortRequest) await canvas.store.commit(next=>{
   if(!same(next.pending[transactionId]?.prepared,prepared)) throw pendingError(transactionId,'STALE_TRANSACTION');
   next.pending[transactionId].abortRequest=abortRequest;
  });
  // An uncertain Abort reply is replayed with this exact durable request, never a new one.
  const reply=validateBoundResponse('world-adapter/v7','AbortPreparedHistoryTransaction',abortRequest,
   await canvas.adapter.call('AbortPreparedHistoryTransaction',abortRequest));
  if(reply.error) throw Object.assign(new Error(reply.error.code),{publicError:reply.error});
  confirmation=reply.result;
  if(confirmation.transactionId!==transactionId || confirmation.status!=='ABORTED_PREPARED' || confirmation.mutationState!=='NONE')
   throw pendingError(transactionId,'REPLAY_MISMATCH');
  await canvas.store.commit(next=>{
   if(!same(next.pending[transactionId]?.prepared,prepared)) throw pendingError(transactionId,'STALE_TRANSACTION');
   next.pending[transactionId].abortConfirmation=confirmation;
  });
 }
 const read=await call('Readback',{transactionId,coveredPositions:row.before.coveredPositions,stateProfile:row.before.stateProfile});
 if(!same(read.projection,row.before) || D('readback',read.projection)!==read.readbackDigest)
  throw pendingError(transactionId,'READBACK_MISMATCH');
 const operation=row.direction==='REDO'?'Redo':'Undo';
 const original=row.failure?.error;
 const error=original ? {...original,mutationState:'NONE'} : {
  code:row.causeCode??'TARGET_FACTS_INCOMPLETE',phase:'validate',retryability:'AFTER_NEW_FACTS',
  mutationState:'NONE',transactionRef:transactionId,causeCode:null,reason:'REQUIRED_FACT_UNKNOWN'};
 const response=validateResponse('canvas/v7',operation,{contractVersion:'canvas/v7',requestId:body.requestId,
  result:null,error,guardRefusal:row.failure?.guardRefusal??null});
 const resolution={transactionId,status:'ABORTED_PREPARED',mutationState:'NONE',
  readbackDigest:read.readbackDigest,receipt,response};
 await canvas.store.commit(next=>{
  const live=next.pending[transactionId];
  if(!same(live?.prepared,prepared) || !same(next.sessions[sessionRef]?.localContext,body.localContext))
   throw pendingError(transactionId,'CURRENT_WORLD_MISMATCH');
  next.transactions[transactionId]={receipt,body,worldRef:body.worldRef,recoveryResolution:resolution};
  next.replay[`${sessionRef}\0${operation}\0${body.requestId}`]={digest:requestDigest('canvas/v7',operation,body),response};
  delete next.pending[transactionId];
 });
 return resolution;
}
