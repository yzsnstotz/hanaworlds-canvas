import {validateRequest,validateBoundResponse,deepFreeze} from './runtime.mjs';
import {requireFact} from '../errors.mjs';
import {worldLifecycle} from './world-lifecycle.mjs';
const wire='local-worlds/v2',operation='describeSourceWorld';
/** Consumer admission for the optional read. The paired world source alone
 * interprets sourceLocator; no host projection or lifecycle authority exists. */
export async function describeSourceWorld(port,input) {
 const request=validateRequest(wire,operation,input);
 requireFact(typeof port?.describeSourceWorld==='function','CAPABILITY_UNAVAILABLE','REQUIRED_FACT_UNKNOWN');
 return validateBoundResponse(wire,operation,request,await port.describeSourceWorld(request));
}
/** Stateless published fixture provider; selects by exact worldRef, never name.
 * No filesystem/process/world work and no claim to fresh source observations. */
export function createLocalWorldSourceMock(fixture,refusalCode=null) {
 const exchanges=structuredClone(fixture.exchanges);
 const declaration=worldLifecycle.operations.find(o=>o.wire===wire&&o.operation===operation);
 if(refusalCode!==null&&!declaration.errors.includes(refusalCode))throw new TypeError('Undeclared source refusal');
 for(const x of exchanges){
  if(x.wire!==wire||x.operation!==operation)throw new TypeError('Not a source description fixture');
  validateBoundResponse(wire,operation,x.request,x.response);
 }
 const successes=exchanges.filter(x=>x.response.result!==null);
 if(new Set(successes.map(x=>x.request.worldRef)).size!==successes.length)throw new TypeError('Duplicate source fixture worldRef');
 for(const code of declaration.errors)if(!exchanges.some(x=>x.response.error?.code===code))throw new TypeError('Missing source refusal fixture');
 return input=>{
  const request=validateRequest(wire,operation,input);
  const success=successes.find(x=>x.request.worldRef===request.worldRef);
  const code=refusalCode??(success?null:'WORLD_NOT_FOUND');
  const example=code?exchanges.find(x=>x.response.error?.code===code):success;
  const response={...example.response,requestId:request.requestId};
  return deepFreeze(validateBoundResponse(wire,operation,request,response));
 };
}
