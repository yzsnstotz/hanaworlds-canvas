// Public route-A proposal contract. Pure shape/coherence checks only: no model,
// world read, provider authentication, BUILD assembly or transaction decision.
import { validateType, validateRequest, validateResponse, validateDigestBinding,
  digestValue, canonicalJSON, checkContractHandshake,
  schemaBundle, validateBoundRequest, validateCurrentRequest, validateRegionInspection, validateStaticMaterials,
  validateWitnessCoherence, safetyProfileFromConfirmedIntent, requireSiteRuleChecks, requireOccupiedNotEmpty } from './runtime.mjs';
import { requireFact } from '../errors.mjs';
import { confirmedPlacementOf, requirePlacementSource, requirePlacementTarget, requirePlacementInspection, requireOperationsPlacementTarget } from './placement.mjs';
import { inside, unionCellCount, comparePosition } from '../geometry.mjs';
const WIRE = 'painter/v6', OPERATION = 'ValidateBuildProposal', PLAN = 'CreateBuildPlan';
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const identity = ok => requireFact(ok, 'TRANSACTION_CONFLICT', 'PAYLOAD_CHANGED');
const stale = ok => requireFact(ok, 'TARGET_FACTS_STALE', 'REVISION_CHANGED');
const geometry = ok => requireFact(ok, 'BUILD_INVALID', 'INVALID_GEOMETRY');

/** Check this new Painter producer only; not a request to update default peers. Same contracts
 * major (checkContractHandshake) plus the painter/v6 wire; minor/patch never decide. */
export function checkBuildProposalHandshake(input) {
  const { advertised } = checkContractHandshake(input,
    { wires: [WIRE], factProfiles: ['target-facts/v5'] });
  return Object.freeze({ result: 'HANDSHAKE_OPERATION_MATCH', advertised });
}

