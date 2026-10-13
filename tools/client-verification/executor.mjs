import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { decodeSnapshot } from '../../src/region-v1.mjs';
import { validateType, validateBoundResponse, digestValue } from '../../src/protocol/local/index.mjs';
import { binding, pointer, applyBinding, sha, matchFixedShape } from './bindings.mjs';
import { SupplyFailure, failSupply, publicFailure, getService, callPublic,
  readCurrentState, casePositions, snapshotActual } from './snapshot.mjs';

import examples from '../../test/client-verification/canvas-examples.json' with { type: 'json' };
const CANVAS='hanaworldsCanvasV5';
const REGION='hanaworldsCanvasRegionV1';
const FACTS='hanaworldsWorldFacts';
const callItems=new Map(examples.cases.map(x=>[x.id,x]));
const localItems=new Map(examples.local.map(x=>[x.id,x]));
const eventItems=new Map(examples.events.map(x=>[x.id,x]));
const businessItems=new Map(examples.business.map(x=>[x.id,x]));
const scenarioItems=new Map(examples.scenarios.map(x=>[x.id,x]));
export const operationRoutes=Object.freeze(Object.fromEntries(examples.cases.map(x=>[x.id,{key:x.wire==='canvas/v7'?CANVAS:REGION,method:'call',operation:x.id}])));
const localRoutes=Object.freeze({
  readToolSummary:[CANVAS,'readToolSummary',r=>[r]],
  readScopedState:[CANVAS,'nativeFacts.readScopedState',r=>[r.connectionRef,r.positions]],
  'Error.source':[CANVAS,'nativeFacts.readScopedState',r=>[r.connectionRef,r.positions]],
  objectsHistory:[CANVAS,'readObjectsHistory',r=>[r.sessionRef]],
  footprintRegistry:['hanaworldsCanvasFootprintRegistry','readFootprints',r=>[r.worldRef,r.objectRefs,r.request]],
  historyFacts:['hanaworldsCanvasHistoryFacts','read',r=>[r]],
  worldRevision:['hanaworldsWorldRevisionOracle','read',r=>[r.worldRef]],
  historyActions:[CANVAS,'readHistoryActions',r=>[r.sessionRef]],
  engineSafety:[CANVAS,'readEngineSafety',r=>[r.sessionRef]],
  compilerConfig:['hanaworldsCompilerConfig','read',r=>[r.worldRef]],
  configSupply:['hanaworldsCanvasConfigSupply','read',r=>[r.worldRef]],
});
const uiIds=new Set(['navigation','populated-history','undo-redo','configuration-reload','region','visible-error','unload']);
const placementKeys=['frontGapCells','forwardSearchCells','lateralSearchCells','verticalSearchCells'];
const clone=x=>structuredClone(x);
const newRef=kind=>`canvas-verification-${kind}-${randomUUID()}`;
const durable=readCurrentState;
const D=(kind,value)=>digestValue(kind,value).sha256;
const equal=(a,b)=>sha(a)===sha(b);
function requireValue(value,name,stage='setup') {
  if(value===undefined || value===null) failSupply('CURRENT_CASE_INPUT_UNAVAILABLE',stage,{missing:name});
  return value;
}
async function localCall(observer,id,request) {
  const route=localRoutes[id];
  if(!route) failSupply('CLIENT_REMOTE_EXECUTION_REQUIRED','call',{caseId:id});
  const [key,method,args]=route;
  const receiver=getService(observer,key);
  if(method==='nativeFacts.readScopedState') {
    if(typeof receiver.nativeFacts?.readScopedState!=='function') failSupply('CURRENT_SCOPED_STATE_READER_UNAVAILABLE','call');
    return receiver.nativeFacts.readScopedState(...args(request));
  }
  if(typeof receiver[method]!=='function') failSupply('CURRENT_PROVIDER_UNAVAILABLE','call',{key,method});
  return receiver[method](...args(request));
}
async function preFacts(observer,scope,id) {
  const canvas=getService(observer,CANVAS);
  const state=await durable(observer);
  const current=canvas.current(scope.sessionRef);
  const view=await canvas.readObjectsHistory(scope.sessionRef);
  const actions=await canvas.readHistoryActions(scope.sessionRef);
  const contextRequest={contractVersion:'canvas/v7',requestId:newRef('context'),sessionRef:scope.sessionRef,worldRef:scope.worldRef};
  const contextResponse=await canvas.call('ReadWorldSelectionContext',contextRequest);
  if(contextResponse.error) failSupply('CURRENT_CONNECTION_INVENTORY_UNAVAILABLE','setup',{response:contextResponse});
  const context=contextResponse.result;
  const discoveryRequest={contractVersion:'world-adapter/v8',requestId:newRef('discover'),sessionRef:scope.sessionRef,adapterId:canvas.adapterId};
  const discovery=await callPublic(observer,'hanaworldsWorldAdapterV6','DiscoverConnections',discoveryRequest);
  validateBoundResponse('world-adapter/v8','DiscoverConnections',discoveryRequest,discovery);
  if(discovery.error) failSupply('CURRENT_CONNECTION_INVENTORY_UNAVAILABLE','setup',{response:discovery});
  const inventoryRequest={contractVersion:'canvas/v7',requestId:newRef('inventory-public'),sessionRef:scope.sessionRef,worldRef:scope.worldRef,expectedCapabilityRevision:discovery.result.capabilityRevision};
  const inventoryResponse=await canvas.call('ListWorldConnections',inventoryRequest);
  if(inventoryResponse.error) failSupply('CURRENT_CONNECTION_INVENTORY_UNAVAILABLE','setup',{response:inventoryResponse});
  const objectList=current?.localContext ? await canvas.call('ListObjects',{contractVersion:'canvas/v7',requestId:newRef('registry-public'),sessionRef:scope.sessionRef,worldRef:scope.worldRef,expectedRevision:null,localContext:current.localContext}) : null;
  const objectAction=actions.objects.find(x=>x.mode===(id.includes('Region')?'REGION':'CELL') &&
    (id==='Redo'||id==='display.redo'?x.redo?.available:x.undo?.available)) ?? actions.objects[0];
  const object=objectAction ? state.objects[scope.worldRef]?.[objectAction.objectRef] : Object.values(state.objects[scope.worldRef]??{})[0];
  const head=object ? state.history[object.objectRef]?.at(-1) : null;
  const originId=(id==='Redo'||id==='display.redo') ? head?.originTransactionId :
    id.includes('Region') ? objectAction?.originTransactionId : head?.transactionId;
  let origin=originId ? state.transactions[originId] : null;
  if(origin?.kind==='REGION' && origin.result?.status==='VERIFIED' && origin.verifiedAfterSnapshot) {
    const disk=await observer.readDurable();
    const content=async (ref,summary)=>decodeSnapshot(await readFile(join(dirname(disk.path),'region-snapshots',`${validateType('RegionSnapshotRef',ref).compressedSha256}.json.gz`)),ref,summary);
    origin={...origin,request:clone(origin.originRequest),
      before:await content(origin.result.snapshot,origin.result.beforeSummary),
      after:await content(origin.verifiedAfterSnapshot,origin.result.actualSummary)};
  }
  const worldInventoryResponse=await canvas.call('ListWorldSelections',{contractVersion:'canvas/v7',requestId:newRef('world-selection-inventory'),worldRef:scope.worldRef});
  return {scope,state,current,view,actions,context,worldInventory:worldInventoryResponse.result,object,objectAction,head,originId,origin,
    inventory:inventoryResponse.result,registry:objectList?.result,requestId:newRef('request'),transactionId:newRef('transaction'),undoTransactionId:newRef('undo')};
}
function requestResolver(spec,f,item) {
  const parts=spec.path.split('/').slice(2), key=parts.at(-1), path=parts.join('/');
  if(/materialRef$/.test(key)) return undefined;
  const scope=f.scope;
  if(spec.kind==='RefKey') return requireValue(f.object?.objectRef,'actual object dictionary key');
  if(path.startsWith('operations/') || path.startsWith('expectedOperations/')) {
    if(key==='worldRef') return scope.worldRef;
    // Normal product builds are read from the actual durable origin; no synthetic build provenance.
    const operations=f.operationsSource ?? f.origin?.operations ?? f.origin?.body?.operations ?? f.origin?.originRequest?.operations;
    if(operations) return pointer(operations,'/'+parts.slice(1).join('/'));
    return undefined;
  }
  if(path.startsWith('analysis/')) return pointer(f.analysis,'/'+parts.slice(1).join('/'));
  if(path.includes('affectedObjectRefs/') || path.includes('orderedSelectedRefs/')) return requireValue(f.object?.objectRef,'actual affected/selected object reference');
  if(path.startsWith('expectedProvider/')) return f.sourceBefore?.provider?.[key];
  if(path.includes('expectedObjectRevisions/')) return requireValue(f.object?.objectRevision,'actual object revision');
  if(['sessionRef','currentSession'].includes(key)) return scope.sessionRef;
  if(['worldRef','fromWorldRef'].includes(key)) return scope.worldRef;
  if(['connectionRef','connectionIncarnationRef','selectionRevision'].includes(key)) return f.current?.localContext?.[key] ?? scope.localContext?.[key] ?? scope.connection?.[key];
  if(key==='toConnectionRef' || key==='toWorldRef') {
    const target=f.inventory.connections.find(x=>x.worldRef!==scope.worldRef);
    return requireValue(target?.[key==='toWorldRef'?'worldRef':'connectionRef'],'second actual world connection');
  }
  if(key==='requestId') return f.requestId;
  if(key==='transactionId') return ['Readback','CreateObject'].includes(item.id) ? requireValue(f.originId,'verified original transaction') : f.transactionId;
  if(key==='undoTransactionId') return f.undoTransactionId;
  if(['historyTransactionId','originTransactionId'].includes(key)) return requireValue(f.originId,'durable movable origin');
  if(['objectRef','objectRefs','0'].includes(key) && (key!=='0' || path.includes('objectRefs/'))) return requireValue(f.object?.objectRef,'actual registered object');
  if(key==='expectedCapabilityRevision') return f.inventory.capabilityRevision;
  if(key==='expectedSelectionRevision') return f.current?.selectionRevision;
  if(key==='expectedRegistryRevision') return f.state.registryRevisions[scope.worldRef] ?? f.registry?.registryRevision;
  if(key==='expectedWorldRevision') return f.state.worldRevisions[scope.worldRef];
  if(key==='expectedDecisionRevision') return f.state.affectedDecisions?.[f.transactionId]?.decisionRevision;
  if(key==='analysisRevision' && f.analysis) return D('affected-analysis',f.analysis);
  if(key==='analysisDigest' && f.analysis) return D('affected-analysis',f.analysis);
  if(key==='decisionRevision') return f.state.affectedDecisions?.[f.transactionId]?.decisionRevision;
  if(key==='expectedInventoryRevision') return f.worldInventory?.inventoryRevision;
  if(key==='reservationRef') return f.worldInventory?.retirementReservationRef;
  if(key==='expectedHistoryRevision') return requireValue(f.head?.historyRevision,'linked current history head');
  if(key==='expectedScopeDigest') return requireValue(f.origin?.confirmedUndoScopeDigest,'durable verified origin scope digest');
  if(key==='verifiedReceiptDigest') return requireValue(f.origin?.history?.receiptDigest,'durable verified receipt digest');
  if(key==='commitRevision') return requireValue(f.origin?.receipt?.commitRevision,'actual commit revision');
  if(key==='transactionPayloadDigest') return requireValue(f.origin?.receipt?.transactionPayloadDigest,'actual transaction payload digest');
  if(key==='originalUndoRequestId') {
    const row=Object.values(f.state.pending ?? {}).find(x=>x.body?.sessionRef===scope.sessionRef && ['UNDO','SCOPED_UNDO'].includes(x.direction));
    return requireValue(row?.body?.requestId,'actual pending original undo request');
  }
  if(key==='invocationId') return newRef('placement-invocation');
  if(key==='expectedRevision') {
    if(['SelectWorldConnection','SwitchWorldConnection','UnselectWorldConnection'].includes(item.id))
      return f.current?.selectionRevision ?? f.scope.identity.sessionRevision;
    if(['NameObject','RenameObject','InspectObject'].includes(item.id)) return requireValue(f.object?.objectRevision,'actual object revision');
    if(item.id==='AnalyzeAffectedObjects') return f.state.worldRevisions[scope.worldRef];
    return f.state.registryRevisions[scope.worldRef] ?? f.registry?.registryRevision;
  }
  return undefined;
}
function bindRequests(template,item,f) {
  const root={request:clone(template)}, rows=[];
  for(const spec of item.bindings.filter(x=>x.path.startsWith('/request/') && x.kind!=='RefKey')) {
    const actualExample=pointer(root,spec.path);
    if(actualExample===undefined || !equal(actualExample,spec.example) || /\/materialRef$/.test(spec.path)) continue;
    const value=requestResolver(spec,f,item);
    if(value===undefined) continue;
    applyBinding(root,spec,value); rows.push(binding(spec,value,true));
  }
  // Request dictionary keys are renamed only after their corresponding values have been bound.
  for(const spec of item.bindings.filter(x=>x.path.startsWith('/request/') && x.kind==='RefKey')) {
    const value=requestResolver(spec,f,item);
    if(applyBinding(root,spec,value)) rows.push(binding(spec,value,true));
  }
  return {request:root.request,bindings:rows};
}
function setDerived(request,item,rows,path,value) {
  const spec=item.bindings.find(x=>x.path===path);
  if(!spec || pointer({request},path)===undefined || /\/materialRef$/.test(path))
    failSupply('DERIVED_BINDING_NOT_APPROVED','setup',{path});
  binding(spec,value,true);
  const existing=rows.find(x=>x.path===path);
  if(existing) existing.value=value;
  else rows.push(binding(spec,value,true));
  const parts=path.split('/').slice(2); let target=request;
  for(const key of parts.slice(0,-1)) target=target[key];
  target[parts.at(-1)]=value;
}
async function prepareRequest(observer,item,template,scope,mode,group) {
  const f=await preFacts(observer,scope,item.id);
  if(item.id==='readToolSummary' && mode==='ok') {
    const canvas=getService(observer,CANVAS);
    // Canvas owns the privileged source reader. readToolSummary captures its real readCanvasFacts.
    // readCanvasFacts has the same Canvas identity boundary as readScopedState; see sourceRead below.
    const summary=await canvas.readToolSummary({sessionRef:scope.sessionRef});
    f.sourceBefore=await readSourceFacts(observer,scope); f.historyBefore=await canvas.readObjectsHistory(scope.sessionRef);
  }
  if(item.id==='ReserveWorldRetirement') {
    const result=await callPublic(observer,CANVAS,'ListWorldSelections',{contractVersion:'canvas/v7',requestId:newRef('inventory'),worldRef:scope.worldRef});
    if(!result.error) f.worldInventory=result.result;
  }
  if(template.operations) {
    const source=item.request?.operations ?? template.operations;
    const permitted=item.bindings.map(x=>({...x,path:x.path.replace('/request/operations','/request')}));
    const candidates=Object.values(f.state.transactions ?? {}).filter(row=>
      (row.receipt?.status ?? row.result?.status)==='VERIFIED' && (row.worldRef ?? row.originRequest?.worldRef)===scope.worldRef);
    const row=candidates.find(row=> {
      const operations=row.operations ?? row.body?.operations ?? row.originRequest?.operations;
      return operations && matchFixedShape(source,operations,permitted);
    });
    if(!row) failSupply('CURRENT_CASE_INPUT_UNAVAILABLE','setup',{operation:item.id,
      missing:'actual compiled origin operations matching document geometry/materials/quantities'});
    f.operationsSource=clone(row.operations ?? row.body?.operations ?? row.originRequest.operations);
  }
  const pair=bindRequests(template,item,f);
  if(pair.request.operations && item.bindings.some(x=>x.path==='/request/operationDigest'))
    setDerived(pair.request,item,pair.bindings,'/request/operationDigest',D(pair.request.operations.contractVersion==='region-operations/v2'?'region-operations':'operations',pair.request.operations));
  if(pair.request.expectedOperations) {
    const actual=f.origin?.operations;
    if(!actual || !matchFixedShape(template.expectedOperations,actual,
      item.bindings.map(x=>({...x,path:x.path.replace('/request/expectedOperations','/request')}))))
      failSupply('CURRENT_CASE_INPUT_UNAVAILABLE','setup',{missing:'verified origin with document exact expectedOperations'});
  }
  if(['Undo','Redo'].includes(item.id)) {
    requireValue(f.origin?.history,'durable VERIFIED linked origin');
    const intent={surface:'app/canvas-objects-history',action:item.id.toLowerCase(),sessionRef:scope.sessionRef,
      objectRef:pair.request.objectRef,historyTransactionId:pair.request.historyTransactionId};
    for(const [key,value] of [['intentDigest',sha(intent)],['surfaceActionDigest',sha({...intent,transactionId:pair.request.transactionId})]]) {
      const spec=item.bindings.find(x=>x.path==='/request/'+key);
      if(spec && pair.request[key]===spec.example) setDerived(pair.request,item,pair.bindings,spec.path,value);
    }
  }
  if(['UndoRegionCommit','UndoScopedRegionCommit'].includes(item.id) && mode==='ok') {
    if(f.origin?.kind!=='REGION' || f.origin.result?.status!=='VERIFIED' || !f.origin.originRequest)
      failSupply('CURRENT_CASE_INPUT_UNAVAILABLE','setup',{missing:'durable VERIFIED region origin request/result/before/after'});
  }
  if(['RecoverPendingUndo','ReadPendingUndoResult'].includes(item.id) && mode==='ok')
    requireValue(Object.values(f.state.pending??{}).find(x=>x.body?.requestId===pair.request.originalUndoRequestId),'actual pending original undo transaction');
  // Stale/missing business selectors and invalid inputs stay exactly as documented. They are
  // intentionally absent from the item binding table or differ from the valid example value.
  return {...pair,f};
}
async function readSourceFacts(observer,scope) {
  const summary=await getService(observer,CANVAS,'readToolSummary').readToolSummary({sessionRef:scope.sessionRef});
  return summary.source;
}
async function afterProof(observer,item,request,scope,group) {
  const disk=await observer.readDurable();
  const state=disk.state ?? await durable(observer);
  const provider=observer.provider(item.wire==='canvas-region/v3'?REGION:CANVAS);
  const replay=Object.values(state.replay ?? {}).filter(x=>x.response?.requestId===request.requestId);
  if(replay.length===1) return {value:replay[0].response,surface:'CanvasStore.readDurable',provider,
    request:{path:disk.path,requestId:request.requestId},response:clone(replay[0])};
  if(group==='local') {
    if(item.id==='display.actions') {
      const result=await getService(observer,'hanaworldsCanvasDisplay','actions').actions(scope.sessionRef);
      return {value:result,surface:'CanvasDisplay.actions independent actual read',provider,request:{sessionRef:scope.sessionRef},response:result};
    }
    if(['display.read','objectsHistory'].includes(item.id)) {
      const result=await getService(observer,CANVAS).readObjectsHistory(scope.sessionRef);
      return {value:result,surface:'Canvas.readObjectsHistory',provider,request:{sessionRef:scope.sessionRef},response:result};
    }
    if(item.id==='readScopedState') {
      const result=await localCall(observer,item.id,request);
      return {value:result,surface:'Canvas.nativeFacts.readScopedState',provider:observer.provider(FACTS),request, response:result};
    }
    if(localRoutes[item.id] && !['Error.source'].includes(item.id)) {
      const result=await localCall(observer,item.id,request);
      return {value:result,surface:item.surface,provider,request,response:result};
    }
    if(['display.undo','display.redo'].includes(item.id)) {
      const view=await getService(observer,CANVAS).readObjectsHistory(scope.sessionRef);
      const head=state.history[request.objectRef]?.at(-1);
      const transaction=head && state.transactions[head.transactionId];
      if(transaction?.receipt?.status==='VERIFIED' && transaction.objectRef===request.objectRef)
        return {value:{status:transaction.receipt.status,transactionId:head.transactionId,
          originTransactionId:head.originTransactionId,objectRef:transaction.objectRef,view},
          surface:'Canvas.readObjectsHistory + durable linked history',provider,
          request:{sessionRef:scope.sessionRef,objectRef:request.objectRef},response:{head,transaction,view}};
    }
    if(item.id==='display.changes') {
      const current=getService(observer,CANVAS).current(scope.sessionRef);
      const value={worldRef:current?.activeWorldRef ?? null,registryRevision:state.registryRevisions[current?.activeWorldRef] ?? null};
      return {value,surface:'Canvas.current + CanvasStore.readDurable',provider,request:{sessionRef:scope.sessionRef},response:{current,state}};
    }
  }
  if(['ReadWorldSelectionContext','ListWorldSelections'].includes(item.id)) {
    const body={...request,requestId:newRef('context-readback')};
    const result=await callPublic(observer,CANVAS,item.id,body);
    return {value:result,surface:'Canvas.ReadWorldSelectionContext',provider,request:body,response:result};
  }
  if(['ReserveWorldRetirement','ReleaseWorldRetirement'].includes(item.id)) {
    const row=state.worldSelections?.[scope.worldRef];
    if(row) return {resolve:path=>{
      const key=path.split('/').at(-1);
      if(key==='worldRef') return scope.worldRef;
      if(item.id==='ReleaseWorldRetirement') return row.lastRelease?.[key];
      if(key==='reservationRef') return row.reservationRef;
      if(key==='inventoryRevision') return row.inventoryRevision;
      return undefined;
    },surface:'CanvasStore.readDurable.worldSelections',provider,request:{worldRef:scope.worldRef,path:disk.path},response:row};
  }
  if(group==='events' && item.id.startsWith('AffectedObjectNotificationRequired')) {
    const decision=state.affectedDecisions?.[request.transactionId];
    if(decision) return {resolve:path=>pointer(decision,path.replace(/^\/result/,'')),
      surface:'CanvasStore.readDurable.affectedDecisions',provider,request:{transactionId:request.transactionId,path:disk.path},response:decision};
  }
  return null;
}
function outputBindings(item,requestRows,request,response,events,proof) {
  const rows=[...requestRows];
  for(const spec of item.bindings.filter(x=>!x.path.startsWith('/request/'))) {
    if(/\/materialRef$/.test(spec.path) || spec.kind==='RefKey') continue;
    const root=spec.path.startsWith('/failure/')?'failure':spec.path.startsWith('/events/')?'events':'response';
    const actual=pointer({[root]:root==='events'?events:response},spec.path);
    if(actual===undefined || actual===spec.example || typeof actual!=='string' && spec.kind!=='NativeCode') continue;
    const key=spec.path.split('/').at(-1);
    const pre=requestRows.find(x=>x.value===actual && x.kind===spec.kind);
    if(pre) { rows.push(binding(spec,actual,true)); continue; }
    if(key==='requestId' && actual===request.requestId) { rows.push(binding(spec,actual,true)); continue; }
    if(!proof) failSupply('CURRENT_OUTPUT_READBACK_UNAVAILABLE','readback',{path:spec.path,surface:item.surface ?? item.id});
    const proofPath=root==='events' ? spec.path.replace(/^\/events\/\d+\/receipt/,'') : spec.path.replace(/^\/(response|failure)/,'');
    const observed=proof.resolve ? proof.resolve(proofPath) : pointer(proof.value,proofPath);
    if(observed!==actual) failSupply('CURRENT_OUTPUT_READBACK_UNAVAILABLE','readback',{path:spec.path,surface:proof.surface});
    rows.push(binding(spec,actual,false,{surface:proof.surface,provider:proof.provider,
      request:clone(proof.request),response:clone(proof.response),observedValue:observed}));
  }
  return rows;
}
function requireBoundRequest(item,pair,{deferAnalysis=false}={}) {
  for(const spec of item.bindings.filter(x=>x.path.startsWith('/request/') && x.kind!=='RefKey')) {
    if(/\/(materialRef|geometryProfile)$/.test(spec.path) || pointer({request:pair.request},spec.path)!==spec.example) continue;
    if(pair.bindings.some(x=>x.path===spec.path)) continue;
    if(deferAnalysis && /^\/request\/(analysis(?:\/|Digest$|Revision$)|decisionRevision$)/.test(spec.path)) continue;
    failSupply('CURRENT_CASE_INPUT_UNAVAILABLE','setup',{operation:item.id,missing:spec.path});
  }
}
function bindActualRequest(item,template,actual) {
  const root={request:clone(template)},rows=[];
  for(const spec of item.bindings.filter(x=>x.path.startsWith('/request/') && x.kind!=='RefKey')) {
    if(/\/materialRef$/.test(spec.path)) continue;
    const value=pointer({request:actual},spec.path);
    if(value===undefined || pointer(root,spec.path)!==spec.example) continue;
    applyBinding(root,spec,value); rows.push(binding(spec,value,true));
  }
  for(const spec of item.bindings.filter(x=>x.path.startsWith('/request/') && x.kind==='RefKey')) {
    const parent=spec.path.slice(0,spec.path.lastIndexOf('/'));
    const keys=Object.keys(pointer({request:actual},parent) ?? {});
    if(keys.length!==1 || !applyBinding(root,spec,keys[0]))
      failSupply('CURRENT_REQUEST_DICTIONARY_BINDING_UNAVAILABLE','setup',{path:spec.path});
    rows.push(binding(spec,keys[0],true));
  }
  if(!equal(root.request,actual)) failSupply('CURRENT_CASE_DOCUMENT_SHAPE_UNAVAILABLE','setup',{operation:item.id,
    missing:'actual request matching the complete document after opaque scalar binding'});
  return {request:root.request,bindings:rows};
}
async function prepareAnalysis(observer,pair,item) {
  if(!['ApplyRecoverableCommit','DecideAffectedObjectNotification'].includes(item.id)) return;
  const analysisItem=callItems.get('AnalyzeAffectedObjects');
  const prepared=await prepareRequest(observer,analysisItem,analysisItem.request,pair.f.scope,'ok','setup');
  const actual={...prepared.request,transactionId:pair.request.transactionId};
  if(pair.request.operations) actual.operations=clone(pair.request.operations);
  actual.operationDigest=D('operations',actual.operations);
  const bound=bindActualRequest(analysisItem,analysisItem.request,actual);
  requireBoundRequest(analysisItem,bound);
  await requireMaterials(observer,bound.request,pair.f.scope);
  const response=await callPublic(observer,CANVAS,'AnalyzeAffectedObjects',bound.request);
  validateBoundResponse('canvas/v7','AnalyzeAffectedObjects',bound.request,response);
  if(response.error) failSupply('CURRENT_ANALYSIS_UNAVAILABLE','setup',{response});
  const state=await durable(observer),analysis=state.analyses?.[pair.request.transactionId];
  if(!analysis || !equal(analysis,response.result)) failSupply('CURRENT_ANALYSIS_READBACK_UNAVAILABLE','setup');
  pair.f.analysis=clone(analysis); pair.f.state=state;
  for(const spec of item.bindings.filter(x=>x.path.startsWith('/request/analysis/'))) {
    const value=pointer(analysis,spec.path.slice('/request/analysis'.length));
    if(value!==undefined && pointer({request:pair.request},spec.path)===spec.example)
      setDerived(pair.request,item,pair.bindings,spec.path,value);
  }
  if(pair.request.analysis && !equal(pair.request.analysis,analysis))
    failSupply('CURRENT_CASE_DOCUMENT_SHAPE_UNAVAILABLE','setup',{operation:item.id,missing:'actual analysis with document exact collections'});
  for(const field of ['analysisDigest','analysisRevision']) {
    const spec=item.bindings.find(x=>x.path==='/request/'+field);
    if(spec && pair.request[field]===spec.example) setDerived(pair.request,item,pair.bindings,spec.path,D('affected-analysis',analysis));
  }
  if(pair.request.decisionRevision!==undefined && pair.request.decisionRevision!==null) {
    const decision=state.affectedDecisions?.[pair.request.transactionId];
    if(decision) setDerived(pair.request,item,pair.bindings,'/request/decisionRevision',decision.decisionRevision);
  }
  const expected=item.bindings.find(x=>x.path==='/request/expectedDecisionRevision');
  if(expected && pair.request.expectedDecisionRevision===expected.example) {
    let decision=state.affectedDecisions?.[pair.request.transactionId];
    if(!decision && pair.request.decision==='NO_NOTIFICATION') {
      // A documented non-null CAS needs an actual predecessor. Persist it through the
      // normal public Decision API; this setup is completed before the case baseline.
      const initial={...clone(pair.request),requestId:newRef('initial-decision'),expectedDecisionRevision:null};
      delete initial.unexpectedRequired;
      const first=await callPublic(observer,CANVAS,'DecideAffectedObjectNotification',initial);
      validateBoundResponse('canvas/v7','DecideAffectedObjectNotification',initial,first);
      if(first.error) failSupply('CURRENT_INITIAL_DECISION_UNAVAILABLE','setup',{request:initial,response:first});
      decision=(await durable(observer)).affectedDecisions?.[pair.request.transactionId];
      if(!decision || !equal(decision,first.result)) failSupply('CURRENT_INITIAL_DECISION_READBACK_UNAVAILABLE','readback');
    }
    if(decision) setDerived(pair.request,item,pair.bindings,expected.path,decision.decisionRevision);
  }
  return {request:clone(bound.request),response:clone(response)};
}
async function ensureHistory(observer,scope,mode='CELL') {
  const canvas=getService(observer,CANVAS);
  const actions=await canvas.readHistoryActions(scope.sessionRef);
  const existing=actions.objects.find(x=>x.mode===mode && x.undo?.available);
  if(existing) return existing;
  const item=callItems.get(mode==='CELL'?'ApplyRecoverableCommit':'ApplyRegionCommit');
  const pair=await prepareRequest(observer,item,item.request,scope,'ok','setup');
  await requireMaterials(observer,pair.request,scope);
  if(mode==='CELL') {
    await prepareAnalysis(observer,pair,item);
    // This is a normal setup transaction, separate from the locked sample assertion.
    // The actual public analysis offers no notification only when no object is affected.
    if(pair.f.analysis.affectedObjectRefs.length)
      failSupply('CURRENT_CASE_INPUT_UNAVAILABLE','setup',{missing:'unoccupied document material/position for verified history'});
    pair.request.decisionRevision=null;
  }
  const response=await callPublic(observer,mode==='CELL'?CANVAS:REGION,item.id,pair.request);
  if(response.error || (response.result?.outcome ?? response.result)?.status!=='VERIFIED')
    failSupply('CURRENT_VERIFIED_HISTORY_UNAVAILABLE','setup',{operation:item.id,request:pair.request,response});
  const readback=await canvas.readHistoryActions(scope.sessionRef);
  const actual=readback.objects.find(x=>x.mode===mode && x.undo?.available);
  if(!actual) failSupply('CURRENT_VERIFIED_HISTORY_READBACK_UNAVAILABLE','setup',{response:readback});
  return actual;
}
async function requireMaterials(observer,request,scope) {
  if(!request.operations) return;
  const materials=new Set();
  const walk=value=> {
    if(!value || typeof value!=='object') return;
    if(Object.hasOwn(value,'materialRef')) materials.add(value.materialRef);
    for(const child of Object.values(value)) walk(child);
  }; walk(request.operations);
  if(!materials.size) return;
  const body={contractVersion:'world-facts/v1',requestId:newRef('catalogue'),worldRef:scope.worldRef};
  const response=await callPublic(observer,FACTS,'ReadCatalogue',body);
  validateBoundResponse('world-facts/v1','ReadCatalogue',body,response);
  if(response.error) failSupply('CURRENT_MATERIAL_CATALOGUE_UNAVAILABLE','setup',{response});
  const catalogue=validateType('Catalogue',response.result.catalogue);
  const registered=new Set(Object.keys(catalogue.materials));
  const missing=[...materials].filter(x=>!registered.has(x));
  if(missing.length) failSupply('DOCUMENT_MATERIAL_UNAVAILABLE','setup',{worldRef:scope.worldRef,materials:missing,
    surface:'world-facts/v1.ReadCatalogue',request:body,response});
}
export function createExecutor(ctx,observer) {
  if(!observer || !['service','provider','readDurable','begin','checkpoint','finish','inspect'].every(x=>typeof observer[x]==='function'))
    failSupply('OFFICIAL_OBSERVER_UNAVAILABLE','setup');
  const pending=new Map(),replays=new Map(),caseScopes=new Map();
  const scopeFor=(caseId,positions)=>{
    const scope=caseScopes.get(caseId);
    if(!scope) failSupply('CURRENT_CASE_SESSION_NOT_PREPARED','setup',{caseId,missing:'normal official client sessions.create + actual ReadSessionIdentity + Canvas selection'});
    return {...clone(scope),positions:positions.length?positions:clone(scope.positions)};
  };
  async function casePrepare(caseId,phase) {
    if(Object.keys(phase).some(x=>!['phase','sessionRef','mode'].includes(x)) || typeof phase.sessionRef!=='string' || !phase.sessionRef || !['ok','reject','replay'].includes(phase.mode))
      failSupply('CASE_SESSION_INPUT_NOT_ALLOWED','setup',{caseId});
    if (phase.mode === 'replay') {
      const prior = replays.get(caseId);
      if (!prior || prior.f.scope.sessionRef !== phase.sessionRef) failSupply('CURRENT_REPLAY_SESSION_UNAVAILABLE','setup',{caseId});
      const liveIdentity = await callPublic(observer,'hanaworldsWorkshopV3','ReadSessionIdentity', {contractVersion:'session/v5',requestId:newRef('replay-identity'),sessionRef:phase.sessionRef});
      if (liveIdentity.error) failSupply('CURRENT_REPLAY_SESSION_IDENTITY_UNAVAILABLE','setup',{response:liveIdentity});
      caseScopes.set(caseId, clone(prior.f.scope));
      return {sessionRef:phase.sessionRef,worldRef:prior.f.scope.worldRef,identity:liveIdentity.result};
    }
    if([...caseScopes.values()].some(x=>x.sessionRef===phase.sessionRef))
      failSupply('CASE_SESSION_NOT_ISOLATED','setup',{caseId});
    const identityRequest={contractVersion:'session/v5',requestId:newRef('case-identity'),sessionRef:phase.sessionRef};
    const identityResponse=await callPublic(observer,'hanaworldsWorkshopV3','ReadSessionIdentity',identityRequest);
    validateBoundResponse('session/v5','ReadSessionIdentity',identityRequest,identityResponse);
    if(identityResponse.error) failSupply('CURRENT_CASE_SESSION_IDENTITY_UNAVAILABLE','setup',{request:identityRequest,response:identityResponse});
    const canvas=getService(observer,CANVAS);
    await canvas.ready;
    if(canvas.current(phase.sessionRef)) failSupply('CASE_SESSION_NOT_NEW','setup',{caseId});
    const discoverRequest={contractVersion:'world-adapter/v8',requestId:newRef('case-discover'),sessionRef:phase.sessionRef,adapterId:canvas.adapterId};
    const inventory=await callPublic(observer,'hanaworldsWorldAdapterV6','DiscoverConnections',discoverRequest);
    validateBoundResponse('world-adapter/v8','DiscoverConnections',discoverRequest,inventory);
    if(inventory.error) failSupply('CURRENT_CASE_CONNECTIONS_UNAVAILABLE','setup',{request:discoverRequest,response:inventory});
    // Session isolation comes from the official create API. Reuse the actual
    // current local world so later history cases can read its real commits;
    // never require a fabricated world per case or reset a provider's store.
    const target=inventory.result.connections.find(x=>x.readiness==='READY');
    if(!target) failSupply('CURRENT_CASE_WORLD_UNAVAILABLE','setup',{inventory:inventory.result});
    const connectionRequest={contractVersion:'world-adapter/v8',requestId:newRef('case-connection'),sessionRef:phase.sessionRef,connectionRef:target.connectionRef};
    const connection=await callPublic(observer,'hanaworldsWorldAdapterV6','ReadLocalConnection',connectionRequest);
    validateBoundResponse('world-adapter/v8','ReadLocalConnection',connectionRequest,connection);
    if(connection.error || connection.result.worldRef!==target.worldRef || connection.result.connectionIncarnationRef!==target.connectionIncarnationRef)
      failSupply('CURRENT_CASE_CONNECTION_CHANGED','setup',{request:connectionRequest,response:connection});
    let localContext;
    const unboundRetirement=['ReserveWorldRetirement','ReleaseWorldRetirement'].includes(caseId);
    const testedSelect=unboundRetirement || caseId==='SelectWorldConnection' || caseId==='event/WorldConnectionSelectionChanged-SelectWorldConnection';
    if(!testedSelect) {
      const selectRequest={contractVersion:'canvas/v7',sessionRef:phase.sessionRef,requestId:newRef('case-select'),worldRef:target.worldRef,connectionRef:target.connectionRef,
        expectedRevision:identityResponse.result.sessionRevision,expectedContext:null,connectionIncarnationRef:target.connectionIncarnationRef};
      const selected=await canvas.call('SelectWorldConnection',selectRequest);
      if(selected.error) failSupply('CURRENT_CASE_WORLD_SELECTION_UNAVAILABLE','setup',{request:selectRequest,response:selected});
      localContext=selected.result.localContext;
    }
    const scope={sessionRef:phase.sessionRef,worldRef:target.worldRef,connectionRef:target.connectionRef,
      localContext:localContext ?? null,identity:identityResponse.result,connection:connection.result,
      positions:casePositions(callItems.get('ApplyRecoverableCommit').request)};
    if (caseId === 'ReleaseWorldRetirement') {
      const inventoryResponse = await canvas.call('ListWorldSelections',{contractVersion:'canvas/v7',requestId:newRef('release-inventory'),worldRef:scope.worldRef});
      if (inventoryResponse.error || inventoryResponse.result.sessionRefs.length) failSupply('CURRENT_RETIRABLE_WORLD_UNAVAILABLE','setup',{response:inventoryResponse});
      const reserved = await canvas.call('ReserveWorldRetirement',{contractVersion:'canvas/v7',requestId:newRef('release-reserve'),worldRef:scope.worldRef,expectedInventoryRevision:inventoryResponse.result.inventoryRevision});
      if (reserved.error) failSupply('CURRENT_RETIREMENT_RESERVATION_UNAVAILABLE','setup',{response:reserved});
      scope.reservationRef=reserved.result.reservationRef;
    }
    caseScopes.set(caseId,scope);
    return {sessionRef:scope.sessionRef,worldRef:scope.worldRef,selection:clone(canvas.current(scope.sessionRef)),identity:identityResponse.result};
  }
  const snapshot=scope=>snapshotActual(observer,scope);
  const providerFor=item=>observer.provider(item.wire==='canvas-region/v3'?REGION:
    ['readScopedState','Error.source'].includes(item.id)?FACTS:CANVAS);
  async function finishExchange(item,mode,pair,before,token,group,response,extra={},captured=null) {
    // Close collection before the independent reads: snapshot read diagnostics are never business calls.
    const capture=captured ?? await observer.finish(token);
    const after=await snapshot(pair.f.scope);
    let proof;
    if(!response?.error && !response?.publicError && !response?.code)
      proof=await afterProof(observer,item,pair.request,pair.f.scope,group);
    const dynamicLocal=group==='local' && ['readToolSummary','readScopedState','Error.source','historyActions','engineSafety','compilerConfig','configSupply'].includes(item.id) && mode==='ok';
    const rows=dynamicLocal ? pair.bindings : outputBindings(item,pair.bindings,pair.request,response,capture.events,proof);
    return {caseId:item.id,mode,execution:'INSTALLED_CLIENT_TO_REGISTERED_PROVIDER',provider:providerFor(item),
      request:clone(pair.request),response:clone(response),events:clone(capture.events),before,after,
      adapterCalls:clone(capture.adapterCalls),worldWrites:clone(capture.worldWrites),publicCalls:clone(capture.publicCalls),bindings:rows,...extra};
  }
  async function publicPrepareChain(pair,item,token) {
    const documentSteps=item.prepareChain?.steps;
    if(!documentSteps?.length) failSupply('DOCUMENT_PREPARE_CHAIN_UNAVAILABLE','setup',{operation:item.id});
    const steps=[];
    for(const [index,sample] of documentSteps.entries()) {
      const stepItem={...callItems.get(sample.operation),bindings:sample.bindings};
      let actual;
      if(sample.mode==='replay') {
        const previous=steps.at(-1);
        if(!previous || previous.operation!==sample.operation) failSupply('DOCUMENT_PREPARE_CHAIN_INVALID','setup');
        actual=clone(previous.request);
      } else {
        const facts={...pair.f,state:await durable(observer),requestId:newRef('prepare-'+index),transactionId:pair.request.transactionId};
        const prepared=bindRequests(sample.request,stepItem,facts);
        actual=prepared.request;
        if(sample.operation==='AnalyzeAffectedObjects') {
          actual.operations=clone(pair.request.operations);
          actual.operationDigest=pair.request.operationDigest;
        }
      }
      const bound=bindActualRequest(stepItem,sample.request,actual);
      requireBoundRequest(stepItem,bound);
      const start=await observer.checkpoint(token);
      const response=await callPublic(observer,CANVAS,sample.operation,bound.request);
      const end=await observer.checkpoint(token);
      validateBoundResponse('canvas/v7',sample.operation,bound.request,response);
      if(response.error) failSupply('CURRENT_PREPARE_CHAIN_FAILED','call',{operation:sample.operation,request:bound.request,response});
      const proof=await afterProof(observer,stepItem,bound.request,pair.f.scope,'prepare');
      if(!proof || !equal(proof.value,response)) failSupply('CURRENT_PREPARE_CHAIN_READBACK_UNAVAILABLE','readback',{operation:sample.operation});
      const step={operation:sample.operation,mode:sample.mode,request:clone(bound.request),response:clone(response),
        requestBindings:bound.bindings,proof,start,end};
      if(sample.operation==='AnalyzeAffectedObjects') {
        pair.f.analysis=clone(response.result);
        if(response.result.affectedObjectRefs.length || response.result.orderedSelectedRefs.length)
          failSupply('CURRENT_NO_NOTIFICATION_SCENARIO_UNAVAILABLE','setup',{request:bound.request,response});
        setDerived(pair.request,item,pair.bindings,'/request/analysisDigest',D('affected-analysis',response.result));
        if(pair.request.expectedWorldRevision!==response.result.worldRevision)
          failSupply('CURRENT_ANALYSIS_WORLD_REVISION_MISMATCH','readback');
      } else if(sample.operation==='DecideAffectedObjectNotification') {
        if(response.result.decisionKind!=='NO_NOTIFICATION' || response.result.affectedObjectRefs.length || response.result.orderedSelectedRefs.length)
          failSupply('CURRENT_NO_NOTIFICATION_SCENARIO_UNAVAILABLE','readback',{response});
        if(sample.mode==='replay') {
          if(!equal(steps.at(-1).request,bound.request) || !equal(steps.at(-1).response,response))
            failSupply('CURRENT_DECISION_REPLAY_MISMATCH','readback');
          setDerived(pair.request,item,pair.bindings,'/request/decisionRevision',response.result.decisionRevision);
        }
      }
      steps.push(step);
    }
    if(pair.request.decisionRevision!==null && !steps.some(x=>x.operation==='DecideAffectedObjectNotification' && x.mode==='replay'))
      failSupply('CURRENT_DECISION_REPLAY_UNAVAILABLE','setup');
    return steps;
  }
  function chainResult(steps,document,capture) {
    const slice=(key,start,end)=>{
      if(!Number.isSafeInteger(start[key]) || !Number.isSafeInteger(end[key]) || start[key]<0 || end[key]<start[key] || end[key]>capture[key].length)
        failSupply('CURRENT_CAPTURE_BOUNDARY_INVALID','readback',{key});
      return clone(capture[key].slice(start[key],end[key]));
    };
    return {steps:steps.map((step,index)=>{
      const events=slice('events',step.start,step.end),worldWrites=slice('worldWrites',step.start,step.end);
      const item={id:step.operation,bindings:document.steps[index].bindings};
      return {operation:step.operation,mode:step.mode,request:step.request,response:step.response,events,worldWrites,
        adapterCalls:slice('adapterCalls',step.start,step.end),publicCalls:slice('publicCalls',step.start,step.end),
        actualBindings:outputBindings(item,step.requestBindings,step.request,step.response,events,step.proof)};
    })};
  }
  async function wireCase(original,mode,group='cases',descriptorId=null) {
    if(!['ok','reject','replay'].includes(mode) || mode==='replay' && !['events','scenarios'].includes(group))
      failSupply('CASE_MODE_NOT_ALLOWED','setup',{caseId:original.id,mode});
    const metadata=group==='events'?eventItems.get(descriptorId):group==='scenarios'?scenarioItems.get(descriptorId):null;
    const operation=group==='events' && metadata.name==='TransactionVerified'?'ApplyRecoverableCommit':
      group==='scenarios'?metadata.operation:original.id;
    const item=metadata?{...original,id:operation,bindings:metadata.bindings,prepareChain:metadata.prepareChain}:
      group==='business'?{...original,prepareChain:callItems.get(operation)?.prepareChain}:original;
    const caseId=group==='events'?'event/'+descriptorId:group==='scenarios'?'scenario/'+descriptorId:group==='business'?'business/'+item.id:item.id;
    const template=metadata?metadata[mode==='ok'?'success':mode==='reject'?'refusal':'replay'].request:
      group==='business'?item.request:mode==='reject'?item.invalidRequest:item.request;
    const scope=scopeFor(caseId,casePositions(template));
    let pair,previous;
    if(mode==='replay') {
      previous=replays.get(caseId);
      if(!previous) failSupply('CURRENT_REPLAY_ORIGIN_UNAVAILABLE','setup',{caseId});
      pair=clone(previous); pair.f.scope=scope;
    } else {
      pair=await prepareRequest(observer,item,template,scope,mode,group);
      if(operation==='DecideAffectedObjectNotification') await prepareAnalysis(observer,pair,item);
      if(mode==='ok') {
        await requireMaterials(observer,pair.request,scope);
        if(['Undo','Redo','UndoRegionCommit','UndoScopedRegionCommit'].includes(operation) && !pair.f.origin)
          failSupply('CURRENT_CASE_INPUT_UNAVAILABLE','setup',{missing:'independent verified movable history'});
      }
      // Decode-refusal inputs remain unchanged; their non-error references must still be actual.
      // Apply's document chain derives analysis/decision scalars inside the capture on success.
      requireBoundRequest(item,pair,{deferAnalysis:operation==='ApplyRecoverableCommit'});
      if(operation==='ApplyRecoverableCommit' && mode==='reject') {
        await prepareAnalysis(observer,pair,item);
        if(pair.request.decisionRevision!==null && !pair.bindings.some(x=>x.path==='/request/decisionRevision')) {
          // Run the same approved public preparation before the refusal baseline. No predicted decision.
          const setupToken=await observer.begin({...scope,caseId:caseId+'/preparation'});
          try { await publicPrepareChain(pair,item,setupToken); }
          finally { await observer.finish(setupToken); }
        }
        requireBoundRequest(item,pair);
      }
    }
    const before=await snapshot(scope),token=await observer.begin({...scope,caseId,requestId:pair.request.requestId,
      transactionId:pair.request.transactionId ?? pair.request.undoTransactionId});
    let response,prepared=[];
    try {
      if(operation==='ApplyRecoverableCommit' && mode==='ok') prepared=await publicPrepareChain(pair,item,token);
      requireBoundRequest(item,pair);
      response=await callPublic(observer,item.wire==='canvas-region/v3'?REGION:CANVAS,operation,pair.request);
    } catch(error) { await observer.finish(token); throw error; }
    const captured=await observer.finish(token),extra={};
    if(metadata) extra.actualTrigger={operation,request:clone(pair.request),response:clone(response)};
    if(prepared.length) extra.prepareChain=chainResult(prepared,item.prepareChain,captured);
    if(metadata?.name==='AffectedObjectNotificationRequired' && mode!=='reject') {
      const disk=await observer.readDurable(),state=disk.state ?? await durable(observer);
      const decision=requireValue(state.affectedDecisions?.[pair.request.transactionId],'actual durable Analyzer notification decision','readback');
      let receipt;
      if(mode==='ok') {
        const events=captured.events.filter(x=>x.event===metadata.name && x.receipt?.requestId===pair.request.requestId);
        if(events.length!==1) failSupply('CURRENT_AFFECTED_OBJECT_NOTIFICATION_UNAVAILABLE','readback',{events:captured.events});
        receipt=clone(events[0].receipt);
      } else {
        receipt=requireValue(previous.internalDecision?.response,'prior actual event receipt','readback');
        extra.internalDecisionSource='PRIOR_DURABLE_RECEIPT_NOT_ANALYZER_RETURN';
      }
      if(!equal(receipt.result,decision)) failSupply('CURRENT_NOTIFICATION_DURABLE_RECEIPT_MISMATCH','readback');
      extra.internalDecision={operation:'DecideAffectedObjectNotification',response:clone(receipt)};
      const proof={resolve:path=>path==='/requestId'?pair.request.requestId:pointer(decision,path.replace(/^\/result/,'')),
        surface:'CanvasStore.readDurable.affectedDecisions',provider:observer.provider(CANVAS),
        request:{path:disk.path,transactionId:pair.request.transactionId},response:clone(decision)};
      const internalItem={id:operation,bindings:metadata.internalDecisionBindings};
      extra.internalDecisionBindings=outputBindings(internalItem,pair.bindings,pair.request,receipt,[],proof)
        .filter(x=>metadata.internalDecisionBindings.some(s=>s.path===x.path));
      // Event decision fields use the independently durable decision, while Analyzer fields
      // use its independently persisted public replay. Never compare two different receipts.
      const analyzerProof=await afterProof(observer,item,pair.request,scope,group);
      extra.notificationProof={analyzerProof,decisionProof:proof};
    }
    if(['UndoRegionCommit','UndoScopedRegionCommit'].includes(operation) && mode==='ok') {
      extra.origin=clone(pair.f.origin); extra.originReadBeforeCall=true;
    }
    if(extra.notificationProof) {
      const {analyzerProof,decisionProof}=extra.notificationProof; delete extra.notificationProof;
      const after=await snapshot(scope);
      const normal=outputBindings({...item,bindings:item.bindings.filter(x=>!x.path.startsWith('/events/'))},pair.bindings,pair.request,response,[],analyzerProof);
      const eventRows=outputBindings({...item,bindings:item.bindings.filter(x=>x.path.startsWith('/events/'))},pair.bindings,pair.request,response,captured.events,decisionProof)
        .filter(x=>x.path.startsWith('/events/'));
      if(mode==='ok') replays.set(caseId,{...clone(pair),internalDecision:clone(extra.internalDecision)});
      return {caseId:descriptorId,mode,execution:'INSTALLED_CLIENT_TO_REGISTERED_PROVIDER',provider:providerFor(item),
        request:clone(pair.request),response:clone(response),events:clone(captured.events),before,after,
        adapterCalls:clone(captured.adapterCalls),worldWrites:clone(captured.worldWrites),publicCalls:clone(captured.publicCalls),bindings:[...normal,...eventRows],...extra};
    }
    const value=await finishExchange(metadata?{...item,id:descriptorId}:item,mode,pair,before,token,group,response,extra,captured);
    if(mode==='ok' && metadata) replays.set(caseId,clone(pair));
    return value;
  }
  async function localCase(item,mode) {
    if(!['ok','reject'].includes(mode)) failSupply('CASE_MODE_NOT_ALLOWED','setup',{caseId:item.id,mode});
    if(item.id==='panelId' || item.id.startsWith('display.'))
      failSupply('CLIENT_REMOTE_EXECUTION_REQUIRED','call',{caseId:item.id,phase:'local-prepare'});
    const template=mode==='ok'?item.request:item.invalidRequest;
    const positions=casePositions(template);
    const scope=scopeFor('local/'+item.id,positions);
    if(mode==='ok' && ['readToolSummary','historyActions','objectsHistory','historyFacts','footprintRegistry'].includes(item.id))
      await ensureHistory(observer,scope);
    const pair=await prepareRequest(observer,item,template,scope,mode,'local');
    const extra={};
    if(mode==='ok') {
      if(item.id==='readToolSummary') {
        extra.sourceBefore=await readSourceFacts(observer,scope);
        extra.historyBefore=await getService(observer,CANVAS).readObjectsHistory(scope.sessionRef);
      } else if(item.id==='readScopedState') extra.sourceBefore=await localCall(observer,item.id,pair.request);
      else if(['historyActions','engineSafety','compilerConfig','configSupply'].includes(item.id)) {
        extra.sourceReadBeforeCall=true;
        extra.sourceBefore=await localCall(observer,item.id,pair.request);
        if(['compilerConfig','configSupply'].includes(item.id)) {
          const request={contractVersion:'world-facts/v1',requestId:newRef('write-profile'),worldRef:scope.worldRef};
          const response=await callPublic(observer,FACTS,'ReadWriteProfile',request);
          validateBoundResponse('world-facts/v1','ReadWriteProfile',request,response);
          if(response.error) failSupply('CURRENT_WRITE_PROFILE_UNAVAILABLE','setup',{request,response});
          extra.worldSourceCompilationConfig=requireValue(response.result.compilationConfig,'public world-source CompilationConfig');
        }
      } else if(item.id==='Error.source') {
        try { await localCall(observer,item.id,pair.request); }
        catch(error) { extra.observedSourceError=requireValue(error.publicError,'actual public source Error'); }
        if(!extra.observedSourceError) failSupply('CURRENT_SOURCE_ERROR_SCENARIO_UNAVAILABLE','setup',{
          request:pair.request,missing:'actual source failure for the exact documented positions'});
      }
    }
    const before=await snapshot(scope),token=await observer.begin({...scope,caseId:item.id});
    let response;
    try { response=await localCall(observer,item.id,pair.request); }
    catch(error) { if(error instanceof SupplyFailure) { await observer.finish(token); throw error; } response=publicFailure(error); }
    return finishExchange(item,mode,pair,before,token,'local',response,extra);
  }
  async function localPrepare(item,mode,clientDOM=null) {
    if(!['ok','reject'].includes(mode)) failSupply('CASE_MODE_NOT_ALLOWED','setup',{caseId:item.id,mode});
    if(pending.has('local/'+item.id)) failSupply('CASE_ALREADY_RUNNING','setup',{caseId:item.id});
    const scope=scopeFor('local/'+item.id,casePositions(callItems.get('ApplyRecoverableCommit').request));
    if(mode==='ok' && ['display.read','display.actions','display.undo','display.redo','display.changes'].includes(item.id))
      await ensureHistory(observer,scope);
    if(mode==='ok' && item.id==='display.redo') {
      const actions=await getService(observer,CANVAS).readHistoryActions(scope.sessionRef);
      if(!actions.objects.some(x=>x.redo?.available)) {
        const object=actions.objects.find(x=>x.mode==='CELL' && x.undo?.available);
        if(!object) failSupply('CURRENT_REDO_ORIGIN_UNAVAILABLE','setup');
        const response=await getService(observer,'hanaworldsCanvasDisplay','undo').undo(scope.sessionRef,object.objectRef,object.undo.historyTransactionId);
        if(response.status!=='VERIFIED') failSupply('CURRENT_REDO_ORIGIN_UNAVAILABLE','setup',{response});
      }
    }
    const template=mode==='ok'?item.request:item.invalidRequest;
    const pair=await prepareRequest(observer,item,template,scope,mode,'local');
    if(item.id==='panelId' && mode==='ok') {
      if(!clientDOM || typeof clientDOM.mainKey!=='string' || !clientDOM.mainKey || clientDOM.sidebarTarget!==clientDOM.mainKey)
        failSupply('CURRENT_PANEL_REGISTRATION_UNAVAILABLE','setup');
      setDerived(pair.request,item,pair.bindings,'/request/panelId',clientDOM.mainKey);
    }
    const before=await snapshot(scope),token=await observer.begin({...scope,caseId:item.id});
    pending.set('local/'+item.id,{item,mode,pair,before,token});
    return {request:clone(pair.request),sessionRef:scope.sessionRef,targetObjectRef:pair.f.object?.objectRef ?? null,
      historyTransactionId:pair.f.originId ?? null,before};
  }
  async function localFinish(item,phase) {
    const state=pending.get('local/'+item.id);
    if(!state || phase.mode!==state.mode || !equal(phase.request,state.pair.request))
      failSupply('CLIENT_CASE_INPUT_MISMATCH','call',{caseId:item.id});
    if(Object.keys(phase).some(x=>!['phase','mode','request','response','dom','actions'].includes(x)))
      failSupply('CLIENT_CASE_FIELDS_NOT_ALLOWED','call',{caseId:item.id});
    if(item.id==='panelId') {
      validateDOM(phase.dom,phase.actions,'panelId');
      if(state.mode==='ok') {
        const key=phase.dom.mainKey;
        requireValue(key,'actual registered panel key');
        if(phase.dom.sidebarTarget!==key || phase.dom.selectedPanelId!==key)
          failSupply('CURRENT_PANEL_NAVIGATION_UNAVAILABLE','call');
        const spec=item.bindings.find(x=>x.path==='/request/panelId');
        setDerived(state.pair.request,item,state.pair.bindings,spec.path,key);
      }
    }
    if(state.mode==='ok' && item.id.startsWith('display.')) {
      const proof=await afterProof(observer,item,state.pair.request,state.pair.f.scope,'local');
      if(!proof || !equal(proof.value,phase.response))
        failSupply('CLIENT_REMOTE_RESPONSE_READBACK_MISMATCH','readback',{caseId:item.id,surface:proof?.surface ?? null});
    }
    pending.delete('local/'+item.id);
    return finishExchange(item,state.mode,state.pair,state.before,state.token,'local',phase.response);
  }
  function validateDOM(dom,actions,id) {
    if(!dom || typeof dom!=='object' || Array.isArray(dom) || typeof dom.canvasPanels!=='number' || typeof dom.text!=='string')
      failSupply('ACTUAL_PRODUCT_DOM_UNAVAILABLE','call',{caseId:id});
    const domKeys=['canvasPanels','text','mainKey','sidebarTarget','selectedPanelId','mainEntryPresent','sidebarEntryPresent','remoteNamespacePresent','oldTargetAccepted'];
    if(Object.keys(dom).some(x=>!domKeys.includes(x))) failSupply('UI_DOM_FIELDS_NOT_ALLOWED','call',{caseId:id});
    if(!Array.isArray(actions) || actions.some(x=>!x || Object.keys(x).some(k=>!['kind','label','panelId'].includes(k)) ||
      typeof x.kind!=='string' || typeof x.label!=='string')) failSupply('UI_ACTION_FIELDS_NOT_ALLOWED','call',{caseId:id});
    const allow={navigation:['sidebar','sidebar-click','navigation','registry-navigation'],
      'populated-history':['sidebar','sidebar-click','navigation','registry-navigation'],
      'undo-redo':['sidebar','sidebar-click','navigation','registry-navigation','undo','redo','confirm','history-action','product-undo','product-redo','product-confirm'],
      'configuration-reload':['sidebar','manager','configuration','setting','save','reload'],
      region:['sidebar','undo'],
      'visible-error':['sidebar','refresh','undo','redo'],
      unload:['sidebar','manager','uninstall','confirm-uninstall'],panelId:['sidebar','manager','configuration','setting','save','reload']};
    const kinds=allow[id] ?? [];
    if(actions.some(x=>!kinds.includes(x.kind))) failSupply('UI_ACTION_NOT_ALLOWED','call',{caseId:id,kinds:actions.map(x=>x.kind)});
    if(id!=='unload' && dom.canvasPanels<1) failSupply('ACTUAL_PRODUCT_PANEL_UNAVAILABLE','call',{caseId:id});
  }
  function actualPlacement(canvas) {
    const value=clone(canvas.placementConfig);
    if(!value || Object.keys(value).length!==placementKeys.length || placementKeys.some(x=>
      !Object.hasOwn(value,x) || !Number.isSafeInteger(value[x]) || value[x]<0))
      failSupply('CURRENT_PLACEMENT_CONFIGURATION_UNAVAILABLE','setup',{surface:'Canvas.config.placement'});
    return value;
  }
  async function regionRefusalScope(primary) {
    const data=await durable(observer);
    const item=callItems.get('ApplyRegionCommit');
    for(const [sessionRef,selection] of Object.entries(data.sessions ?? {})) {
      if(selection.activeWorldRef===primary.worldRef || !selection.localContext) continue;
      const identityRequest={contractVersion:'session/v5',requestId:newRef('region-refusal-identity'),sessionRef};
      const identity=await callPublic(observer,'hanaworldsWorkshopV3','ReadSessionIdentity',identityRequest);
      validateBoundResponse('session/v5','ReadSessionIdentity',identityRequest,identity);
      if(identity.error) continue;
      const readRequest={contractVersion:'world-adapter/v8',requestId:newRef('region-refusal-source'),sessionRef,connectionRef:selection.localContext.connectionRef};
      const read=await callPublic(observer,'hanaworldsWorldAdapterV6','ReadLocalConnection',readRequest);
      validateBoundResponse('world-adapter/v8','ReadLocalConnection',readRequest,read);
      if(read.error) continue;
      const geometry=read.result.capabilities.worldGeometry;
      if(geometry && geometry.geometryProfiles.includes('voxel-grid/v1') && equal(geometry.partition,item.request.operations.partition)) continue;
      const scope={sessionRef,worldRef:selection.activeWorldRef,connectionRef:selection.localContext.connectionRef,
        localContext:clone(selection.localContext),identity:identity.result,positions:casePositions(item.request)};
      const pair=await prepareRequest(observer,item,item.request,scope,'ok','ui');
      return {scope,request:pair.request,source:read.result};
    }
    failSupply('CURRENT_UI_REGION_REFUSAL_SCENARIO_UNAVAILABLE','setup',{missing:'a real current source that rejects the exact documented voxel-grid/partition; no material/geometry mutation permitted'});
  }
  async function confirmedPlacementInput(scope) {
    const data=await durable(observer);
    const candidates=[...(observer.confirmedPlacements?.values() ?? [])];
    for(const row of candidates) {
      const request=row.request;
      if(request?.contractVersion!=='canvas/v7' || request.sessionRef!==scope.sessionRef || request.worldRef!==scope.worldRef || !request.regionInspectionBinding?.build) continue;
      const inspection=data.placementInspections?.[request.regionInspectionBinding.inspectionId];
      if(!inspection || inspection.sessionRef!==scope.sessionRef || inspection.worldRef!==scope.worldRef || !equal(inspection.localContext,scope.localContext)) continue;
      validateType('BuildProjection',request.regionInspectionBinding.build);
      const source=clone(request);
      // Retain the actual original BuildProjection/confirmedPlacement/operations bytes; no
      // document placeholder Build is promoted into a supplied CompiledBuild.
      const transaction=data.transactions[request.transactionId];
      if(transaction?.receipt?.status!=='VERIFIED' || transaction.receipt.transactionId!==row.response?.result?.transactionId) continue;
      return {request:source,inspection:clone(inspection),origin:clone(transaction),observation:clone(row)};
    }
    failSupply('CURRENT_CONFIRMED_PLACEMENT_BUILD_UNAVAILABLE','setup',{missing:'actual VERIFIED original canvas/v7 request.regionInspectionBinding.build associated with a retained real inspection in this isolated Session'});
  }
  async function rejectOldInspection(state) {
    const scope=state.scope,canvas=getService(observer,CANVAS);
    const facts=await preFacts(observer,scope,'ApplyRecoverableCommit');
    const request=clone(state.confirmedPlacement.request);
    request.sessionRef=scope.sessionRef; request.requestId=newRef('old-inspection-apply'); request.transactionId=newRef('old-inspection-transaction');
    request.localContext=clone(canvas.current(scope.sessionRef).localContext);
    request.expectedWorldRevision=facts.state.worldRevisions[scope.worldRef];
    request.operationDigest=D('operations',request.operations);
    const analysisRequest={contractVersion:'canvas/v7',requestId:newRef('old-inspection-analysis'),sessionRef:scope.sessionRef,worldRef:scope.worldRef,
      transactionId:request.transactionId,operations:clone(request.operations),operationDigest:request.operationDigest,
      expectedRevision:request.expectedWorldRevision,expectedRegistryRevision:facts.registry.registryRevision,
      expectedSelectionRevision:canvas.current(scope.sessionRef).selectionRevision,localContext:clone(request.localContext)};
    const analysisResponse=await canvas.call('AnalyzeAffectedObjects',analysisRequest);
    if(analysisResponse.error || analysisResponse.result.affectedObjectRefs.length)
      failSupply('CURRENT_OLD_INSPECTION_ZERO_WRITE_INPUT_UNAVAILABLE','setup',{request:analysisRequest,response:analysisResponse});
    const disk=await durable(observer);
    if(!equal(disk.analyses[request.transactionId],analysisResponse.result)) failSupply('CURRENT_ANALYSIS_READBACK_UNAVAILABLE','readback');
    request.analysisDigest=D('affected-analysis',analysisResponse.result); request.decisionRevision=null;
    request.expectedObjectRevisions={};
    const token=await observer.begin({...scope,requestId:request.requestId,transactionId:request.transactionId});
    let response,capture;
    try { response=await canvas.call('ApplyRecoverableCommit',request); }
    finally { capture=await observer.finish(token); }
    if(capture.worldWrites.length || response.error?.code!=='INSPECTION_FAILED' || response.error.mutationState!=='NONE')
      failSupply('CURRENT_OLD_INSPECTION_REFUSAL_UNAVAILABLE','readback',{request,response,capture});
    return {request,response,capture,staleInspectionAccepted:response.error===null};
  }
  async function uiPrepare(id) {
    if(!uiIds.has(id)) failSupply('CASE_NOT_ALLOWED','setup',{caseId:id});
    if(pending.has('ui/'+id)) failSupply('CASE_ALREADY_RUNNING','setup',{caseId:id});
    const scope=scopeFor('ui/'+id,casePositions(callItems.get('ApplyRecoverableCommit').request));
    if(['populated-history','undo-redo','configuration-reload','visible-error'].includes(id)) await ensureHistory(observer,scope);
    const canvas=getService(observer,CANVAS);
    const f=await preFacts(observer,scope,id);
    const before=await snapshot(scope);
    const state={id,scope,f,before,beforeWorldDigest:sha(before.scopedState),view:await canvas.readObjectsHistory(scope.sessionRef),
      provider:observer.provider(CANVAS),oldCanvas:canvas,inspection:await observer.inspect(),phases:[]};
    if(id==='configuration-reload') {
      state.confirmedPlacement=await confirmedPlacementInput(scope);
      state.beforeSettings=actualPlacement(canvas);
      state.requestedSettings={...state.beforeSettings,frontGapCells:state.beforeSettings.frontGapCells+1};
      state.historyBefore=clone(state.view); state.beforeProviderRef=state.provider.instanceRef;
    }
    if(id==='undo-redo') {
      const object=f.actions.objects.find(x=>x.mode==='CELL' && x.undo?.available);
      if(!object) failSupply('CURRENT_UI_UNDO_ORIGIN_UNAVAILABLE','setup');
      state.targetObjectRef=object.objectRef; state.historyTransactionId=object.undo.historyTransactionId;
      state.scope.positions=clone(object.cells);
      state.before=await snapshot(state.scope); state.beforeWorldDigest=sha(state.before.scopedState);
    }
    if(id==='visible-error') {
      const safety=await canvas.readEngineSafety(scope.sessionRef);
      const candidates=f.actions.objects.flatMap(object=>['undo','redo'].filter(action=>object[action]?.available).map(action=>({object,action,operation:object[action].operation})));
      const refused=candidates.find(row=>safety.operations.some(x=>x.operation===row.operation && x.status==='CAPABILITY_UNAVAILABLE'));
      if(!refused) failSupply('CURRENT_VISIBLE_ERROR_SCENARIO_UNAVAILABLE','setup',{missing:'actual enabled product history action with a declared real source capability refusal',historyActions:f.actions,engineSafety:safety});
      state.targetObjectRef=refused.object.objectRef; state.historyTransactionId=refused.object[refused.action].historyTransactionId;
      state.errorAction=refused.action;
    }
    if(id==='region') {
      state.regionRejection=await regionRefusalScope(scope);
      const source=await readSourceFacts(observer,scope);
      state.sourcePartition=clone(source.partition.value);
      const item=callItems.get('ApplyRegionCommit');
      const pair=await prepareRequest(observer,item,item.request,scope,'ok','ui');
      await requireMaterials(observer,pair.request,scope);
      const token=await observer.begin({...scope,requestId:pair.request.requestId,transactionId:pair.request.transactionId});
      try { state.commit=await callPublic(observer,REGION,item.id,pair.request); }
      finally { state.regionCommitCapture=await observer.finish(token); }
      if(state.commit.error || state.commit.result?.status!=='VERIFIED')
        failSupply('CURRENT_UI_REGION_COMMIT_UNAVAILABLE','setup',{request:pair.request,response:state.commit});
      const undoItem=callItems.get('UndoScopedRegionCommit');
      const undoPair=await prepareRequest(observer,undoItem,undoItem.request,scope,'ok','ui');
      state.regionUndoRequest=undoPair.request; state.regionOrigin=clone(undoPair.f.origin);
      state.regionCommitRequest=clone(pair.request); state.targetObjectRef=undoPair.f.object?.objectRef;
      state.view=await canvas.readObjectsHistory(scope.sessionRef);
      state.historyTransactionId=pair.request.transactionId; state.partition=clone(pair.request.operations.partition);
      // The capability refusal must come from a real publicly declared unsupported geometry,
      // using the original document request unchanged. There is no synthesized engine refusal.
      state.regionRejectionRequest=clone(pair.request);
      state.regionRejectionRequest.requestId=newRef('region-refusal');
      state.regionRejectionRequest.transactionId=newRef('region-refusal-transaction');
    }
    state.token=await observer.begin({...state.scope,caseId:'ui/'+id});
    pending.set('ui/'+id,state);
    return {sessionRef:scope.sessionRef,targetObjectRef:state.targetObjectRef ?? f.object?.objectRef ?? null,
      historyTransactionId:state.historyTransactionId ?? f.originId ?? null,before:state.before,
      beforeWorldDigest:state.beforeWorldDigest,requestedSettings:state.requestedSettings ?? null,
      errorAction:state.errorAction ?? null,action:state.errorAction ?? null,view:state.view};
  }
  async function uiStage(id,phase) {
    const state=pending.get('ui/'+id);
    if(!state) failSupply('UI_CASE_NOT_PREPARED','call',{caseId:id,phase});
    const allowed={ 'undo-redo':['after-undo','after-redo'], 'configuration-reload':['after-reload'],unload:['after-unload'],
      region:['after-region-undo'], 'visible-error':['after-error'] };
    if(!allowed[id]?.includes(phase)) failSupply('UI_PHASE_NOT_ALLOWED','call',{caseId:id,phase});
    const capture=await observer.finish(state.token);
    const stage={phase,capture};
    if(phase!=='after-unload') {
      stage.after=await snapshot(state.scope); stage.view=await getService(observer,CANVAS).readObjectsHistory(state.scope.sessionRef);
      stage.worldDigest=sha(stage.after.scopedState); stage.provider=observer.provider(CANVAS);
    } else { stage.inspection=await observer.inspect(); stage.provider=observer.provider(CANVAS,{required:false}); }
    if(phase==='after-undo' || phase==='after-redo') {
      const operation=phase==='after-undo'?'Undo':'Redo';
      const events=capture.events.filter(x=>x.event==='HistoryPositionChanged' && x.operation===operation);
      if(events.length!==1) failSupply('CURRENT_UI_HISTORY_RECEIPT_UNAVAILABLE','call',{operation,events:capture.events});
      stage.receipt=clone(events[0].receipt.result?.outcome ?? events[0].receipt.result);
      if(stage.receipt?.status!=='VERIFIED') failSupply('CURRENT_UI_HISTORY_NOT_VERIFIED','call',{operation,receipt:stage.receipt});
      const stateDisk=await durable(observer),transaction=stateDisk.transactions[stage.receipt.transactionId];
      if(transaction?.receipt?.status!=='VERIFIED') failSupply('CURRENT_UI_HISTORY_DURABLE_RECEIPT_UNAVAILABLE','readback',{operation});
    }
    if(phase==='after-region-undo') {
      const disk=await durable(observer);
      const original=state.regionOrigin;
      const actualObject=original?.objectRef;
      const head=disk.history[actualObject]?.at(-1),row=head && disk.transactions[head.transactionId];
      if(row?.kind!=='REGION_UNDO' || row.originTransactionId!==state.regionCommitRequest.transactionId || row.scopedResult?.status!=='VERIFIED')
        failSupply('CURRENT_UI_REGION_UNDO_RECEIPT_UNAVAILABLE','readback',{head,row:row ?? null});
      if(!stage.view.history.some(x=>x.transactionId===state.regionCommitRequest.transactionId && x.status==='UNDONE'))
        failSupply('CURRENT_UI_REGION_UNDO_VIEW_UNAVAILABLE','readback',{view:stage.view});
      stage.receipt=clone(row.scopedResult);
    }
    if(phase==='after-reload') {
      stage.settings=actualPlacement(getService(observer,CANVAS));
      stage.oldInspection=await rejectOldInspection(state);
      stage.staleInspectionAccepted=stage.oldInspection.staleInspectionAccepted;
    }
    state.phases.push(stage);
    state.token=phase==='after-unload'?null:await observer.begin({...state.scope,caseId:'ui/'+id});
    return {phase,...(stage.after?{after:stage.after,view:stage.view,worldDigest:stage.worldDigest}:{}),
      provider:stage.provider ?? null,...(stage.receipt?{receipt:stage.receipt}:{}),...(stage.settings?{settings:stage.settings}:{})};
  }
  async function uiFinish(id,phase) {
    const state=pending.get('ui/'+id);
    if(!state) failSupply('UI_CASE_NOT_PREPARED','call',{caseId:id});
    if(Object.keys(phase).some(x=>!['phase','dom','actions'].includes(x))) failSupply('UI_FINISH_FIELDS_NOT_ALLOWED','call',{caseId:id});
    validateDOM(phase.dom,phase.actions,id);
    const capture=state.token?await observer.finish(state.token):{events:[],adapterCalls:[],worldWrites:[]};
    const base={execution:'ACTUAL_PRODUCT_UI',origin:state.provider.origin};
    let result;
    if(id==='navigation') {
      const {mainKey,sidebarTarget,selectedPanelId}=phase.dom;
      if(!mainKey || sidebarTarget!==mainKey || selectedPanelId!==mainKey || !/对象/.test(phase.dom.text) || !/历史/.test(phase.dom.text))
        failSupply('CURRENT_UI_NAVIGATION_UNAVAILABLE','call',{dom:phase.dom});
      result={mainKey,sidebarTarget,selectedPanelId};
    } else if(id==='populated-history') {
      const view=await getService(observer,CANVAS).readObjectsHistory(state.scope.sessionRef);
      if(!view.objects.length || !view.history.length || !phase.dom.text.includes(view.objects[0].name))
        failSupply('CURRENT_UI_POPULATED_HISTORY_UNAVAILABLE','call',{view,dom:phase.dom});
      result={view};
    } else if(id==='undo-redo') {
      const undo=state.phases.find(x=>x.phase==='after-undo'),redo=state.phases.find(x=>x.phase==='after-redo');
      if(!undo || !redo) failSupply('CURRENT_UI_HISTORY_PHASE_UNAVAILABLE','call');
      const events=state.phases.flatMap(x=>x.capture.events).concat(capture.events);
      result={beforeWorldDigest:state.beforeWorldDigest,undoWorldDigest:undo.worldDigest,redoWorldDigest:redo.worldDigest,
        undo:undo.receipt,redo:redo.receipt,undoView:undo.view,redoView:redo.view,events};
      if(result.beforeWorldDigest===result.undoWorldDigest || result.beforeWorldDigest!==result.redoWorldDigest)
        failSupply('CURRENT_UI_HISTORY_WORLD_READBACK_MISMATCH','readback',result);
    } else if(id==='configuration-reload') {
      const reload=state.phases.find(x=>x.phase==='after-reload');
      if(!reload) failSupply('CURRENT_UI_RELOAD_PHASE_UNAVAILABLE','call');
      result={beforeSettings:state.beforeSettings,afterSettings:reload.settings,requestedSettings:state.requestedSettings,
        beforeProviderRef:state.beforeProviderRef,afterProviderRef:reload.provider.instanceRef,
        historyBefore:state.historyBefore,historyAfter:reload.view,staleInspectionAccepted:reload.staleInspectionAccepted};
      if(equal(result.beforeSettings,result.afterSettings) || !equal(result.requestedSettings,result.afterSettings) ||
        result.beforeProviderRef===result.afterProviderRef || !equal(result.historyBefore,result.historyAfter) || result.staleInspectionAccepted)
        failSupply('CURRENT_UI_CONFIGURATION_RELOAD_MISMATCH','readback',result);
    } else if(id==='region') {
      // These are actual provider calls; their complete refusals are retained, never converted.
      const undo=state.phases.find(x=>x.phase==='after-region-undo')?.receipt;
      if(!undo) failSupply('CURRENT_UI_REGION_UNDO_RECEIPT_UNAVAILABLE','readback');
      const rejection=state.regionRejection;
      const token=await observer.begin({...rejection.scope,requestId:rejection.request.requestId,transactionId:rejection.request.transactionId});
      let rejected;
      try { rejected=await callPublic(observer,REGION,'ApplyRegionCommit',rejection.request); }
      finally { state.regionRejectionCapture=await observer.finish(token); }
      if(rejected.error?.code!=='CAPABILITY_GAP' || rejected.error?.mutationState!=='NONE' || state.regionRejectionCapture.worldWrites.length)
        failSupply('CURRENT_UI_REGION_REFUSAL_SCENARIO_UNAVAILABLE','call',{request:rejection.request,response:rejected,capture:state.regionRejectionCapture});
      result={commit:state.commit.result,undo,partition:state.partition,sourcePartition:state.sourcePartition,rejected};
    } else if(id==='visible-error') {
      const publicErrors=(capture.publicCalls ?? []).concat(capture.adapterCalls).flatMap(x=>x.response?.error?[x.response.error]:[]);
      const phaseErrors=state.phases.flatMap(x=>(x.capture.publicCalls ?? []).concat(x.capture.adapterCalls).flatMap(row=>row.response?.error?[row.response.error]:[]));
      const observed=state.publicError?.publicError ?? state.publicError;
      const error=publicErrors.concat(phaseErrors,observed?[observed]:[]).find(x=>phase.dom.text.includes(x.code));
      if(!error) failSupply('CURRENT_UI_VISIBLE_PUBLIC_ERROR_UNAVAILABLE','call',{missing:'actual captured public error shown in product DOM'});
      const after=await snapshot(state.scope);
      if(!equal(state.before,after)) failSupply('CURRENT_UI_VISIBLE_ERROR_CHANGED_STATE','readback');
      result={publicError:error,before:state.before,after,placeholderSubstituted:false};
    } else {
      const provider=observer.provider(CANVAS,{required:false});
      const dom=phase.dom;
      if(provider || dom.canvasPanels!==0 || [dom.mainEntryPresent,dom.sidebarEntryPresent,dom.remoteNamespacePresent,dom.oldTargetAccepted].some(x=>x!==false))
        failSupply('CURRENT_UI_UNLOAD_INCOMPLETE','readback',{provider:provider ?? null,dom});
      if(!phase.actions.some(x=>['uninstall','plugin-uninstall'].includes(x.kind)))
        failSupply('CURRENT_UI_PLUGIN_MANAGER_UNLOAD_UNOBSERVED','call');
      result={unloadVia:'NORMAL_PLUGIN_MANAGER',canvasProviderPresent:false,mainEntryPresent:dom.mainEntryPresent,
        sidebarEntryPresent:dom.sidebarEntryPresent,remoteNamespacePresent:dom.remoteNamespacePresent,oldTargetAccepted:dom.oldTargetAccepted};
    }
    pending.delete('ui/'+id);
    return {...base,...result};
  }
  async function releaseCaseScope(caseId, value) {
    const scope=caseScopes.get(caseId);
    if(!scope || !observer.provider(CANVAS,{required:false})) return;
    const canvas=getService(observer,CANVAS);
    const selection=canvas.current(scope.sessionRef);
    if(selection?.activeWorldRef) {
      const request={contractVersion:'canvas/v7',requestId:newRef('case-unselect'),sessionRef:scope.sessionRef,
        worldRef:selection.activeWorldRef,expectedRevision:selection.selectionRevision,expectedContext:clone(selection.localContext)};
      const response=await canvas.call('UnselectWorldConnection',request);
      if(response.error) failSupply('CASE_SELECTION_CLEANUP_FAILED','cleanup',{request,response});
    }
    const reservationRef=scope.reservationRef ?? (caseId==='ReserveWorldRetirement' ? value?.response?.result?.reservationRef : null);
    if(reservationRef) {
      const listed=await canvas.call('ListWorldSelections',{contractVersion:'canvas/v7',requestId:newRef('case-reservation-inventory'),worldRef:scope.worldRef});
      if(listed.result?.retirementReservationRef===reservationRef) {
        const request={contractVersion:'canvas/v7',requestId:newRef('case-release'),worldRef:scope.worldRef,reservationRef,outcome:'CANCELLED'};
        const response=await canvas.call('ReleaseWorldRetirement',request);
        if(response.error) failSupply('CASE_RESERVATION_CLEANUP_FAILED','cleanup',{request,response});
      }
    }
  }
  async function invoke(caseId,mode) {
    let phase;
    if(typeof mode==='string' && mode.startsWith('{')) { try { phase=JSON.parse(mode).phase; } catch {} }
    const terminal=['ok','reject','replay'].includes(mode) || ['finish','local-finish','cancel'].includes(phase);
    try {
      const value=await execute(caseId,mode);
      if(terminal && !((caseId.startsWith('event/') || caseId.startsWith('scenario/')) && mode==='ok')) await releaseCaseScope(caseId,value);
      return value;
    } catch(error) {
      const state=pending.get(caseId); pending.delete(caseId);
      if(state?.token) { try { await observer.finish(state.token); } catch(cleanupError) { error.captureCleanupFailure={code:cleanupError.code,message:cleanupError.message}; } }
      try { await releaseCaseScope(caseId); } catch(cleanupError) { throw new AggregateError([error,cleanupError],'Canvas case and normal scope cleanup failed'); }
      throw error;
    }
  }
  async function execute(caseId,mode) {
    if(caseId && typeof caseId==='object') ({caseId,mode}=caseId);
    if(typeof caseId!=='string' || typeof mode!=='string') failSupply('CASE_INPUT_INVALID','setup');
    let phase=null;
    if(mode.startsWith('{')) {
      try { phase=JSON.parse(mode); } catch { failSupply('CASE_PHASE_INVALID','setup'); }
      if(!phase || typeof phase!=='object' || typeof phase.phase!=='string') failSupply('CASE_PHASE_INVALID','setup');
    }
    if (phase?.phase === 'cancel') {
      if (Object.keys(phase).some(key=>key!=='phase')) failSupply('CASE_CANCEL_FIELDS_NOT_ALLOWED','setup');
      const state = pending.get(caseId);
      pending.delete(caseId);
      if (state?.token) { try { await observer.finish(state.token); } finally { state.token=null; } }
      return {caseId,observationReleased:true};
    }
    if(phase?.phase==='case-prepare') {
      if(!callItems.has(caseId) && !(caseId.startsWith('ui/') && uiIds.has(caseId.slice(3))) && !(caseId.startsWith('local/') && localItems.has(caseId.slice(6))) && !(caseId.startsWith('event/') && eventItems.has(caseId.slice(6))) && !(caseId.startsWith('business/') && businessItems.has(caseId.slice(9))) && !(caseId.startsWith('scenario/') && scenarioItems.has(caseId.slice(9))))
        failSupply('CASE_NOT_ALLOWED','setup',{caseId});
      return casePrepare(caseId,phase);
    }
    if(caseId.startsWith('ui/')) {
      const id=caseId.slice(3);
      if(!uiIds.has(id)) failSupply('CASE_NOT_ALLOWED','setup',{caseId});
      if(mode==='prepare') return uiPrepare(id);
      if(phase?.phase==='finish') return uiFinish(id,phase);
      if(mode.startsWith('after-')) return uiStage(id,mode);
      failSupply('UI_PHASE_NOT_ALLOWED','setup',{caseId,mode});
    }
    if(caseId.startsWith('local/')) {
      const item=localItems.get(caseId.slice(6));
      if(!item) failSupply('CASE_NOT_ALLOWED','setup',{caseId});
      if(phase?.phase==='local-prepare') {
        if(Object.keys(phase).some(x=>!['phase','mode',...(item.id==='panelId'?['dom']:[])].includes(x))) failSupply('CLIENT_CASE_FIELDS_NOT_ALLOWED','setup');
        return localPrepare(item,phase.mode,phase.dom ?? null);
      }
      if(phase?.phase==='local-finish') return localFinish(item,phase);
      if(phase?.phase==='after-subscribe') {
        const state=pending.get(caseId);
        if(!state || item.id!=='display.changes' || state.mode!=='ok' || phase.mode!==state.mode || Object.keys(phase).some(x=>!['phase','mode'].includes(x)))
          failSupply('CLIENT_CASE_PHASE_NOT_ALLOWED','call');
        const actions=await getService(observer,CANVAS).readHistoryActions(state.pair.f.scope.sessionRef);
        const target=actions.objects.find(row=>row.mode==='CELL' && row.undo?.available);
        if(!target) failSupply('CURRENT_CHANGE_OBJECT_UNAVAILABLE','setup');
        const request={sessionRef:state.pair.f.scope.sessionRef,objectRef:target.objectRef,historyTransactionId:target.undo.historyTransactionId};
        const response=await getService(observer,'hanaworldsCanvasDisplay','undo').undo(request.sessionRef,request.objectRef,request.historyTransactionId);
        if(response.status!=='VERIFIED') failSupply('CURRENT_CHANGE_COMMIT_UNAVAILABLE','call',{request,response});
        return {request,response};
      }
      if(phase) failSupply('CLIENT_CASE_PHASE_NOT_ALLOWED','setup');
      return localCase(item,mode);
    }
    if(phase) failSupply('CASE_PHASE_NOT_ALLOWED','setup');
    if(caseId.startsWith('event/')) {
      const id=caseId.slice(6),event=eventItems.get(id);
      if(!event) failSupply('CASE_NOT_ALLOWED','setup',{caseId});
      const operation=event.name==='TransactionVerified'?'ApplyRecoverableCommit':event.trigger;
      return wireCase(callItems.get(operation),mode,'events',id);
    }
    if(caseId.startsWith('scenario/')) {
      const id=caseId.slice(9),scenario=scenarioItems.get(id);
      if(!scenario) failSupply('CASE_NOT_ALLOWED','setup',{caseId});
      return wireCase(callItems.get(scenario.operation),mode,'scenarios',id);
    }
    if(caseId.startsWith('business/')) {
      const item=businessItems.get(caseId.slice(9));
      if(!item || mode!=='reject') failSupply('CASE_MODE_NOT_ALLOWED','setup',{caseId,mode});
      return wireCase(item,mode,'business');
    }
    const item=callItems.get(caseId);
    if(!item) failSupply('CASE_NOT_ALLOWED','setup',{caseId});
    return wireCase(item,mode);
  }
  return {invoke};
}
