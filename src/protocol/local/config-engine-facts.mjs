/** config-engine-facts/v2: pure checks over Adapter-supplied engine facts. No engine read, default,
 * persistence or world write. Provider authenticity/currentness stay with the caller.
 * No player geometry is representable here (INV-POSE-STAYS-IN-ENGINE). */
import {requireFact} from '../errors.mjs';
import {contractMetadata} from './generated/contracts.mjs';
import {validateType, digestValue, canonicalJSON} from './runtime.mjs';
export const configEngineFacts = contractMetadata.configEngineFacts;
export function validateConfigEngineFacts(input, catalogue, currentConnection) {
 const facts=validateType('ConfigEngineFacts',input);
 const cat=validateType('Catalogue',catalogue);
 const current=validateType('MaterialSourceConnection',currentConnection);
 requireFact(canonicalJSON(facts.connection)===canonicalJSON(current),'CURRENT_WORLD_MISMATCH');
 requireFact(facts.catalogueDigest===digestValue('catalogue',cat).sha256,'CATALOGUE_MISMATCH');
 const {sourceRevision,...projection}=facts;
 requireFact(sourceRevision===digestValue('config-engine-facts',projection).sha256,'NON_CANONICAL_AMBIGUITY');
 return facts;
}
// An UNAVAILABLE fact is a named refusal, never a value to fill.
export function requireKnownWriteBackend(facts) {
 const f=validateType('ConfigEngineFacts',facts);
 requireFact(f.writeBackend.availability==='KNOWN','CAPABILITY_UNAVAILABLE','REQUIRED_FACT_UNKNOWN');
 return f.writeBackend.writeBackend;
}
// avatarEnvelope has no KNOWN form: player geometry stays in the engine.
export function requireKnownAvatarEnvelope(facts) {
 validateType('ConfigEngineFacts',facts);
 const r=configEngineFacts.avatarDimensions.refusal;
 requireFact(false,r.code,r.reason,r.phase);
}
