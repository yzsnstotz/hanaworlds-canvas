/** 2.9.0 world-inspection/v1 ReadPluginRoles binding (C-world-inspection). Pure checks; no host read. */
import {contractMetadata} from './generated/contracts.mjs';
import {requireFact} from '../errors.mjs';
import {compareUTF16} from '../geometry.mjs';

const meta=contractMetadata.pluginRoles;
const shape=ok=>requireFact(ok,'SCHEMA_INVALID','INVALID_SHAPE');
const canonical=ok=>requireFact(ok,'NON_CANONICAL_AMBIGUITY','INVALID_SHAPE');
/** missingRoles and status are derived from providers; the provider cannot state them independently. */
export function derivePluginRoleStatus(providers) {
 const missingRoles=meta.requiredRoles.filter(role=>providers[role].length===0);
 const status=missingRoles.length===0?'COMPLETE':missingRoles.length===meta.requiredRoles.length?'UNAVAILABLE':'PARTIAL';
 return {status,missingRoles};
}
export function validatePluginRolesBinding(wire,name,request,response) {
 if(wire!==meta.wire||name!==meta.operation)return;
 // Exactly one of result/error: a failed read is never an empty answer.
 shape((response.result===null)!==(response.error===null));
 if(response.error!==null)shape(meta.errors.includes(response.error.code));
 const result=response.result;
 if(result===null)return;
 for(const role of meta.roles){
  const list=result.providers[role];
  for(let i=1;i<list.length;i++)canonical(compareUTF16(list[i-1],list[i])<0);
 }
 const derived=derivePluginRoleStatus(result.providers);
 shape(result.status===derived.status);
 shape(result.missingRoles.length===derived.missingRoles.length&&result.missingRoles.every((r,i)=>r===derived.missingRoles[i]));
}
