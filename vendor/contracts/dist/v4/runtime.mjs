import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { contractMetadata, schemaBundle } from './generated/contracts.mjs';
import { snapshotJSON, deepFreeze, decodeRawJSON } from '../strict-json.mjs';
import { validateShape } from './schema-validator.mjs';
import { validateDomain, validateEventDomain } from './domain.mjs';
import { requireFact, fail, ContractError } from '../errors.mjs';
import { inside, validateExactEffects, comparePosition, compareUTF16 } from '../geometry.mjs';
export { decodeRawJSON, snapshotJSON, deepFreeze, assertPureJSON } from '../strict-json.mjs';
export { ContractError, publicError } from '../errors.mjs';
export { normalizeName, validateNameSyntax, requireUnicode17, runtimeCompatibility } from '../names.mjs';
export { boxCellCount, unionCellCount, validateExactEffects, comparePosition, compareUTF16 } from '../geometry.mjs';
export const version = contractMetadata.version;
export const wireVersions = contractMetadata.wireVersions;
export const compiledOperationsVersion = contractMetadata.compiledOperationsVersion;
export const operationContracts = contractMetadata.operations;
export const canvasEventRules = contractMetadata.canvasEventRules;
export const errorPrecedence = contractMetadata.errorPrecedence;
export const ownership = contractMetadata.ownership;
export const digestProfile = contractMetadata.digest;
export const schemaInventory = contractMetadata.typeNames;
export const providerGates = contractMetadata.providerGates;
export const contractHandshake = contractMetadata.contractHandshake;
export const legacyWireSuccessors = contractMetadata.legacyWireSuccessors;
export const placementSettingDescriptors = contractMetadata.placementSettings;
export const placementInvariants = contractMetadata.placementInvariants;
export { schemaBundle };
export function validateType(typeName, value) {
  const snapshot = snapshotJSON(value);
  const visits = validateShape(typeName, snapshot);
  validateDomain(visits);
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
  if (wire === 'world-adapter/v5') validateScopedRequest(operationName, request);
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
  if (response.error !== null) requireFact(op.failureCodes.includes(response.error.code), 'SCHEMA_INVALID', 'INVALID_SHAPE');
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
  for (const field of Object.keys(fields)) projection[field] = admitted[field];
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
/** Referential coherence checks for payloads that actually carry both sides of
 * a binding. This is not a grant verifier and never claims provider authenticity. */
const sameJSON = (a, b) => canonicalJSON(a) === canonicalJSON(b);
function validateScopedRequest(operationName, request) {
  if (operationName === 'QueryPreparedTransaction') return request;
  validateDigestBinding('operations', request.operations, request.operationDigest);
  validateDigestBinding('authorization-binding', request.authorizationBinding,
    request.scope.authorizationBindingDigest);
  validateDigestBinding('scoped-world', request.scope, request.scopeDigest);
  requireFact(request.scope.authorizationBindingDigest ===
    digestValue('authorization-binding', request.authorizationBinding).sha256,
    'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
  if (operationName === 'ApplyCompiledTransaction') {
    const p = request.preparedTransaction;
    validateDigestBinding('scoped-transaction-payload', p.payload, p.transactionPayloadDigest);
    requireFact(p.scopeDigest === request.scopeDigest && p.payload.scopeDigest === request.scopeDigest,
      'STALE_REVISION', 'REVISION_CHANGED');
    requireFact(p.payload.worldRef === request.worldRef && p.payload.transactionId === request.transactionId &&
      p.payload.operationDigest === request.operationDigest &&
      p.payload.authorizationBindingDigest === request.scope.authorizationBindingDigest &&
      p.guarantee === request.guarantee && sameJSON(p.stateProfile, request.scope.stateProfile),
      'REPLAY_MISMATCH', 'PAYLOAD_CHANGED');
    const effectPositions = request.operations.effects.map(effect => JSON.stringify(effect.position)).sort();
    requireFact(sameJSON(p.protectedPositions.map(position => JSON.stringify(position)).sort(), effectPositions),
      'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
  }
  return request;
}
/** Pure cross-envelope check; the Adapter still authenticates reads and re-reads
 * the same cells from the paired world immediately before the write barrier. */
export function validateScopedTransition(prepareInput, applyInput) {
  const prepare = validateRequest('world-adapter/v5', 'PrepareRecoverableTransaction', prepareInput);
  const apply = validateRequest('world-adapter/v5', 'ApplyCompiledTransaction', applyInput);
  requireFact(prepare.worldRef === apply.worldRef && prepare.transactionId === apply.transactionId &&
    prepare.operationDigest === apply.operationDigest && prepare.scopeDigest === apply.scopeDigest &&
    prepare.guarantee === apply.guarantee &&
    sameJSON(prepare.authorizationBinding, apply.authorizationBinding) &&
    sameJSON(prepare.operations, apply.operations) && sameJSON(prepare.scope, apply.scope),
    'STALE_REVISION', 'REVISION_CHANGED');
  return deepFreeze({ prepare, apply });
}
/** Payload-carried part of the canvas/v4 Apply region binding. The Canvas record
 * match (issued inspectionId, evidence/position lists, record revision) needs the
 * provider's durable record and is never decided here. */
function regionApplyBindingCoherence(request) {
  const binding = request.regionInspectionBinding;
  if (binding === null) return;
  // CAV4-APPLY-REGION-EVIDENCE oracle: evidence mismatch needs new facts, not a new grant.
  const identity = ok => requireFact(ok, 'PERMISSION_DENIED', 'IDENTITY_UNVERIFIED', 'authorize', { retryability: 'AFTER_NEW_FACTS' });
  identity(digestValue('build', binding.build).sha256 === request.operations.buildDigest);
  identity(binding.build.targetFactsDigest === request.operations.targetFactsDigest);
  identity(digestValue('frame', binding.build.coordinateFrame).sha256 === request.operations.frameDigest);
}
/** painter/v3: REGION_INSPECTED facts must be exactly the relayed RegionInspection. */
function painterRegionCoherence(request) {
  const ri = request.regionInspection, tf = request.targetFacts;
  if (ri === null) return;
  const stale = ok => requireFact(ok, 'TARGET_FACTS_STALE', 'REVISION_CHANGED');
  stale(sameJSON(ri.targetFacts, tf) && ri.targetFactsDigest === request.targetFactsDigest);
  stale(digestValue('target-facts', tf).sha256 === request.targetFactsDigest);
  stale(digestValue('frame', ri.frame).sha256 === tf.frameDigest);
  stale(tf.worldRef === request.worldRef);
}
export function validateBoundRequest(wire, operationName, value) {
  const request = validateRequest(wire, operationName, value);
  if (wire === 'canvas/v4' && operationName === 'ApplyRecoverableCommit') regionApplyBindingCoherence(request);
  if (wire === 'painter/v3' && operationName === 'CreateBuildPlan') painterRegionCoherence(request);
  const pairs = [['build','buildDigest','build'],['operations','operationDigest','operations'],['intent','intentDigest','intent'],
    ['referenceBrief','referenceBriefDigest','reference-brief'],['brief','briefDigest','reference-brief'],['catalogue','catalogueDigest','catalogue'],
    ['targetFacts','targetFactsDigest','target-facts'],['safetyProfile','safetyProfileDigest','safety-profile'],['compilationConfig','compilationConfigDigest','compilation-config'],
    ['surfaceAction','surfaceActionDigest','surface-action'],['analysis','analysisDigest','affected-analysis'],['authorizationBinding','authorizationBindingDigest','authorization-binding'],['manifest','resourceManifestDigest','saved-work-resources']];
  for (const [field, hashField, kind] of pairs) if (Object.hasOwn(request, field) && Object.hasOwn(request, hashField)) validateDigestBinding(kind, request[field], request[hashField]);
  if (request.preparedTransaction && wire !== 'world-adapter/v5') {
    const p = request.preparedTransaction;
    validateDigestBinding('transaction-payload', p.payload, p.transactionPayloadDigest);
    ambiguity(p.payload.transactionId === request.transactionId && p.payload.operationDigest === request.operationDigest);
  }
  if (request.build) {
    for (const field of ['catalogueDigest','targetFactsDigest','safetyProfileDigest']) if (Object.hasOwn(request, field)) ambiguity(request.build[field] === request[field]);
  }
  if (request.authorizationBinding) {
    const auth = request.authorizationBinding;
    // world-adapter/v4 is called only by Canvas (InspectRegion "caller is Canvas only"; Prepare/Apply behind the
    // trusted Canvas domain), so its request actorRef names the calling principal, not the bound end-user actor.
    const fields = wire === 'world-adapter/v4' || wire === 'world-adapter/v5'
      ? ['sessionRef','worldRef','transactionId','operationDigest']
      : ['actorRef','sessionRef','worldRef','transactionId','operationDigest'];
    for (const field of fields) if (Object.hasOwn(request, field)) requireFact(auth[field] === request[field], 'CONNECTION_UNAUTHORIZED', 'SCOPE_DENIED', 'authorize');
  }
  if (wire === 'BUILD/V2' && operationName === 'BuildDocument') {
    // A BUILD frame must be the provider frame the facts were inspected in (Adapter-computed frame).
    const tf = request.targetFacts;
    ambiguity(digestValue('frame', request.build.coordinateFrame).sha256 === tf.frameDigest);
    if (tf.source === 'INSPECTED' || tf.source === 'REGION_INSPECTED') requireFact(tf.worldRef === request.worldRef, 'TARGET_FACTS_STALE', 'REVISION_CHANGED');
  }
  if (Object.hasOwn(request, 'historyOperationDigest')) {
    const fields = schemaBundle.definitions.HistoryOperationProjection.properties;
    if (Object.keys(fields).every(field => Object.hasOwn(request, field))) {
      const projection = Object.fromEntries(Object.keys(fields).map(field => [field, request[field]]));
      validateDigestBinding('history-operation', projection, request.historyOperationDigest);
    }
  }
  if (request.preparedHistoryTransaction) {
    const prepared = request.preparedHistoryTransaction;
    for (const field of ['originTransactionId', 'transactionId', 'direction', 'historyOperationDigest'])
      ambiguity(prepared[field] === request[field]);
  }
  return request;
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
    requireFact(Object.hasOwn(catalogue.nodes, material.nodeName), 'CATALOGUE_MISMATCH', 'CATALOGUE_UNRESOLVED');
    const capability = catalogue.nodes[material.nodeName];
    requireFact(capability.allowedParam2 !== null && capability.definitionRevision !== null && capability.hasCallbacks === false && capability.hasPersistentState === false,
      'UNSUPPORTED_MUTATION_SEMANTICS', 'REQUIRED_FACT_UNKNOWN');
    requireFact(capability.allowedParam2.includes(material.param2), 'UNSUPPORTED_MUTATION_SEMANTICS', 'REQUIRED_FACT_UNKNOWN');
  }
  return materials;
}
/** Coherence of complete supplied facts. The returned object is intentionally
 * NOT a VerifiedBinding or authorization decision. */
export function validateWitnessCoherence({ build: buildInput, finalEffects: effectsInput, targetFacts: factsInput, safetyProfile: safetyInput, catalogue: catalogueInput }) {
  const build = validateType('BuildProjection', buildInput), effects = validateType('FinalEffects', effectsInput), facts = validateType('TargetFacts', factsInput), safety = validateType('SafetyProfile', safetyInput), catalogue = validateType('Catalogue', catalogueInput);
  validateStaticMaterials(build.materials, catalogue);
  validateExactEffects(build.operations, build.materials, effects.effects);
  const hashes = { finalEffectsDigest: digestValue('final-effects', effects).sha256, targetFactsDigest: digestValue('target-facts', facts).sha256, safetyProfileDigest: digestValue('safety-profile', safety).sha256 };
  ambiguity(build.catalogueDigest === digestValue('catalogue', catalogue).sha256 && build.targetFactsDigest === hashes.targetFactsDigest && build.safetyProfileDigest === hashes.safetyProfileDigest);
  requireFact(safety.requireProtectedClearance && safety.requireBodyClearance, 'CAPABILITY_UNAVAILABLE', 'POLICY_UNAVAILABLE');
  const required = ['COVERAGE', 'PROTECTION', 'BODY_CLEARANCE', 'HAZARD'];
  if (safety.requireEntranceConnectivity) required.push('ENTRANCE_CONNECTIVITY');
  for (const predicate of required) requireFact(build.witnesses.some(w => w.predicate === predicate), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
  const effectPositions = effects.effects.map(x => JSON.stringify(x.position));
  for (const w of build.witnesses) {
    for (const key of Object.keys(hashes)) ambiguity(w[key] === hashes[key]);
    if (w.facts.positions) {
      const positions = new Set(w.facts.positions.map(x => JSON.stringify(x)));
      if (['COVERAGE','PROTECTION','BODY_CLEARANCE'].includes(w.predicate)) requireFact(effectPositions.every(p => positions.has(p)), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
    }
    if (w.predicate === 'PROTECTION') requireFact(w.facts.protectedPositions.length === 0, 'PERMISSION_DENIED', 'SCOPE_DENIED', 'authorize');
    if (w.predicate === 'BODY_CLEARANCE') {
      const occupied = new Set(w.facts.bodyOccupiedPositions.map(p => JSON.stringify(p)));
      requireFact(!effectPositions.some(p => occupied.has(p)), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
      ambiguity(JSON.stringify(w.facts.avatarDimensions) === JSON.stringify(safety.avatarDimensions));
    }
    if (w.predicate === 'HAZARD') {
      ambiguity(w.facts.forbidLiquid === safety.hazardPolicy.forbidLiquid && w.facts.maximumDamagePerSecond === safety.hazardPolicy.maximumDamagePerSecond);
      for (const p of w.facts.positions) {
        const written = effects.effects.find(e => JSON.stringify(e.position) === JSON.stringify(p));
        const occupied = facts.occupiedCells.find(e => JSON.stringify(e.position) === JSON.stringify(p));
        const empty = facts.knownEmptyCells.some(q => JSON.stringify(q) === JSON.stringify(p));
        const nodeName = written?.nodeName ?? occupied?.nodeName ?? (empty ? 'air' : null);
        requireFact(nodeName !== null && Object.hasOwn(catalogue.nodes, nodeName), 'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
        const c = catalogue.nodes[nodeName];
        requireFact(c.liquidType !== null && c.damagePerSecond !== null, 'UNSUPPORTED_MUTATION_SEMANTICS', 'REQUIRED_FACT_UNKNOWN');
        requireFact((!w.facts.forbidLiquid || c.liquidType === 'none') && c.damagePerSecond <= w.facts.maximumDamagePerSecond, 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
      }
    }
  }
  return deepFreeze({ coherent: true, authenticityVerified: false, providerAuthorization: 'NOT_RUN', worldWrites: 0 });
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
/** world-adapter/v4 history seam A: Canvas projects the original seven fields for Apply. */
export function projectPreparedTransaction(value) {
  const result = validateType('PreparedTransactionResult', value);
  const fields = Object.keys(schemaBundle.definitions.PreparedTransaction.properties);
  return validateType('PreparedTransaction', Object.fromEntries(fields.map(field => [field, result[field]])));
}
export function projectScopedPreparedTransaction(value) {
  const result = validateType('ScopedPreparedTransactionResult', value);
  validateDigestBinding('scoped-transaction-payload', result.payload, result.transactionPayloadDigest);
  const fields = Object.keys(schemaBundle.definitions.ScopedPreparedTransaction.properties);
  return validateType('ScopedPreparedTransaction', Object.fromEntries(fields.map(field => [field, result[field]])));
}
/** ContractHandshake (rc.7): every required wire and fact profile must be advertised
 * exactly; otherwise UNSUPPORTED_VERSION before any request, with no fallback. */
export function checkContractHandshake(advertisedInput, requiredInput) {
  const required = snapshotJSON(requiredInput);
  requireFact(required !== null && typeof required === 'object' && Array.isArray(required.wires) && Array.isArray(required.factProfiles), 'SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
  const advertised = validateType('ContractHandshake', advertisedInput);
  const supported = required.wires.every(w => advertised.wireVersions.includes(w)) && required.factProfiles.every(f => advertised.factProfiles.includes(f));
  requireFact(supported, 'UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
  return deepFreeze({ result: 'HANDSHAKE_VERSION_MATCH', advertised });
}
/** A session/v2 major match alone does not advertise the added readback
 * operation. Reject an older package peer before issuing this operation. */
export function checkSessionReadbackHandshake(advertisedInput) {
  const { advertised } = checkContractHandshake(advertisedInput, { wires: ['session/v2'], factProfiles: [] });
  requireFact(['hanaworlds-contracts@0.3.1', 'hanaworlds-contracts@0.3.2', 'hanaworlds-contracts@0.3.3', 'hanaworlds-contracts@0.3.4'].includes(advertised.contracts) &&
    operationContracts['session/v2'].some(op => op.operation === 'ReadSessionTurnDetails'),
    'UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
  return deepFreeze({ result: 'HANDSHAKE_OPERATION_MATCH', advertised });
}
/** Undo requires the 0.3.2 package advertisement; a 0.3.1 peer's matching
 * canvas/v4 and session/v2 majors do not advertise these added operations. */
export function checkSessionUndoHandshake(advertisedInput) {
  const { advertised } = checkContractHandshake(advertisedInput, { wires: ['canvas/v4', 'session/v2'], factProfiles: [] });
  requireFact(['hanaworlds-contracts@0.3.2', 'hanaworlds-contracts@0.3.3', 'hanaworlds-contracts@0.3.4'].includes(advertised.contracts) &&
    ['ReadCurrentUndoStatus', 'UndoCurrentBuild'].every(name =>
      operationContracts['session/v2'].some(op => op.operation === name)),
    'UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
  return deepFreeze({ result: 'HANDSHAKE_OPERATION_MATCH', advertised });
}
export function checkScopedWorldHandshake(advertisedInput) {
  const { advertised } = checkContractHandshake(advertisedInput, { wires: ['world-adapter/v5'], factProfiles: [] });
  requireFact(['hanaworlds-contracts@0.3.3', 'hanaworlds-contracts@0.3.4'].includes(advertised.contracts) &&
    ['PrepareRecoverableTransaction', 'ApplyCompiledTransaction', 'QueryPreparedTransaction'].every(name =>
      operationContracts['world-adapter/v5'].some(op => op.operation === name)),
    'UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
  return deepFreeze({ result: 'HANDSHAKE_OPERATION_MATCH', advertised });
}
/** Service recovery is a package capability in the existing session/v2 and
 * canvas/v4 wires. The matching wire majors alone do not advertise it. */
export function checkUndoRecoveryHandshake(advertisedInput) {
  const { advertised } = checkContractHandshake(advertisedInput,
    { wires: ['canvas/v4', 'session/v2'], factProfiles: [] });
  requireFact(advertised.contracts === 'hanaworlds-contracts@0.3.4' &&
    operationContracts['session/v2'].some(op => op.operation === 'RecoverPendingUndo') &&
    ['RecoverPendingUndo', 'ReadPendingUndoResult'].every(name =>
      operationContracts['canvas/v4'].some(op => op.operation === name)),
    'UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
  return deepFreeze({ result: 'HANDSHAKE_OPERATION_MATCH', advertised });
}
/** Coherence only: the record MUST come from the provider's own durable store
 * after independent service authentication. Caller JSON is never that record. */
export function validateUndoRecoveryRecord(requestInput, durableRecordInput, operationName = 'RecoverPendingUndo') {
  requireFact(['RecoverPendingUndo', 'ReadPendingUndoResult'].includes(operationName),
    'UNSUPPORTED_OPERATION', 'INVALID_SHAPE');
  const request = validateRequest('canvas/v4', operationName, requestInput);
  requireFact(durableRecordInput !== null && durableRecordInput !== undefined,
    'TRANSACTION_CONFLICT', 'POLICY_UNAVAILABLE');
  const record = validateType('UndoRecoveryRecord', durableRecordInput);
  for (const field of ['actorRef', 'sessionRef', 'worldRef', 'authorizationRef'])
    requireFact(record[field] === request[field], 'PERMISSION_DENIED', 'IDENTITY_UNVERIFIED', 'authorize');
  requireFact(record.originalUndoRequestId === request.originalUndoRequestId && record.direction === 'UNDO',
    'PERMISSION_DENIED', 'IDENTITY_UNVERIFIED', 'authorize');
  requireFact(record.status !== 'RESERVED' && (operationName !== 'RecoverPendingUndo' ||
    !['VERIFIED', 'ROLLED_BACK'].includes(record.status)),
    'TRANSACTION_CONFLICT', 'POLICY_UNAVAILABLE');
  return record;
}
/** Correlates a typed response to its request. No provider-authenticity claim. */
export function validateUndoRecoveryResponse(wire, operationName, requestInput, responseInput) {
  requireFact((wire === 'session/v2' && operationName === 'RecoverPendingUndo') ||
    (wire === 'canvas/v4' && ['RecoverPendingUndo', 'ReadPendingUndoResult'].includes(operationName)),
  'UNSUPPORTED_OPERATION', 'INVALID_SHAPE');
  const request = validateRequest(wire, operationName, requestInput);
  const response = validateResponse(wire, operationName, responseInput);
  requireFact(response.requestId === request.requestId, 'SCHEMA_INVALID', 'INVALID_SHAPE');
  if (response.result !== null) {
    for (const field of ['sessionRef', 'worldRef'])
      requireFact(response.result[field] === request[field], 'PERMISSION_DENIED', 'IDENTITY_UNVERIFIED', 'authorize');
    if (wire === 'canvas/v4')
      requireFact(response.result.originalUndoRequestId === request.originalUndoRequestId,
        'PERMISSION_DENIED', 'IDENTITY_UNVERIFIED', 'authorize');
  }
  return response;
}
/** interaction-surface/v3 SELECT_CHOICE: the value must be one listed choice of the
 * same frameRef/frameRevision/actionId; renderers never parse frame text for options. */
export function validateChoiceSelection(frameInput, requestInput) {
  const frame = validateType('InteractionFrame', frameInput);
  const request = validateRequest('interaction-surface/v3', 'InvokeAction', requestInput);
  requireFact(request.frameRef === frame.frameRef && request.frameRevision === frame.frameRevision, 'INVALID_FRAME', 'REVISION_CHANGED');
  const action = frame.actions.find(a => a.actionId === request.actionId);
  requireFact(action !== undefined, 'UNKNOWN_ACTION', 'SCOPE_DENIED');
  if (request.input.kind === 'SELECT_CHOICE')
    requireFact(action.choices !== null && action.choices.some(choice => choice.value === request.input.value), 'INVALID_SELECTION', 'SCOPE_DENIED');
  return request;
}
/** Admission of the four Canvas-owned placement.* values for one bound world. An unset
 * or invalid value is never defaulted: CAPABILITY_UNAVAILABLE/validate/POLICY_UNAVAILABLE
 * names every affected setting in error.unavailableSettings. */
export function admitPlacementSettings(storedInput, settingsRevision) {
  const stored = snapshotJSON(storedInput);
  requireFact(stored !== null && typeof stored === 'object' && !Array.isArray(stored), 'SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
  const unavailable = [], values = Object.create(null);
  for (const setting of placementSettingDescriptors) {
    const v = Object.hasOwn(stored, setting.name) ? stored[setting.name] : undefined;
    if (Number.isSafeInteger(v) && v >= 0) values[setting.field] = v; else unavailable.push(setting.name);
  }
  if (unavailable.length) {
    const error = new ContractError('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    error.unavailableSettings = Object.freeze(unavailable.sort(compareUTF16));
    throw error;
  }
  return validateType('PlacementSettings', { ...values, settingsRevision });
}
