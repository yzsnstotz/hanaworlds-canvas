import {worldLifecycle} from './world-lifecycle.mjs';
import {validateRequest,validateBoundResponse,deepFreeze} from './runtime.mjs';
/** Fixture-only, stateless provider. Takes the published fixtures/world-lifecycle JSON.
 * It returns only supplied examples; it never creates worlds, starts processes or
 * asserts fresh facts. Unknown fixture selectors receive declared refusals.
 * refusals keys are `${wire}:${operation}` so overlapping verb names stay distinct. */
export function createWorldLifecycleMock(fixture,refusals={}) {
 const exchanges=structuredClone(fixture.exchanges);
 // Admit the full supplied corpus before making it a provider.
 for(const x of exchanges)validateBoundResponse(x.wire,x.operation,x.request,x.response);
 const configured=structuredClone(refusals);
 for(const [key,code] of Object.entries(configured)){
  const d=worldLifecycle.operations.find(o=>`${o.wire}:${o.operation}`===key);
  if(!d?.errors.includes(code))throw new TypeError('Undeclared lifecycle fixture error');
 }
 return (wire,operation,input)=>{
  const request=validateRequest(wire,operation,input);
  const declaration=worldLifecycle.operations.find(o=>o.wire===wire&&o.operation===operation);
  const example=exchanges.find(x=>x.wire===wire&&x.operation===operation&&x.response.result!==null);
  if(!declaration||!example)throw new TypeError('Not a lifecycle fixture operation');
  let code=configured[`${wire}:${operation}`];
  const different=key=>Object.hasOwn(request,key)&&request[key]!==example.request[key];
  if(!code){
   if(different('worldId')||different('worldRef'))code=declaration.errors.includes('WORLD_NOT_FOUND')?'WORLD_NOT_FOUND':declaration.errors.includes('CONNECTION_NOT_FOUND')?'CONNECTION_NOT_FOUND':'ADAPTER_UNAVAILABLE';
   else if(different('connectionRef'))code='CONNECTION_NOT_FOUND';
   else if(different('confirmationName'))code='TRANSACTION_CONFLICT';
   else if(different('templateId')||different('worldRoot'))code='ADAPTER_UNAVAILABLE';
   else if(different('displayName'))code='INVALID_NAME';
  }
  const refusal=code?exchanges.find(x=>x.wire===wire&&x.operation===operation&&x.response.error?.code===code):null;
  if(code&&!refusal)throw new TypeError('Missing declared lifecycle refusal fixture');
  const response={...(refusal??example).response,requestId:request.requestId};
  return deepFreeze(validateBoundResponse(wire,operation,request,response));
 };
}
