import test from 'node:test';
import {guardRefusalError,digestValue} from 'hanaworlds-contracts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUndoExample } from '../scripts/undo-example.mjs';
import { openUndoHost } from '../scripts/undo-host.mjs';

test('a definitely pre-write History failure aborts its exact prepared transaction instead of Restore', async () => {
 const dir=await mkdtemp(join(tmpdir(),'canvas-prepared-failure-'));
 try {
  await createUndoExample(dir); const host=await openUndoHost(dir);
  const ref=(await host.readView()).entries[1].objectRef;
  assert.equal((await host.perform(ref,'undo')).status,'VERIFIED');
  const port=host.canvas.adapter, original=port.call.bind(port); let prepared, request, restores=0, aborted=0;
  port.call=async (op,q)=>{
   const answer=result=>({contractVersion:'world-adapter/v7',requestId:q.requestId,result,error:null});
   if(op==='PrepareHistoryTransaction') { const r=await original(op,q);prepared=r.result;request=q;return r; }
   if(op==='ApplyHistoryTransaction') return {...answer(null),guardRefusal:null,error:{code:'TARGET_FACTS_INCOMPLETE',phase:'validate',retryability:'NEVER',mutationState:'NONE',transactionRef:q.transactionId,causeCode:null,reason:'REQUIRED_FACT_UNKNOWN'}};
   if(op==='RestoreTransaction') {restores++;throw new Error('STALE_TRANSACTION');}
   if(op==='QueryTransaction') return answer({contractVersion:'canvas/v6',transactionId:q.transactionId,operationDigest:prepared.historyOperationDigest,transactionPayloadDigest:prepared.transactionPayloadDigest,status:'REJECTED',previousWorldRevision:request.expectedWorldRevision,observedWorldRevision:null,readbackDigest:null,restoreStatus:'UNKNOWN',error:null,guardRefusal:null,applyFailure:null,localContext:q.localContext});
   if(op==='QueryPreparedHistoryTransaction') return answer(prepared);
   if(op==='AbortPreparedHistoryTransaction') {aborted++;return answer({transactionId:q.transactionId,status:'ABORTED_PREPARED',mutationState:'NONE'});}
   return original(op,q);
  };
  const history=structuredClone(host.canvas.store.snapshot.history[ref]);
  const result=await host.perform(ref,'redo');
  assert.equal(result.error?.code,'TARGET_FACTS_INCOMPLETE');
  assert.equal(result.error?.mutationState,'NONE');
  assert.equal(restores,0,'pre-write failure must never Restore');
  assert.equal(aborted,1);
  assert.deepEqual(host.canvas.store.snapshot.pending,{});
  assert.deepEqual(host.canvas.store.snapshot.history[ref],history);
  assert.equal((await host.readView()).entries[1].state,'UNDONE');
  const again=await host.canvas.call('Redo',result.request);
  assert.equal(again.error?.code,'TARGET_FACTS_INCOMPLETE');
  assert.equal(aborted,1,'exact replay must not run a second Abort');
 } finally {await rm(dir,{recursive:true,force:true});}
});


