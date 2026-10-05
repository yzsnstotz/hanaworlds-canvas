import { schemaBundle, contractMetadata } from './generated/contracts.mjs';
import { fail, requireFact } from '../errors.mjs';
import { compareUTF16, comparePosition, assertBox, inside, unionBounds } from '../geometry.mjs';
import { validateNameSyntax } from '../names.mjs';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const geometry = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
const shape = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_SHAPE');
const positionKey = p => JSON.stringify(p);
// rc.6/rc.7 rules whose approved oracle names a decode-phase shape rejection.
const decodeShape = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
const PLACEMENT_OPTION_ORDER = ['NAME_PLAYER', 'PICK_WORLD_POINT'];
function arrayCompare(name, order) {
  if (order === 'numeric ascending') return (a, b) => a - b;
  if (order === 'UTF16 ascending') return compareUTF16;
  if (order === 'numeric x,y,z' || order === 'numeric lexicographic six coordinates') return comparePosition;
  if (order === 'position numeric x,y,z') return (a, b) => comparePosition(a.position, b.position);
  if (order === 'objectRef UTF16 ascending') return (a, b) => compareUTF16(a.objectRef, b.objectRef);
  if (order === 'portalRef UTF16 ascending') return (a, b) => compareUTF16(a.portalRef, b.portalRef);
  if (order === 'witnessId UTF16 ascending') return (a, b) => compareUTF16(a.witnessId, b.witnessId);
  if (order === 'resourceId UTF16 ascending') return (a, b) => compareUTF16(a.resourceId, b.resourceId);
  if (order === 'fixed NAME_PLAYER then PICK_WORLD_POINT') return (a, b) => PLACEMENT_OPTION_ORDER.indexOf(a) - PLACEMENT_OPTION_ORDER.indexOf(b);
  if (order === 'creationSequence numeric then objectRef UTF16') return (a, b) => (a.creationSequence - b.creationSequence) || compareUTF16(a.objectRef, b.objectRef);
  if (order === 'limitKind,source UTF16' || order === 'adapterId,connectionRef,worldRef UTF16') {
    const keys = order.split(' ')[0].split(',');
    return (a, b) => { for (const k of keys) { const n = compareUTF16(a[k], b[k]); if (n) return n; } return 0; };
  }
  return null; // all other declared arrays retain input/engine/path order
}
export function validateArrayOrder(name, v, parent) {
  const schema = schemaBundle.definitions[name];
  const uniqueBy = schema['x-uniqueBy']; const unique = schema.uniqueItems;
  if (uniqueBy || unique) {
    const keys = uniqueBy?.split(','); const seen = new Set();
    for (const item of v) {
      const key = JSON.stringify(keys ? keys.map(k => item[k]) : item);
      if (seen.has(key)) fail(name === 'OrderedRefs' && parent === 'SetObjectSelectionRequest' ? 'DUPLICATE_OBJECT_REF' : 'SCHEMA_INVALID', 'validate', 'INVALID_SHAPE');
      seen.add(key);
    }
  }
  const compare = arrayCompare(name, schema['x-order']);
  if (compare) for (let i = 1; i < v.length; i++) shape(compare(v[i - 1], v[i]) <= 0);
}
function targetFacts(v) {
  const actual = ['worldRef', 'objectRef', 'worldRevision', 'objectRevision'];
  const planned = ['buildDigest', 'planRevision'];
  // rc.7: target-facts/v3 iff REGION_INSPECTED; INSPECTED and PLANNED keep target-facts/v2.
  decodeShape((v.source === 'REGION_INSPECTED') === (v.profileVersion === 'target-facts/v3'));
  if (v.source === 'REGION_INSPECTED') {
    decodeShape(v.worldRef !== null && v.worldRevision !== null);
    decodeShape(['objectRef', 'objectRevision', ...planned].every(k => v[k] === null));
  } else {
    shape(actual.every(k => (v[k] !== null) === (v.source === 'INSPECTED')));
    shape(planned.every(k => (v[k] !== null) === (v.source === 'PLANNED')));
  }
  const positions = [...v.occupiedCells.map(x => x.position), ...v.knownEmptyCells, ...v.unknownCells.map(x => x.position)];
  shape(new Set(positions.map(positionKey)).size === positions.length);
  geometry(positions.every(p => inside(p, v.sampledBounds)));
  if (v.unknownCells.length) requireFact(v.usableVolume === null, 'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
}
function receipt(v) {
  if (v.status === 'VERIFIED') {
    shape(v.readbackDigest !== null && v.observedWorldRevision !== null && v.error === null && v.restoreStatus === 'NOT_REQUIRED');
  }
  if (v.status === 'RESTORE_FAILED') {
    shape(v.error !== null && v.error.phase === 'restore' && v.error.causeCode !== null && ['PARTIAL', 'UNKNOWN'].includes(v.error.mutationState));
  }
  if (v.status === 'RECOVERY_PENDING') shape(v.error !== null && v.error.mutationState === 'UNKNOWN');
  if (v.status === 'ROLLED_BACK') shape(v.restoreStatus === 'VERIFIED_RESTORED' && v.readbackDigest !== null && v.observedWorldRevision !== null);
}
function scopedWorld(v) {
  const known = ok => requireFact(ok, 'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
  known(v.cells.every(cell => cell.availability === 'KNOWN' && cell.stateDigest !== null));
  known(v.objects.every(object => object.provenance === 'CANVAS_REGISTERED' && object.positions.length > 0));
  requireFact(v.objects.every(object => object.worldRef === v.worldRef), 'OBJECT_SCOPE_MISMATCH', 'SCOPE_DENIED');
  const covered = new Map();
  for (const position of v.checkedPositions) covered.set(positionKey(position), position);
  for (const object of v.objects) for (const position of object.positions) covered.set(positionKey(position), position);
  known(covered.size > 0 && covered.size === v.cells.length &&
    v.cells.every(cell => covered.has(positionKey(cell.position))));
}
function scopedRequest(v) {
  const scope = v.scope;
  shape(scope.worldRef === v.worldRef && scope.transactionId === v.transactionId &&
    scope.operationDigest === v.operationDigest && v.operations.worldRef === v.worldRef);
  const covered = new Set(scope.cells.map(cell => positionKey(cell.position)));
  requireFact(v.operations.effects.every(effect => covered.has(positionKey(effect.position))),
    'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
  shape(v.authorizationBinding.worldRef === v.worldRef &&
    v.authorizationBinding.transactionId === v.transactionId &&
    v.authorizationBinding.operationDigest === v.operationDigest &&
    v.authorizationBinding.sessionRef === v.sessionRef);
}
/** Local, declarative domain invariants only. Authenticity, durable storage,
 * actual world occupancy and event emission always require the owning provider. */
export function validateDomain(visits) {
  for (let i = visits.length - 1; i >= 0; i--) {
    const { name, value: v, parent } = visits[i];
    const schema = schemaBundle.definitions[name];
    if (Array.isArray(v) && schema.type === 'array' && !Array.isArray(schema.items)) validateArrayOrder(name, v, parent);
    if (name === 'Box' || name === 'SetBox') assertBox(v);
    else if (name === 'Axes') geometry(new Set(v.map(x => x[1])).size === 3);
    else if (name === 'CollisionBox') geometry(v.slice(0, 3).every((x, a) => x <= v[a + 3]));
    else if (name === 'NodeCapability') {
      const nulls = Object.keys(v).filter(k => k !== 'unknownFields' && v[k] === null).sort(compareUTF16);
      shape(same(nulls, v.unknownFields));
    } else if (name === 'Coverage') geometry(v.sampledPositions.every(p => inside(p, v.sampledBounds)));
    else if (name === 'OccupiedCell') requireFact(v.nodeName !== 'air', 'SCHEMA_INVALID', 'INVALID_SHAPE');
    else if (name === 'Portal') {
      geometry(v.positions.length > 0);
      geometry([0,1,2].some(axis => v.positions.every(p => p[axis] === v.positions[0][axis])));
    } else if (name === 'TargetFacts') targetFacts(v);
    else if (name === 'EntranceWitness') {
      const usable = new Set(v.usablePositions.map(positionKey));
      geometry(v.path.every(p => usable.has(positionKey(p))));
      for (let j = 1; j < v.path.length; j++) geometry(v.path[j].reduce((n, x, a) => n + Math.abs(x - v.path[j - 1][a]), 0) === 1);
    } else if (name === 'ProtectionWitness' || name === 'BodyWitness') {
      shape(v.evidence.worldRef !== null && v.evidence.worldRevision !== null);
    } else if (name === 'BuildProjection') {
      shape(same(unionBounds(v.operations), v.declaredBounds));
      for (const op of v.operations) requireFact(Object.hasOwn(v.materials, op.materialRef), 'CATALOGUE_MISMATCH', 'CATALOGUE_UNRESOLVED');
    } else if (name === 'MediaBinding') shape((v.projectionVariantId === null) === (v.projectionBytesDigest === null));
    else if (name === 'ReceiptProjection') receipt(v);
    else if (name === 'BeforeImage' || name === 'ReadbackProjection') shape(same(v.coveredPositions, v.records.map(x => x.position)));
    else if (name === 'PreparedTransaction' || name === 'PreparedTransactionResult') shape(v.beforeImageDigest === v.payload.beforeImageDigest);
    else if (name === 'ScopedWorldBinding') scopedWorld(v);
    else if (name === 'ScopedPrepareRequest' || name === 'ScopedApplyRequest') scopedRequest(v);
    else if (name === 'ScopedPreparedTransaction' || name === 'ScopedPreparedTransactionResult')
      shape(v.beforeImageDigest === v.payload.beforeImageDigest && v.scopeDigest === v.payload.scopeDigest &&
        v.guarantee === 'RECOVERABLE_VERIFIED');
    else if (name === 'ActionDescriptor') decodeShape((v.choices !== null) === v.inputKinds.includes('SELECT_CHOICE'));
    else if (name === 'PlacementChoiceRequired') {
      shape((v.candidatePlayerNames !== null) === v.reasons.includes('MULTIPLE_ONLINE_PLAYERS'));
      // rc.9 (Q2 user decision): NAME_PLAYER only for MULTIPLE_ONLINE_PLAYERS; every other reason offers PICK_WORLD_POINT only.
      shape(same(v.options, v.reasons.includes('MULTIPLE_ONLINE_PLAYERS') ? PLACEMENT_OPTION_ORDER : ['PICK_WORLD_POINT']));
    } else if (name === 'RegionInspection') {
      decodeShape(v.targetFacts.source === 'REGION_INSPECTED');
      shape(v.evidence.worldRef === v.targetFacts.worldRef && v.evidence.worldRevision === v.targetFacts.worldRevision);
      shape(v.evidence.sourceRevision === v.frame.transformRevision);
      geometry([...v.protectedPositions, ...v.bodyOccupiedPositions].every(p => inside(p, v.targetFacts.sampledBounds)));
    } else if (name === 'PlacementRegionInspection') {
      shape((v.unavailableSettings !== null) === (v.error !== null && v.error.code === 'CAPABILITY_UNAVAILABLE' && v.error.reason === 'POLICY_UNAVAILABLE'));
    } else if (name === 'SessionTurnDetails') {
      shape(v.turns.every(turn => turn.confirmedBrief === null ||
        (turn.confirmedBrief.sessionRef === v.sessionRef && turn.confirmedBrief.turnRevision === turn.turnRevision)));
    } else if (name === 'CurrentUndoStatus') {
      if (v.availability === 'NO_VERIFIED_BUILD') shape(v.turnRef === null && v.turnRevision === null && v.head === null);
      else shape(v.turnRef !== null && v.turnRevision !== null && v.head !== null &&
        (v.availability !== 'AVAILABLE' || v.head.headTransactionId !== null));
    } else if (name === 'CurrentBuildUndoResult') {
      shape(v.beforeHead.headTransactionId !== null &&
        v.beforeHead.historyRevision !== v.afterHead.historyRevision &&
        v.beforeHead.headTransactionId !== v.afterHead.headTransactionId);
    } else if (name === 'UndoRecoveryResult') {
      shape((v.status === 'VERIFIED') === (v.receipt !== null));
      if (v.receipt !== null) shape(v.receipt.status === 'VERIFIED');
    } else if (name === 'CreateBuildPlanRequest') {
      // Payload-decidable painter/v3 rules in the approved order; digest coherence is in validateBoundRequest.
      if (v.targetFacts.source === 'REGION_INSPECTED') {
        requireFact(v.painterId === 'picture-blocks', 'TARGET_REQUIRED', 'SCOPE_DENIED');
        requireFact(v.regionInspection !== null, 'TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
      } else decodeShape(v.regionInspection === null);
    }
    else if (name === 'NameObjectRequest' || name === 'RenameObjectRequest') validateNameSyntax(v.name);
    else if (name === 'ObjectNameReceipt') shape(validateNameSyntax(v.displayName) === v.displayName);
    else if (name === 'SavedResourceReceipt') requireFact(v.durable === true, 'SAVED_RESOURCE_UNAVAILABLE', 'RESOURCE_MISSING');
    else if (name === 'CompiledOperationSet') {
      shape(same(unionBounds(v.projection.effects.map(e => ({ min: e.position, max: e.position }))), v.writeBounds));
    }
    if (schema.type === 'object' && schema.properties && Object.hasOwn(schema.properties, 'result') && Object.hasOwn(schema.properties, 'error')) {
      shape((v.result === null) !== (v.error === null));
    }
  }
}
export function validateEventDomain(typeName, event) {
  const rule = contractMetadata.canvasEventRules[typeName];
  if (!rule) throw new TypeError('Unknown Canvas event type');
  shape(rule.operations.includes(event.operation));
  shape(event.receipt.error === null && event.receipt.result !== null);
  const result = event.receipt.result;
  if (rule.requiredReceiptStatus) shape(result.status === rule.requiredReceiptStatus);
  if (rule.requiredDecisionKind) shape(result.decisionKind === rule.requiredDecisionKind);
  if (rule.observedWorldRevisionMustDiffer) shape(result.source === 'INSPECTED' && event.newWorldRevision !== result.worldRevision);
  return event;
}
