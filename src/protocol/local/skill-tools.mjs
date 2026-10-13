import {createHash} from 'node:crypto';
import {contractMetadata} from './generated/contracts.mjs';
import {requireFact,fail} from '../errors.mjs';
import {validateType,validateRequest,validateBoundResponse,validateDigestBinding,canonicalJSON,deepFreeze} from './runtime.mjs';

export const toolManifest=contractMetadata.toolManifest;
export const buildingSkill=contractMetadata.buildingSkill;
export const directBuild=contractMetadata.directBuild;
const shape=ok=>requireFact(ok,'SCHEMA_INVALID','INVALID_SHAPE');
const current=ok=>requireFact(ok,'CURRENT_WORLD_MISMATCH','REVISION_CHANGED');
const associated=ok=>requireFact(ok,'TRANSACTION_CONFLICT','PAYLOAD_CHANGED');
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const tool=name=>{
 const t=toolManifest.tools.find(t=>t.name===name);
 if(!t)fail('UNSUPPORTED_OPERATION','validate','INVALID_SHAPE');
 return t;
};
const action=(t,name)=>{
 const a=t.actions.find(a=>a.action===name);shape(!!a);return a;
};
/** Applied to new types only. Existing wire types and digest domains are retained. */
export function validateToolDomain(visits){
 for(const {name,value:v} of visits){
  if(name==='ImageBytes'){
   const bytes=Buffer.from(v.bytesBase64,'base64');
   shape(bytes.length===v.byteLength&&bytes.toString('base64')===v.bytesBase64);
   shape(createHash('sha256').update(bytes).digest('hex')===v.bytesDigest);
   shape(v.mediaType.startsWith('image/'));
  }
  const t=toolManifest.tools.find(t=>t.response===name);
  if(t&&v.error)shape(t.actions.some(a=>a.errors.includes(v.error.code)));
  if(name==='BuildingSkillResponse'&&v.error)shape(buildingSkill.errors.includes(v.error.code));
  if(name==='RedoCurrentBuildResponse'&&v.error)
   shape(['STALE_TRANSACTION','TRANSACTION_CONFLICT','WORLD_NOT_BOUND','CAPABILITY_UNAVAILABLE','SAFETY_INVARIANT_FAILED','RESTORE_FAILED'].includes(v.error.code));
 }
}
function sourceConnection(facts,host){
 current(host.localContext!==null);
 const c=facts.connection,h=host.localContext;
 current(c.worldRef===h.worldRef&&c.connectionRef===h.connectionRef&&c.connectionIncarnationRef===h.connectionIncarnationRef);
}
const intent=ok=>requireFact(ok,'INTENT_UNCONFIRMED','REQUIRED_FACT_UNKNOWN');
const sha=value=>createHash('sha256').update(canonicalJSON(value),'utf8').digest('hex');
function directAuthorization(q){
 requireFact(q.hostContext.localContext!==null,'WORLD_NOT_BOUND','REQUIRED_FACT_UNKNOWN');
 const a=q.intentAuthorization,h=q.hostContext;
 intent(!!a);
 associated(a.sessionRef===h.sessionRef&&a.turnRef===h.turnRef);
 requireFact(a.turnRevision===h.turnRevision&&a.intent.confirmedTurnRevision===h.turnRevision,'TURN_REVISION_MISMATCH','REVISION_CHANGED');
 current(same(a.localContext,h.localContext));
 intent(a.intent.kind==='BUILD_STRUCTURE'&&a.intent.text.trim().length>0);
 intent(a.proposalDigest===sha(q.input.proposal));
 return a;
}
/** Independent host readback is mandatory here; this does not authenticate a provider. */
export function validateToolRequest(name,input,hostFacts){
 const t=tool(name),q=validateRequest(t.wire,name,input),h=validateType(name==='hanaworlds_build'?'ToolBuildHostFacts':'ToolHostContext',hostFacts);
 action(t,q.input.action);
 associated(q.hostContext.sessionRef===h.sessionRef&&q.hostContext.turnRef===h.turnRef);
 requireFact(q.hostContext.turnRevision===h.turnRevision,'TURN_REVISION_MISMATCH','REVISION_CHANGED');
 current(same(q.hostContext.localContext,h.localContext));
 if(name==='hanaworlds_build'&&q.input.action==='build'){
  const a=directAuthorization(q);
  intent(!!h.intentAuthorization&&!!h.currentUserRequest);
  intent(same(a,h.intentAuthorization));
  intent(h.currentUserRequest.text.trim().length>0&&a.messageRef===h.currentUserRequest.messageRef&&a.messageDigest===sha(h.currentUserRequest));
 }
 if(q.catalogueFacts)sourceConnection(q.catalogueFacts,h);
 return q;
}
/** Runtime bound-response admission also invokes this for direct wire consumers. */
export function validateToolBinding(wire,name,q,response){
 const t=toolManifest.tools.find(t=>t.wire===wire&&t.name===name);
 if(!t)return;
 const a=action(t,q.input.action);
 if(response.error){shape(a.errors.includes(response.error.code));return;}
 if(name==='hanaworlds_build'&&q.input.action==='build')directAuthorization(q);
 const result=response.result;
 associated(result.action===q.input.action);
 const host=q.hostContext;
 for(const key of ['engineFacts','catalogueFacts'])if(result[key])sourceConnection(result[key],host);
 if(result.localContext)current(same(result.localContext,host.localContext));
 if(result.plan){
  const kind=name==='hanaworlds_region_proposal'?'region-build':'build';
  validateDigestBinding(kind,result.plan.build,result.plan.buildDigest);
  if(kind==='region-build')current(result.plan.build.worldRef===host.localContext?.worldRef);
 }
 for(const value of [result.outcome,result.undoStatus])if(value){
  if(value.sessionRef!==undefined)associated(value.sessionRef===host.sessionRef);
  if(value.worldRef!==undefined)current(value.worldRef===host.localContext?.worldRef);
  if(value.turnRevision!==undefined&&value.turnRevision!==null)
   requireFact(value.turnRevision===host.turnRevision,'TURN_REVISION_MISMATCH','REVISION_CHANGED');
 }
 const receipt=result.receipt??result.outcome?.receipt;
 if(receipt)current(same(receipt.localContext,host.localContext));
 if(name==='hanaworlds_image_material'){
  sourceConnection(q.catalogueFacts,host);
  const {catalogue,presentation}=q.catalogueFacts;
  for(const m of result.matches){
   const tags=catalogue.materials[m.materialRef];
   shape(!!tags&&tags.placeable===true&&tags.orientations!==null&&tags.definitionRevision!==null);
   shape(m.materialRef!==catalogue.emptyMaterialRef&&presentation[m.materialRef]?.color===m.materialColor);
  }
 }
}
export function validateToolResponse(name,request,response){
 const t=tool(name);return validateBoundResponse(t.wire,name,request,response);
}
/** Stateless supplied-fixture provider: no model, network, image decoding or world writes. */
export function createSkillToolsMock(fixture,refusals={}){
 const exchanges=fixture.exchanges.map(x=>({operation:x.operation,request:validateToolRequest(x.operation,x.request,x.hostFacts??x.request.hostContext),response:validateToolResponse(x.operation,x.request,x.response)}));
 return (name,input,hostFacts)=>{
  const q=validateToolRequest(name,input,hostFacts),code=refusals[`${name}:${q.input.action}`];
  const example=exchanges.find(x=>x.operation===name&&same(x.request.input,q.input)&&same(x.request.hostContext,q.hostContext)&&same(x.request.catalogueFacts??null,q.catalogueFacts??null)&&same(x.request.intentAuthorization??null,q.intentAuthorization??null)&&(code?x.response.error?.code===code:x.response.result!==null));
  if(!example)throw new TypeError('No supplied fixture matches this invocation');
  return deepFreeze(validateToolResponse(name,q,{...example.response,requestId:q.requestId}));
 };
}
