import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import canonicalize from 'canonicalize';
import { digestValue, encodeRegionBlock, expandRegionBlock, regionChunksOfBox, comparePosition } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, CanvasRegionV1 } from '../src/index.mjs';
import { objectsRunRoot } from './objects-web-server.mjs';

export const exampleSessionRef = 'objects-history-fixture-session';
const worldRef = 'objects-history-fixture-world';
const D = (kind, value) => digestValue(kind, value).sha256;
const profile = { profileVersion:'state-profile/v2', nodeFields:['nodeName','param1','param2'],
  metadataMode:'exact', inventoryMode:'exact', timerMode:'exact', derivedLightMode:'recompute-with-readback' };
const connection = { connectionRef:'objects-fixture-connection', connectionIncarnationRef:'objects-fixture-incarnation',
  worldRef, payloadVersion:'local-world/v1', payloadDigest:'1'.repeat(64), capabilities:{ providerRef:'fixture-adapter',
    capabilityRevision:'fixture-cap-1', worldRef, engineBounds:{min:[-64,-64,-64],max:[64,64,64]}, limits:[],
    recoveryGuarantee:'RECOVERABLE_VERIFIED', stateProfile:profile, sessionDeleteSupported:true, imageMediaTypes:[], model:null } };

// Only the world/Adapter inputs are fixtures. Canvas decisions, validation,
// before snapshots, readback, commits and fsynced history are production code.
function fixtureEnvironment() {
  const nodes = new Map(); const prepared = new Set(); const calls = [];
  const key = p => p.join(',');
  const record = p => nodes.get(key(p)) ?? { position:p, nodeName:'air', param1:0, param2:0, metadata:{}, inventory:{}, timer:null };
  const positions = box => {
    const result = [];
    for (let z=box.min[2];z<=box.max[2];z++) for (let y=box.min[1];y<=box.max[1];y++)
      for (let x=box.min[0];x<=box.max[0];x++) result.push([x,y,z]);
    return result;
  };
  const regionState = box => {
    const palette = [], seen = new Map();
    const indices = Int32Array.from(positions(box), p => {
      const r = record(p); const id = `${r.nodeName}\0${r.param2}`;
      if (!seen.has(id)) { seen.set(id,palette.length); palette.push({nodeName:r.nodeName,param2:r.param2}); }
      return seen.get(id);
    });
    return { profileVersion:'region-state/v1', worldRef, block:encodeRegionBlock({origin:box.min,
      size:box.max.map((v,a)=>v-box.min[a]+1), palette, indices}), extras:[], derivedLightMode:'recompute-with-readback' };
  };
  const projection = request => ({worldRef, coveredPositions:request.coveredPositions ?? request.scope.checkedPositions,
    records:(request.coveredPositions ?? request.scope.checkedPositions).map(record), stateProfile:profile});
  const env = { calls, writes:[], readWorldRevision:null };
  env.nativeFacts = { async readScopedState(ref, requestedPositions) {
    if (ref !== connection.connectionRef) throw new Error('FIXTURE_CONNECTION_MISMATCH');
    return {worldRef, stateProfile:profile, cells:requestedPositions.map(p=>({position:p, availability:'KNOWN',
      stateDigest:createHash('sha256').update('HanaWorlds|contracts@0.4.0|adapter-scoped-cell/v1\n')
        .update(canonicalize({profile,record:record(p)})).digest('hex')}))};
  } };
  // FIXTURE per-cell port handshake: what a G3 Adapter advertises on world-adapter/v6.
  env.adapter = { protocolHandshake:{ profileVersion:'protocol-handshake/v1', component:'objects-fixture-adapter',
    protocols:[{ protocol:'world-adapter', major:6, minor:1 }],
    capabilities:['world-adapter/v6:callback-free-write','world-adapter/v6:write-path-state-facts'],
    provenance:{ packageName:'objects-fixture-adapter', packageVersion:'1.0.0', sourceRevision:null, artifactDigest:null } },
    async call(operation, request) {
    calls.push({port:'world-adapter/v6',operation,request:structuredClone(request)});
    const answer = result => ({contractVersion:'world-adapter/v6',requestId:request.requestId,result,error:null});
    if (operation==='DiscoverConnections') return answer({capabilityRevision:'fixture-cap-1',connections:[{
      adapterId:'hanaworlds-world-adapter',connectionRef:connection.connectionRef,worldRef,
      displayName:'隔离示例世界',capabilityRevision:'fixture-cap-1',payloadVersion:connection.payloadVersion,
      readiness:'READY',connectionIncarnationRef:connection.connectionIncarnationRef}]});
    if (operation==='ReadLocalConnection') return answer(connection);
    if (operation==='PrepareRecoverableTransaction') {
      prepared.add(request.transactionId);
      const payload = {contractVersion:'world-adapter/v6', transactionId:request.transactionId,worldRef,
        operationDigest:request.operationDigest,scopeDigest:request.scopeDigest,beforeImageDigest:'3'.repeat(64),localContext:request.localContext};
      return answer({payload,transactionPayloadDigest:D('scoped-transaction-payload',payload),beforeImageDigest:payload.beforeImageDigest,
        scopeDigest:request.scopeDigest,guarantee:'RECOVERABLE_VERIFIED',stateProfile:profile,
        adapterExecutionRevision:'fixture-cell-before',beforeStateReadbackDigest:D('readback',projection(request))});
    }
    if (operation==='Readback') {
      if (!prepared.has(request.transactionId)) throw new Error('FIXTURE_UNPREPARED_READ');
      const p = projection(request);
      return answer({projection:p,readbackDigest:D('readback',p),adapterExecutionRevision:'fixture-cell-readback'});
    }
    if (operation==='ApplyCompiledTransaction') {
      const previousWorldRevision = await env.readWorldRevision();
      for (const effect of request.operations.effects) nodes.set(key(effect.position),{...record(effect.position),nodeName:effect.nodeName,param2:effect.param2});
      env.writes.push({port:'cell',transactionId:request.transactionId});
      return answer({contractVersion:'canvas/v5',transactionId:request.transactionId,operationDigest:request.operationDigest,
        transactionPayloadDigest:request.preparedTransaction.transactionPayloadDigest,status:'VERIFIED',previousWorldRevision,
        observedWorldRevision:'fixture-cell-world-1',readbackDigest:D('readback',projection(request)),
        restoreStatus:'NOT_REQUIRED',error:null,localContext:request.localContext});
    }
    throw new Error(`FIXTURE_UNSUPPORTED_CELL_OPERATION:${operation}`);
  } };
  env.regionAdapter = { protocolHandshake:{profileVersion:'protocol-handshake/v1',component:'objects-fixture-adapter',
    protocols:[{protocol:'world-adapter-region',major:1,minor:1}],capabilities:[
      'world-adapter-region/v1:callback-free-write',
      'world-adapter-region/v1:chunked-read','world-adapter-region/v1:chunked-write','world-adapter-region/v1:lighting-complete',
      'world-adapter-region/v1:load-then-know','world-adapter-region/v1:restore-state'],
    provenance:{packageName:'objects-fixture-adapter',packageVersion:'1.0.0',sourceRevision:null,artifactDigest:null}},
    async call(operation, request) {
      calls.push({port:'world-adapter-region/v1',operation,request:structuredClone(request)});
      const answer = result => ({contractVersion:'world-adapter-region/v1',requestId:request.requestId,result,error:null});
      if (operation==='ReadRegion') return answer({worldRef,box:request.box,localContext:request.localContext,
        chunks:regionChunksOfBox(request.box).map(({chunkPos,box})=>{
          const state=regionState(box);
          return {chunkPos,box,availability:'KNOWN',loadMethod:'ALREADY_LOADED',unknownReason:null,state,stateDigest:D('region-state',state)};
        })});
      if (operation==='WriteRegion') {
        const boxes=[];
        const chunks=request.writes.map(w=>{
          const block=w.ops ?? w.state.block; const expanded=expandRegionBlock(block); const {box,indices,palette}=expanded;
          boxes.push(box);
          if (D('region-state',regionState(box))!==w.expectedCurrentDigest) throw new Error('FIXTURE_REGION_DIGEST_MISMATCH');
          positions(box).forEach((p,i)=>{if(indices[i]!==-1) nodes.set(key(p),{...record(p),nodeName:palette[indices[i]].nodeName,param2:palette[indices[i]].param2});});
          return {chunkPos:w.chunkPos,status:'WRITTEN',readbackDigest:D('region-state',regionState(box))};
        });
        env.writes.push({port:'region',purpose:request.purpose,transactionId:request.transactionId});
        const box={min:[0,1,2].map(a=>Math.min(...boxes.map(b=>b.min[a]))),max:[0,1,2].map(a=>Math.max(...boxes.map(b=>b.max[a])))};
        return answer({transactionId:request.transactionId,worldRef,purpose:request.purpose,chunks,
          lighting:{status:'COMPLETE',box,method:'fixture:in-memory-relight'},localContext:request.localContext});
      }
      throw new Error(`FIXTURE_UNSUPPORTED_REGION_OPERATION:${operation}`);
    } };
  return env;
}
const checked = response => {
  if (response.error) throw new Error(`EXAMPLE_TRANSACTION_FAILED:${JSON.stringify(response.error)}`);
  return response.result;
};
const regionInput = (origin,size) => {
  const block=encodeRegionBlock({origin,size,palette:[{nodeName:'fixture:stone',param2:0}],indices:new Int32Array(size.reduce((a,b)=>a*b,1))});
  const chunks=regionChunksOfBox({min:origin,max:origin.map((o,a)=>o+size[a]-1)});
  if (chunks.length!==1) throw new Error('EXAMPLE_INPUT_MUST_USE_ONE_CHUNK');
  const operations={contractVersion:'region-operations/v1',buildDigest:'b'.repeat(64),compilerRevision:'fixture-brush-region-1',
    worldRef,catalogueDigest:'c'.repeat(64),chunkEdge:16,chunks:[{chunkPos:chunks[0].chunkPos,block}]};
  return {operations,operationDigest:D('region-operations',operations)};
};

