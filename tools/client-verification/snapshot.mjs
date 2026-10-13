import { randomUUID } from 'node:crypto';
import { validateType, validateBoundResponse } from '../../src/protocol/local/index.mjs';

export class SupplyFailure extends Error {
  constructor(code, stage, details = {}) {
    super(`${code} (${stage})`); this.name = 'SupplyFailure'; this.code = code;
    this.stage = stage; this.details = details;
  }
}
export const failSupply = (code, stage, details) => { throw new SupplyFailure(code, stage, details); };
export function publicFailure(error) {
  if (error?.publicError) return { publicError: structuredClone(validateType('Error', error.publicError)) };
  // Gateway/Remote errors remain their public JSON identity, never provider class objects.
  if (typeof error?.code === 'string') return {
    code: error.code, ...(error.message ? { message: error.message } : {}),
    ...(error.details !== undefined ? { details: structuredClone(error.details) } : {}),
  };
  throw error;
}
export function getService(observer, key, method) {
  const service = observer.service(key, method);
  if (!service || method && typeof service[method] !== 'function')
    failSupply('CURRENT_PROVIDER_UNAVAILABLE', 'setup', { key, method });
  return service;
}
export async function callPublic(observer, key, operation, request) {
  const receiver = getService(observer, key, 'call');
  return receiver.call(operation, structuredClone(request));
}
export async function readCurrentState(observer) {
  const disk = await observer.readDurable();
  if (disk.exists) return disk.state;
  // A READY, newly opened store has no durable file until its first commit.
  // Read that actual registered provider's initialized memory, never invent a
  // fresh store or claim these bytes have been persisted.
  const canvas = getService(observer, 'hanaworldsCanvasV5');
  if (canvas.storageState !== 'READY' || !canvas.store?.snapshot)
    failSupply('CURRENT_STORE_STATE_UNAVAILABLE', 'setup');
  return structuredClone(canvas.store.snapshot);
}
export function uniquePositions(positions) {
  const values = new Map();
  for (const position of positions) values.set(JSON.stringify(position), [...position]);
  return [...values.values()].sort((a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
}
export function casePositions(request) {
  if (request.positions?.length) return uniquePositions(request.positions);
  const effects = request.operations?.effects ?? request.expectedOperations?.effects;
  if (effects?.length) return uniquePositions(effects.map(x => x.position));
  const chunks = request.operations?.chunks;
  if (chunks?.length) {
    const result=[];
    for (const {block} of chunks) for(let z=0;z<block.size[2];z++)
      for(let y=0;y<block.size[1];y++) for(let x=0;x<block.size[0];x++)
        result.push(block.origin.map((v,i)=>v+[x,y,z][i]));
    return uniquePositions(result);
  }
  const box=request.sampledBounds;
  if (box) {
    const result=[];
    for(let x=box.min[0];x<=box.max[0];x++) for(let y=box.min[1];y<=box.max[1];y++)
      for(let z=box.min[2];z<=box.max[2];z++) result.push([x,y,z]);
    return uniquePositions(result);
  }
  return [];
}
export async function establishScope(observer, positions = []) {
  const canvas=getService(observer,'hanaworldsCanvasV5','current');
  await canvas.ready;
  const durable=await readCurrentState(observer);
  const candidates=Object.entries(durable.sessions ?? {}).filter(([,row])=>row?.activeWorldRef && row.localContext);
  if (!candidates.length) failSupply('CURRENT_SESSION_WORLD_UNAVAILABLE','setup', { surface:'Canvas.current + CanvasStore.readDurable' });
  let identityFailure;
  for (const [sessionRef, row] of candidates) {
    const request={contractVersion:'session/v5',requestId:`canvas-verification-identity-${randomUUID()}`,sessionRef};
    const response=await callPublic(observer,'hanaworldsWorkshopV3','ReadSessionIdentity',request);
    validateBoundResponse('session/v5','ReadSessionIdentity',request,response);
    if(response.error) { identityFailure=response.error; continue; }
    const current=canvas.current(sessionRef);
    if(!current || JSON.stringify(current)!==JSON.stringify(row)) continue;
    const actions=await canvas.readHistoryActions(sessionRef);
    const observedPositions=positions.length ? positions : uniquePositions(actions.objects.flatMap(x=>x.cells ?? x.footprint ?? []));
    if(!observedPositions.length) failSupply('CURRENT_CASE_INPUT_UNAVAILABLE','setup', { surface:'Canvas.readHistoryActions', missing:'nonempty actual case scope' });
    return {sessionRef,worldRef:row.activeWorldRef,connectionRef:row.localContext.connectionRef,
      localContext:structuredClone(row.localContext),positions:observedPositions,identity:response.result};
  }
  failSupply('CURRENT_SESSION_IDENTITY_UNAVAILABLE','setup',{error:identityFailure ?? null});
}
async function observeRead(read) {
  try { return await read(); } catch(error) { return publicFailure(error); }
}
export async function snapshotActual(observer, scope) {
  const canvas=getService(observer,'hanaworldsCanvasV5');
  const selection=structuredClone(canvas.current(scope.sessionRef));
  const context=await callPublic(observer,'hanaworldsCanvasV5','ReadWorldSelectionContext',{
    contractVersion:'canvas/v7',requestId:`verification-snapshot-context-${randomUUID()}`,
    sessionRef:scope.sessionRef,worldRef:scope.worldRef});
  const listed=selection?.localContext ? await callPublic(observer,'hanaworldsCanvasV5','ListObjects',{
    contractVersion:'canvas/v7',requestId:`verification-snapshot-objects-${randomUUID()}`,
    sessionRef:scope.sessionRef,worldRef:scope.worldRef,expectedRevision:null,
    localContext:selection.localContext}) : null;
  const view=await canvas.readObjectsHistory(scope.sessionRef);
  const actions=await canvas.readHistoryActions(scope.sessionRef);
  const worldRevision=await observeRead(()=>getService(observer,'hanaworldsWorldRevisionOracle','read').read(scope.worldRef));
  if(typeof canvas.nativeFacts?.readScopedState!=='function')
    failSupply('CURRENT_SCOPED_STATE_READER_UNAVAILABLE','setup',{surface:'Canvas.nativeFacts.readScopedState'});
  // This is the registered Canvas consumer's own reader; it retains its actual fiber identity.
  const scopedState=await canvas.nativeFacts.readScopedState(scope.connectionRef,scope.positions);
  validateType('StateProfile',scopedState.stateProfile); validateType('ScopedCells',scopedState.cells);
  if(scopedState.worldRef!==scope.worldRef || !scopedState.cells.length ||
    JSON.stringify(scopedState.cells.map(x=>x.position))!==JSON.stringify(scope.positions))
    failSupply('CURRENT_SCOPED_STATE_COVERAGE_UNAVAILABLE','setup',{worldRef:scope.worldRef,positions:scope.positions});
  const durable=await readCurrentState(observer);
  const pending=Object.entries(durable.pending ?? {}).filter(([,row])=>(row.body?.worldRef ?? row.worldRef)===scope.worldRef)
    .map(([transactionId])=>actions.recovery?.find(x=>x.transactionId===transactionId));
  if(pending.some(x=>!x)) failSupply('CURRENT_PENDING_READBACK_UNAVAILABLE','setup',{surface:'Canvas.readHistoryActions'});
  return structuredClone({selection,context:context.result ?? {publicError:context.error},
    registry:listed ? listed.result ?? {publicError:listed.error} : null, objects:view.objects,history:view.history,
    pending,recovery:actions.recovery ?? [],worldRevision,scopedState});
}
