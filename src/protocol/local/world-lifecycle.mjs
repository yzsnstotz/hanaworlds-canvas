import {contractMetadata} from './generated/contracts.mjs';
import {requireFact} from '../errors.mjs';
export const worldLifecycle = contractMetadata.worldLifecycle;
const responses = new Map(worldLifecycle.operations.map(o=>[o.response,o]));
const inventories = new Set(['WorldLifecycleInventory','LocalWorldsInventory']);
const shape = ok=>requireFact(ok,'SCHEMA_INVALID','INVALID_SHAPE');
const current = ok=>requireFact(ok,'CURRENT_WORLD_MISMATCH','REVISION_CHANGED');
const associated = ok=>requireFact(ok,'TRANSACTION_CONFLICT','PAYLOAD_CHANGED');
/** New types only: never interpret source-owned opaque fields. */
export function validateLifecycleDomain(visits) {
 for(const {name,value:v} of visits){
  const declaration=responses.get(name);
  if(declaration && v.error!==null)shape(declaration.errors.includes(v.error.code));
  if(name==='WorldLifecycleDescription'){
   shape(new Set(v.templates.map(t=>t.templateId)).size===v.templates.length);
   shape(new Set(v.prerequisites.map(p=>p.prerequisiteId)).size===v.prerequisites.length);
  }
  if(inventories.has(name)){
   shape(new Set(v.worlds.map(w=>w.worldId)).size===v.worlds.length);
   shape(new Set(v.worlds.map(w=>w.worldRef)).size===v.worlds.length);
  }
  if(name==='LocalWorldsPairResponse' && v.result!==null)
   current(v.result.worldRef===v.result.capabilities.worldRef);
 }
}
/** Called only for the new wires after ordinary request/response admission. */
export function validateLifecycleBinding(wire,name,request,response) {
 if(!worldLifecycle.operations.some(o=>o.wire===wire&&o.operation===name))return;
 const result=response.result;if(result===null)return;
 for(const field of ['worldId','worldRef','connectionRef'])
  if(Object.hasOwn(request,field)&&Object.hasOwn(result,field))current(request[field]===result[field]);
 for(const field of ['templateId','displayName','confirmationName'])
  if(Object.hasOwn(request,field)&&Object.hasOwn(result,field))associated(request[field]===result[field]);
}
