import { schemaBundle, contractMetadata } from './generated/contracts.mjs';
import { fail, requireFact } from '../errors.mjs';
import { compareUTF16, comparePosition, assertBox, inside, unionBounds } from '../geometry.mjs';
import { validateNameSyntax } from '../names.mjs';
import { validateRegionDomain, comparePalette } from './region-domain.mjs';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const geometry = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
const shape = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_SHAPE');
const positionKey = p => JSON.stringify(p);
// rc.6/rc.7 rules whose approved oracle names a decode-phase shape rejection.
const decodeShape = ok => requireFact(ok, 'SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
const PLACEMENT_OPTION_ORDER = ['PICK_WORLD_POINT'];
const enumOrder = (type, key) => { const values = schemaBundle.definitions[type].enum;
  return (a, b) => values.indexOf(key(a)) - values.indexOf(key(b)); };
// Engine guards: exact public Error for a GuardRefusal, and the refusal/violation pairing.
const GUARD_VIOLATION = { BODY_CLEARANCE: 'BODY_OCCUPIED', CELL_PROTECTION: 'PROTECTED_CELL', PLAYER_ENCLOSURE: 'PLAYER_ENCLOSED' };
export function guardRefusalError(refusal, { transactionRef = null, preflight = false, cause = null } = {}) {
  const stage = contractMetadata.engineGuards.stages.find(s => s.stage === refusal.stage);
  const violated = refusal.finding !== 'GUARD_UNAVAILABLE';
  // Pre-flight: a needed guard is not covered, so nothing was written (only for GUARD_UNAVAILABLE).
  if (preflight) {
    if (violated) throw new Error('a guard violation is never pre-flight');
    return { code: 'CAPABILITY_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE',
      transactionRef, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' };
  }
  // Restore stages have two forms. With a cause (the transaction owner knows which failure made the
  // restore necessary): RESTORE_FAILED pending manual recovery, causeCode = that failure. Without a
  // cause (a stateless engine write such as WriteRegion RESTORE, or an Undo that has no failure):
  // the engine form below, phase restore, nothing written; the transaction owner decides whether
  // it becomes a pending RESTORE_FAILED (rollback, with applyFailure) or stays a refusal (Undo).
  if (stage.phase === 'restore' && cause !== null) return { code: 'RESTORE_FAILED', phase: 'restore',
    retryability: 'AFTER_MANUAL_RECOVERY', mutationState: 'PARTIAL', transactionRef, causeCode: cause, reason: 'RESTORE_ERROR' };
  return { code: violated ? 'SAFETY_INVARIANT_FAILED' : 'CAPABILITY_UNAVAILABLE', phase: stage.phase,
    retryability: stage.phase === 'decode' ? 'NEVER' : 'AFTER_NEW_FACTS', mutationState: 'NONE', transactionRef, causeCode: null,
    reason: violated ? (refusal.finding === 'PROTECTED_CELL' ? 'SCOPE_DENIED' : 'INVALID_GEOMETRY') : 'REQUIRED_FACT_UNKNOWN' };
}
const sameError = (e, refusal) => [false, ...(refusal.finding === 'GUARD_UNAVAILABLE' ? [true] : [])].some(preflight => {
  const x = guardRefusalError(refusal, { transactionRef: e.transactionRef, preflight, cause: e.causeCode });
  return ['code', 'phase', 'retryability', 'mutationState', 'causeCode', 'reason'].every(k => e[k] === x[k]); });
// A guard refusal always explains the error beside it, exactly.
function guarded(v) {
  if (v.guardRefusal !== null) shape(v.error !== null && sameError(v.error, v.guardRefusal));
}
// A failed restore keeps the failure that caused it: error.causeCode is applyFailure.error.code.
function applyFailure(v) {
  if (v.applyFailure === null) return;
  shape(v.error !== null && v.error.phase === 'restore' && v.error.retryability === 'AFTER_MANUAL_RECOVERY' &&
    ['PARTIAL', 'UNKNOWN'].includes(v.error.mutationState) && v.applyFailure.error.phase !== 'restore' &&
    v.error.causeCode === v.applyFailure.error.code);
  if (v.applyFailure.guardRefusal !== null) shape(sameError(v.applyFailure.error, v.applyFailure.guardRefusal));
}
const GUARDED_RESPONSES = new Set(['ScopedPrepareResponse', 'ScopedApplyResponse', 'PrepareHistoryTransactionResponse',
  'ApplyHistoryTransactionResponse', 'RestoreTransactionResponse', 'WriteRegionResponse', 'InspectRegionResponse',
  'ApplyRegionCommitResponse', 'UndoRegionCommitResponse', 'UndoScopedRegionCommitResponse',
  // Relays up to the skill: Canvas per-cell and placement responses, Workshop build/undo responses.
  'RecoverableCommitAppliedReceipt', 'UndoReceipt', 'RedoReceipt', 'CanvasUndoRecoveryResponse', 'PlacementRegionInspection',
  'AdvanceCurrentBuildResponse', 'UndoCurrentBuildResponse', 'SessionRecoverPendingUndoResponse', 'RedoCurrentBuildResponse', 'ToolBuildResponse']);
function arrayCompare(name, order) {
  if (order === 'numeric ascending') return (a, b) => a - b;
  if (order === 'UTF16 ascending') return compareUTF16;
  if (order === 'numeric x,y,z' || order === 'numeric lexicographic six coordinates') return comparePosition;
  if (order === 'position numeric x,y,z') return (a, b) => comparePosition(a.position, b.position);
  if (order === 'materialRef UTF16 then orientation numeric') return comparePalette;
  if (order === 'materialRef UTF16 ascending') return (a, b) => compareUTF16(a.materialRef, b.materialRef);
  if (order === 'chunkPos numeric x,y,z') return (a, b) => comparePosition(a.chunkPos, b.chunkPos);
  if (order === 'EngineGuardStage enum order') return enumOrder('EngineGuardStage', x => x);
  if (order === 'WriteMethod enum order') return enumOrder('WriteMethod', x => x);
  if (order === 'orientation numeric ascending') return (a, b) => a.orientation - b.orientation;
  if (order === 'guard EngineGuard enum order') return enumOrder('EngineGuard', x => x.guard);
  if (order === 'protocol UTF16 ascending') return (a, b) => compareUTF16(a.protocol, b.protocol);
  if (order === 'objectRef UTF16 ascending') return (a, b) => compareUTF16(a.objectRef, b.objectRef);
  if (order === 'sessionRef UTF16 ascending') return (a, b) => compareUTF16(a.sessionRef, b.sessionRef);
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
  decodeShape(v.profileVersion === 'target-facts/v5');
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
  guarded(v);
  // RESTORE_FAILED (including a restore a guard refused) stays pending manual recovery and keeps
  // the apply failure that caused the restore.
  shape((v.status === 'RESTORE_FAILED') === (v.applyFailure !== null));
  applyFailure(v);
  if (v.status === 'VERIFIED') {
    shape(v.readbackDigest !== null && v.observedWorldRevision !== null && v.error === null && v.restoreStatus === 'NOT_REQUIRED');
  }
  if (v.status === 'RESTORE_FAILED') shape(['FAILED', 'UNKNOWN'].includes(v.restoreStatus));
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

}
/** Local, declarative domain invariants only. Authenticity, durable storage,
 * actual world occupancy and event emission always require the owning provider. */
export function validateDomain(visits) {
  for (let i = visits.length - 1; i >= 0; i--) {
    const { name, value: v, parent } = visits[i];
    const schema = schemaBundle.definitions[name];
    if (Array.isArray(v) && schema.type === 'array' && !Array.isArray(schema.items)) validateArrayOrder(name, v, parent);
    validateRegionDomain(name, v); // no-op for non-region types
    if (GUARDED_RESPONSES.has(name)) { guarded(v); if (Object.hasOwn(v, 'applyFailure')) applyFailure(v); }
    if (name === 'GuardRefusal') shape(v.finding === 'GUARD_UNAVAILABLE' || GUARD_VIOLATION[v.guard] === v.finding);
    if (name === 'FailureDetail' && v.guardRefusal !== null) shape(sameError(v.error, v.guardRefusal));
    if (name === 'EngineGuardDeclaration') shape(v.coverage.map(c => c.guard).join() === schemaBundle.definitions.EngineGuard.enum.join());
    if (name === 'EngineGuardCoverage') shape((v.protectionPrincipal !== null) === (v.guard === 'CELL_PROTECTION' && v.stages.length > 0));
    if (name === 'Box' || name === 'SetBox') assertBox(v);
    else if (name === 'CanvasWorldSelection' && v.status === 'BOUND')
      shape(v.context.activeWorldRef !== null);
    else if (name === 'WorldSelectionContext') {
      shape(v.inventory.connections.every(row => row.worldRef === v.worldRef));
      shape((v.selection.status === 'BOUND' ? v.selection.context.currentSession : v.selection.sessionRef) === v.sessionRef);
    }
    else if (name === 'CurrentContext') shape(v.activeWorldRef === (v.localContext?.worldRef ?? null));
    else if (name === 'UnselectWorldConnectionRequest') shape(v.expectedContext.worldRef === v.worldRef);
    else if (name === 'SelectionConnectionState') shape((v.status === 'UNBOUND') === (v.worldRef === null) && (v.worldRef === null) === (v.connectionRef === null));
    else if (name === 'Axes') geometry(new Set(v.map(x => x[1])).size === 3);
    else if (name === 'MaterialTags') {
      const nulls = Object.keys(v).filter(k => k !== 'unknownFields' && v[k] === null).sort(compareUTF16);
      shape(same(nulls, v.unknownFields));
    } else if (name === 'Catalogue') {
      // The empty material is a declared material of the same vocabulary, never a contracts literal.
      shape(Object.hasOwn(v.materials, v.emptyMaterialRef));
    } else if (name === 'StateProfile') {
      const all = [...v.derivedFields, ...v.preservedFields, ...v.clearedFields];
      shape(new Set(all).size === all.length);
    } else if (name === 'WriteProfile' || name === 'WorldSourceCapabilities') {
      // world-source-facts/v1: the configuration exists exactly when the backend is known, and carries it unchanged.
      shape((v.compilationConfig !== null) === (v.writeBackend.availability === 'KNOWN'));
      if (v.compilationConfig !== null) {
        const a = v.compilationConfig.writeBackend, b = v.writeBackend.writeBackend;
        shape(a.profileId === b.profileId && a.revision === b.revision);
      }
      if (name === 'WorldSourceCapabilities') shape(v.writePath.catalogueDigest === v.catalogueDigest);
    } else if (name === 'CatalogueFacts') {
      shape(same(Object.keys(v.presentation).sort(compareUTF16), Object.keys(v.catalogue.materials).sort(compareUTF16)));
      const described = new Set(v.orientationIndex.map(o => o.orientation));
      shape(Object.values(v.catalogue.materials).every(m => (m.orientations ?? []).every(o => described.has(o))));
    } else if (name === 'MaterialSourceFacts') {
      shape(same(Object.keys(v.presentation).sort(compareUTF16), [...new Set(v.snapshot.materials.map(m => m.materialRef))].sort(compareUTF16)));
    } else if (name === 'InspectionContext') {
      shape(v.localContext.worldRef === v.worldRef);
    } else if (name === 'Coverage') geometry(v.sampledPositions.every(p => inside(p, v.sampledBounds)));
    else if (name === 'Portal') {
      geometry(v.positions.length > 0);
      geometry([0,1,2].some(axis => v.positions.every(p => p[axis] === v.positions[0][axis])));
    } else if (name === 'TargetFacts') targetFacts(v);
    else if (name === 'EntranceWitness') {
      const usable = new Set(v.usablePositions.map(positionKey));
      geometry(v.path.every(p => usable.has(positionKey(p))));
      for (let j = 1; j < v.path.length; j++) geometry(v.path[j].reduce((n, x, a) => n + Math.abs(x - v.path[j - 1][a]), 0) === 1);
    } else if (name === 'BodyWitness') {
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
 else if (name === 'RegionInspection') {
      decodeShape(v.targetFacts.source === 'REGION_INSPECTED');
      shape(v.evidence.worldRef === v.targetFacts.worldRef && v.evidence.worldRevision === v.targetFacts.worldRevision);
      shape(v.evidence.sourceRevision === v.frame.transformRevision);
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
    } else if (name === 'BuildEntryChoiceRequired' ||
      (name === 'BuildEntryOutcome' && v.outcome === 'CHOICE_REQUIRED')) {
      shape(v.frame.sessionRef === v.sessionRef && v.frame.turnRevision === v.turnRevision);
    } else if (name === 'BuildEntryVerified' ||
      (name === 'BuildEntryOutcome' && v.outcome === 'VERIFIED')) {
      shape(v.receipt.status === 'VERIFIED');
    } else if (name === 'BuildProposalBox') {
      assertBox(v); geometry(v.min.every(x => x >= 0));
    } else if (name === 'ValidateBuildProposalResponse' && v.error !== null) {
      shape(v.error.mutationState === 'NONE' && v.error.transactionRef === null);
    } else if (name === 'CreateBuildPlanRequest') {
      // Payload-decidable painter/v3 rules in the approved order; digest coherence is in validateBoundRequest.
      if (v.targetFacts.source === 'REGION_INSPECTED') {
        requireFact(v.painterId === 'building-exterior', 'TARGET_REQUIRED', 'SCOPE_DENIED');
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