test('an unknown History outcome stays pending until same-transaction Query and Abort prove NONE', async () => {
 const dir=await mkdtemp(join(tmpdir(),'canvas-unknown-history-'));
 try {
  await createUndoExample(dir); const host=await openUndoHost(dir), ref=(await host.readView()).entries[1].objectRef;
  assert.equal((await host.perform(ref,'undo')).status,'VERIFIED');
  const port=host.canvas.adapter, original=port.call.bind(port);let prepared,request,unknown=true,abort=0,restores=0;
  port.call=async(op,q)=>{
   const answer=result=>({contractVersion:'world-adapter/v7',requestId:q.requestId,result,error:null});
   if(op==='PrepareHistoryTransaction'){const r=await original(op,q);prepared=r.result;request=q;return r;}
   if(op==='ApplyHistoryTransaction') return {...answer(null),guardRefusal:null,error:{code:'RECOVERY_PENDING',phase:'apply',retryability:'SAME_TRANSACTION_QUERY',mutationState:'UNKNOWN',transactionRef:q.transactionId,causeCode:null,reason:'TRANSPORT_OUTCOME_UNKNOWN'}};
   if(op==='RestoreTransaction'){restores++;throw new Error('STALE_TRANSACTION');}
   if(op==='QueryTransaction')return answer({contractVersion:'canvas/v6',transactionId:q.transactionId,operationDigest:prepared.historyOperationDigest,transactionPayloadDigest:prepared.transactionPayloadDigest,status:unknown?'RECOVERY_PENDING':'REJECTED',previousWorldRevision:request.expectedWorldRevision,observedWorldRevision:null,readbackDigest:null,restoreStatus:'UNKNOWN',error:unknown?{code:'RECOVERY_PENDING',phase:'apply',retryability:'SAME_TRANSACTION_QUERY',mutationState:'UNKNOWN',transactionRef:q.transactionId,causeCode:null,reason:'TRANSPORT_OUTCOME_UNKNOWN'}:null,guardRefusal:null,applyFailure:null,localContext:q.localContext});
   if(op==='QueryPreparedHistoryTransaction')return answer(prepared);
   if(op==='AbortPreparedHistoryTransaction'){abort++;return answer({transactionId:q.transactionId,status:'ABORTED_PREPARED',mutationState:'NONE'});}
   return original(op,q);
  };
  const result=await host.perform(ref,'redo');assert.equal(result.error?.code,'RECOVERY_PENDING');
  assert.equal(restores,0);assert.equal(abort,0);assert.ok(host.canvas.store.snapshot.pending[result.transactionId]);
  const publicUnknown=(await host.canvas.readHistoryActions('undo-fixture-session')).recovery.find(r=>r.transactionId===result.transactionId);
  assert.equal(publicUnknown.mutationState,'UNKNOWN');
  assert.equal(publicUnknown.abortConfirmation,null);
  assert.equal(publicUnknown.originalFailure.error.code,'RECOVERY_PENDING');
  await assert.rejects(()=>host.canvas.resolvePendingHistory({sessionRef:'undo-fixture-session',transactionId:result.transactionId}),/RECOVERY_PENDING/);
  assert.equal(abort,0);unknown=false;
  const resolution=await host.canvas.resolvePendingHistory({sessionRef:'undo-fixture-session',transactionId:result.transactionId});
  assert.equal(resolution.status,'ABORTED_PREPARED');assert.equal(abort,1);assert.equal(restores,0);
  assert.deepEqual(host.canvas.store.snapshot.pending,{});assert.equal((await host.readView()).entries[1].state,'UNDONE');
  await host.canvas.resolvePendingHistory({sessionRef:'undo-fixture-session',transactionId:result.transactionId});assert.equal(abort,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('a lost History apply reply is queried and read back once, never restored or reapplied', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canvas-history-lost-reply-'));
 try {
  await createUndoExample(dir);const host=await openUndoHost(dir),ref=(await host.readView()).entries[1].objectRef;
  assert.equal((await host.perform(ref,'undo')).status,'VERIFIED');
  const port=host.canvas.adapter,original=port.call.bind(port);let receipt,applies=0,restores=0;
  port.call=async(op,q)=>{
   if(op==='ApplyHistoryTransaction') {applies++;receipt=(await original(op,q)).result;return {contractVersion:'world-adapter/v7',requestId:q.requestId,result:null,guardRefusal:null,error:{code:'RECOVERY_PENDING',phase:'apply',retryability:'SAME_TRANSACTION_QUERY',mutationState:'UNKNOWN',transactionRef:q.transactionId,causeCode:null,reason:'TRANSPORT_OUTCOME_UNKNOWN'}};}
   if(op==='QueryTransaction')return {contractVersion:'world-adapter/v7',requestId:q.requestId,result:receipt,error:null};
   if(op==='RestoreTransaction'){restores++;throw new Error('STALE_TRANSACTION');}
   return original(op,q);
  };
  const result=await host.perform(ref,'redo');assert.equal(result.status,'VERIFIED');assert.equal(result.error,null);
  assert.equal(applies,1);assert.equal(restores,0);assert.deepEqual(host.canvas.store.snapshot.pending,{});
  assert.equal((await host.readView()).entries[1].state,'APPLIED');
  assert.equal((await host.canvas.call('Redo',result.request)).result.status,'VERIFIED');assert.equal(applies,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('a verified query with a different previous world revision cannot finalize history', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canvas-history-lost-reply-'));
 try {
  await createUndoExample(dir);const host=await openUndoHost(dir),ref=(await host.readView()).entries[1].objectRef;
  assert.equal((await host.perform(ref,'undo')).status,'VERIFIED');
  const port=host.canvas.adapter,original=port.call.bind(port);let receipt,applies=0,restores=0;
  port.call=async(op,q)=>{
   if(op==='ApplyHistoryTransaction') {applies++;receipt=(await original(op,q)).result;return {contractVersion:'world-adapter/v7',requestId:q.requestId,result:null,guardRefusal:null,error:{code:'RECOVERY_PENDING',phase:'apply',retryability:'SAME_TRANSACTION_QUERY',mutationState:'UNKNOWN',transactionRef:q.transactionId,causeCode:null,reason:'TRANSPORT_OUTCOME_UNKNOWN'}};}
   if(op==='QueryTransaction')return {contractVersion:'world-adapter/v7',requestId:q.requestId,result:{...receipt,previousWorldRevision:'different-world-revision'},error:null};
   if(op==='RestoreTransaction'){restores++;throw new Error('STALE_TRANSACTION');}
   return original(op,q);
  };
  const result=await host.perform(ref,'redo');assert.equal(result.error?.code,'RECOVERY_PENDING');
  assert.ok(host.canvas.store.snapshot.pending[result.transactionId]);
  assert.equal((await host.readView()).entries[1].state,'UNDONE');
  assert.equal(applies,1);assert.equal(restores,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('lost Abort reply replays its durable request after reopening, then concurrent resolution finalizes once', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canvas-history-abort-replay-'));
 try {
  await createUndoExample(dir);let host=await openUndoHost(dir);const ref=(await host.readView()).entries[1].objectRef;
  await host.perform(ref,'undo');const port=host.canvas.adapter,original=port.call.bind(port);
  let prepared,request,abortId,abortWrites=0,abortCalls=0,lose=true,readFails=true;
  port.call=async(op,q)=>{
   const answer=result=>({contractVersion:'world-adapter/v7',requestId:q.requestId,result,error:null});
   if(op==='PrepareHistoryTransaction'){const r=await original(op,q);prepared=r.result;request=q;return r;}
   if(op==='ApplyHistoryTransaction')return {...answer(null),guardRefusal:null,error:{code:'TARGET_FACTS_INCOMPLETE',phase:'validate',retryability:'AFTER_NEW_FACTS',mutationState:'NONE',transactionRef:q.transactionId,causeCode:null,reason:'REQUIRED_FACT_UNKNOWN'}};
   if(op==='QueryTransaction')return answer({contractVersion:'canvas/v6',transactionId:q.transactionId,operationDigest:prepared.historyOperationDigest,transactionPayloadDigest:prepared.transactionPayloadDigest,status:'REJECTED',previousWorldRevision:request.expectedWorldRevision,observedWorldRevision:null,readbackDigest:null,restoreStatus:'UNKNOWN',error:null,guardRefusal:null,applyFailure:null,localContext:q.localContext});
   if(op==='QueryPreparedHistoryTransaction')return answer(prepared);
   if(op==='AbortPreparedHistoryTransaction') {
    abortCalls++;if(!abortId){abortId=q.requestId;abortWrites++;}else assert.equal(q.requestId,abortId,'same Abort request must replay');
    if(lose){lose=false;throw Error('LOST_ABORT_REPLY');}
    return answer({transactionId:q.transactionId,status:'ABORTED_PREPARED',mutationState:'NONE'});
   }
   if(op==='Readback' && q.transactionId===prepared?.transactionId && readFails)throw Error('READBACK_UNAVAILABLE');
   return original(op,q);
  };
  const failed=await host.perform(ref,'redo');assert.equal(failed.error.code,'RECOVERY_PENDING');
  const durable=host.canvas.store.snapshot.pending[failed.transactionId];assert.equal(durable.abortRequest.requestId,abortId);assert.equal(durable.abortConfirmation,undefined);
  const lostView=(await host.canvas.readHistoryActions('undo-fixture-session')).recovery.find(r=>r.transactionId===failed.transactionId);
  assert.equal(lostView.mutationState,'UNKNOWN','a lost Abort reply must not publish NONE');
  assert.equal(lostView.originalFailure.error.code,'TARGET_FACTS_INCOMPLETE');
  assert.equal(lostView.queryFailure,'LOST_ABORT_REPLY');
  const world=host.world;host=await openUndoHost(dir,{world});
  const recovery={sessionRef:'undo-fixture-session',transactionId:failed.transactionId};
  await assert.rejects(()=>host.canvas.resolvePendingHistory(recovery),/RECOVERY_PENDING/);
  assert.equal(host.canvas.store.snapshot.pending[failed.transactionId].abortConfirmation.mutationState,'NONE');
  const confirmedView=(await host.canvas.readHistoryActions('undo-fixture-session')).recovery.find(r=>r.transactionId===failed.transactionId);
  assert.equal(confirmedView.mutationState,'NONE');
  assert.deepEqual(confirmedView.abortConfirmation,{transactionId:failed.transactionId,status:'ABORTED_PREPARED',mutationState:'NONE'});
  assert.equal(confirmedView.originalFailure.error.code,'TARGET_FACTS_INCOMPLETE');
  assert.equal(confirmedView.queryFailure,'READBACK_UNAVAILABLE');
  confirmedView.abortConfirmation.mutationState='UNKNOWN';
  assert.equal((await host.canvas.readHistoryActions('undo-fixture-session')).recovery[0].mutationState,'NONE','read projection cannot mutate durable evidence');
  const beforeForeign=structuredClone(host.canvas.store.snapshot);
  await assert.rejects(()=>host.canvas.resolvePendingHistory({...recovery,sessionRef:'foreign-session'}),/CURRENT_WORLD_MISMATCH/);
  assert.deepEqual(host.canvas.store.snapshot,beforeForeign,'foreign session must not update even recovery metadata');
  host=await openUndoHost(dir,{world});readFails=false;
  const both=await Promise.all([host.canvas.resolvePendingHistory(recovery),host.canvas.resolvePendingHistory(recovery)]);
  assert.deepEqual(both[0],both[1]);assert.equal(both[0].status,'ABORTED_PREPARED');
  assert.equal(abortWrites,1);assert.equal(abortCalls,2);assert.deepEqual(host.canvas.store.snapshot.pending,{});
  assert.equal((await host.readView()).entries[1].state,'UNDONE');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Host recovery cannot overtake an active History apply',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canvas-history-active-'));
 try{
  await createUndoExample(dir);const host=await openUndoHost(dir),ref=(await host.readView()).entries[1].objectRef;
  await host.perform(ref,'undo');const port=host.canvas.adapter,original=port.call.bind(port);
  let release,transactionId,queries=0;const held=new Promise(r=>release=r);let entered;const applying=new Promise(r=>entered=r);
  port.call=async(op,q)=>{
   if(op==='ApplyHistoryTransaction'){const result=await original(op,q);transactionId=q.transactionId;entered();await held;return result;}
   if(op==='QueryTransaction')queries++;
   return original(op,q);
  };
  const pending=host.perform(ref,'redo');await applying;
  await assert.rejects(()=>host.canvas.resolvePendingHistory({sessionRef:'undo-fixture-session',transactionId}),/TRANSACTION_CONFLICT/);
  assert.equal(queries,0);release();assert.equal((await pending).status,'VERIFIED');assert.deepEqual(host.canvas.store.snapshot.pending,{});
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('queried RESTORE_FAILED keeps both failure causes and the original restore guard pending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canvas-history-restore-guard-'));
 try {
  await createUndoExample(dir);const host=await openUndoHost(dir),ref=(await host.readView()).entries[1].objectRef;
  await host.perform(ref,'undo');const port=host.canvas.adapter,original=port.call.bind(port);let prepared,request,receipt,restores=0;
  const guard={guard:'BODY_CLEARANCE',stage:'RESTORE',finding:'BODY_OCCUPIED'};
  port.call=async(op,q)=>{
   const answer=result=>({contractVersion:'world-adapter/v7',requestId:q.requestId,result,error:null});
   if(op==='PrepareHistoryTransaction'){const r=await original(op,q);prepared=r.result;request=q;return r;}
   if(op==='ApplyHistoryTransaction')return {...answer(null),guardRefusal:null,error:{code:'RESTORE_FAILED',phase:'restore',retryability:'AFTER_MANUAL_RECOVERY',mutationState:'UNKNOWN',transactionRef:q.transactionId,causeCode:'APPLY_FAILED',reason:'REQUIRED_FACT_UNKNOWN'}};
   if(op==='QueryTransaction') {
    receipt={contractVersion:'canvas/v6',transactionId:q.transactionId,operationDigest:prepared.historyOperationDigest,transactionPayloadDigest:prepared.transactionPayloadDigest,status:'RESTORE_FAILED',previousWorldRevision:request.expectedWorldRevision,observedWorldRevision:null,readbackDigest:null,restoreStatus:'FAILED',error:guardRefusalError(guard,{transactionRef:q.transactionId,cause:'APPLY_FAILED'}),guardRefusal:guard,applyFailure:{error:{code:'APPLY_FAILED',phase:'apply',retryability:'NEVER',mutationState:'UNKNOWN',transactionRef:q.transactionId,causeCode:null,reason:'REQUIRED_FACT_UNKNOWN'},guardRefusal:null},localContext:q.localContext};return answer(receipt);
   }
   if(op==='RestoreTransaction'){restores++;throw Error('NO_FORCED_RESTORE');}
   return original(op,q);
  };
  const result=await host.perform(ref,'redo');assert.equal(result.status,'RESTORE_FAILED');assert.equal(restores,0);
  const row=host.canvas.store.snapshot.pending[result.transactionId];assert.deepEqual(JSON.parse(JSON.stringify(row.queriedReceipt)),JSON.parse(JSON.stringify(receipt)));assert.deepEqual(JSON.parse(JSON.stringify(row.guardRefusal)),guard);assert.equal(row.causeCode,'APPLY_FAILED');assert.equal(row.receiptStatus,'RESTORE_FAILED');
  const replay=await host.canvas.call('Redo',result.request);assert.equal(replay.result?.status,'RESTORE_FAILED');assert.deepEqual(JSON.parse(JSON.stringify(replay.result)),JSON.parse(JSON.stringify(receipt)));
  const query=await host.canvas.resolvePendingHistory({sessionRef:'undo-fixture-session',transactionId:result.transactionId});assert.equal(query.recoveryPending,true);assert.deepEqual(JSON.parse(JSON.stringify(query.receipt)),JSON.parse(JSON.stringify(receipt)));
  assert.ok(host.canvas.store.snapshot.pending[result.transactionId]);assert.equal(restores,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});


test('a valid ROLLED_BACK History reply is queried and read back without leaking SCHEMA_INVALID or pending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canvas-history-rolled-back-'));
 try{
  await createUndoExample(dir);const host=await openUndoHost(dir),ref=(await host.readView()).entries[1].objectRef;
  await host.perform(ref,'undo');const port=host.canvas.adapter,original=port.call.bind(port);let receipt,restores=0;
  port.call=async(op,q)=>{
   const answer=result=>({contractVersion:'world-adapter/v7',requestId:q.requestId,result,error:null});
   if(op==='ApplyHistoryTransaction'){
    const before=host.canvas.store.snapshot.pending[q.transactionId].before;
    receipt={contractVersion:'canvas/v6',transactionId:q.transactionId,operationDigest:q.historyOperationDigest,transactionPayloadDigest:q.preparedHistoryTransaction.transactionPayloadDigest,status:'ROLLED_BACK',previousWorldRevision:q.expectedWorldRevision,observedWorldRevision:q.expectedWorldRevision,readbackDigest:digestValue('readback',before).sha256,restoreStatus:'VERIFIED_RESTORED',error:null,guardRefusal:null,applyFailure:null,localContext:q.localContext};return answer(receipt);
   }
   if(op==='QueryTransaction')return answer(receipt);
   if(op==='RestoreTransaction'){restores++;throw Error('ALREADY_ROLLED_BACK');}
   return original(op,q);
  };
  const result=await host.perform(ref,'redo');assert.equal(result.status,'ROLLED_BACK');assert.equal(result.error,null);assert.deepEqual(host.canvas.store.snapshot.pending,{});assert.equal(restores,0);
  assert.equal((await host.readView()).entries[1].state,'UNDONE');assert.equal((await host.canvas.call('Redo',result.request)).result.status,'ROLLED_BACK');
 }finally{await rm(dir,{recursive:true,force:true});}
});
