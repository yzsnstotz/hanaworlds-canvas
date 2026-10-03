import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { contractMetadata, schemaBundle } from './generated/contracts.mjs';
import { snapshotJSON, deepFreeze, decodeRawJSON } from '../strict-json.mjs';
import { validateShape } from './schema-validator.mjs';
import { validateDomain, validateEventDomain } from './domain.mjs';
import { requireFact, fail } from '../errors.mjs';
import { inside, validateExactEffects, comparePosition } from '../geometry.mjs';
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
  return validateType(operation(wire, operationName).request, value);
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
export function validateDigestBinding(kind, payload, providedDigest) {
  validateType('Digest', providedDigest);
  const actual = digestValue(kind, payload);
  requireFact(actual.sha256 === providedDigest, kind === 'reference-brief' ? 'MEDIA_DIGEST_MISMATCH' : 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
  return actual;
}
/** Referential coherence checks for payloads that actually carry both sides of
 * a binding. This is not a grant verifier and never claims provider authenticity. */
export function validateBoundRequest(wire, operationName, value) {
  const request = validateRequest(wire, operationName, value);
  const pairs = [['build','buildDigest','build'],['operations','operationDigest','operations'],['intent','intentDigest','intent'],
    ['referenceBrief','referenceBriefDigest','reference-brief'],['brief','briefDigest','reference-brief'],['catalogue','catalogueDigest','catalogue'],
    ['targetFacts','targetFactsDigest','target-facts'],['safetyProfile','safetyProfileDigest','safety-profile'],['compilationConfig','compilationConfigDigest','compilation-config'],
    ['surfaceAction','surfaceActionDigest','surface-action'],['analysis','analysisDigest','affected-analysis'],['authorizationBinding','authorizationBindingDigest','authorization-binding'],['manifest','resourceManifestDigest','saved-work-resources']];
  for (const [field, hashField, kind] of pairs) if (Object.hasOwn(request, field) && Object.hasOwn(request, hashField)) validateDigestBinding(kind, request[field], request[hashField]);
  if (request.preparedTransaction) {
    const p = request.preparedTransaction;
    validateDigestBinding('transaction-payload', p.payload, p.transactionPayloadDigest);
    requireFact(p.payload.transactionId === request.transactionId && p.payload.operationDigest === request.operationDigest, 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
  }
  if (request.build) {
    for (const field of ['catalogueDigest','targetFactsDigest','safetyProfileDigest']) if (Object.hasOwn(request, field)) requireFact(request.build[field] === request[field], 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
  }
  if (request.authorizationBinding) {
    const auth = request.authorizationBinding;
    for (const field of ['actorRef','sessionRef','worldRef','transactionId','operationDigest']) if (Object.hasOwn(request, field)) requireFact(auth[field] === request[field], 'CONNECTION_UNAUTHORIZED', 'SCOPE_DENIED', 'authorize');
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
      requireFact(prepared[field] === request[field], 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
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
  requireFact(build.catalogueDigest === digestValue('catalogue', catalogue).sha256 && build.targetFactsDigest === hashes.targetFactsDigest && build.safetyProfileDigest === hashes.safetyProfileDigest, 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
  requireFact(safety.requireProtectedClearance && safety.requireBodyClearance, 'CAPABILITY_UNAVAILABLE', 'POLICY_UNAVAILABLE');
  const required = ['COVERAGE', 'PROTECTION', 'BODY_CLEARANCE', 'HAZARD'];
  if (safety.requireEntranceConnectivity) required.push('ENTRANCE_CONNECTIVITY');
  for (const predicate of required) requireFact(build.witnesses.some(w => w.predicate === predicate), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
  const effectPositions = effects.effects.map(x => JSON.stringify(x.position));
  for (const w of build.witnesses) {
    for (const key of Object.keys(hashes)) requireFact(w[key] === hashes[key], 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
    if (w.facts.positions) {
      const positions = new Set(w.facts.positions.map(x => JSON.stringify(x)));
      if (['COVERAGE','PROTECTION','BODY_CLEARANCE'].includes(w.predicate)) requireFact(effectPositions.every(p => positions.has(p)), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
    }
    if (w.predicate === 'PROTECTION') requireFact(w.facts.protectedPositions.length === 0, 'PERMISSION_DENIED', 'SCOPE_DENIED', 'authorize');
    if (w.predicate === 'BODY_CLEARANCE') {
      const occupied = new Set(w.facts.bodyOccupiedPositions.map(p => JSON.stringify(p)));
      requireFact(!effectPositions.some(p => occupied.has(p)), 'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
      requireFact(JSON.stringify(w.facts.avatarDimensions) === JSON.stringify(safety.avatarDimensions), 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
    }
    if (w.predicate === 'HAZARD') {
      requireFact(w.facts.forbidLiquid === safety.hazardPolicy.forbidLiquid && w.facts.maximumDamagePerSecond === safety.hazardPolicy.maximumDamagePerSecond, 'NON_CANONICAL_AMBIGUITY', 'PAYLOAD_CHANGED');
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
