import {contractMetadata} from './generated/contracts.mjs';
import {ContractError,requireFact} from '../errors.mjs';
import {validateType,validateRequest,validateBoundResponse,requestWorldSelectors,deepFreeze} from './runtime.mjs';

export const worldErrorContext=contractMetadata.worldErrorContext;
const sessionOf=request=>request.sessionRef??request.hostContext?.sessionRef;
/** Provider side: the world an admitted request actually targets. A selector the request
 * carries decides; otherwise only the provider's own trusted Session binding
 * (sessionRef -> worldRef) is read. undefined when no target can be determined; never guessed
 * from model input, raw JSON, another Session or an exception message. */
export function targetWorldRef(request,trustedSessionWorlds={}) {
 const selected=[...new Set(requestWorldSelectors(request))];
 requireFact(selected.length<=1,'CURRENT_WORLD_MISMATCH','REVISION_CHANGED');
 if(selected.length===1)return selected[0];
 const session=sessionOf(request);
 const bound=trustedSessionWorlds instanceof Map?trustedSessionWorlds.get(session)
  :typeof session==='string'&&Object.hasOwn(trustedSessionWorlds,session)?trustedSessionWorlds[session]:undefined;
 return typeof bound==='string'&&bound.length>0?bound:undefined;
}
/** Provider side: the public Error of an admitted operation that could not reach its world.
 * code/phase/reason/retryability/mutationState/transactionRef/causeCode are kept exactly;
 * worldRef is added only when targetWorldRef determines one. */
export function worldUnavailableError(request,error,trustedSessionWorlds) {
 const {code,phase,reason,...details}=validateType('Error',error);
 if(Object.hasOwn(details,'worldRef'))throw new TypeError('Error template already names a world; the target comes only from targetWorldRef');
 return new ContractError(code,phase,reason,{...details,worldRef:targetWorldRef(request,trustedSessionWorlds)}).publicError;
}
/** Stateless published-fixture provider: answers every matching operation with its fixture
 * failure, naming the target world from the request selector or fixture.trustedSessionWorlds.
 * No filesystem/process/world work. */
export function createWorldErrorMock(fixture) {
 const trusted=structuredClone(fixture.trustedSessionWorlds??{});
 const failures=structuredClone(fixture.exchanges).filter(x=>x.response.error!==null);
 for(const x of failures){
  validateBoundResponse(x.wire,x.operation,x.request,x.response);
  if(x.response.error.worldRef!==targetWorldRef(x.request,trusted))throw new TypeError('Fixture error names a world the provider would not determine');
 }
 return (wire,operation,input)=>{
  const request=validateRequest(wire,operation,input);
  const example=failures.find(x=>x.wire===wire&&x.operation===operation);
  if(!example)throw new TypeError('No supplied failure fixture for this operation');
  const {worldRef,...template}=example.response.error;
  const response={...example.response,requestId:request.requestId,error:worldUnavailableError(request,template,trusted)};
  return deepFreeze(validateBoundResponse(wire,operation,request,response));
 };
}
