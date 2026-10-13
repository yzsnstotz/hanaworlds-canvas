/** 2.9.0 world-inspection/v1 ReadPluginRoles (C-world-inspection): role -> providing plugins. */
import {contractMetadata} from './generated/contracts.mjs';
import {ContractError} from '../errors.mjs';
import {compareUTF16} from '../geometry.mjs';
import {validateRequest,validateBoundResponse,deepFreeze} from './runtime.mjs';
import {derivePluginRoleStatus} from './plugin-roles-binding.mjs';

export const pluginRoles=contractMetadata.pluginRoles;
const {wire,operation}=pluginRoles;
const nonEmpty=(value,what)=>{if(typeof value!=='string'||value.length===0)throw new TypeError(`${what} must be a non-empty string`);return value;};
/** Provider side: the PluginRoles of what the host actually registered, through the published
 * evidence table only. services: active registered services {name, moduleName}; skills: live skill
 * catalog entries {name, provider}. Anything not named by pluginRoles.evidence is ignored; nothing
 * is inferred from a package or module name. */
export function derivePluginRoles({services=[],skills=[]}={}) {
 const found=Object.fromEntries(pluginRoles.roles.map(role=>[role,new Set()]));
 const byKind={service:new Map(),skill:new Map()};
 for(const role of pluginRoles.roles)for(const e of pluginRoles.evidence[role]){
  const roles=byKind[e.kind].get(e.name)??[];roles.push(role);byKind[e.kind].set(e.name,roles);
 }
 for(const s of services){
  const provider=nonEmpty(s?.moduleName,'service moduleName');
  for(const role of byKind.service.get(nonEmpty(s?.name,'service name'))??[])found[role].add(provider);
 }
 for(const s of skills){
  const provider=nonEmpty(s?.provider,'skill provider');
  for(const role of byKind.skill.get(nonEmpty(s?.name,'skill name'))??[])found[role].add(provider);
 }
 const providers=Object.fromEntries(pluginRoles.roles.map(role=>[role,[...found[role]].sort(compareUTF16)]));
 return deepFreeze({...derivePluginRoleStatus(providers),providers});
}
/** Provider side: the validated successful response. */
export function pluginRolesResponse(requestInput,result) {
 const request=validateRequest(wire,operation,requestInput);
 return deepFreeze(validateBoundResponse(wire,operation,request,{contractVersion:wire,requestId:request.requestId,result,error:null}));
}
/** Provider side: the read could not be completed. Never an empty providers answer. */
export function pluginRolesUnavailable(requestInput) {
 const request=validateRequest(wire,operation,requestInput);
 const error=new ContractError('CAPABILITY_UNAVAILABLE','validate','REQUIRED_FACT_UNKNOWN').publicError;
 return deepFreeze(validateBoundResponse(wire,operation,request,{contractVersion:wire,requestId:request.requestId,result:null,error}));
}
/** Stateless provider over one published fixture host ({services, skills} or {unreadable:true}).
 * No filesystem, process or host work. */
export function createPluginRolesMock(host) {
 const snapshot=structuredClone(host);
 const result=snapshot.unreadable===true?null:derivePluginRoles(snapshot);
 return (w,o,input)=>{
  if(w!==wire||o!==operation)throw new TypeError('The plugin roles mock answers only world-inspection/v1 ReadPluginRoles');
  return result===null?pluginRolesUnavailable(input):pluginRolesResponse(input,result);
 };
}