export async function createObjectsExample(directory) {
  // This is an explicit one-time fixture producer, never a server read side effect.
  try { await readFile(join(directory,'canvas-v5.json')); throw new Error('EXAMPLE_ALREADY_EXISTS'); }
  catch (error) { if (error.code!=='ENOENT') throw error; }
  const env=fixtureEnvironment();
  const canvas=new CanvasV5({store:await CanvasStore.open(directory),adapter:env.adapter,nativeFacts:env.nativeFacts});
  const region=new CanvasRegionV1(canvas,env.regionAdapter);
  env.readWorldRevision=()=>canvas.readWorldRevision(worldRef);
  const trace=[];
  const call=async (service,operation,body)=>{
    const response=await service.call(operation,body); trace.push({operation,request:body,response});
    checked(response); return response.result;
  };
  const base={contractVersion:'canvas/v5',sessionRef:exampleSessionRef,worldRef};
  const context=await call(canvas,'ReadWorldSelectionContext',{...base,requestId:'fixture-context'});
  const selected=await call(canvas,'SelectWorldConnection',{...base,requestId:'fixture-select',connectionRef:connection.connectionRef,
    connectionIncarnationRef:connection.connectionIncarnationRef,expectedRevision:context.selection.sessionRevision,expectedContext:null});
  const localContext=selected.localContext;
  const regionBase={contractVersion:'canvas-region/v1',sessionRef:exampleSessionRef,worldRef,localContext,guarantee:'RECOVERABLE_VERIFIED'};
  await call(region,'ApplyRegionCommit',{...regionBase,requestId:'fixture-region-keep',transactionId:'fixture-region-keep',...regionInput([12,4,8],[2,2,2])});
  const operations={contractVersion:'operations/v3',buildDigest:'b'.repeat(64),compilerRevision:'fixture-brush-cell-1',
    compilationConfigDigest:'a'.repeat(64),worldRef,frameDigest:'f'.repeat(64),catalogueDigest:'c'.repeat(64),
    targetFactsDigest:'d'.repeat(64),effects:[{position:[0,1,3],nodeName:'fixture:stone',param2:0}]};
  const operationDigest=D('operations',operations);
  const worldRevision=await canvas.readWorldRevision(worldRef);
  const listed=await call(canvas,'ListObjects',{...base,requestId:'fixture-objects',localContext,expectedRevision:null});
  const analyzed=await call(canvas,'AnalyzeAffectedObjects',{...base,requestId:'fixture-analysis',transactionId:'fixture-cell-keep',
    operations,operationDigest,expectedRevision:worldRevision,expectedRegistryRevision:listed.registryRevision,
    expectedSelectionRevision:selected.selectionRevision,localContext});
  await call(canvas,'ApplyRecoverableCommit',{...base,requestId:'fixture-cell-keep',transactionId:'fixture-cell-keep',
    operations,operationDigest,analysisDigest:D('affected-analysis',analyzed),decisionRevision:null,expectedWorldRevision:worldRevision,
    expectedObjectRevisions:{},guarantee:'RECOVERABLE_VERIFIED',regionInspectionBinding:null,localContext});
  const withdrawn=await call(region,'ApplyRegionCommit',{...regionBase,requestId:'fixture-region-withdrawn',transactionId:'fixture-region-withdrawn',...regionInput([4,1,4],[2,1,1])});
  await call(region,'UndoRegionCommit',{contractVersion:'canvas-region/v1',sessionRef:exampleSessionRef,worldRef,localContext,
    requestId:'fixture-region-undo',originTransactionId:'fixture-region-withdrawn',undoTransactionId:'fixture-region-undo',expectedHistoryRevision:withdrawn.historyRevision});
  const view=await canvas.readObjectsHistory(exampleSessionRef);
  return {classification:'REAL_RUNTIME + FIXTURE',sessionRef:exampleSessionRef,worldRef,storeDirectory:directory,
    inputs:'Adapter/native world/Brush inputs are explicit in-memory fixtures; no real world connection',
    records:'Public Canvas selection, region commit, per-cell analysis/commit, region Undo; no direct Store record insertion',
    names:'Public transaction producers record null names; display must say unnamed rather than invent names',trace,adapterCalls:env.calls,writes:env.writes,view};
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const directory=join(objectsRunRoot,'isolated-example');
  const receipt=await createObjectsExample(directory);
  await writeFile(join(directory,'production-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({classification:receipt.classification,storeDirectory:directory,objects:receipt.view.objects.length,history:receipt.view.history.length}));
}