function proposalGeometry(request) {
  const { proposal, targetFacts: facts, safetyProfile: safety } = request;
  validateStaticMaterials(proposal.materials, request.catalogue);
  const bounds = facts.sampledBounds;
  // BigInt before conversion: no overflowing additions, clipping or guessed caps.
  const translate = position => position.map((x, axis) => {
    const translated = BigInt(x) + BigInt(bounds.min[axis]);
    geometry(translated >= BigInt(bounds.min[axis]) && translated <= BigInt(bounds.max[axis]) &&
      translated >= BigInt(Number.MIN_SAFE_INTEGER) && translated <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(translated);
  });
  const operations = proposal.boxes.map(box => {
    requireFact(Object.hasOwn(proposal.materials, box.materialRef),
      'UNSUPPORTED_MATERIAL', 'CATALOGUE_UNRESOLVED');
    return { op: 'set_box', min: translate(box.min), max: translate(box.max), materialRef: box.materialRef };
  });
  const touched = p => operations.some(op => inside(p, op));
  geometry(!facts.occupiedCells.some(cell => touched(cell.position)));
  const written = facts.knownEmptyCells.filter(touched).sort(comparePosition);
  // Exact union volume proves there are no unknown/unsampled holes without
  // iterating an attacker-supplied huge box; overlap is counted only once.
  requireFact(unionCellCount(operations) === BigInt(written.length),
    'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
  // Actual player bodies are not supplied here: the engine rejected body-occupied footprints at
  // inspection and rechecks every written cell before mutation.
  const effects = written.map(position => {
    const op = operations.findLast(op => inside(position, op));
    return { position, geometryProfile: 'voxel-grid/v1', ...proposal.materials[op.materialRef] };
  });
  for (const effect of effects) {
    const tags = request.catalogue.materials[effect.materialRef];
    requireFact(tags.liquid !== null && tags.hazardPerSecond !== null,
      'UNSUPPORTED_MATERIAL', 'REQUIRED_FACT_UNKNOWN');
    requireFact((!safety.hazardPolicy.forbidLiquid || tags.liquid === false) &&
      tags.hazardPerSecond <= safety.hazardPolicy.maximumDamagePerSecond,
      'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
  }
  return { operations, effects };
}

/** Payload coherence only. Current connection state is a provider duty. */
export function validateBuildProposalRequest(input) {
  const request = validateBoundRequest(WIRE, OPERATION, input);
  const { intent, referenceBrief: brief, targetFacts: facts, safetyProfile: safety } = request;
  for (const [field, hash, kind] of [
    ['intent', 'intentDigest', 'intent'], ['referenceBrief', 'referenceBriefDigest', 'reference-brief'],
    ['targetFacts', 'targetFactsDigest', 'target-facts'], ['safetyProfile', 'safetyProfileDigest', 'safety-profile'],
  ]) validateDigestBinding(kind, request[field], request[hash]);
  requireFact(intent.confirmedIntent.kind === 'BUILD_STRUCTURE' &&
    intent.confirmedIntent.confirmedTurnRevision === request.turnRevision &&
    intent.intendedWorldRef === request.worldRef && intent.orderedTargetRefs.length === 0 &&
    intent.referenceBriefDigest === request.referenceBriefDigest &&
    brief.sessionRef === request.sessionRef && brief.turnRevision === request.turnRevision &&
    brief.text.trim().length > 0 && intent.confirmedIntent.text.trim().length > 0,
    'INTENT_UNCONFIRMED', 'REQUIRED_FACT_UNKNOWN');
  requireFact(facts.source === 'REGION_INSPECTED', 'TARGET_REQUIRED', 'REQUIRED_FACT_UNKNOWN');
  const region = validateRegionInspection(request.regionInspection);
  stale(facts.worldRef === request.worldRef && same(region.targetFacts, facts) &&
    region.targetFactsDigest === request.targetFactsDigest &&
    facts.catalogueDigest === digestValue('catalogue', request.catalogue).sha256 &&
    region.evidence.worldRef === request.worldRef && region.evidence.worldRevision === facts.worldRevision);
  requireOccupiedNotEmpty(facts, request.catalogue);
  // A confirmed structured placement binds this build to the inspection it was proposed from.
  const placement = confirmedPlacementOf(intent, brief);
  if (placement !== null) requirePlacementSource(placement, region, request.worldRef);
  requireFact(safety.requireBodyClearance,
    'CAPABILITY_UNAVAILABLE', 'POLICY_UNAVAILABLE');
  // Site rules are skill-proposed and player-confirmed; the confirmed intent is their only source:
  // the request SafetyProfile must be exactly the one derived from it (no World/Host/package value).
  const rules = intent.confirmedIntent.siteRules;
  requireFact(same(safety, safetyProfileFromConfirmedIntent(intent)), 'INTENT_UNCONFIRMED', 'PAYLOAD_CHANGED');
  requireSiteRuleChecks(rules, { entrance: true });
  if (rules.requireEntranceConnectivity) requireFact(rules.entranceClearance !== null,
    'INTENT_UNCONFIRMED', 'REQUIRED_FACT_UNKNOWN');
  // Confirmed portals must exist; none confirmed means the doorway on regionInspection.entranceFacing.
  requireFact(intent.confirmedIntent.entrancePortalRefs.every(ref => facts.portals.some(p => p.portalRef === ref)),
    'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
  const { effects } = proposalGeometry(request);
  if (placement !== null) requirePlacementTarget(placement, effects.map(effect => effect.position));
  return request;
}

/** Inputs read by Workshop from current local state and public fact providers.
 * This checks their correlation, never their authenticity or temporal atomicity. */
export function validateBuildProposalContext(input, factsInput) {
  const request = validateBoundRequest(WIRE, OPERATION, input);
  const facts = validateType('BuildProposalProviderFacts', factsInput);
  validateCurrentRequest(WIRE, OPERATION, request, facts.requestFacts);
  validateBuildProposalRequest(request);
  const keys = Object.keys(schemaBundle.definitions.BuildProposalContext.properties);
  const context = Object.fromEntries(keys.map(key => [key, request[key]]));
  stale(same(context, facts.sourceContext) && same(context, facts.currentContext));
  return request;
}

/** Request/result coherence only; caller rechecks validateBuildProposalContext
 * with fresh local facts before releasing this response, including replay. */
export function validateBuildProposalResponse(input, responseInput) {
  const request = validateBoundRequest(WIRE, OPERATION, input);
  const response = validateResponse(WIRE, OPERATION, responseInput);
  identity(response.requestId === request.requestId);
  if (response.error !== null) return response;
  validateBuildProposalRequest(request);
  const { build, buildDigest, invocationId } = response.result;
  identity(invocationId === request.invocationId);
  validateDigestBinding('build', build, buildDigest);
  const { operations, effects } = proposalGeometry(request);
  stale(same(build.coordinateFrame, request.regionInspection.frame) &&
    build.catalogueDigest === digestValue('catalogue', request.catalogue).sha256 &&
    build.targetFactsDigest === request.targetFactsDigest && build.safetyProfileDigest === request.safetyProfileDigest);
  geometry(build.geometryProfile === request.targetFacts.geometryProfile &&
    same(build.materials, request.proposal.materials) && same(build.operations, operations));
  const positions = effects.map(effect => effect.position);
  for (const witness of build.witnesses) {
    if (witness.facts.evidence) identity(same(witness.facts.evidence, request.regionInspection.evidence));
    if (['COVERAGE', 'BODY_CLEARANCE'].includes(witness.predicate))
      geometry(same(witness.facts.positions, positions));
    if (witness.predicate === 'HAZARD')
      requireFact(positions.every(p => witness.facts.positions.some(q => same(p, q))),
        'SAFETY_INVARIANT_FAILED', 'REQUIRED_FACT_UNKNOWN');
    if (witness.predicate === 'ENTRANCE_CONNECTIVITY') {
      const { siteRules, entrancePortalRefs } = request.intent.confirmedIntent;
      identity(same(witness.facts.clearance, siteRules.entranceClearance) &&
        (witness.facts.portalRef === null ? entrancePortalRefs.length === 0 : entrancePortalRefs.includes(witness.facts.portalRef)));
    }
  }
  validateWitnessCoherence({ build, finalEffects: { profileVersion: 'final-effects/v3',
    frameDigest: request.targetFacts.frameDigest, catalogueDigest: build.catalogueDigest, effects },
    targetFacts: request.targetFacts, safetyProfile: request.safetyProfile, catalogue: request.catalogue });
  return response;
}

/** painter/v6 CreateBuildPlan (model path) request coherence for a confirmed placement: the plan is
 * made on the placement's source inspection (no re-sampled view). Same named refusals as
 * ValidateBuildProposal; without a placement the request is checked exactly as in 1.0. */
export function validateCreateBuildPlanRequest(input) {
  const request = validateBoundRequest(WIRE, PLAN, input);
  const placement = confirmedPlacementOf(request.intent, request.referenceBrief);
  requirePlacementInspection(placement, request.regionInspection);
  if (placement !== null) requirePlacementSource(placement, request.regionInspection, request.worldRef);
  return request;
}
/** CreateBuildPlan request/result coherence: same request and invocation, BUILD on the request's
 * facts and frame, and with a confirmed placement the planned operations write exactly the
 * confirmed cells / stay inside the confirmed extent. A ClarificationNeed must answer this request. */
export function validateCreateBuildPlanResponse(input, responseInput) {
  const request = validateCreateBuildPlanRequest(input);
  const response = validateResponse(WIRE, PLAN, responseInput);
  if (Object.hasOwn(response, 'clarificationId')) {
    identity(response.sessionRef === request.sessionRef && response.turnRevision === request.turnRevision &&
      response.invocationId === request.invocationId);
    return response;
  }
  identity(response.requestId === request.requestId);
  if (response.error !== null) return response;
  const { build, buildDigest, invocationId } = response.result;
  identity(invocationId === request.invocationId);
  validateDigestBinding('build', build, buildDigest);
  stale(build.targetFactsDigest === request.targetFactsDigest &&
    (request.regionInspection === null || same(build.coordinateFrame, request.regionInspection.frame)));
  validateDigestBinding('frame', build.coordinateFrame, request.targetFacts.frameDigest);
  const placement = confirmedPlacementOf(request.intent, request.referenceBrief);
  if (placement !== null) requireOperationsPlacementTarget(placement, build.operations);
  return response;
}
