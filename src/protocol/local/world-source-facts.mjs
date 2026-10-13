/** world-source-facts/v1: pure checks over the named world source fact operations (world-facts/v1,
 * world-adapter/v8 ReadWorldSourceCapabilities) and the host inspection context (world-inspection/v1).
 * No engine read, default, persistence or world write. Provider authenticity stays with the caller. */
import {requireFact} from '../errors.mjs';
import {snapshotJSON} from '../strict-json.mjs';
import {contractMetadata} from './generated/contracts.mjs';
import {validateType, validateBoundResponse, digestValue, canonicalJSON, compareUTF16} from './runtime.mjs';
export const worldSourceFacts = contractMetadata.worldSourceFacts;
const currentConnection = (fact, current) =>
 requireFact(canonicalJSON(fact)===canonicalJSON(validateType('MaterialSourceConnection',current)),'CURRENT_WORLD_MISMATCH');
const catalogueBound = (digest, catalogue) =>
 requireFact(digest===digestValue('catalogue',validateType('Catalogue',catalogue)).sha256,'CATALOGUE_MISMATCH');
/** ReadCatalogue result: current connection and a catalogueDigest that is the digest of the carried Catalogue. */
export function validateCatalogueFacts(input, current) {
 const facts=validateType('CatalogueFacts',input);
 currentConnection(facts.connection,current);catalogueBound(facts.catalogueDigest,facts.catalogue);
 return facts;
}
/** ReadMaterialSources result: the snapshot belongs to the current connection and Catalogue and its sourceRevision is recomputed. */
export function validateMaterialSourceFacts(input, catalogue, current) {
 const facts=validateType('MaterialSourceFacts',input),snapshot=facts.snapshot,cat=validateType('Catalogue',catalogue);
 currentConnection(snapshot.connection,current);
 catalogueBound(snapshot.catalogueDigest,cat);
 requireFact(canonicalJSON(snapshot.engineRevisions)===canonicalJSON(cat.engineRevisions),'CATALOGUE_MISMATCH');
 const {sourceRevision,...projection}=snapshot;
 requireFact(sourceRevision===digestValue('material-sources',projection).sha256,'NON_CANONICAL_AMBIGUITY');
 let previous=null;
 for(const row of snapshot.materials){
  if(previous)requireFact(compareUTF16(previous.materialRef,row.materialRef)<0 ||
   (previous.materialRef===row.materialRef&&(previous.orientation??-1)<(row.orientation??-1)));
  previous=row;
  requireFact(Object.hasOwn(cat.materials,row.materialRef),'CATALOGUE_MISMATCH','CATALOGUE_UNRESOLVED');
  const tags=cat.materials[row.materialRef];
  requireFact(row.definitionRevision===tags.definitionRevision,'CATALOGUE_MISMATCH');
  if(row.orientation!==null)requireFact(tags.orientations!==null&&tags.orientations.includes(row.orientation),'UNSUPPORTED_MUTATION_SEMANTICS');
  else requireFact(tags.orientations===null,'UNSUPPORTED_MUTATION_SEMANTICS');
  if(row.availability==='UNKNOWN'){
   if(row.reason==='UNKNOWN_ORIENTATION')requireFact(tags.orientations===null);
   if(row.reason==='UNKNOWN_DEFINITION')requireFact(tags.definitionRevision===null);
  }
 }
 return facts;
}
/** ReadEngineFacts result for the current connection. */
export function validateEngineFacts(input, current) {
 const facts=validateType('EngineFacts',input);
 currentConnection(facts.connection,current);
 return facts;
}
/** ReadWriteProfile result for the current connection and Catalogue. */
export function validateWriteProfile(input, catalogue, current) {
 const profile=validateType('WriteProfile',input);
 currentConnection(profile.connection,current);catalogueBound(profile.catalogueDigest,catalogue);
 return profile;
}
/** ReadWorldSourceCapabilities result for the current connection and Catalogue. Write path conclusions name only
 * Catalogue materials, and a placeable material has no side effect and no persistent state on the path. */
export function validateWorldSourceCapabilities(input, catalogue, current) {
 const caps=validateType('WorldSourceCapabilities',input),cat=validateType('Catalogue',catalogue);
 currentConnection(caps.connection,current);catalogueBound(caps.catalogueDigest,cat);
 const {path,materials}=caps.writePath,clean=c=>c.hasSideEffects===false&&c.hasPersistentState===false;
 requireFact(Object.keys(materials).every(m=>Object.hasOwn(cat.materials,m)),'CATALOGUE_MISMATCH','CATALOGUE_UNRESOLVED');
 for(const [ref,tags] of Object.entries(cat.materials))
  if(tags.placeable===true)requireFact(clean(path)&&Object.hasOwn(materials,ref)&&clean(materials[ref]),'CATALOGUE_MISMATCH','CATALOGUE_UNRESOLVED');
 return caps;
}
const unknownFact = () => requireFact(false,'CAPABILITY_UNAVAILABLE','REQUIRED_FACT_UNKNOWN');
/** The complete CompilationConfig the world source declares, unchanged; a named refusal when the backend is unknown. */
export function requireWriteProfileConfig(profile) {
 const p=validateType('WriteProfile',profile);
 if(p.compilationConfig===null)unknownFact();
 return p.compilationConfig;
}
/** The declared body size (WriteProfile or WorldSourceCapabilities); a named refusal when none is declared. */
export function requireDeclaredAvatarEnvelope(fact) {
 const input=snapshotJSON(fact);
 const f=validateType(input?.profileVersion==='world-source-capabilities/v1'?'WorldSourceCapabilities':'WriteProfile',input);
 if(f.avatarEnvelope.availability!=='KNOWN')unknownFact();
 return f.avatarEnvelope.size;
}
/** world-inspection/v1 ReadInspectionContext: the answer is about the session (TRANSACTION_CONFLICT/PAYLOAD_CHANGED
 * otherwise) and the World (CURRENT_WORLD_MISMATCH/REVISION_CHANGED otherwise) that were asked; the bound-response rule. */
export function validateInspectionContextResponse(request, response) {
 return validateBoundResponse('world-inspection/v1','ReadInspectionContext',request,response);
}
