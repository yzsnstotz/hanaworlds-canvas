import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { contractMetadata, schemaBundle } from './generated/contracts.mjs';
import {validateLifecycleDomain, validateLifecycleBinding} from './world-lifecycle.mjs';
import {validateToolDomain, validateToolBinding} from './skill-tools.mjs';
import {validatePluginRolesBinding} from './plugin-roles-binding.mjs';
import {validateScopedRegionUndoBinding} from './scoped-region-undo.mjs';
import {validatePlacementSettingsBinding} from './placement-settings.mjs';
import { snapshotJSON, deepFreeze, decodeRawJSON } from '../strict-json.mjs';
import { validateShape } from './schema-validator.mjs';
import { validateDomain, validateEventDomain, guardRefusalError as domainGuardRefusalError } from './domain.mjs';
import { requireFact, fail, ContractError } from '../errors.mjs';
import { inside, validateExactEffects, comparePosition, compareUTF16 } from '../geometry.mjs';
import { placementApplyCoherence, requireConfirmedPlacementSent } from './placement.mjs';
export { decodeRawJSON, snapshotJSON, deepFreeze, assertPureJSON } from '../strict-json.mjs';
export { ContractError, publicError } from '../errors.mjs';
export { normalizeName, validateNameSyntax, requireUnicode17, runtimeCompatibility } from '../names.mjs';
export { boxCellCount, unionCellCount, validateExactEffects, comparePosition, compareUTF16 } from '../geometry.mjs';
export const version = contractMetadata.version;
export const wireVersions = contractMetadata.wireVersions;
export const compiledOperationsVersion = contractMetadata.compiledOperationsVersion;
export const operationContracts = contractMetadata.operations;
export const canvasEventRules = contractMetadata.canvasEventRules;
export const ownership = contractMetadata.ownership;
export const placementSettingDescriptors = contractMetadata.placementSettings;
export const placementInvariants = contractMetadata.placementInvariants;
export const settingsSurface = contractMetadata.settingsSurface;
export const digestProfile = contractMetadata.digest;
export const schemaInventory = contractMetadata.typeNames;
export const contractHandshake = contractMetadata.contractHandshake;
export const contractsCompatibility = contractMetadata.contractsCompatibility;
export const sessionWorldSeam = contractMetadata.sessionWorldSeam;
export { schemaBundle };
export function validateType(typeName, value) {
  const snapshot = snapshotJSON(value);
  const visits = validateShape(typeName, snapshot);
  validateDomain(visits);
  validateLifecycleDomain(visits);
  validateToolDomain(visits);
  // Check every nested RegionChunk, including standalone admission and enclosing digests.
  for (const {name, value} of visits) if (name === 'RegionChunk' && Object.hasOwn(value, 'blockDigest'))
    validateDigestBinding('region-block', value.block, value.blockDigest);
  if (Object.hasOwn(canvasEventRules, typeName)) validateEventDomain(typeName, snapshot);
  return deepFreeze(snapshot);
}
export function assertType(typeName, value) { validateType(typeName, value); }
export function admitType(typeName, bytes) { return validateType(typeName, decodeRawJSON(bytes)); }
export function validateCanvasEvent(typeName, value) {
  if (!Object.hasOwn(canvasEventRules, typeName)) throw new TypeError('Unknown Canvas event type');
  return validateType(typeName, value);
}
function operation(wire, operationName) {
  if (!Object.hasOwn(operationContracts, wire)) fail('UNSUPPORTED_VERSION', 'decode', 'VERSION_UNSUPPORTED');
  const result = operationContracts[wire].find(op => op.operation === operationName);
  if (!result) fail('UNSUPPORTED_OPERATION', 'validate', 'INVALID_SHAPE');
  return result;
}
export function validateRequest(wire, operationName, value) {
  const request = validateType(operation(wire, operationName).request, value);
  return request;
}
export function admitRequest(wire, operationName, bytes) {
  // Raw admission precedes any operation-level/provider access.
  const value = decodeRawJSON(bytes);
  return validateRequest(wire, operationName, value);
}
export function validateResponse(wire, operationName, value) {
  const op = operation(wire, operationName);
  value = snapshotJSON(value);
  // alternateResult is an explicit operation-level public type, not an invented
  // field in the frozen CreateBuildPlanResponse envelope.
  if (op.alternateResult && value !== null && typeof value === 'object' && Object.hasOwn(value, 'clarificationId')) return validateType(op.alternateResult, value);
  const response = validateType(op.response, value);
  return response;
}
function safeCanonicalize(value) {
  // Prevent inherited serialization hooks from entering the upstream library.
  for (const proto of [Object.prototype, Array.prototype]) {
    if (Object.getOwnPropertyDescriptor(proto, 'toJSON')) fail('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  }
  return canonicalize(value); // exactly the pinned, unmodified published implementation
}
/** JCS only, without a production digest domain. Useful for conformance. */
export function canonicalJSON(value) { return safeCanonicalize(snapshotJSON(value)); }
/** Exact projection input, not an arbitrary untyped envelope. All 19 projections
 * are reconstructed using their OWN declared top-level fields; nested digest,
 * metadata/inventory/timer/state-profile fields are retained unchanged. */
export function project(kind, payload) {
  const typeName = digestProfile.projectionTypes[kind];
  if (!typeName) throw new TypeError('Unknown production digest kind');
  const admitted = validateType(typeName, payload);
  const fields = schemaBundle.definitions[typeName].properties;
  const projection = Object.create(null);
  // An absent optional field stays absent: its digest equals the digest before the field existed.
  for (const field of Object.keys(fields)) if (Object.hasOwn(admitted, field)) projection[field] = admitted[field];
  return deepFreeze(projection);
}
export function digestValue(kind, payload) {
  const projection = project(kind, payload);
  const canonicalUtf8 = safeCanonicalize(projection);
  const domain = (digestProfile.domainPrefixByKind?.[kind] ?? digestProfile.domainPrefix) + kind + digestProfile.domainSuffix;
  const preimageUtf8 = domain + canonicalUtf8;
  const bytes = Buffer.from(preimageUtf8, 'utf8');
  return deepFreeze({ kind, projection, canonicalUtf8, preimageUtf8, preimageHex: bytes.toString('hex'), sha256: createHash('sha256').update(bytes).digest('hex') });
}
export function digestRaw(kind, bytes) { return digestValue(kind, decodeRawJSON(bytes)); }
/** Extract ONLY a publicly declared typed field. Validation is applied to the
 * entire source first; this is how wrapper digests/metadata stay out without
 * recursively deleting any field named digest. No arbitrary loose envelope. */
export function projectField(kind, sourceType, source, field) {
  const admitted = validateType(sourceType, source);
  const type = digestProfile.projectionTypes[kind];
  const prop = schemaBundle.definitions[sourceType]?.properties?.[field];
  const target = prop?.$ref ?? prop?.anyOf?.find(x => x.$ref)?.$ref;
  requireFact(target === '#/definitions/' + type, 'SCHEMA_INVALID', 'INVALID_SHAPE');
  return project(kind, admitted[field]);
}
// Approved rc.5/rc.8 oracles pin NON_CANONICAL_AMBIGUITY/validate/PAYLOAD_CHANGED to retryability NEVER:
// resending the same changed payload cannot succeed.
const ambiguity = ok => requireFact(ok, 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED', 'validate', { retryability: 'NEVER' });
export function validateDigestBinding(kind, payload, providedDigest) {
  validateType('Digest', providedDigest);
  const actual = digestValue(kind, payload);
  if (kind === 'reference-brief') requireFact(actual.sha256 === providedDigest, 'MEDIA_DIGEST_MISMATCH', 'PAYLOAD_CHANGED');
  else ambiguity(actual.sha256 === providedDigest);
  return actual;
}
export function validateFactsCoverage(factsInput, coverageInput) {
  const facts = validateType('TargetFacts', factsInput); const coverage = validateType('Coverage', coverageInput);
  validateDigestBinding('coverage', coverage, facts.coverageDigest);
  requireFact(JSON.stringify(facts.sampledBounds) === JSON.stringify(coverage.sampledBounds), 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
  const union = [...facts.occupiedCells.map(x => x.position), ...facts.knownEmptyCells, ...facts.unknownCells.map(x => x.position)].sort(comparePosition);
  requireFact(JSON.stringify(union) === JSON.stringify(coverage.sampledPositions), 'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
  return facts;
}
export function validateStaticMaterials(materialsInput, catalogueInput) {
  const materials = validateType('MaterialMap', materialsInput); const catalogue = validateType('Catalogue', catalogueInput);
  for (const material of Object.values(materials)) {
    requireFact(Object.hasOwn(catalogue.materials, material.materialRef), 'CATALOGUE_MISMATCH', 'CATALOGUE_UNRESOLVED');
    const tags = catalogue.materials[material.materialRef];
    requireFact(tags.orientations !== null && tags.definitionRevision !== null && tags.placeable === true,
      'UNSUPPORTED_MUTATION_SEMANTICS', 'REQUIRED_FACT_UNKNOWN');
    requireFact(tags.orientations.includes(material.orientation), 'UNSUPPORTED_MUTATION_SEMANTICS', 'REQUIRED_FACT_UNKNOWN');
  }
  return materials;
}
/** An occupied cell never reports the Catalogue's empty material (that cell is known empty). */
export function requireOccupiedNotEmpty(factsInput, catalogueInput) {
  const facts = validateType('TargetFacts', factsInput); const catalogue = validateType('Catalogue', catalogueInput);
  requireFact(facts.occupiedCells.every(c => c.materialRef !== catalogue.emptyMaterialRef), 'SCHEMA_INVALID', 'INVALID_SHAPE');
  return facts;
}
/** Safety capabilities: who must advertise which check, and the exact public error when it is
 * absent or fails. Contracts fix no rule value; they only name what can be checked. */
export const safetyCapabilities = contractMetadata.safetyCapabilities;
const safetyCapability = id => {
  const c = safetyCapabilities.find(x => x.id === id);
  if (!c) throw new Error('unknown safety capability ' + id);
  return c;
};
/** Ids from `ids` that a peer's ProtocolHandshake does not advertise, with their named cause. */
export function unmetSafetyCapabilities(handshakeInput, ids) {
  const advertised = validateType('ProtocolHandshake', handshakeInput).capabilities;
  return deepFreeze(ids.map(safetyCapability).filter(c => !advertised.includes(c.id))
    .map(c => ({ id: c.id, cause: c.cause, error: c.whenAbsent })));
}
/** Throws the named absent-capability error for the first unmet id; returns the checked ids. */
export function requireSafetyCapabilities(handshakeInput, ids) {
  const [unmet] = unmetSafetyCapabilities(handshakeInput, ids);
  if (unmet) fail(unmet.error.code, unmet.error.phase, unmet.error.reason);
  return deepFreeze([...ids]);
}
/** Engine guards (G1 body clearance, G2 cell protection, G3 player enclosure): what each stage
 * maps to, and the exact Error that a GuardRefusal stands beside. */
export const engineGuards = contractMetadata.engineGuards;
export function guardRefusalError(refusalInput, options = {}) {
  const refusal = validateType('GuardRefusal', refusalInput);
  return deepFreeze(validateType('Error', domainGuardRefusalError(refusal, options)));
}
/** Requirements {guard, stage, protectionPrincipal?} that a declaration does not cover, as
 * GUARD_UNAVAILABLE refusals. A null declaration covers nothing. ACTING_PRINCIPAL protection is
 * never satisfied by ANONYMOUS coverage. */
export function unmetEngineGuards(declarationInput, requirements) {
  const declaration = declarationInput === null ? null : validateType('EngineGuardDeclaration', declarationInput);
  return deepFreeze(requirements.map(r => {
    validateType('EngineGuard', r.guard); validateType('EngineGuardStage', r.stage);
    const c = declaration?.coverage.find(x => x.guard === r.guard);
    const covered = !!c && c.stages.includes(r.stage) &&
      (r.protectionPrincipal === undefined || r.protectionPrincipal === null || r.protectionPrincipal === c.protectionPrincipal);
    return covered ? null : { guard: r.guard, stage: r.stage, finding: 'GUARD_UNAVAILABLE' };
  }).filter(x => x !== null));
}
/** Pre-flight: throws the named CAPABILITY_UNAVAILABLE for the first uncovered requirement. */
export function requireEngineGuards(declarationInput, requirements) {
  const [unmet] = unmetEngineGuards(declarationInput, requirements);
  if (unmet) { const e = guardRefusalError(unmet, { preflight: true }); fail(e.code, e.phase, e.reason); }
  return deepFreeze(requirements.map(r => ({ ...r })));
}
/** Site rules that no peer of this major can check are refused by capability name, never ignored.
 * A stated light rule always is (no light witness kind exists); a required entrance is refused
 * only on paths without an entrance check (`entrance:false`, e.g. painter-region). */
export function requireSiteRuleChecks(rules, { entrance }) {
  const light = safetyCapability('painter/v6:light-rule').whenAbsent;
  requireFact(rules.optionalLightRule === null, light.code, light.reason, light.phase);
  if (!entrance) {
    const e = safetyCapability('painter-region/v3:entrance-rule').whenAbsent;
    requireFact(!rules.requireEntranceConnectivity, e.code, e.reason, e.phase);
  }
}
/** The only SafetyProfile source for a confirmed build: the non-switchable invariants plus the
 * player-confirmed skill site rules. No World, Host or package value is consulted. */
export function safetyProfileFromConfirmedIntent(intentInput) {
  const { siteRules } = validateType('IntentProjection', intentInput).confirmedIntent;
  return deepFreeze(validateType('SafetyProfile', { profileVersion: 'safety-profile/v5', connectivity: 6,
    requireBodyClearance: true, requireEntranceConnectivity: siteRules.requireEntranceConnectivity,
    hazardPolicy: siteRules.hazardPolicy, optionalLightRule: siteRules.optionalLightRule }));
}
/** Coherence of complete supplied facts. The returned object is intentionally
 * a pure supplied-facts check; it does not read the world. */
export function validateWitnessCoherence({ build: buildInput, finalEffects: effectsInput, targetFacts: factsInput, safetyProfile: safetyInput, catalogue: catalogueInput }) {
  const build = validateType('BuildProjection', buildInput), effects = validateType('FinalEffects', effectsInput), facts = validateType('TargetFacts', factsInput), safety = validateType('SafetyProfile', safetyInput), catalogue = validateType('Catalogue', catalogueInput);
  validateStaticMaterials(build.materials, catalogue);
  requireOccupiedNotEmpty(facts, catalogue);
  validateExactEffects(build.operations, build.materials, effects.effects);
  const hashes = { finalEffectsDigest: digestValue('final-effects', effects).sha256, targetFactsDigest: digestValue('target-facts', facts).sha256, safetyProfileDigest: digestValue('safety-profile', safety).sha256 };
  ambiguity(build.catalogueDigest === digestValue('catalogue', catalogue).sha256 && build.targetFactsDigest === hashes.targetFactsDigest && build.safetyProfileDigest === hashes.safetyProfileDigest);
  requireFact(safety.requireBodyClearance, 'CAPABILITY_UNAVAILABLE', 'POLICY_UNAVAILABLE');
  // No witness kind for light exists in this major: a stated rule is refused by capability name.
  requireSiteRuleChecks(safety, { entrance: true });
  const required = ['COVERAGE', 'BODY_CLEARANCE', 'HAZARD'];
  if (safety.requireEntranceConnectivity) required.push('ENTRANCE_CONNECTIVITY');
  for (const predicate of required) requireFact(build.witnesses.some(w => w.predicate === predicate), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
  const effectPositions = effects.effects.map(x => JSON.stringify(x.position));
  for (const w of build.witnesses) {
    for (const key of Object.keys(hashes)) ambiguity(w[key] === hashes[key]);
    if (w.facts.positions) {
      const positions = new Set(w.facts.positions.map(x => JSON.stringify(x)));
      if (['COVERAGE','BODY_CLEARANCE'].includes(w.predicate)) requireFact(effectPositions.every(p => positions.has(p)), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
    }
    // BODY_CLEARANCE carries no player geometry: actual bodies are checked inside the engine at
    // inspection and before every write; the witness only binds the covered positions.
    if (w.predicate === 'HAZARD') {
      ambiguity(w.facts.forbidLiquid === safety.hazardPolicy.forbidLiquid && w.facts.maximumDamagePerSecond === safety.hazardPolicy.maximumDamagePerSecond);
      for (const p of w.facts.positions) {
        const written = effects.effects.find(e => JSON.stringify(e.position) === JSON.stringify(p));
        const occupied = facts.occupiedCells.find(e => JSON.stringify(e.position) === JSON.stringify(p));
        const empty = facts.knownEmptyCells.some(q => JSON.stringify(q) === JSON.stringify(p));
        const materialRef = written?.materialRef ?? occupied?.materialRef ?? (empty ? catalogue.emptyMaterialRef : null);
        requireFact(materialRef !== null && Object.hasOwn(catalogue.materials, materialRef), 'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
        const c = catalogue.materials[materialRef];
        requireFact(c.liquid !== null && c.hazardPerSecond !== null, 'UNSUPPORTED_MUTATION_SEMANTICS', 'REQUIRED_FACT_UNKNOWN');
        requireFact((!w.facts.forbidLiquid || c.liquid === false) && c.hazardPerSecond <= w.facts.maximumDamagePerSecond, 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
      }
    }
  }
  return deepFreeze({ coherent: true, authenticityVerified: false, worldWrites: 0 });
}

/** Adapter-produced RegionInspection self-coherence: the facts digest, the frame
 * digest and the coverage digest are recomputed from the carried values. */
export function validateRegionInspection(value) {
  const inspection = validateType('RegionInspection', value);
  const tf = inspection.targetFacts;
  validateDigestBinding('target-facts', tf, inspection.targetFactsDigest);
  validateDigestBinding('frame', inspection.frame, tf.frameDigest);
  const sampledPositions = [...tf.occupiedCells.map(x => x.position), ...tf.knownEmptyCells, ...tf.unknownCells.map(x => x.position)].sort(comparePosition);
  validateDigestBinding('coverage', { profileVersion: 'coverage/v2', sampledBounds: tf.sampledBounds, sampledPositions }, tf.coverageDigest);
  return inspection;
}

const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const associated = ok => requireFact(ok, 'TRANSACTION_CONFLICT', 'PAYLOAD_CHANGED');
const current = ok => requireFact(ok, 'CURRENT_WORLD_MISMATCH', 'REVISION_CHANGED');
const pairs = [['build','buildDigest','build'],['operations','operationDigest','operations'],
 ['intent','intentDigest','intent'],['referenceBrief','referenceBriefDigest','reference-brief'],
 ['brief','briefDigest','reference-brief'],['catalogue','catalogueDigest','catalogue'],
 ['targetFacts','targetFactsDigest','target-facts'],['safetyProfile','safetyProfileDigest','safety-profile'],
 ['compilationConfig','compilationConfigDigest','compilation-config'],['surfaceAction','surfaceActionDigest','surface-action'],
 ['analysis','analysisDigest','affected-analysis'],['scope','scopeDigest','scoped-world']];
/** Pure relation checks. Live connection/selection and journal facts come from the
 * owning provider, never from JSON submitted by a model or external caller. */
export function validateBoundRequest(wire, name, input) {
 const request=validateRequest(wire,name,input);
 for(const [field,hash,kind] of pairs)if(Object.hasOwn(request,field)&&Object.hasOwn(request,hash))validateDigestBinding(kind,request[field],request[hash]);
 const context=request.localContext;
 if(context) {
  if(request.worldRef!==undefined)current(request.worldRef===context.worldRef);
  for(const child of [request.operations,request.expectedOperations,request.scope,request.targetFacts,request.analysis])
   if(child?.worldRef!==undefined&&child.worldRef!==null)current(child.worldRef===context.worldRef);
  if(request.scope)current(same(request.scope.localContext,context));
 }
 if(request.preparedTransaction){const p=request.preparedTransaction;validateDigestBinding('scoped-transaction-payload',p.payload,p.transactionPayloadDigest);
  associated(p.payload.transactionId===request.transactionId&&p.payload.operationDigest===request.operationDigest&&p.payload.scopeDigest===request.scopeDigest&&p.scopeDigest===request.scopeDigest);
  current(same(p.payload.localContext,context)&&p.payload.worldRef===request.worldRef);
 }
 if(request.scope){associated(request.scope.transactionId===request.transactionId&&request.scope.operationDigest===request.operationDigest);}
 if(request.regionInspection){const ri=validateRegionInspection(request.regionInspection);
  associated(same(ri.targetFacts,request.targetFacts)&&ri.targetFactsDigest===request.targetFactsDigest);
 }
 if(request.build){for(const k of ['catalogueDigest','targetFactsDigest','safetyProfileDigest'])if(request[k]!==undefined)associated(request.build[k]===request[k]);
  if(request.targetFacts)validateDigestBinding('frame',request.build.coordinateFrame,request.targetFacts.frameDigest);
 }
 if(request.regionInspectionBinding){const b=request.regionInspectionBinding.build;
  validateDigestBinding('build',b,request.operations.buildDigest);
  validateDigestBinding('frame',b.coordinateFrame,request.operations.frameDigest);
  associated(b.targetFactsDigest===request.operations.targetFactsDigest&&b.catalogueDigest===request.operations.catalogueDigest);
  placementApplyCoherence(request);
 }
 if(request.historyOperationDigest){const keys=Object.keys(schemaBundle.definitions.HistoryOperationProjection.properties);
  if(keys.every(k=>Object.hasOwn(request,k)))validateDigestBinding('history-operation',Object.fromEntries(keys.map(k=>[k,request[k]])),request.historyOperationDigest);
 }
 if(name==='PrepareHistoryTransaction'){
  associated(request.originTransactionId!==request.transactionId);
  associated(request.targetStateDigest===(request.direction==='UNDO'?request.originBeforeStateReadbackDigest:request.originAfterReadbackDigest));
  associated(request.expectedCurrentStateDigest===(request.direction==='UNDO'?request.originAfterReadbackDigest:request.originBeforeStateReadbackDigest));
 }
 if(request.preparedHistoryTransaction){for(const k of ['originTransactionId','transactionId','direction','historyOperationDigest'])associated(request.preparedHistoryTransaction[k]===request[k]);
  current(same(request.preparedHistoryTransaction.localContext,context));
 }
 return request;
}
export function requestDigest(wire,name,input) {
 const request=validateBoundRequest(wire,name,input);
 return createHash('sha256').update('HanaWorlds|contracts@0.4.0|request|'+wire+'|'+name+'|'+canonicalJSON(request)).digest('hex');
}
/** Provider admission instruction: RETURN_STORED never executes another write.
 * Reservation + stored outcome must be durable in that provider's own state. */
export function validateCurrentRequest(wire,name,input,factsInput) {
 const request=validateBoundRequest(wire,name,input),facts=validateType('LocalRequestFacts',factsInput);
 associated(request.sessionRef===facts.sessionRef);
 if(request.localContext)current(same(request.localContext,facts.currentContext));
 if(Object.hasOwn(request,'expectedContext'))current(same(request.expectedContext,facts.currentContext));
 const turn=request.expectedTurnRevision??request.turnRevision;
 if(turn!==undefined)requireFact(turn===facts.currentTurnRevision,'TURN_REVISION_MISMATCH','REVISION_CHANGED');
 if(request.referenceBriefDigest)associated(request.referenceBriefDigest===facts.currentBriefDigest);
 requireFact(facts.requestState!=='CANCELLED','REQUEST_CANCELLED','REVISION_CHANGED');
 requireFact(facts.requestState!=='UNKNOWN','REQUEST_NOT_ACTIVE','REQUIRED_FACT_UNKNOWN');
 const hash=requestDigest(wire,name,request);
 associated(facts.replay!=='CONFLICT');
 if(facts.replay==='NEW')associated(facts.priorRequestDigest===null&&facts.requestState==='ACTIVE');
 else associated(facts.priorRequestDigest===hash&&facts.requestState==='COMPLETED');
 return deepFreeze({request,requestDigest:hash,disposition:facts.replay==='NEW'?'EXECUTE':'RETURN_STORED'});
}
// The one contracts version predicate: same package, well-formed semver, equal major. Minor, patch,
// prerelease and build provenance never decide; structure, wires and capabilities are checked separately.
const contractsRef=new RegExp('^'+contractsCompatibility.package+'@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$','u');
export function checkContractsVersion(ref) {
 const m=typeof ref==='string'?contractsRef.exec(ref):null;
 requireFact(m!==null&&Number(m[1])===contractsCompatibility.major,'UNSUPPORTED_VERSION','VERSION_UNSUPPORTED','decode');
 return deepFreeze({result:'CONTRACTS_MAJOR_MATCH',major:contractsCompatibility.major,advertised:ref});
}
/** Schema entry: a peer's published schema bundle ($id) or profile (version) is accepted by the same
 * major predicate; every type the caller relies on must still be present (version never implies it). */
const schemaId=/^https:\/\/hanaworlds\.invalid\/contracts\/([^/]+)\/schema\.json$/u;
export function checkSchemaCompatibility(input,requiredTypes=[]) {
 const isObject=input!==null&&typeof input==='object'&&!Array.isArray(input);
 const id=isObject&&typeof input.$id==='string'?schemaId.exec(input.$id):null;
 const version=id!==null?id[1]:isObject&&!Object.hasOwn(input,'$id')&&typeof input.version==='string'?input.version:null;
 const {major}=checkContractsVersion(version===null?null:contractsCompatibility.package+'@'+version);
 const definitions=isObject?input.definitions:null;
 requireFact(definitions!==null&&typeof definitions==='object'&&!Array.isArray(definitions),'SCHEMA_INVALID','INVALID_SHAPE','decode');
 requireFact(Array.isArray(requiredTypes)&&requiredTypes.every(t=>typeof t==='string'&&Object.hasOwn(definitions,t)),'CAPABILITY_UNAVAILABLE','VERSION_UNSUPPORTED','decode');
 return deepFreeze({result:'SCHEMA_MAJOR_MATCH',major,version,requiredTypes:[...requiredTypes]});
}
/** Wires added in a minor are advertised but not required by default: an earlier minor of the same major stays compatible. */
export const minorWires = contractMetadata.minorWires;
const defaultRequiredWires = wireVersions.filter(w => !Object.hasOwn(minorWires, w));
export function checkContractHandshake(advertisedInput,required={wires:defaultRequiredWires,factProfiles:['target-facts/v5']}) {
 const advertised=validateType('ContractHandshake',advertisedInput);
 checkContractsVersion(advertised.contracts);
 requireFact(advertised.compiledOperationsVersion===compiledOperationsVersion&&required.wires.every(w=>wireVersions.includes(w)&&advertised.wireVersions.includes(w))&&required.factProfiles.every(f=>advertised.factProfiles.includes(f)), 'UNSUPPORTED_VERSION','VERSION_UNSUPPORTED','decode');
 return deepFreeze({result:'HANDSHAKE_VERSION_MATCH',advertised});
}
export function validateCurrentBuildSubmission(input,factsInput) {
 const submission=validateType('CurrentBuildSubmission',input),{parentRequest:parent,apply,intent,analysis}=submission;
 validateCurrentRequest('session/v5','AdvanceCurrentBuild',parent,factsInput);
 validateBoundRequest('canvas/v7','ApplyRecoverableCommit',apply);
 current(same(parent.localContext,apply.localContext));associated(parent.sessionRef===apply.sessionRef&&parent.worldRef===apply.worldRef);
 associated(intent.intendedWorldRef===parent.worldRef&&intent.confirmedIntent.confirmedTurnRevision===parent.expectedTurnRevision&&intent.referenceBriefDigest===factsInput.currentBriefDigest);
 associated(analysis.worldRef===parent.worldRef&&analysis.operationDigest===apply.operationDigest);
 validateDigestBinding('affected-analysis',analysis,apply.analysisDigest);
 // This entry builds a fresh object. Existing affected objects are a Canvas conflict.
 requireFact(analysis.affectedObjectRefs.length===0,'OTHER_OBJECTS_AFFECTED','SCOPE_DENIED');
 associated(apply.decisionRevision===null&&apply.guarantee==='RECOVERABLE_VERIFIED');
 requireConfirmedPlacementSent(intent,apply);
 return submission;
}
/** World selectors a request itself carries: top-level worldRef, its localContext, or the
 * host-injected tool context. Model input, raw JSON and messages are never selectors. */
export function requestWorldSelectors(request) {
 return [request.worldRef,request.localContext?.worldRef,request.hostContext?.localContext?.worldRef].filter(w=>typeof w==='string');
}
/** 2.8.0 world-adapter/v8 QueryTransaction: a durable receipt keeps the context it was written
 * with. The envelope's currentLocalContext is bound to the request in full (currency is not
 * relaxed); the historical receipt is bound by its digest, world and transaction only. */
function historicalReceiptBinding(wire,name,request,response) {
 const pair=contractMetadata.historicalReceipt.fields.filter(k=>Object.hasOwn(response,k));
 if(pair.length===0)return false;
 requireFact(wire===contractMetadata.historicalReceipt.wire&&name===contractMetadata.historicalReceipt.operation&&pair.length===2&&response.result!==null&&response.error===null,'SCHEMA_INVALID','INVALID_SHAPE','decode');
 const receipt=response.result;
 current(same(response.currentLocalContext,request.localContext));
 validateDigestBinding('receipt',receipt,response.receiptDigest);
 current(receipt.localContext.worldRef===request.worldRef);
 associated(receipt.transactionId===request.transactionId&&receipt.transactionPayloadDigest===request.transactionPayloadDigest);
 return true;
}
export function validateBoundResponse(wire,name,requestInput,responseInput) {
 const request=validateBoundRequest(wire,name,requestInput),response=validateResponse(wire,name,responseInput);
 associated(response.requestId===request.requestId);
 validateLifecycleBinding(wire,name,request,response);
 validateToolBinding(wire,name,request,response);
 validatePluginRolesBinding(wire,name,request,response);
 validatePlacementSettingsBinding(wire,name,request,response);
 validateScopedRegionUndoBinding(wire,name,request,response);
 // 2.7.0: an error naming its target world must name every world the request selected.
 if(response.error?.worldRef!==undefined)for(const selected of requestWorldSelectors(request))current(response.error.worldRef===selected);
 const history=historicalReceiptBinding(wire,name,request,response);
 const result=response.result;
 if(result){
  if(result.connectionRef!==undefined&&request.connectionRef!==undefined)current(result.connectionRef===request.connectionRef);
  if(name==='SelectWorldConnection'){current(result.activeWorldRef===request.worldRef&&result.localContext?.connectionRef===request.connectionRef&&result.localContext?.connectionIncarnationRef===request.connectionIncarnationRef);associated(result.currentSession===request.sessionRef);}
  if(name==='UnselectWorldConnection'){associated(result.currentSession===request.sessionRef);current(result.activeWorldRef===null&&result.localContext===null&&result.orderedSelectedObjectRefs.length===0);}
  if(name==='ReserveWorldRetirement')current(result.inventoryRevision===request.expectedInventoryRevision);
  if(name==='ReleaseWorldRetirement')associated(result.reservationRef===request.reservationRef&&result.outcome===request.outcome);
  if(name==='BuildDocument'){validateDigestBinding('operations',result.projection,result.operationDigest);associated(result.projection.buildDigest===request.buildDigest&&result.projection.worldRef===request.worldRef&&result.projection.targetFactsDigest===request.targetFactsDigest&&result.projection.compilationConfigDigest===request.compilationConfigDigest);validateExactEffects(request.build.operations,request.build.materials,result.projection.effects);}
  if((name==='InspectPlacementRegion'||name==='InspectRegion') && request.footprint?.geometryProfile!==undefined && result.outcome==='REGION_INSPECTED'){
   const inspection=validateRegionInspection(result.inspection);
   current(inspection.targetFacts.worldRef===request.worldRef);
   associated(inspection.anchorKind===request.anchor.kind);
   requireFact(inspection.targetFacts.geometryProfile===request.footprint.geometryProfile,'CAPABILITY_GAP','GEOMETRY_PROFILE_UNSUPPORTED');
  }
  if(result.localContext&&request.localContext&&!history)current(same(result.localContext,request.localContext));
  if(result.worldRef!==undefined&&request.worldRef!==undefined)current(result.worldRef===request.worldRef);
  // Named fact reads carry their World in the connection rather than at the result root.
  if(contractMetadata.worldSourceFacts.operations.some(o=>o.wire===wire&&o.operation===name)){
   const connection=result.connection??result.snapshot?.connection;
   if(connection)current(connection.worldRef===request.worldRef);
  }
  if(result.sessionRef!==undefined)associated(result.sessionRef===request.sessionRef);
  if(result.transactionId!==undefined&&request.transactionId!==undefined)associated(result.transactionId===request.transactionId);
  if(result.operationDigest!==undefined&&request.operationDigest!==undefined)associated(result.operationDigest===request.operationDigest);
 }
 return response;
}
export function projectScopedPreparedTransaction(input) {
 const result=validateType('ScopedPreparedTransactionResult',input);
 validateDigestBinding('scoped-transaction-payload',result.payload,result.transactionPayloadDigest);
 return validateType('ScopedPreparedTransaction',Object.fromEntries(Object.keys(schemaBundle.definitions.ScopedPreparedTransaction.properties).map(k=>[k,result[k]])));
}
export function validateWorldSelection(input,factsInput,connectionInput) {
 const {request}=validateCurrentRequest('canvas/v7','SelectWorldConnection',input,factsInput);
 const connection=validateType('LocalConnectionReadback',connectionInput);
 current(request.connectionRef===connection.connectionRef&&request.worldRef===connection.worldRef&&request.connectionIncarnationRef===connection.connectionIncarnationRef);
 current(connection.capabilities.worldRef===connection.worldRef);
 return request;
}
/** Canvas supplies expected complete state (compiled result, or saved before
 * image for rollback), actual Adapter readback, and its durable history row.
 * This pure check neither performs readback nor makes a transaction decision. */
export function validateCommitReadback(receiptInput,expectedInput,actualInput,historyInput) {
 const receipt=validateType('ReceiptProjection',receiptInput),expected=validateType('ReadbackProjection',expectedInput),actual=validateType('ReadbackProjection',actualInput);
 current(expected.worldRef===receipt.localContext.worldRef&&actual.worldRef===expected.worldRef);
 requireFact(same(expected,actual),'READBACK_MISMATCH','PAYLOAD_CHANGED','readback',{mutationState:'UNKNOWN',transactionRef:receipt.transactionId});
 validateDigestBinding('readback',actual,receipt.readbackDigest);
 if(receipt.status==='VERIFIED'){
  const history=validateType('HistoryEntry',historyInput);
  associated(history.status==='VERIFIED'&&history.transactionId===receipt.transactionId&&history.operationDigest===receipt.operationDigest&&history.expectedAfterReadbackDigest===receipt.readbackDigest);
  validateDigestBinding('receipt',receipt,history.receiptDigest);
 }else associated(receipt.status==='ROLLED_BACK'&&receipt.restoreStatus==='VERIFIED_RESTORED'&&historyInput===null);
 return receipt;
}
/** session-world-seam/v1. Pure precondition for Adapter world deletion: the Canvas
 * inventory read must show no selecting Session and no other reservation. It does not
 * read Canvas or reserve anything; ReserveWorldRetirement is still required. */
export function requireWorldRetirable(inventoryInput) {
 const inventory=validateType('WorldSelectionInventory',inventoryInput);
 requireFact(inventory.sessionRefs.length===0&&inventory.retirementReservationRef===null,'TRANSACTION_CONFLICT','SCOPE_DENIED');
 return inventory;
}
/** C2/C3: compares a Canvas selection with Adapter's current ConnectionInventory.
 * CONNECTED only for the same connectionRef, worldRef and connectionIncarnationRef
 * with readiness READY; it never upgrades a stale incarnation to current. */
export function describeSelectionConnection(selectionInput,inventoryInput) {
 const selection=validateType('CanvasWorldSelection',selectionInput),inventory=validateType('ConnectionInventory',inventoryInput);
 if(selection.status==='UNBOUND')return validateType('SelectionConnectionState',{sessionRef:selection.sessionRef,status:'UNBOUND',worldRef:null,connectionRef:null});
 const ctx=selection.context.localContext;
 const live=inventory.connections.some(row=>row.readiness==='READY'&&row.connectionRef===ctx.connectionRef&&row.worldRef===ctx.worldRef&&row.connectionIncarnationRef===ctx.connectionIncarnationRef);
 return validateType('SelectionConnectionState',{sessionRef:selection.context.currentSession,status:live?'CONNECTED':'SELECTED_NOT_CONNECTED',worldRef:ctx.worldRef,connectionRef:ctx.connectionRef});
}
/** G-L executable precondition: Workshop may start Session deletion (and call Canvas
 * RetireSessionSelection) only when its provider actually supports persistent deletion.
 * Releasing live handles is not deletion. */
export function requireSessionDeleteSupported(capabilitiesInput) {
 const capabilities=validateType('PublicCapabilities',capabilitiesInput);
 requireFact(capabilities.sessionDeleteSupported===true,'SESSION_DELETE_UNSUPPORTED','DELETE_SEAM_ABSENT');
 return capabilities;
}
