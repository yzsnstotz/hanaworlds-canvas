import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { CodePointSetData, ComposingNormalizer } from 'icu';
import { CanvasStore } from './store.mjs';
import { readJSON } from './strict-json.mjs';
import { admitRequest, validateRequest, validateBoundRequest,
  validateResponse, validateCanvasEvent, digestValue, validateRegionInspection,
  projectPreparedTransaction, placementSettingDescriptors,
  placementInvariants, admitPlacementSettings, checkContractHandshake,
  contractHandshake } from 'hanaworlds-contracts/v4';
export { CanvasStore };

const VERSION = 'canvas/v4';
const ADAPTER_VERSION = 'world-adapter/v4';
const PLACEMENT_FIELDS = ['placement.forwardSearchCells', 'placement.frontGapCells',
  'placement.lateralSearchCells', 'placement.verticalSearchCells'];
const authorScopedReplay = new Set(['ApplyRecoverableCommit', 'Readback',
  'HistoryQuery', 'CreateObject', 'Undo', 'Redo']);
const ref = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validPosition(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isSafeInteger);
}
function validPositions(value, nonempty = false) {
  return Array.isArray(value) && (!nonempty || value.length > 0) &&
    value.every((position, index) => validPosition(position) &&
      (index === 0 || comparePosition(value[index - 1], position) < 0));
}
function issue(code, phase, reason, transactionRef = null) {
  const error = new Error(code);
  error.publicError = { code, phase, retryability: phase === 'authorize' ? 'AFTER_NEW_AUTH' :
    phase === 'validate' ? 'AFTER_NEW_FACTS' : 'NEVER', mutationState: 'NONE',
    transactionRef, causeCode: null, reason };
  return error;
}
function uncertain(transactionRef) {
  const error = new Error('RECOVERY_PENDING');
  error.publicError = { code: 'RECOVERY_PENDING', phase: 'apply',
    retryability: 'SAME_TRANSACTION_QUERY', mutationState: 'UNKNOWN',
    transactionRef, causeCode: null, reason: 'TRANSPORT_OUTCOME_UNKNOWN' };
  return error;
}
function envelope(body, result, error = null) {
  return { contractVersion: VERSION, requestId: ref(body?.requestId) ? body.requestId : null,
    result, error };
}
function placementEnvelope(body, result, error = null, unavailableSettings = null) {
  return { ...envelope(body, result, error), unavailableSettings };
}
function revision() { return `rev-${randomUUID()}`; }
function identity(body) { return createHash('sha256').update(canonicalize(body)).digest('hex'); }
function projectionDigest(kind, value) {
  return createHash('sha256').update(`HanaWorlds|contracts@0.1.0|${kind}\n${canonicalize(value)}`).digest('hex');
}
function compareUtf16(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
const adapterActions = new Set(['READ', 'SELECT', 'NAME', 'RENAME', 'INSPECT',
  'ANALYZE', 'DECIDE', 'APPLY_RECOVERABLE', 'READBACK', 'UNDO', 'REDO', 'HISTORY']);
const limitKinds = new Set(['BYTES', 'PIXELS', 'WIDTH', 'HEIGHT', 'BATCH_COUNT',
  'COORDINATE', 'ENGINE_WRITE_CELLS', 'HOST_MEMORY_BYTES', 'REQUEST_BYTES']);
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function sortedUnique(values, predicate) {
  return Array.isArray(values) && values.every((value, index) => predicate(value) &&
    (index === 0 || compareUtf16(values[index - 1], value) < 0));
}
function validAdapterAnswer(answer, request) {
  return exact(answer, ['contractVersion', 'requestId', 'result', 'error']) &&
    answer.contractVersion === 'world-adapter/v4' && answer.requestId === request.requestId &&
    answer.error === null;
}
function inspectionError(answer, request) {
  const error = answer?.error;
  if (exact(answer, ['contractVersion', 'requestId', 'result', 'error']) &&
      answer.contractVersion === 'world-adapter/v4' && answer.requestId === request.requestId &&
      answer.result === null && exact(error, ['code', 'phase', 'retryability',
        'mutationState', 'transactionRef', 'causeCode', 'reason']) &&
      error.mutationState === 'NONE' && error.transactionRef === null &&
      error.causeCode === null) {
    if (error.code === 'AUTHORIZATION_REVOKED' && error.phase === 'authorize' &&
        error.retryability === 'AFTER_NEW_AUTH' && error.reason === 'GRANT_REVOKED')
      return issue('AUTHORIZATION_REVOKED', 'authorize', 'GRANT_REVOKED');
    if (error.code === 'PERMISSION_DENIED' && error.phase === 'authorize' &&
        error.retryability === 'AFTER_NEW_AUTH' && error.reason === 'SCOPE_DENIED')
      return issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
    if (error.code === 'REPLAY_MISMATCH' && error.phase === 'replay' &&
        error.retryability === 'NEVER' && error.reason === 'PAYLOAD_CHANGED')
      return issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
    if (error.code === 'INSPECTION_FAILED' && error.phase === 'validate' &&
        error.retryability === 'AFTER_NEW_FACTS' && ref(error.reason))
      return issue('INSPECTION_FAILED', 'validate', 'REQUIRED_FACT_UNKNOWN');
  }
  return issue('INSPECTION_FAILED', 'validate', 'REQUIRED_FACT_UNKNOWN');
}
function missingConnection(answer, request) {
  const error = answer?.error;
  return exact(answer, ['contractVersion', 'requestId', 'result', 'error']) &&
    answer.contractVersion === 'world-adapter/v4' && answer.requestId === request.requestId &&
    answer.result === null && exact(error, ['code', 'phase', 'retryability', 'mutationState',
      'transactionRef', 'causeCode', 'reason']) && error.code === 'CONNECTION_NOT_FOUND' &&
    error.phase === 'validate' && error.retryability === 'AFTER_NEW_FACTS' &&
    error.mutationState === 'NONE' && error.transactionRef === null &&
    error.causeCode === null && error.reason === 'POLICY_UNAVAILABLE';
}
function validConnectionInventory(result) {
  if (!exact(result, ['capabilityRevision', 'connections']) || !ref(result.capabilityRevision) ||
      !Array.isArray(result.connections)) return false;
  const pairs = new Set();
  return result.connections.every((row, index) => {
    if (!exact(row, ['adapterId', 'connectionRef', 'worldRef', 'displayName',
      'capabilityRevision', 'payloadVersion', 'readiness']) ||
        !['adapterId', 'connectionRef', 'worldRef', 'capabilityRevision', 'payloadVersion']
          .every(key => ref(row[key])) || typeof row.displayName !== 'string' ||
        !['READY', 'ADAPTER_UNAVAILABLE', 'CONNECTION_UNAUTHORIZED',
          'PAYLOAD_VERSION_MISMATCH', 'CAPABILITY_UNAVAILABLE'].includes(row.readiness)) return false;
    const pair = JSON.stringify([row.connectionRef, row.worldRef]);
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    if (index > 0) {
      const previous = result.connections[index - 1];
      const order = compareUtf16(previous.adapterId, row.adapterId) ||
        compareUtf16(previous.connectionRef, row.connectionRef) ||
        compareUtf16(previous.worldRef, row.worldRef);
      if (order >= 0) return false;
    }
    return true;
  });
}
function validBox(box) {
  return exact(box, ['min', 'max']) && validPosition(box.min) && validPosition(box.max) &&
    box.min.every((value, index) => value <= box.max[index]);
}
function validInspectionFacts(value) {
  if (!exact(value, ['profileVersion', 'source', 'worldRef', 'objectRef',
    'worldRevision', 'objectRevision', 'buildDigest', 'planRevision',
    'catalogueDigest', 'frameDigest', 'sampledBounds', 'coverageDigest',
    'occupiedCells', 'knownEmptyCells', 'unknownCells', 'portals', 'usableVolume']) ||
      value.profileVersion !== 'target-facts/v2' || value.source !== 'INSPECTED' ||
      !['worldRef', 'objectRef', 'worldRevision', 'objectRevision'].every(key => ref(value[key])) ||
      value.buildDigest !== null || value.planRevision !== null ||
      !['catalogueDigest', 'frameDigest', 'coverageDigest'].every(key => digest(value[key])) ||
      !validBox(value.sampledBounds) || !Array.isArray(value.occupiedCells) ||
      !validPositions(value.knownEmptyCells) || !Array.isArray(value.unknownCells) ||
      !Array.isArray(value.portals)) return false;
  const inBounds = position => position.every((coordinate, index) =>
    coordinate >= value.sampledBounds.min[index] && coordinate <= value.sampledBounds.max[index]);
  const sortedCells = (cells, keys, valid) => cells.every((cell, index) =>
    exact(cell, keys) && validPosition(cell.position) && inBounds(cell.position) &&
    valid(cell) && (index === 0 || comparePosition(cells[index - 1].position, cell.position) < 0));
  if (!sortedCells(value.occupiedCells, ['position', 'nodeName', 'param2'], cell =>
    ref(cell.nodeName) && cell.nodeName !== 'air' && Number.isInteger(cell.param2) &&
    cell.param2 >= 0 && cell.param2 <= 255) ||
      !value.knownEmptyCells.every(inBounds) ||
      !sortedCells(value.unknownCells, ['position', 'reason'], cell =>
        ['UNLOADED', 'IGNORE', 'READ_FAILED'].includes(cell.reason))) return false;
  const positions = [...value.occupiedCells.map(cell => cell.position), ...value.knownEmptyCells,
    ...value.unknownCells.map(cell => cell.position)];
  if (new Set(positions.map(position => JSON.stringify(position))).size !== positions.length) return false;
  if (!value.portals.every((portal, index) => exact(portal, ['portalRef', 'positions']) &&
    ref(portal.portalRef) && validPositions(portal.positions, true) &&
    portal.positions.every(inBounds) &&
    (index === 0 || compareUtf16(value.portals[index - 1].portalRef, portal.portalRef) < 0))) return false;
  const volume = value.usableVolume;
  return volume === null || exact(volume,
    ['emptyCellCount', 'physicalVolume', 'standingArea', 'unit']) &&
    Number.isSafeInteger(volume.emptyCellCount) && volume.emptyCellCount >= 0 &&
    ['physicalVolume', 'standingArea'].every(key => volume[key] === null ||
      typeof volume[key] === 'number' && Number.isFinite(volume[key]) && volume[key] >= 0) &&
    ref(volume.unit);
}
function validCapabilities(value) {
  if (!exact(value, ['providerRef', 'capabilityRevision', 'worldRef', 'engineBounds',
    'limits', 'recoveryGuarantee', 'stateProfile', 'regionProtectionWriters',
    'sessionDeleteSupported', 'imageMediaTypes', 'model']) ||
      !ref(value.providerRef) || !ref(value.capabilityRevision) ||
      value.worldRef !== null && !ref(value.worldRef) ||
      value.engineBounds !== null && !validBox(value.engineBounds) ||
      !Array.isArray(value.limits) ||
      value.recoveryGuarantee !== null && value.recoveryGuarantee !== 'RECOVERABLE_VERIFIED' ||
      value.stateProfile !== null && !validStateProfile(value.stateProfile) ||
      !sortedUnique(value.regionProtectionWriters, ref) ||
      typeof value.sessionDeleteSupported !== 'boolean' ||
      !sortedUnique(value.imageMediaTypes, item => mediaTypes.has(item)) ||
      value.model !== null && !ref(value.model)) return false;
  return value.limits.every((limit, index) => exact(limit,
    ['limitKind', 'actual', 'limit', 'source', 'sourceRevision']) &&
    limitKinds.has(limit.limitKind) && Number.isSafeInteger(limit.actual) && limit.actual >= 0 &&
    Number.isSafeInteger(limit.limit) && limit.limit >= 0 && ref(limit.source) &&
    ref(limit.sourceRevision) && (index === 0 ||
      compareUtf16(value.limits[index - 1].limitKind, limit.limitKind) < 0 ||
      value.limits[index - 1].limitKind === limit.limitKind &&
        compareUtf16(value.limits[index - 1].source, limit.source) < 0));
}
function validStateProfile(value) {
  return exact(value, ['profileVersion', 'nodeFields', 'metadataMode', 'inventoryMode',
    'timerMode', 'derivedLightMode']) && value.profileVersion === 'state-profile/v2' &&
    JSON.stringify(value.nodeFields) === '["nodeName","param1","param2"]' &&
    value.metadataMode === 'exact' && value.inventoryMode === 'exact' &&
    value.timerMode === 'exact' && value.derivedLightMode === 'recompute-with-readback';
}
function validBindingReceipt(value) {
  const binding = value?.binding;
  return exact(value, ['connectionRef', 'worldRef', 'payloadVersion', 'payloadDigest',
    'binding', 'capabilities']) && ref(value.connectionRef) && ref(value.worldRef) &&
    ref(value.payloadVersion) && digest(value.payloadDigest) &&
    exact(binding, ['authorizerRef', 'actorRef', 'bindingRef', 'worldRef', 'grantEpoch',
      'allowedActions']) && ['authorizerRef', 'actorRef', 'bindingRef', 'worldRef',
        'grantEpoch'].every(key => ref(binding[key])) &&
    sortedUnique(binding.allowedActions, action => adapterActions.has(action)) &&
    validCapabilities(value.capabilities);
}
function comparePosition(a, b) {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
function operationPositions(operations, worldRef, expectedDigest) {
  if (!operations || typeof operations !== 'object' || operations.contractVersion !== 'operations/v2' ||
      operations.worldRef !== worldRef || !Array.isArray(operations.effects) ||
      operations.effects.length === 0 ||
      operations.effects.some((effect, index) => !Array.isArray(effect.position) ||
        effect.position.length !== 3 || !effect.position.every(Number.isSafeInteger) ||
        typeof effect.nodeName !== 'string' || !effect.nodeName ||
        !Number.isInteger(effect.param2) || effect.param2 < 0 || effect.param2 > 255 ||
        index > 0 && comparePosition(operations.effects[index - 1].position, effect.position) >= 0))
    throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  if (projectionDigest('operations', operations) !== expectedDigest)
    throw issue('TRANSACTION_CONFLICT', 'validate', 'PAYLOAD_CHANGED');
  return operations.effects.map(effect => effect.position);
}

const forbiddenName = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/u;
const unicode17Nfc = ComposingNormalizer.createNfc();
function whitespace(character) { return CodePointSetData.whiteSpaceForChar(character.codePointAt(0)); }
function invisible(character) {
  const point = character.codePointAt(0);
  return whitespace(character) || point === 0x200c || point === 0x200d ||
    point >= 0xfe00 && point <= 0xfe0f || point >= 0xe0020 && point <= 0xe007f ||
    point >= 0xe0100 && point <= 0xe01ef;
}
function normalizedName(name) {
  if (unicode17Nfc.normalize('か\u3099') !== 'が' || !whitespace('\u3000'))
    throw issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
  if (typeof name !== 'string' || forbiddenName.test(name) ||
      [...name].some(ch => ch.codePointAt(0) >= 0xd800 && ch.codePointAt(0) <= 0xdfff))
    throw issue('INVALID_NAME', 'validate', 'NAME_FORBIDDEN_CHARACTER');
  const scalars = [...name];
  while (scalars.length && whitespace(scalars[0])) scalars.shift();
  while (scalars.length && whitespace(scalars.at(-1))) scalars.pop();
  const displayName = scalars.join('');
  if (!displayName || scalars.every(invisible))
    throw issue('INVALID_NAME', 'validate', 'NAME_INVISIBLE_OR_EMPTY');
  const comparisonKey = unicode17Nfc.normalize(displayName).replace(/[A-Z]/g, ch => ch.toLowerCase());
  return { displayName, comparisonKey };
}

export class CanvasV4 {
  constructor({ store, adapter, adapters, authority, adminAuthority,
    serviceActorRef = 'hanaworlds-canvas' }) {
    this.store = store;
    this.storageState = store ? 'READY' : 'UNAVAILABLE';
    this.ready = Promise.resolve();
    this.adapters = adapters ?? (adapter ? [{ adapterId: null, port: adapter }] : []);
    this.authority = authority;
    this.adminAuthority = adminAuthority;
    this.serviceActorRef = serviceActorRef;
    this.subscriptions = new Set();
  }
  status() {
    return { component: name, version: '0.2.0', canvasContract: VERSION,
      adapterContract: 'world-adapter/v4', storage: this.storageState,
      productReadiness: 'UNPROVEN' };
  }
  get contractHandshake() { return structuredClone(contractHandshake); }
  adminProjection(worldRef) {
    const stored = this.store?.snapshot.placementSettings?.[worldRef];
    return { worldRef, owner: name, settings: placementSettingDescriptors.map(row => ({
      ...row, currentValue: stored?.stored?.[row.name] ?? null,
      settingsRevision: stored?.settingsRevision ?? null })),
      invariants: placementInvariants };
  }
  async setPlacementSettings(worldRef, settings, context) {
    const proof = await this.adminAuthority?.verify?.(
      context, 'UpdatePlacementSettings', worldRef);
    if (!ref(worldRef) || !proof?.current || proof.worldRef !== worldRef ||
        proof.domainOwner !== 'hanaworlds-canvas')
      throw issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
    const stored = Object.fromEntries(PLACEMENT_FIELDS.map(field => [field, settings?.[field]]));
    admitPlacementSettings(stored, 'validated');
    const next = { worldRef, stored, settingsRevision: revision() };
    await this.store.commit(state => {
      state.placementSettings ??= Object.create(null);
      state.placementSettings[worldRef] = next;
    });
    return this.adminProjection(worldRef);
  }
  async #subscriptionProof(context) {
    await this.ready;
    if (!this.store || this.store.unavailable ||
        this.store.snapshot.sessions[context.sessionRef]?.activeWorldRef !== context.worldRef)
      throw issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
    const request = { contractVersion: VERSION, actorRef: context.actorRef,
      sessionRef: context.sessionRef, requestId: `event-subscription:${randomUUID()}`,
      authorizationRef: context.authorizationRef, worldRef: context.worldRef,
      expectedRevision: null };
    const proof = await this.authority?.verify?.(request, 'ListObjects');
    if (!proof?.current || proof.actorRef !== context.actorRef ||
        proof.sessionRef !== context.sessionRef ||
        proof.authorizationRef !== context.authorizationRef ||
        !proof.allowedActions?.includes('ListObjects') ||
        typeof proof.authorRef !== 'string' || !proof.authorRef)
      throw issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
    return proof;
  }
  async subscribeCanvasEvents(context, callback) {
    if (!exact(context, ['actorRef', 'sessionRef', 'authorizationRef', 'worldRef']) ||
        !Object.values(context).every(ref) || typeof callback !== 'function')
      throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
    const copy = structuredClone(context);
    const proof = await this.#subscriptionProof(copy);
    const subscription = { context: copy, authorRef: proof.authorRef, callback };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }
  async #publishEvent(eventName, operation, body, result, suffix,
      { requiredAuthorRef = null, initiatorOnly = false,
        authorizationAction = operation,
        authorizationRequest = body,
        eventFields = {},
        deliveryWorldRef = body.worldRef } = {}) {
    if (this.subscriptions.size === 0) return;
    const receipt = { contractVersion: VERSION,
      requestId: `${body.requestId}:${suffix}`, result, error: null };
    const event = validateCanvasEvent(eventName, {
      contractVersion: VERSION, event: eventName, operation, receipt,
      ...eventFields });
    for (const subscription of this.subscriptions) {
      const switchingWorld = eventName === 'ActiveWorldChanged' &&
        subscription.context.worldRef === body.fromWorldRef &&
        deliveryWorldRef === body.toWorldRef;
      if (subscription.context.worldRef !== deliveryWorldRef && !switchingWorld ||
          requiredAuthorRef !== null &&
          subscription.authorRef !== requiredAuthorRef ||
          initiatorOnly && (subscription.context.actorRef !== body.actorRef ||
            subscription.context.sessionRef !== body.sessionRef ||
            subscription.context.authorizationRef !== body.authorizationRef)) continue;
      try {
        const deliveryContext = switchingWorld ?
          { ...subscription.context, worldRef: deliveryWorldRef } : subscription.context;
        const fresh = await this.#subscriptionProof(deliveryContext);
        if (fresh.authorRef !== subscription.authorRef) {
          this.subscriptions.delete(subscription);
          continue;
        }
        if (authorizationAction !== 'ListObjects') {
          const actionProof = await this.authority?.verify?.(
            authorizationRequest, authorizationAction);
          if (!actionProof?.current ||
              actionProof.actorRef !== subscription.context.actorRef ||
              actionProof.sessionRef !== subscription.context.sessionRef ||
              actionProof.authorizationRef !== subscription.context.authorizationRef ||
              !actionProof.allowedActions?.includes(authorizationAction) ||
              requiredAuthorRef !== null && actionProof.authorRef !== requiredAuthorRef)
            continue;
        }
        if (switchingWorld) subscription.context = deliveryContext;
        Promise.resolve(subscription.callback(structuredClone(event)))
          .catch(() => this.subscriptions.delete(subscription));
      } catch { this.subscriptions.delete(subscription); }
    }
  }
  async #publishObjectCreated(body, authorRef, objectRef) {
    if (!objectRef) return;
    const object = this.store.snapshot.objects[body.worldRef]?.[objectRef];
    if (object)
      await this.#publishEvent('ObjectCreated', 'CreateObject', body,
        object, 'create', { requiredAuthorRef: authorRef, initiatorOnly: true,
          authorizationAction: 'ApplyRecoverableCommit' });
  }
  async #publishObjectInventoryChanged(body) {
    const inventory = { worldRef: body.worldRef,
      registryRevision: this.store.snapshot.registryRevisions[body.worldRef] ?? '0',
      objects: Object.values(this.store.snapshot.objects[body.worldRef] ?? {}).sort((a, b) =>
        a.creationSequence - b.creationSequence ||
        (a.objectRef < b.objectRef ? -1 : a.objectRef > b.objectRef ? 1 : 0)) };
    await this.#publishEvent('ObjectInventoryChanged', 'ListObjects', body,
      inventory, 'inventory');
  }
  #staleInspections(worldRef, newWorldRevision) {
    if (!ref(newWorldRevision)) return [];
    return Object.entries(this.store.snapshot.replay)
      .filter(([, row]) => row.inspectionRequest?.worldRef === worldRef &&
        row.response?.result?.source === 'INSPECTED' &&
        row.response.result.worldRevision !== newWorldRevision &&
        !row.inspectionInvalidated)
      .map(([key, row]) => ({ key, row }));
  }
  async #publishInspectionInvalidations(candidates, newWorldRevision) {
    for (const { row } of candidates)
      await this.#publishEvent('ObjectInspectionInvalidated', 'InspectObject',
        row.inspectionRequest, row.response.result, 'inspection-invalidated',
        { requiredAuthorRef: row.inspectionAuthorRef ?? null, initiatorOnly: true,
          eventFields: { newWorldRevision } });
  }
  async #invalidateInspections(worldRef, newWorldRevision) {
    const candidates = this.#staleInspections(worldRef, newWorldRevision);
    if (candidates.length === 0) return;
    await this.store.commit(state => {
      for (const { key, row } of candidates)
        if (state.replay[key]?.digest === row.digest)
          state.replay[key].inspectionInvalidated = true;
    });
    await this.#publishInspectionInvalidations(candidates, newWorldRevision);
  }
  #boundAdapter(sessionRef, worldRef) {
    const binding = this.store.snapshot.bindings[sessionRef];
    if (!binding || binding.worldRef !== worldRef ||
        binding.recoveryGuarantee !== 'RECOVERABLE_VERIFIED')
      throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
    const adapter = this.adapters.find(entry => entry.adapterId === binding.adapterId)?.port;
    if (!adapter) throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    this.#checkAdapterCompatibility(adapter);
    return adapter;
  }
  #checkAdapterCompatibility(adapter) {
    try { checkContractHandshake(adapter?.contractHandshake, {
      wires: [ADAPTER_VERSION], factProfiles: ['target-facts/v2', 'target-facts/v3'] }); }
    catch { throw issue('UNSUPPORTED_VERSION', 'decode', 'VERSION_UNSUPPORTED'); }
  }
  async #adapterCall(adapter, operation, request, afterWriteBarrier = false) {
    let response;
    try { response = await adapter.call(operation, request); }
    catch {
      if (afterWriteBarrier) throw uncertain(request.transactionId);
      throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    }
    try { response = validateResponse('world-adapter/v4', operation, response); }
    catch {
      if (afterWriteBarrier) throw uncertain(request.transactionId);
      throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    }
    if (response.requestId !== request.requestId)
      throw afterWriteBarrier ? uncertain(request.transactionId) :
        issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    if (response.error) {
      const failure = new Error(response.error.code);
      failure.publicError = response.error;
      throw failure;
    }
    return response.result;
  }
  #checkRegionBinding(body, proof) {
    const records = Object.values(this.store.snapshot.placementInspections ?? {})
      .filter(row => row.status === 'RECORDED' &&
        row.outcome?.outcome === 'REGION_INSPECTED' &&
        row.outcome.inspection.targetFactsDigest === body.operations.targetFactsDigest);
    const binding = body.regionInspectionBinding;
    if (!records.length && binding === null) return;
    const match = binding && records.find(row =>
      row.inspectionId === binding.inspectionId &&
      row.worldRef === body.worldRef && row.sessionRef === body.sessionRef &&
      row.actorRef === body.actorRef && row.authorRef === proof.authorRef);
    if (!match) throw issue('PERMISSION_DENIED', 'authorize', 'IDENTITY_UNVERIFIED');
    const inspection = match.outcome.inspection;
    const build = binding.build;
    const same = (left, right) => canonicalize(left) === canonicalize(right);
    if (digestValue('build', build).sha256 !== body.operations.buildDigest ||
        build.targetFactsDigest !== inspection.targetFactsDigest ||
        body.operations.targetFactsDigest !== inspection.targetFactsDigest ||
        digestValue('frame', build.coordinateFrame).sha256 !== body.operations.frameDigest ||
        digestValue('frame', build.coordinateFrame).sha256 !==
          digestValue('frame', inspection.frame).sha256)
      throw issue('PERMISSION_DENIED', 'authorize', 'IDENTITY_UNVERIFIED');
    if (!build.witnesses.some(witness => witness.predicate === 'PROTECTION') ||
        !build.witnesses.some(witness => witness.predicate === 'BODY_CLEARANCE'))
      throw issue('PERMISSION_DENIED', 'authorize', 'IDENTITY_UNVERIFIED');
    for (const witness of build.witnesses) {
      if (witness.predicate !== 'PROTECTION' && witness.predicate !== 'BODY_CLEARANCE')
        continue;
      const facts = witness.facts;
      const field = witness.predicate === 'PROTECTION' ?
        'protectedPositions' : 'bodyOccupiedPositions';
      const wanted = new Set(facts.positions.map(position => canonicalize(position)));
      const restricted = inspection[field].filter(position => wanted.has(canonicalize(position)));
      if (!same(facts.evidence, inspection.evidence) ||
          !same(facts[field], restricted))
        throw issue('PERMISSION_DENIED', 'authorize', 'IDENTITY_UNVERIFIED');
    }
    if (match.worldRevision !== proof.currentWorldRevision)
      throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
  }
  async #apply(body, proof, replayKey, digest) {
    const context = this.store.snapshot.sessions[body.sessionRef];
    if (!context || context.activeWorldRef !== body.worldRef)
      throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
    const adapter = this.#boundAdapter(body.sessionRef, body.worldRef);
    if (typeof proof.authorRef !== 'string' || !proof.authorRef)
      throw issue('AUTHORIZATION_REVOKED', 'authorize', 'GRANT_REVOKED');
    const ownPending = this.store.snapshot.pending[body.transactionId];
    if (ownPending?.status === 'VERIFIED_PENDING_HISTORY') {
      if (ownPending.digest !== digest || ownPending.authorRef !== proof.authorRef)
        throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
      return await this.#finalizePending(body.transactionId);
    }
    if (ownPending && ['APPLYING', 'APPLIED_PENDING_READBACK',
      'RECOVERY_PENDING'].includes(ownPending.status)) {
      if (ownPending.digest !== digest || ownPending.authorRef !== proof.authorRef)
        throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
      if (!ownPending.prepared?.transactionPayloadDigest)
        throw uncertain(body.transactionId);
      const query = { contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:query`,
        authorizationRef: body.authorizationRef, worldRef: body.worldRef,
        transactionId: body.transactionId,
        transactionPayloadDigest: ownPending.prepared.transactionPayloadDigest };
      const queried = await this.#adapterCall(adapter, 'QueryTransaction', query, true);
      if (queried.transactionId !== body.transactionId ||
          queried.operationDigest !== body.operationDigest ||
          queried.transactionPayloadDigest !== ownPending.prepared.transactionPayloadDigest)
        throw uncertain(body.transactionId);
      if (queried.status === 'ROLLED_BACK' &&
          queried.restoreStatus === 'VERIFIED_RESTORED' &&
          queried.error?.mutationState === 'ROLLED_BACK') {
        validateResponse(VERSION, 'ApplyRecoverableCommit', envelope(body, queried));
        await this.store.commit(state => {
          const pending = state.pending[body.transactionId];
          if (pending.digest !== digest || !['APPLYING', 'APPLIED_PENDING_READBACK',
            'RECOVERY_PENDING'].includes(pending.status)) throw uncertain(body.transactionId);
          pending.status = 'ROLLED_BACK';
          pending.receipt = queried;
          state.replay[replayKey] = { digest, authorRef: proof.authorRef,
            response: envelope(body, queried) };
        });
        return envelope(body, queried);
      }
      if (queried.status !== 'APPLIED_PENDING_READBACK')
        throw uncertain(body.transactionId);
      await this.store.commit(state => {
        const pending = state.pending[body.transactionId];
        if (pending.digest !== digest || !['APPLYING', 'APPLIED_PENDING_READBACK',
          'RECOVERY_PENDING'].includes(pending.status)) throw uncertain(body.transactionId);
        pending.status = 'APPLIED_PENDING_READBACK';
      });
      await this.#publishEvent('TransactionAppliedPendingReadback',
        'ApplyRecoverableCommit', body, queried, 'applied-pending-readback',
        { requiredAuthorRef: proof.authorRef, initiatorOnly: true });
      return await this.#completeApplied(body, proof, digest, adapter, queried,
        ownPending.prepared, ownPending.positions);
    }
    this.#checkRegionBinding(body, proof);
    if (proof.currentWorldRevision !== body.expectedWorldRevision)
      throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
    const positions = operationPositions(body.operations, body.worldRef, body.operationDigest);
    const positionKeys = new Set(positions.map(position => position.join(',')));
    for (const [transactionId, pending] of Object.entries(this.store.snapshot.pending)) {
      if (transactionId === body.transactionId || pending.worldRef !== body.worldRef ||
          ['VERIFIED', 'ROLLED_BACK'].includes(pending.status) ||
          !pending.positions?.some(position => positionKeys.has(position.join(',')))) continue;
      if (pending.status === 'VERIFIED_PENDING_HISTORY')
        await this.#finalizePending(transactionId);
      else throw uncertain(transactionId);
    }
    const analysis = this.store.snapshot.analyses[body.worldRef]?.[body.transactionId];
    if (!analysis || analysis.digest !== body.analysisDigest ||
        analysis.result.operationDigest !== body.operationDigest ||
        analysis.result.worldRevision !== body.expectedWorldRevision ||
        analysis.result.selectionRevision !== context.selectionRevision ||
        analysis.result.registryRevision !==
          (this.store.snapshot.registryRevisions[body.worldRef] ?? '0') ||
        canonicalize(analysis.positions) !== canonicalize(positions))
      throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
    const selected = new Set(analysis.result.orderedSelectedRefs);
    const otherObjects = analysis.result.affectedObjectRefs.filter(ref => !selected.has(ref));
    const decision = this.store.snapshot.decisions[body.worldRef]?.[body.transactionId];
    if (otherObjects.length && (decision?.decisionKind !== 'CONTINUE' ||
        decision.decisionRevision !== body.decisionRevision) ||
        !otherObjects.length && body.decisionRevision !== null &&
          decision?.decisionRevision !== body.decisionRevision)
      throw issue('OTHER_OBJECTS_AFFECTED', 'validate', 'POLICY_UNAVAILABLE');
    for (const [objectRef, expected] of Object.entries(body.expectedObjectRevisions))
      if (this.store.snapshot.objects[body.worldRef]?.[objectRef]?.objectRevision !== expected)
        throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
    if (canonicalize(Object.keys(body.expectedObjectRevisions).sort(compareUtf16)) !==
        canonicalize(analysis.result.affectedObjectRefs))
      throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
    const old = this.store.snapshot.pending[body.transactionId];
    if (old && (old.digest !== digest || old.authorRef !== proof.authorRef ||
        old.worldRef !== body.worldRef))
      throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
    if (!old) {
      await this.store.commit(state => {
        if (state.pending[body.transactionId])
          throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
        state.pending[body.transactionId] = { status: 'RESERVED',
          worldRef: body.worldRef, sessionRef: body.sessionRef,
          actorRef: body.actorRef, authorRef: proof.authorRef,
          request: body, digest, affectedObjectRefs: analysis.result.affectedObjectRefs,
          positions, preparedRequestId: `${body.requestId}:prepare`,
          prepareAttempted: true };
      });
    }
    const prepareRequest = { contractVersion: ADAPTER_VERSION,
      actorRef: this.serviceActorRef, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:prepare`, authorizationRef: body.authorizationRef,
      worldRef: body.worldRef, transactionId: body.transactionId,
      operationDigest: body.operationDigest, operations: body.operations,
      authorizationBinding: body.authorizationBinding,
      expectedWorldRevision: body.expectedWorldRevision,
      expectedObjectRevisions: body.expectedObjectRevisions, guarantee: body.guarantee };
    const queryPrepared = old && (old.status === 'PREPARED' ||
      old.status === 'RESERVED' && old.prepareAttempted);
    const queryPreparedRequest = { contractVersion: ADAPTER_VERSION,
      actorRef: this.serviceActorRef, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:query-prepared`,
      authorizationRef: body.authorizationRef, worldRef: body.worldRef,
      transactionId: body.transactionId, operationDigest: body.operationDigest,
      authorizationBindingDigest: body.authorizationBindingDigest };
    const prepared = queryPrepared ?
      await this.#adapterCall(adapter, 'QueryPreparedTransaction', queryPreparedRequest) :
      await this.#adapterCall(adapter, 'PrepareRecoverableTransaction', prepareRequest);
    if (prepared.payload.transactionId !== body.transactionId ||
        prepared.payload.operationDigest !== body.operationDigest ||
        prepared.payload.authorizationBindingDigest !== body.authorizationBindingDigest ||
        prepared.payload.expectedWorldRevision !== body.expectedWorldRevision ||
        canonicalize(prepared.payload.expectedObjectRevisions) !==
          canonicalize(body.expectedObjectRevisions) ||
        canonicalize(prepared.protectedPositions) !== canonicalize(positions) ||
        prepared.guarantee !== 'RECOVERABLE_VERIFIED' ||
        digestValue('transaction-payload', prepared.payload).sha256 !==
          prepared.transactionPayloadDigest)
      throw issue('TRANSACTION_CONFLICT', 'validate', 'PAYLOAD_CHANGED');
    if (old?.prepared && canonicalize(old.prepared) !== canonicalize(prepared))
      throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
    await this.store.commit(state => {
      const pending = state.pending[body.transactionId];
      if (pending.digest !== digest || !['RESERVED', 'PREPARED'].includes(pending.status))
        throw issue('TRANSACTION_CONFLICT', 'persist', 'POLICY_UNAVAILABLE');
      pending.prepared = prepared;
      pending.status = 'PREPARED';
    });
    const applyRequest = { contractVersion: ADAPTER_VERSION,
      actorRef: this.serviceActorRef, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:apply`, authorizationRef: body.authorizationRef,
      worldRef: body.worldRef, transactionId: body.transactionId,
      expectedWorldRevision: body.expectedWorldRevision,
      preparedTransaction: projectPreparedTransaction(prepared), operations: body.operations,
      operationDigest: body.operationDigest,
      authorizationBinding: body.authorizationBinding, guarantee: body.guarantee };
    await this.store.commit(state => {
      state.pending[body.transactionId].status = 'APPLYING';
    });
    let applied;
    try { applied = await this.#adapterCall(adapter, 'ApplyCompiledTransaction', applyRequest, true); }
    catch (error) {
      await this.store.commit(state => { state.pending[body.transactionId].status = 'RECOVERY_PENDING'; });
      throw error;
    }
    if (applied.status !== 'APPLIED_PENDING_READBACK' ||
        applied.transactionId !== body.transactionId ||
        applied.operationDigest !== body.operationDigest ||
        applied.transactionPayloadDigest !== prepared.transactionPayloadDigest)
      throw uncertain(body.transactionId);
    await this.store.commit(state => {
      state.pending[body.transactionId].status = 'APPLIED_PENDING_READBACK';
    });
    await this.#publishEvent('TransactionAppliedPendingReadback',
      'ApplyRecoverableCommit', body, applied, 'applied-pending-readback',
      { requiredAuthorRef: proof.authorRef, initiatorOnly: true });
    return await this.#completeApplied(body, proof, digest, adapter, applied, prepared, positions);
  }
  async #completeApplied(body, proof, digest, adapter, applied, prepared, positions) {
    if (applied.status !== 'APPLIED_PENDING_READBACK' ||
        applied.transactionId !== body.transactionId ||
        applied.operationDigest !== body.operationDigest ||
        applied.transactionPayloadDigest !== prepared.transactionPayloadDigest)
      throw uncertain(body.transactionId);
    const readbackRequest = { contractVersion: ADAPTER_VERSION,
      actorRef: this.serviceActorRef, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:readback`, authorizationRef: body.authorizationRef,
      worldRef: body.worldRef, transactionId: body.transactionId,
      coveredPositions: prepared.protectedPositions, stateProfile: prepared.stateProfile };
    let readback;
    try { readback = await this.#adapterCall(adapter, 'Readback', readbackRequest, true); }
    catch (error) {
      await this.store.commit(state => { state.pending[body.transactionId].status = 'RECOVERY_PENDING'; });
      throw error;
    }
    if (readback.adapterExecutionRevision !== prepared.adapterExecutionRevision ||
        canonicalize(readback.projection.coveredPositions) !== canonicalize(positions) ||
        canonicalize(readback.projection.stateProfile) !== canonicalize(prepared.stateProfile) ||
        readback.projection.worldRef !== body.worldRef ||
        digestValue('readback', readback.projection).sha256 !== readback.readbackDigest ||
        readback.projection.records.length !== body.operations.effects.length ||
        readback.projection.records.some((record, index) =>
          canonicalize(record.position) !==
            canonicalize(body.operations.effects[index].position) ||
          record.nodeName !== body.operations.effects[index].nodeName ||
          record.param2 !== body.operations.effects[index].param2)) {
      await this.store.commit(state => { state.pending[body.transactionId].status = 'RECOVERY_PENDING'; });
      throw uncertain(body.transactionId);
    }
    const freshProof = await this.authority.verify(body, 'ApplyRecoverableCommit');
    if (!freshProof?.current || freshProof.authorRef !== proof.authorRef ||
        freshProof.actorRef !== body.actorRef ||
        freshProof.sessionRef !== body.sessionRef ||
        freshProof.authorizationRef !== body.authorizationRef ||
        !freshProof.allowedActions?.includes('ApplyRecoverableCommit') ||
        typeof freshProof.currentWorldRevision !== 'string' ||
        !freshProof.currentWorldRevision)
      throw uncertain(body.transactionId);
    const verified = { ...applied, status: 'VERIFIED',
      observedWorldRevision: freshProof.currentWorldRevision,
      readbackDigest: readback.readbackDigest, restoreStatus: 'NOT_REQUIRED', error: null };
    validateResponse(VERSION, 'ApplyRecoverableCommit', envelope(body, verified));
    const receiptDigest = digestValue('receipt', verified).sha256;
    await this.store.commit(state => {
      const pending = state.pending[body.transactionId];
      if (pending?.status !== 'APPLIED_PENDING_READBACK' || pending.digest !== digest)
        throw issue('TRANSACTION_CONFLICT', 'persist', 'POLICY_UNAVAILABLE');
      pending.status = 'VERIFIED_PENDING_HISTORY';
      pending.receipt = verified;
      pending.receiptDigest = receiptDigest;
      if (pending.affectedObjectRefs.length === 0)
        pending.reservedObjectRef ??= randomUUID();
    });
    return await this.#finalizePending(body.transactionId);
  }
  async #finalizePending(transactionId) {
    const prior = this.store.snapshot.pending[transactionId];
    if (prior?.status !== 'VERIFIED_PENDING_HISTORY' ||
        !prior.request || !prior.receipt || !prior.prepared ||
        digestValue('receipt', prior.receipt).sha256 !== prior.receiptDigest)
      throw issue('TRANSACTION_CONFLICT', 'persist', 'POLICY_UNAVAILABLE');
    const body = prior.request;
    const digest = prior.digest;
    const verified = prior.receipt;
    const receiptDigest = prior.receiptDigest;
    const prepared = prior.prepared;
    const readback = { readbackDigest: verified.readbackDigest };
    const positions = prior.positions;
    const invalidations = this.#staleInspections(body.worldRef,
      verified.observedWorldRevision);
    const replayKey = `${body.sessionRef}\u0000ApplyRecoverableCommit\u0000${body.requestId}`;
    const linkedHistoryRevision = revision();
    await this.store.commit(state => {
      const pending = state.pending[body.transactionId];
      if (pending?.status !== 'VERIFIED_PENDING_HISTORY' || pending.digest !== digest)
        throw issue('TRANSACTION_CONFLICT', 'persist', 'POLICY_UNAVAILABLE');
      const recordRefs = pending.affectedObjectRefs.length ?
        pending.affectedObjectRefs : [pending.reservedObjectRef];
      if (pending.reservedObjectRef) {
        const objectRef = pending.reservedObjectRef;
        state.objects[body.worldRef] ??= Object.create(null);
        if (state.objects[body.worldRef][objectRef])
          throw issue('OBJECT_SCOPE_MISMATCH', 'persist', 'SCOPE_DENIED');
        state.objects[body.worldRef][objectRef] = { worldRef: body.worldRef,
          objectRef, objectRevision: '1', displayName: null, nameRevision: null,
          creationSequence: Object.values(state.objects[body.worldRef])
            .reduce((max, row) => Math.max(max, row.creationSequence), 0) + 1,
          status: 'READY' };
        state.registryRevisions[body.worldRef] =
          revision(state.registryRevisions[body.worldRef] ?? '0');
      }
      const worldHistory = state.authorHistory[body.worldRef] ??= Object.create(null);
      for (const objectRef of recordRefs) {
        const byAuthor = worldHistory[objectRef] ??= Object.create(null);
        const previous = byAuthor[pending.authorRef] ?? { historyRevision: '0',
          headTransactionId: null, entries: [], undoAvailable: false, redoAvailable: false };
        const headIndex = previous.headTransactionId === null ? -1 :
          previous.entries.findIndex(entry => entry.transactionId === previous.headTransactionId);
        const historyRevision = linkedHistoryRevision;
        const entry = { transactionId: body.transactionId, originTransactionId: null,
          affectedObjectRefs: recordRefs,
          operationDigest: body.operationDigest, beforeImageDigest: prepared.beforeImageDigest,
          expectedAfterReadbackDigest: readback.readbackDigest, receiptDigest,
          historyRevision, status: 'VERIFIED' };
        byAuthor[pending.authorRef] = { historyRevision, headTransactionId: body.transactionId,
          entries: [...previous.entries.slice(0, headIndex + 1), entry],
          undoAvailable: true, redoAvailable: false };
        const object = state.objects[body.worldRef]?.[objectRef];
        if (object) object.objectRevision = revision(object.objectRevision);
        state.footprints[body.worldRef] ??= Object.create(null);
        const footprint = state.footprints[body.worldRef][objectRef] ?? [];
        state.footprints[body.worldRef][objectRef] = [...footprint, ...positions]
          .filter((position, index, all) => all.findIndex(candidate =>
            canonicalize(candidate) === canonicalize(position)) === index)
          .sort(comparePosition);
      }
      state.transactions[body.worldRef] ??= Object.create(null);
      state.transactions[body.worldRef][body.transactionId] = { status: 'VERIFIED',
        worldRef: body.worldRef, transactionId: body.transactionId,
        authorRef: pending.authorRef, sessionRef: body.sessionRef,
        affectedObjectRefs: recordRefs, positions,
        operationDigest: body.operationDigest, beforeImageDigest: prepared.beforeImageDigest,
        beforeStateReadbackDigest: prepared.beforeStateReadbackDigest,
        afterReadbackDigest: readback.readbackDigest, receiptDigest,
        reservedObjectRef: pending.reservedObjectRef ?? null,
        transactionPayloadDigest: prepared.transactionPayloadDigest,
        receipt: verified };
      pending.status = 'VERIFIED';
      state.replay[replayKey] = { digest, authorRef: pending.authorRef,
        response: envelope(body, verified) };
      for (const { key, row } of invalidations)
        if (state.replay[key]?.digest === row.digest)
          state.replay[key].inspectionInvalidated = true;
    });
    await this.#publishInspectionInvalidations(invalidations,
      verified.observedWorldRevision);
    if (prior.reservedObjectRef) {
      await this.#publishObjectCreated(body, prior.authorRef, prior.reservedObjectRef);
      await this.#publishObjectInventoryChanged(body);
    }
    const eventReadbackRequest = { contractVersion: VERSION,
      actorRef: body.actorRef, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:event-readback`,
      authorizationRef: body.authorizationRef, worldRef: body.worldRef,
      transactionId: body.transactionId,
      commitRevision: verified.observedWorldRevision,
      expectedOperations: body.operations,
      transactionPayloadDigest: prepared.transactionPayloadDigest };
    await this.#publishEvent('TransactionVerified', 'Readback', body,
      verified, 'verified', { requiredAuthorRef: prior.authorRef,
        initiatorOnly: true, authorizationRequest: eventReadbackRequest });
    const recordRefs = prior.affectedObjectRefs.length ?
      prior.affectedObjectRefs : [prior.reservedObjectRef];
    for (const objectRef of recordRefs) {
      const history = this.store.snapshot.authorHistory[body.worldRef][objectRef][prior.authorRef];
      const eventHistoryRequest = { contractVersion: VERSION,
        actorRef: body.actorRef, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:event-history:${objectRef}`,
        authorizationRef: body.authorizationRef, worldRef: body.worldRef,
        objectRef, expectedHistoryRevision: history.historyRevision };
      await this.#publishEvent('HistoryInventoryChanged', 'HistoryQuery', body,
        { worldRef: body.worldRef, objectRef, ...history },
        `history:${objectRef}`, { requiredAuthorRef: prior.authorRef,
          initiatorOnly: true, authorizationRequest: eventHistoryRequest });
    }
    return envelope(body, verified);
  }
  async #readback(body, proof, replayKey, digest) {
    const session = this.store.snapshot.sessions[body.sessionRef];
    if (session?.activeWorldRef !== body.worldRef)
      throw issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
    const transaction = this.store.snapshot.transactions[body.worldRef]?.[body.transactionId];
    if (!transaction || transaction.authorRef !== proof.authorRef ||
        transaction.sessionRef !== body.sessionRef)
      throw issue('PERMISSION_DENIED', 'authorize', 'OWNERSHIP_VIOLATION');
    if (transaction.transactionPayloadDigest !== body.transactionPayloadDigest ||
        transaction.operationDigest !==
          digestValue('operations', body.expectedOperations).sha256)
      throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
    if (transaction.status !== 'VERIFIED' || !transaction.receipt)
      throw uncertain(body.transactionId);
    if (transaction.receipt.observedWorldRevision !== body.commitRevision)
      throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
    const result = transaction.receipt;
    await this.store.commit(state => {
      const current = state.transactions[body.worldRef]?.[body.transactionId];
      if (current?.status !== 'VERIFIED' || current.receiptDigest !== transaction.receiptDigest)
        throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
      state.replay[replayKey] = { digest, authorRef: proof.authorRef,
        response: envelope(body, result) };
    });
    return envelope(body, result);
  }
  #placementSettings(worldRef) {
    const record = this.store.snapshot.placementSettings?.[worldRef];
    const stored = record?.stored;
    const missing = PLACEMENT_FIELDS.filter(name => {
      return !Number.isSafeInteger(stored?.[name]) || stored[name] < 0;
    });
    if (!ref(record?.settingsRevision)) missing.push(...PLACEMENT_FIELDS);
    if (missing.length) {
      const failure = issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      failure.unavailableSettings = [...new Set(missing)].sort(compareUtf16);
      throw failure;
    }
    return admitPlacementSettings(stored, record.settingsRevision);
  }
  async #inspectPlacementRegion(body, proof, replayKey, requestDigest) {
    const session = this.store.snapshot.sessions[body.sessionRef];
    if (session?.activeWorldRef !== body.worldRef)
      throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
    const adapter = this.#boundAdapter(body.sessionRef, body.worldRef);
    const settings = this.#placementSettings(body.worldRef);
    if (!ref(proof.currentWorldRevision))
      throw issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    const earlier = this.store.snapshot.placementInspections?.[replayKey];
    if (earlier && earlier.digest !== requestDigest)
      throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
    if (earlier?.settingsRevision !== undefined &&
        earlier.settingsRevision !== settings.settingsRevision)
      throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
    const inspectionId = earlier?.inspectionId ?? randomUUID();
    if (!earlier) await this.store.commit(state => {
      state.placementInspections ??= Object.create(null);
      if (state.placementInspections[replayKey])
        throw issue('TRANSACTION_CONFLICT', 'persist', 'POLICY_UNAVAILABLE');
      state.placementInspections[replayKey] = { inspectionId, digest: requestDigest,
        worldRef: body.worldRef, sessionRef: body.sessionRef, actorRef: body.actorRef,
        authorizationRef: body.authorizationRef, authorRef: proof.authorRef,
        settingsRevision: settings.settingsRevision, worldRevision: proof.currentWorldRevision,
        status: 'RESERVED' };
    });
    const request = { contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
      sessionRef: body.sessionRef, requestId: `${body.requestId}:region`,
      authorizationRef: body.authorizationRef, worldRef: body.worldRef,
      expectedWorldRevision: proof.currentWorldRevision, inspectionId,
      anchor: body.anchor, footprint: body.footprint, placementSettings: settings };
    const outcome = await this.#adapterCall(adapter, 'InspectRegion', request);
    if (outcome.outcome === 'REGION_INSPECTED') {
      const inspection = validateRegionInspection(outcome.inspection);
      if (inspection.inspectionId !== inspectionId ||
          inspection.targetFacts.worldRef !== body.worldRef ||
          inspection.targetFacts.worldRevision !== proof.currentWorldRevision ||
          canonicalize(inspection.placementSettings) !== canonicalize(settings))
        throw issue('INSPECTION_FAILED', 'validate', 'REQUIRED_FACT_UNKNOWN');
    } else if (outcome.outcome === 'PLACEMENT_CHOICE_REQUIRED') {
      const choice = outcome.choice;
      const multiple = choice.reasons.includes('MULTIPLE_ONLINE_PLAYERS');
      if (canonicalize(choice.placementSettings) !== canonicalize(settings) ||
          choice.observedWorldRevision !== proof.currentWorldRevision ||
          canonicalize(choice.options) !== canonicalize(multiple ?
            ['NAME_PLAYER', 'PICK_WORLD_POINT'] : ['PICK_WORLD_POINT']) ||
          multiple !== (choice.candidatePlayerNames !== null))
        throw issue('INSPECTION_FAILED', 'validate', 'REQUIRED_FACT_UNKNOWN');
    } else throw issue('INSPECTION_FAILED', 'validate', 'REQUIRED_FACT_UNKNOWN');
    const released = await this.authority.verify(body, 'InspectPlacementRegion');
    if (!released?.current || released.actorRef !== body.actorRef ||
        released.sessionRef !== body.sessionRef ||
        released.authorizationRef !== body.authorizationRef ||
        !released.allowedActions?.includes('InspectPlacementRegion') ||
        released.currentWorldRevision !== proof.currentWorldRevision)
      throw issue('AUTHORIZATION_REVOKED', 'authorize', 'GRANT_REVOKED');
    if (outcome.outcome === 'PLACEMENT_CHOICE_REQUIRED' &&
        outcome.choice.candidatePlayerNames !== null &&
        !released.allowedActions?.includes('INSPECT'))
      throw issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
    const response = placementEnvelope(body, outcome);
    validateResponse(VERSION, 'InspectPlacementRegion', response);
    await this.store.commit(state => {
      const record = state.placementInspections?.[replayKey];
      if (!record || record.inspectionId !== inspectionId || record.digest !== requestDigest ||
          state.placementSettings?.[body.worldRef]?.settingsRevision !== settings.settingsRevision)
        throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
      record.status = 'RECORDED';
      record.outcome = outcome;
      state.replay[replayKey] = { digest: requestDigest, authorRef: proof.authorRef,
        response };
    });
    return response;
  }
  async #historyAction(operation, body, proof) {
    const session = this.store.snapshot.sessions[body.sessionRef];
    if (session?.activeWorldRef !== body.worldRef)
      throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
    if (!this.store.snapshot.objects[body.worldRef]?.[body.objectRef])
      throw issue('OBJECT_NOT_FOUND', 'validate', 'SCOPE_DENIED');
    if (typeof proof.authorRef !== 'string' || !proof.authorRef)
      throw issue('PERMISSION_DENIED', 'authorize', 'IDENTITY_UNVERIFIED');
    const origin = this.store.snapshot.transactions[body.worldRef]?.[body.historyTransactionId];
    if (!origin || origin.status !== 'VERIFIED' || origin.worldRef !== body.worldRef ||
        origin.authorRef !== proof.authorRef ||
        !origin.affectedObjectRefs?.includes(body.objectRef))
      throw issue('PERMISSION_DENIED', 'authorize', 'OWNERSHIP_VIOLATION');
    const refs = origin.affectedObjectRefs;
    if (!digest(origin.beforeStateReadbackDigest) || !digest(origin.afterReadbackDigest) ||
        !digest(origin.beforeImageDigest) || !digest(origin.receiptDigest) ||
        !validPositions(origin.positions, true))
      throw issue('SAVED_RESOURCE_UNAVAILABLE', 'validate', 'RESOURCE_MISSING');
    const covered = new Set(origin.positions.map(position => position.join(',')));
    for (const [transactionId, row] of Object.entries(this.store.snapshot.pending)) {
      if (transactionId === body.transactionId || row.worldRef !== body.worldRef ||
          ['VERIFIED', 'ROLLED_BACK'].includes(row.status) ||
          !row.positions?.some(position => covered.has(position.join(',')))) continue;
      if (row.status === 'VERIFIED_PENDING_HISTORY')
        await this.#finalizePending(transactionId);
      else throw uncertain(transactionId);
    }
    const pending = this.store.snapshot.pending[body.transactionId];
    if (proof.currentWorldRevision !== body.expectedWorldRevision &&
        !['HISTORY_APPLYING', 'HISTORY_APPLIED_PENDING_READBACK',
          'HISTORY_RECOVERY_PENDING'].includes(pending?.status))
      throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
    if (canonicalize(Object.keys(body.expectedObjectRevisions).sort(compareUtf16)) !==
        canonicalize(refs))
      throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
    for (const objectRef of refs) {
      const object = this.store.snapshot.objects[body.worldRef]?.[objectRef];
      const history = this.store.snapshot.authorHistory[body.worldRef]?.[objectRef]?.[proof.authorRef];
      if (!object || !history || history.historyRevision !== body.expectedHistoryRevision ||
          object.objectRevision !== body.expectedObjectRevisions[objectRef])
        throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
      const index = history.entries.findIndex(entry =>
        entry.transactionId === body.historyTransactionId);
      if (index < 0) throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
      if (operation === 'Undo' && history.headTransactionId !== body.historyTransactionId)
        throw issue('UNDO_CONFLICT', 'validate', 'EXTERNAL_EDIT_CONFLICT');
      if (operation === 'Redo' && (!history.redoAvailable ||
          history.headTransactionId !== (history.entries[index - 1]?.transactionId ?? null)))
        throw issue('REDO_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    }
    const direction = operation === 'Undo' ? 'UNDO' : 'REDO';
    const expectedCurrentStateDigest = direction === 'UNDO' ?
      origin.afterReadbackDigest : origin.beforeStateReadbackDigest;
    const targetStateDigest = direction === 'UNDO' ?
      origin.beforeStateReadbackDigest : origin.afterReadbackDigest;
    const projection = { contractVersion: ADAPTER_VERSION, worldRef: body.worldRef,
      originTransactionId: body.historyTransactionId, transactionId: body.transactionId,
      direction, affectedObjectRefs: refs,
      originVerifiedReceiptDigest: origin.receiptDigest,
      originBeforeImageDigest: origin.beforeImageDigest,
      originBeforeStateReadbackDigest: origin.beforeStateReadbackDigest,
      originAfterReadbackDigest: origin.afterReadbackDigest,
      expectedCurrentStateDigest, targetStateDigest,
      expectedHistoryRevision: body.expectedHistoryRevision,
      expectedWorldRevision: body.expectedWorldRevision,
      expectedObjectRevisions: body.expectedObjectRevisions,
      guarantee: 'RECOVERABLE_VERIFIED' };
    const historyOperationDigest = digestValue('history-operation', projection).sha256;
    const seed = proof.authorizationBinding;
    if (!seed || seed.actorRef !== body.actorRef || seed.worldRef !== body.worldRef ||
        seed.sessionRef !== body.sessionRef ||
        !['authorizerRef', 'grantEpoch', 'bindingRef', 'turnRevision',
          'selectionRevision'].every(field => ref(seed[field])))
      throw issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    const authorizationBinding = { contractVersion: 'world-adapter/v2',
      authorizerRef: seed.authorizerRef, actorRef: body.actorRef,
      grantEpoch: seed.grantEpoch, bindingRef: seed.bindingRef,
      worldRef: body.worldRef, sessionRef: body.sessionRef,
      turnRevision: seed.turnRevision, intentDigest: body.intentDigest,
      surfaceActionDigest: body.surfaceActionDigest, allowedAction: direction,
      transactionId: body.transactionId, operationDigest: historyOperationDigest,
      worldRevision: body.expectedWorldRevision, selectionRevision: seed.selectionRevision,
      analysisDigest: seed.analysisDigest ?? null,
      decisionRevision: seed.decisionRevision ?? null };
    const authorizationBindingDigest =
      digestValue('authorization-binding', authorizationBinding).sha256;
    const adapter = this.#boundAdapter(body.sessionRef, body.worldRef);
    const requestDigest = identity(body);
    if (pending && (pending.digest !== requestDigest ||
        pending.authorRef !== proof.authorRef || pending.direction !== direction))
      throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
    if (!pending) await this.store.commit(state => {
      if (state.pending[body.transactionId] ||
          state.transactions[body.worldRef]?.[body.transactionId])
        throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
      state.pending[body.transactionId] = { status: 'HISTORY_RESERVED',
        direction, digest: requestDigest, request: body, authorRef: proof.authorRef,
        worldRef: body.worldRef, affectedObjectRefs: refs, positions: origin.positions,
        originTransactionId: body.historyTransactionId,
        historyOperationDigest, authorizationBindingDigest,
        preparedRequestId: `${body.requestId}:history-prepare`, prepareAttempted: true };
    });
    const common = { contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
      sessionRef: body.sessionRef, authorizationRef: body.authorizationRef,
      worldRef: body.worldRef, originTransactionId: body.historyTransactionId,
      transactionId: body.transactionId, direction };
    let prepared = pending?.prepared;
    if (!prepared) {
      const recovering = pending?.prepareAttempted;
      prepared = recovering ? await this.#adapterCall(adapter,
        'QueryPreparedHistoryTransaction', { ...common,
          requestId: `${body.requestId}:history-query-prepared`,
          historyOperationDigest, authorizationBindingDigest }) :
        await this.#adapterCall(adapter, 'PrepareHistoryTransaction', {
          ...common, requestId: `${body.requestId}:history-prepare`,
          affectedObjectRefs: refs,
          originVerifiedReceiptDigest: origin.receiptDigest,
          originBeforeImageDigest: origin.beforeImageDigest,
          originBeforeStateReadbackDigest: origin.beforeStateReadbackDigest,
          originAfterReadbackDigest: origin.afterReadbackDigest,
          expectedHistoryRevision: body.expectedHistoryRevision,
          expectedWorldRevision: body.expectedWorldRevision,
          expectedObjectRevisions: body.expectedObjectRevisions,
          expectedCurrentStateDigest, targetStateDigest,
          historyOperationDigest, authorizationBinding,
          guarantee: 'RECOVERABLE_VERIFIED' });
      if (prepared.originTransactionId !== body.historyTransactionId ||
          prepared.transactionId !== body.transactionId ||
          prepared.direction !== direction ||
          prepared.historyOperationDigest !== historyOperationDigest ||
          prepared.targetStateDigest !== targetStateDigest ||
          prepared.status !== 'PREPARED')
        throw issue('REPLAY_MISMATCH', 'validate', 'PAYLOAD_CHANGED');
      await this.store.commit(state => {
        const row = state.pending[body.transactionId];
        if (!row || row.digest !== requestDigest) throw uncertain(body.transactionId);
        row.prepared = prepared;
        row.status = 'HISTORY_PREPARED';
      });
    }
    let applied;
    if (pending && ['HISTORY_APPLYING', 'HISTORY_APPLIED_PENDING_READBACK',
      'HISTORY_RECOVERY_PENDING'].includes(pending.status)) {
      applied = await this.#adapterCall(adapter, 'QueryTransaction', {
        contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:history-query`,
        authorizationRef: body.authorizationRef, worldRef: body.worldRef,
        transactionId: body.transactionId,
        transactionPayloadDigest: prepared.transactionPayloadDigest }, true);
    } else {
      await this.store.commit(state => { state.pending[body.transactionId].status = 'HISTORY_APPLYING'; });
      try { applied = await this.#adapterCall(adapter, 'ApplyHistoryTransaction', {
        ...common, requestId: `${body.requestId}:history-apply`,
        authorizationBinding, historyOperationDigest,
        expectedWorldRevision: body.expectedWorldRevision,
        expectedObjectRevisions: body.expectedObjectRevisions,
        preparedHistoryTransaction: prepared }, true); }
      catch (error) {
        await this.store.commit(state => {
          state.pending[body.transactionId].status = 'HISTORY_RECOVERY_PENDING';
        });
        throw error;
      }
    }
    if (applied.status === 'ROLLED_BACK' &&
        applied.restoreStatus === 'VERIFIED_RESTORED' &&
        applied.error?.mutationState === 'ROLLED_BACK') {
      validateResponse(VERSION, operation, envelope(body, applied));
      await this.store.commit(state => {
        const row = state.pending[body.transactionId];
        if (!row || row.digest !== requestDigest) throw uncertain(body.transactionId);
        row.status = 'ROLLED_BACK';
        row.receipt = applied;
        state.replay[`${body.sessionRef}\u0000${operation}\u0000${body.requestId}`] = {
          digest: requestDigest, authorRef: proof.authorRef,
          response: envelope(body, applied) };
      });
      return envelope(body, applied);
    }
    if (applied.status !== 'APPLIED_PENDING_READBACK' ||
        applied.transactionId !== body.transactionId ||
        applied.operationDigest !== historyOperationDigest ||
        applied.transactionPayloadDigest !== prepared.transactionPayloadDigest)
      throw uncertain(body.transactionId);
    await this.store.commit(state => {
      state.pending[body.transactionId].status = 'HISTORY_APPLIED_PENDING_READBACK';
    });
    const readback = await this.#adapterCall(adapter, 'Readback', {
      contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
      sessionRef: body.sessionRef, requestId: `${body.requestId}:history-readback`,
      authorizationRef: body.authorizationRef, worldRef: body.worldRef,
      transactionId: body.transactionId,
      coveredPositions: prepared.protectedPositions,
      stateProfile: prepared.stateProfile }, true);
    if (readback.readbackDigest !== targetStateDigest ||
        digestValue('readback', readback.projection).sha256 !== targetStateDigest)
      throw uncertain(body.transactionId);
    const fresh = await this.authority.verify(body, operation);
    if (!fresh?.current || fresh.authorRef !== proof.authorRef ||
        fresh.actorRef !== body.actorRef || fresh.sessionRef !== body.sessionRef ||
        fresh.authorizationRef !== body.authorizationRef ||
        !fresh.allowedActions?.includes(operation) ||
        !ref(fresh.currentWorldRevision)) throw uncertain(body.transactionId);
    const verified = { ...applied, status: 'VERIFIED',
      observedWorldRevision: fresh.currentWorldRevision,
      readbackDigest: targetStateDigest, restoreStatus: 'NOT_REQUIRED', error: null };
    validateResponse(VERSION, operation, envelope(body, verified));
    const receiptDigest = digestValue('receipt', verified).sha256;
    const linkedHistoryRevision = revision();
    await this.store.commit(state => {
      const row = state.pending[body.transactionId];
      if (!row || row.digest !== requestDigest ||
          row.status !== 'HISTORY_APPLIED_PENDING_READBACK')
        throw uncertain(body.transactionId);
      const histories = state.authorHistory[body.worldRef];
      for (const objectRef of refs) {
        const current = histories?.[objectRef]?.[proof.authorRef];
        if (!current || current.historyRevision !== body.expectedHistoryRevision ||
            state.objects[body.worldRef]?.[objectRef]?.objectRevision !==
              body.expectedObjectRevisions[objectRef])
          throw uncertain(body.transactionId);
        const originIndex = current.entries.findIndex(entry =>
          entry.transactionId === body.historyTransactionId);
        const headTransactionId = direction === 'UNDO' ?
          current.entries[originIndex - 1]?.transactionId ?? null : body.historyTransactionId;
        const historyRevision = linkedHistoryRevision;
        current.entries.push({ transactionId: body.transactionId,
          originTransactionId: body.historyTransactionId, affectedObjectRefs: refs,
          operationDigest: historyOperationDigest,
          beforeImageDigest: prepared.beforeImageDigest,
          expectedAfterReadbackDigest: targetStateDigest, receiptDigest,
          historyRevision, status: 'VERIFIED' });
        current.historyRevision = historyRevision;
        current.headTransactionId = headTransactionId;
        current.undoAvailable = headTransactionId !== null;
        current.redoAvailable = direction === 'UNDO';
        state.objects[body.worldRef][objectRef].objectRevision =
          revision(state.objects[body.worldRef][objectRef].objectRevision);
      }
      state.transactions[body.worldRef][body.transactionId] = { status: 'VERIFIED',
        worldRef: body.worldRef, transactionId: body.transactionId,
        authorRef: proof.authorRef, sessionRef: body.sessionRef,
        affectedObjectRefs: refs, positions: prepared.protectedPositions,
        operationDigest: historyOperationDigest,
        beforeImageDigest: prepared.beforeImageDigest,
        afterReadbackDigest: targetStateDigest, receiptDigest,
        originTransactionId: body.historyTransactionId,
        transactionPayloadDigest: prepared.transactionPayloadDigest,
        receipt: verified };
      row.status = 'VERIFIED';
      state.replay[`${body.sessionRef}\u0000${operation}\u0000${body.requestId}`] = {
        digest: requestDigest, authorRef: proof.authorRef,
        response: envelope(body, verified) };
    });
    await this.#publishEvent('HistoryPositionChanged', operation, body,
      verified, 'history-position', { requiredAuthorRef: proof.authorRef,
        initiatorOnly: true });
    for (const objectRef of refs) {
      const current = this.store.snapshot.authorHistory[body.worldRef][objectRef][proof.authorRef];
      await this.#publishEvent('HistoryInventoryChanged', 'HistoryQuery', body,
        { worldRef: body.worldRef, objectRef, ...current }, `history:${objectRef}`,
        { requiredAuthorRef: proof.authorRef, initiatorOnly: true,
          authorizationRequest: { contractVersion: VERSION, actorRef: body.actorRef,
            sessionRef: body.sessionRef, requestId: `${body.requestId}:history:${objectRef}`,
            authorizationRef: body.authorizationRef, worldRef: body.worldRef,
            objectRef, expectedHistoryRevision: current.historyRevision } });
    }
    return envelope(body, verified);
  }
  async #inventory(body) {
    if (!this.adapters.length) throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    const groups = [];
    for (const entry of this.adapters) {
      this.#checkAdapterCompatibility(entry.port);
      const request = {
        contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:discover:${entry.adapterId}`,
        authorizationRef: body.authorizationRef, adapterId: entry.adapterId };
      const answer = await entry.port?.call?.('DiscoverConnections', request);
      if (!validAdapterAnswer(answer, request) || !validConnectionInventory(answer.result))
        throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      if (answer.result.connections.some(row => row.adapterId !== entry.adapterId))
        throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      groups.push(answer.result);
    }
    const connections = groups.flatMap(group => group.connections).sort((a, b) =>
      compareUtf16(a.adapterId, b.adapterId) || compareUtf16(a.connectionRef, b.connectionRef) ||
      compareUtf16(a.worldRef, b.worldRef));
    if (new Set(connections.map(row => JSON.stringify([row.connectionRef, row.worldRef]))).size !==
        connections.length) throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    const capabilityRevision = groups.length === 1 ? groups[0].capabilityRevision :
      identity(groups.map(group => group.capabilityRevision));
    return { capabilityRevision, connections };
  }
  async #bind(body, connectionRef, worldRef) {
    for (const entry of this.adapters) {
      this.#checkAdapterCompatibility(entry.port);
      const listRequest = {
        contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:list:${entry.adapterId}`,
        authorizationRef: body.authorizationRef, connectionRef };
      const listed = await entry.port?.call?.('ListWorlds', listRequest);
      if (missingConnection(listed, listRequest)) continue;
      if (!validAdapterAnswer(listed, listRequest) || !validConnectionInventory(listed.result))
        throw issue('CONNECTION_UNAUTHORIZED', 'validate', 'POLICY_UNAVAILABLE');
      if (listed.result.connections.some(row => row.adapterId !== entry.adapterId ||
          row.connectionRef !== connectionRef))
        throw issue('CONNECTION_UNAUTHORIZED', 'validate', 'POLICY_UNAVAILABLE');
      const descriptor = listed.result.connections.find(row =>
        row.connectionRef === connectionRef && row.worldRef === worldRef);
      if (!descriptor) continue;
      if (descriptor.payloadVersion !== '0.2.0')
        throw issue('PAYLOAD_VERSION_MISMATCH', 'validate', 'PAYLOAD_CHANGED');
      const bindRequest = {
        contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:bind`,
        authorizationRef: body.authorizationRef, worldRef, connectionRef,
        expectedCapabilityRevision: descriptor.capabilityRevision,
      };
      const connected = await entry.port.call('AuthorizeBinding', bindRequest);
      if (!validAdapterAnswer(connected, bindRequest) ||
          !validBindingReceipt(connected.result) ||
          connected.result.worldRef !== worldRef ||
          connected?.result?.connectionRef !== connectionRef ||
          connected?.result?.payloadVersion !== '0.2.0' ||
          connected?.result?.binding?.actorRef !== body.actorRef ||
          connected?.result?.binding?.worldRef !== worldRef ||
          connected.result.capabilities.worldRef !== worldRef ||
          connected.result.capabilities.providerRef !== entry.adapterId ||
          connected.result.capabilities.capabilityRevision !== descriptor.capabilityRevision)
        throw issue('CONNECTION_UNAUTHORIZED', 'validate', 'POLICY_UNAVAILABLE');
      return { adapterId: entry.adapterId, connectionRef, worldRef,
        payloadDigest: connected.result.payloadDigest,
        capabilityRevision: descriptor.capabilityRevision,
        recoveryGuarantee: connected.result.capabilities?.recoveryGuarantee ?? null };
    }
    throw issue('CONNECTION_NOT_FOUND', 'validate', 'SCOPE_DENIED');
  }
  async call(operation, raw) {
    let body;
    try {
      body = raw instanceof Uint8Array || typeof raw === 'string' ?
        admitRequest(VERSION, operation, Buffer.from(raw)) :
        validateRequest(VERSION, operation, raw);
      const proof = await this.authority?.verify?.(body, operation);
      if (!proof?.current || proof.actorRef !== body.actorRef ||
          proof.sessionRef !== body.sessionRef || proof.authorizationRef !== body.authorizationRef ||
          !proof.allowedActions?.includes(operation))
        throw issue('AUTHORIZATION_REVOKED', 'authorize', 'GRANT_REVOKED');
      await this.ready;
      if (!this.store) throw issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      if (this.store.unavailable) {
        this.storageState = 'UNAVAILABLE';
        throw issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      }
      if (this.store.snapshot.sessions[body.sessionRef]?.activeWorldRef === body.worldRef)
        await this.#invalidateInspections(body.worldRef, proof.currentWorldRevision);
      validateBoundRequest(VERSION, operation, body);
      const replayKey = `${body.sessionRef}\u0000${operation}\u0000${body.requestId}`;
      const prior = this.store.snapshot.replay[replayKey];
      const digest = identity(body);
      if (prior) {
        if (prior.digest !== digest) throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
        if (authorScopedReplay.has(operation) &&
            (typeof proof.authorRef !== 'string' || !proof.authorRef ||
             prior.authorRef !== proof.authorRef))
          throw issue('PERMISSION_DENIED', 'authorize', 'OWNERSHIP_VIOLATION');
        if (operation === 'InspectObject' &&
            (prior.inspectionInvalidated ||
              prior.response?.result?.source === 'INSPECTED' &&
              prior.response.result.worldRevision !== proof.currentWorldRevision))
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        if (operation === 'InspectPlacementRegion') {
          const recorded = this.store.snapshot.placementInspections?.[replayKey];
          if (!recorded || recorded.status !== 'RECORDED' ||
              recorded.worldRevision !== proof.currentWorldRevision ||
              recorded.settingsRevision !==
                this.store.snapshot.placementSettings?.[body.worldRef]?.settingsRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          if (Array.isArray(prior.response?.result?.choice?.candidatePlayerNames) &&
              !proof.allowedActions?.includes('INSPECT'))
            throw issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
        }
        return structuredClone(prior.response);
      }
      if (operation === 'InspectPlacementRegion')
        return await this.#inspectPlacementRegion(body, proof, replayKey, digest);
      if (operation === 'ApplyRecoverableCommit') {
        try { return await this.#apply(body, proof, replayKey, digest); }
        catch (error) {
          const pending = this.store.snapshot.pending[body.transactionId];
          if (pending?.digest === digest && ['APPLYING', 'APPLIED_PENDING_READBACK',
            'RECOVERY_PENDING', 'VERIFIED_PENDING_HISTORY'].includes(pending.status) &&
            (!error.publicError || error.publicError.mutationState === 'NONE'))
            throw uncertain(body.transactionId);
          throw error;
        }
      }
      if (operation === 'Readback')
        return await this.#readback(body, proof, replayKey, digest);
      if (operation === 'Undo' || operation === 'Redo') {
        try { return await this.#historyAction(operation, body, proof); }
        catch (error) {
          const pending = this.store.snapshot.pending[body.transactionId];
          if (pending?.digest === digest && ['HISTORY_APPLYING',
            'HISTORY_APPLIED_PENDING_READBACK', 'HISTORY_RECOVERY_PENDING'].includes(pending.status) &&
              (!error.publicError || error.publicError.mutationState === 'NONE'))
            throw uncertain(body.transactionId);
          throw error;
        }
      }
      let result;
      if (operation === 'ListWorldConnections') {
        result = await this.#inventory(body);
        const inventoryKey = `${body.actorRef}\u0000${body.sessionRef}\u0000${body.authorizationRef}`;
        const previous = this.store.snapshot.connectionInventories[inventoryKey];
        const changed = previous && canonicalize(previous) !== canonicalize(result);
        await this.store.commit(state => {
          state.connectionInventories[inventoryKey] = result;
          if (body.expectedCapabilityRevision === result.capabilityRevision)
            state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
        if (changed)
          await this.#publishEvent('WorldConnectionInventoryChanged',
            'ListWorldConnections', body, result, 'connection-inventory',
            { initiatorOnly: true,
              deliveryWorldRef: this.store.snapshot.sessions[body.sessionRef]?.activeWorldRef ??
                body.worldRef });
        if (body.expectedCapabilityRevision !== result.capabilityRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
      } else if (operation === 'SelectWorldConnection') {
        const old = this.store.snapshot.sessions[body.sessionRef];
        const oldBinding = this.store.snapshot.bindings[body.sessionRef];
        if (body.expectedRevision !== (old?.sessionRevision ?? '0'))
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        if (old?.activeWorldRef && old.activeWorldRef !== body.worldRef)
          throw issue('TRANSACTION_CONFLICT', 'validate', 'SCOPE_DENIED');
        const binding = await this.#bind(body, body.connectionRef, body.worldRef);
        result = { currentSession: body.sessionRef, activeWorldRef: body.worldRef,
          orderedSelectedObjectRefs: old?.orderedSelectedObjectRefs ?? [],
          sessionRevision: revision(old?.sessionRevision),
          selectionRevision: old?.selectionRevision ?? '0' };
        await this.store.commit(state => {
          if ((state.sessions[body.sessionRef]?.sessionRevision ?? '0') !== body.expectedRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.sessions[body.sessionRef] = result;
          state.bindings ??= Object.create(null);
          state.bindings[body.sessionRef] = binding;
          state.placementSettings ??= Object.create(null);
          if (!Object.hasOwn(state.placementSettings, body.worldRef))
          state.placementSettings[body.worldRef] = { worldRef: body.worldRef,
            stored: { 'placement.frontGapCells': 2, 'placement.forwardSearchCells': 16,
              'placement.lateralSearchCells': 8, 'placement.verticalSearchCells': 4 },
            settingsRevision: revision() };
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
        if (old?.activeWorldRef !== body.worldRef ||
            oldBinding?.connectionRef !== binding.connectionRef)
          await this.#publishEvent('WorldConnectionSelectionChanged',
            'SelectWorldConnection', body, result, 'connection-selected',
            { initiatorOnly: true });
      } else if (operation === 'SwitchWorldConnection') {
        const old = this.store.snapshot.sessions[body.sessionRef];
        if (!old || old.activeWorldRef !== body.fromWorldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        if (old.sessionRevision !== body.expectedRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        if (Object.values(this.store.snapshot.pending).some(tx =>
            tx.worldRef === body.fromWorldRef &&
            !['VERIFIED', 'ROLLED_BACK'].includes(tx.status)))
          throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
        const binding = await this.#bind(body, body.toConnectionRef, body.toWorldRef);
        result = { currentSession: body.sessionRef, activeWorldRef: body.toWorldRef,
          orderedSelectedObjectRefs: body.toWorldRef === body.fromWorldRef ?
            old.orderedSelectedObjectRefs : [],
          sessionRevision: revision(old.sessionRevision),
          selectionRevision: body.toWorldRef === body.fromWorldRef ?
            old.selectionRevision : revision(old.selectionRevision) };
        await this.store.commit(state => {
          if (state.sessions[body.sessionRef]?.sessionRevision !== body.expectedRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.sessions[body.sessionRef] = result;
          state.bindings[body.sessionRef] = binding;
          state.placementSettings ??= Object.create(null);
          if (!Object.hasOwn(state.placementSettings, body.toWorldRef))
          state.placementSettings[body.toWorldRef] = { worldRef: body.toWorldRef,
            stored: { 'placement.frontGapCells': 2, 'placement.forwardSearchCells': 16,
              'placement.lateralSearchCells': 8, 'placement.verticalSearchCells': 4 },
            settingsRevision: revision() };
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
        if (body.toWorldRef !== body.fromWorldRef)
          await this.#publishEvent('ActiveWorldChanged',
            'SwitchWorldConnection', body, result, 'active-world',
            { initiatorOnly: true, deliveryWorldRef: body.toWorldRef });
      } else if (operation === 'SetObjectSelection') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        if (!Array.isArray(body.objectRefs) || body.objectRefs.some(x => typeof x !== 'string' || !x))
          throw issue('INVALID_SELECTION', 'validate', 'INVALID_SHAPE');
        if (new Set(body.objectRefs).size !== body.objectRefs.length)
          throw issue('DUPLICATE_OBJECT_REF', 'validate', 'INVALID_SHAPE');
        for (const ref of body.objectRefs) {
          if (!this.store.snapshot.objects[body.worldRef]?.[ref])
            throw issue('OBJECT_NOT_FOUND', 'validate', 'SCOPE_DENIED');
        }
        if (context.selectionRevision !== body.expectedSelectionRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        result = { sessionRef: body.sessionRef, worldRef: body.worldRef,
          selectedObjectRefs: [...body.objectRefs], selectionRevision: revision(context.selectionRevision) };
        await this.store.commit(state => {
          const current = state.sessions[body.sessionRef];
          if (current.selectionRevision !== body.expectedSelectionRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          current.orderedSelectedObjectRefs = [...body.objectRefs];
          current.selectionRevision = result.selectionRevision;
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
        await this.#publishEvent('ActiveObjectSelectionReplaced',
          'SetObjectSelection', body, result, 'selection-replaced',
          { initiatorOnly: true });
      } else if (operation === 'ListObjects') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const registryRevision = this.store.snapshot.registryRevisions[body.worldRef] ?? '0';
        if (body.expectedRevision !== null && body.expectedRevision !== registryRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        result = { worldRef: body.worldRef, registryRevision,
          objects: Object.values(this.store.snapshot.objects[body.worldRef] ?? {}).sort((a, b) =>
            a.creationSequence - b.creationSequence ||
            (a.objectRef < b.objectRef ? -1 : a.objectRef > b.objectRef ? 1 : 0)) };
        // Current inventory is a coherent durable snapshot. A read does not
        // advance the registry or persist replay state.
        const released = await this.authority.verify(body, operation);
        if (!released?.current || released.actorRef !== body.actorRef ||
            released.sessionRef !== body.sessionRef ||
            released.authorizationRef !== body.authorizationRef ||
            !released.allowedActions?.includes(operation))
          throw issue('AUTHORIZATION_REVOKED', 'authorize', 'GRANT_REVOKED');
      } else if (operation === 'NameObject' || operation === 'RenameObject') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const object = this.store.snapshot.objects[body.worldRef]?.[body.objectRef];
        if (!object) throw issue('OBJECT_NOT_FOUND', 'validate', 'SCOPE_DENIED');
        const { displayName, comparisonKey } = normalizedName(body.name);
        if (Object.entries(this.store.snapshot.names[body.worldRef] ?? {})
          .some(([ref, key]) => ref !== body.objectRef && key === comparisonKey))
          throw issue('OBJECT_NAME_CONFLICT', 'validate', 'NAME_KEY_EXISTS');
        if (object.objectRevision !== body.expectedRevision ||
            (this.store.snapshot.registryRevisions[body.worldRef] ?? '0') !== body.expectedRegistryRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        if (operation === 'NameObject' && object.displayName !== null)
          throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
        if (operation === 'RenameObject' && object.displayName === null)
          throw issue('INVALID_NAME', 'validate', 'NAME_INVISIBLE_OR_EMPTY');
        if (operation === 'RenameObject' && object.displayName === displayName &&
            this.store.snapshot.names[body.worldRef]?.[body.objectRef] === comparisonKey) {
          result = { worldRef: body.worldRef, objectRef: body.objectRef,
            displayName, comparisonKey, nameRevision: object.nameRevision,
            objectRevision: object.objectRevision,
            registryRevision: body.expectedRegistryRevision };
          await this.store.commit(state => {
            if (state.objects[body.worldRef]?.[body.objectRef]?.objectRevision !==
                body.expectedRevision ||
                state.registryRevisions[body.worldRef] !== body.expectedRegistryRevision)
              throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
            state.replay[replayKey] = { digest, response: envelope(body, result) };
          });
          return envelope(body, result);
        }
        result = { worldRef: body.worldRef, objectRef: body.objectRef,
          displayName, comparisonKey, nameRevision: revision(object.nameRevision),
          objectRevision: revision(object.objectRevision),
          registryRevision: revision(body.expectedRegistryRevision) };
        await this.store.commit(state => {
          const current = state.objects[body.worldRef]?.[body.objectRef];
          if (!current || current.objectRevision !== body.expectedRevision ||
              (state.registryRevisions[body.worldRef] ?? '0') !== body.expectedRegistryRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.names[body.worldRef] ??= Object.create(null);
          if (Object.entries(state.names[body.worldRef]).some(([ref, key]) =>
              ref !== body.objectRef && key === comparisonKey))
            throw issue('OBJECT_NAME_CONFLICT', 'validate', 'NAME_KEY_EXISTS');
          current.displayName = displayName;
          current.nameRevision = result.nameRevision;
          current.objectRevision = result.objectRevision;
          state.names[body.worldRef][body.objectRef] = comparisonKey;
          state.registryRevisions[body.worldRef] = result.registryRevision;
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
        await this.#publishEvent('ObjectNameChanged', operation, body,
          result, 'name-changed', { initiatorOnly: true });
        await this.#publishObjectInventoryChanged(body);
      } else if (operation === 'AnalyzeAffectedObjects') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const positions = operationPositions(body.operations, body.worldRef, body.operationDigest);
        if (proof.currentWorldRevision !== body.expectedRevision ||
            (this.store.snapshot.registryRevisions[body.worldRef] ?? '0') !== body.expectedRegistryRevision ||
            context.selectionRevision !== body.expectedSelectionRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        const positionKeys = new Set(positions.map(position => position.join(',')));
        const affectedObjectRefs = Object.entries(this.store.snapshot.footprints[body.worldRef] ?? {})
          .filter(([, footprint]) => footprint.some(position => positionKeys.has(position.join(','))))
          .map(([ref]) => ref).sort(compareUtf16);
        if (affectedObjectRefs.some(ref => !this.store.snapshot.objects[body.worldRef]?.[ref]))
          throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
        result = { contractVersion: 'canvas/v2', worldRef: body.worldRef,
          worldRevision: body.expectedRevision,
          registryRevision: body.expectedRegistryRevision,
          selectionRevision: body.expectedSelectionRevision,
          operationDigest: body.operationDigest,
          orderedSelectedRefs: [...context.orderedSelectedObjectRefs], affectedObjectRefs };
        await this.store.commit(state => {
          if ((state.registryRevisions[body.worldRef] ?? '0') !== body.expectedRegistryRevision ||
              state.sessions[body.sessionRef]?.selectionRevision !== body.expectedSelectionRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.analyses[body.worldRef] ??= Object.create(null);
          const existing = state.analyses[body.worldRef][body.transactionId];
          if (existing && existing.digest !== projectionDigest('affected-analysis', result))
            throw issue('TRANSACTION_CONFLICT', 'validate', 'PAYLOAD_CHANGED');
          state.analyses[body.worldRef][body.transactionId] = {
            revision: existing?.revision ?? '1', digest: projectionDigest('affected-analysis', result),
            result, positions };
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
        await this.#publishEvent('AffectedObjectAnalysisReady',
          'AnalyzeAffectedObjects', body, result, 'analysis-ready',
          { initiatorOnly: true });
      } else if (operation === 'DecideAffectedObjectNotification') {
        const analysis = this.store.snapshot.analyses[body.worldRef]?.[body.transactionId];
        if (!analysis || analysis.digest !== body.analysisDigest ||
            analysis.revision !== body.analysisRevision ||
            projectionDigest('affected-analysis', body.analysis) !== body.analysisDigest ||
            canonicalize(analysis.result) !== canonicalize(body.analysis))
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        if (proof.currentWorldRevision !== analysis.result.worldRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        const previous = this.store.snapshot.decisions[body.worldRef]?.[body.transactionId];
        if ((previous?.decisionRevision ?? null) !== body.expectedDecisionRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        const selected = new Set(analysis.result.orderedSelectedRefs);
        const others = analysis.result.affectedObjectRefs.filter(ref => !selected.has(ref));
        if (body.decision === 'NO_NOTIFICATION' && others.length ||
            body.decision === 'BLOCK_AND_NOTIFY' && !others.length ||
            !['NO_NOTIFICATION', 'BLOCK_AND_NOTIFY', 'CONTINUE', 'CANCEL'].includes(body.decision))
          throw issue('OTHER_OBJECTS_AFFECTED', 'validate', 'POLICY_UNAVAILABLE');
        if (body.decision === 'CONTINUE' && (!previous ||
            previous.decisionKind !== 'BLOCK_AND_NOTIFY' ||
            proof.confirmedAffectedDecision?.transactionId !== body.transactionId ||
            proof.confirmedAffectedDecision?.analysisDigest !== body.analysisDigest ||
            canonicalize(proof.confirmedAffectedDecision?.affectedObjectRefs) !==
              canonicalize(analysis.result.affectedObjectRefs)))
          throw issue('PERMISSION_DENIED', 'authorize', 'SCOPE_DENIED');
        result = { transactionId: body.transactionId, analysisDigest: body.analysisDigest,
          decisionRevision: revision(previous?.decisionRevision), decisionKind: body.decision,
          affectedObjectRefs: analysis.result.affectedObjectRefs,
          orderedSelectedRefs: analysis.result.orderedSelectedRefs };
        await this.store.commit(state => {
          if (state.analyses[body.worldRef]?.[body.transactionId]?.digest !== body.analysisDigest)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.decisions[body.worldRef] ??= Object.create(null);
          if ((state.decisions[body.worldRef][body.transactionId]?.decisionRevision ?? null) !==
              body.expectedDecisionRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.decisions[body.worldRef][body.transactionId] = result;
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
        if (body.decision === 'BLOCK_AND_NOTIFY')
          await this.#publishEvent('AffectedObjectNotificationRequired',
            'DecideAffectedObjectNotification', body, result, 'notification-required',
            { initiatorOnly: true });
      } else if (operation === 'InspectObject') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const object = this.store.snapshot.objects[body.worldRef]?.[body.objectRef];
        if (!object) throw issue('OBJECT_NOT_FOUND', 'validate', 'SCOPE_DENIED');
        if (object.objectRevision !== body.expectedRevision ||
            typeof proof.currentWorldRevision !== 'string')
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        const bound = this.store.snapshot.bindings[body.sessionRef];
        const adapter = this.adapters.find(entry => entry.adapterId === bound?.adapterId)?.port;
        if (!adapter) throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
        const adapterRequest = {
          contractVersion: ADAPTER_VERSION, actorRef: this.serviceActorRef,
          sessionRef: body.sessionRef, requestId: `${body.requestId}:inspect`,
          authorizationRef: body.authorizationRef, worldRef: body.worldRef,
          expectedWorldRevision: proof.currentWorldRevision, sampledBounds: body.sampledBounds };
        const answer = await adapter.call('InspectWorld', adapterRequest);
        if (answer?.error) throw inspectionError(answer, adapterRequest);
        if (!validAdapterAnswer(answer, adapterRequest) ||
            !validInspectionFacts(answer.result) ||
            answer.result.worldRef !== body.worldRef ||
            answer?.result?.objectRef !== body.objectRef ||
            answer?.result?.objectRevision !== body.expectedRevision ||
            answer?.result?.worldRevision !== proof.currentWorldRevision ||
            canonicalize(answer?.result?.sampledBounds) !== canonicalize(body.sampledBounds))
          throw issue('INSPECTION_FAILED', 'validate', 'REQUIRED_FACT_UNKNOWN');
        result = answer.result;
        await this.store.commit(state => {
          if (state.sessions[body.sessionRef]?.activeWorldRef !== body.worldRef ||
              state.objects[body.worldRef]?.[body.objectRef]?.objectRevision !== body.expectedRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.replay[replayKey] = { digest, response: envelope(body, result),
            inspectionRequest: body, inspectionAuthorRef: proof.authorRef ?? null,
            inspectionInvalidated: false };
        });
      } else if (operation === 'HistoryQuery') {
        if (typeof proof.authorRef !== 'string' || !proof.authorRef)
          throw issue('PERMISSION_DENIED', 'authorize', 'IDENTITY_UNVERIFIED');
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const object = this.store.snapshot.objects[body.worldRef]?.[body.objectRef];
        if (!object) throw issue('OBJECT_NOT_FOUND', 'validate', 'SCOPE_DENIED');
        const history = this.store.snapshot.authorHistory[body.worldRef]?.[body.objectRef]?.[proof.authorRef] ??
          { historyRevision: '0', headTransactionId: null, entries: [],
            undoAvailable: false, redoAvailable: false };
        if (history.historyRevision !== body.expectedHistoryRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        result = { worldRef: body.worldRef, objectRef: body.objectRef, ...history };
        await this.store.commit(state => {
          if (state.sessions[body.sessionRef]?.activeWorldRef !== body.worldRef ||
              !state.objects[body.worldRef]?.[body.objectRef] ||
              (state.authorHistory[body.worldRef]?.[body.objectRef]?.[proof.authorRef]?.historyRevision ?? '0') !==
                body.expectedHistoryRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.replay[replayKey] = { digest, authorRef: proof.authorRef,
            response: envelope(body, result) };
        });
      } else if (operation === 'CreateObject') {
        if (proof.domainOwner !== 'hanaworlds-canvas')
          throw issue('PERMISSION_DENIED', 'authorize', 'OWNERSHIP_VIOLATION');
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const transaction = this.store.snapshot.transactions[body.worldRef]?.[body.transactionId];
        if (transaction?.status !== 'VERIFIED' ||
            transaction.authorRef !== proof.authorRef ||
            transaction.sessionRef !== body.sessionRef)
          throw issue('PERMISSION_DENIED', 'authorize', 'OWNERSHIP_VIOLATION');
        if (transaction.worldRef !== body.worldRef ||
            transaction.receiptDigest !== body.verifiedReceiptDigest ||
            transaction.reservedObjectRef !== body.objectRef)
          throw issue('OBJECT_SCOPE_MISMATCH', 'validate', 'SCOPE_DENIED');
        if ((this.store.snapshot.registryRevisions[body.worldRef] ?? '0') !== body.expectedRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        const registered = this.store.snapshot.objects[body.worldRef]?.[body.objectRef];
        result = registered ?? { worldRef: body.worldRef, objectRef: body.objectRef,
          objectRevision: '1', displayName: null, nameRevision: null,
          creationSequence: Object.values(this.store.snapshot.objects[body.worldRef] ?? {})
            .reduce((max, row) => Math.max(max, row.creationSequence), 0) + 1,
          status: 'READY' };
        await this.store.commit(state => {
          state.objects[body.worldRef] ??= Object.create(null);
          if ((state.registryRevisions[body.worldRef] ?? '0') !== body.expectedRevision ||
              state.objects[body.worldRef][body.objectRef] &&
                canonicalize(state.objects[body.worldRef][body.objectRef]) !== canonicalize(result))
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          if (!state.objects[body.worldRef][body.objectRef]) {
            state.objects[body.worldRef][body.objectRef] = result;
            state.footprints[body.worldRef] ??= Object.create(null);
            state.footprints[body.worldRef][body.objectRef] = transaction.positions;
            state.registryRevisions[body.worldRef] = revision(body.expectedRevision);
          }
          state.replay[replayKey] = { digest, authorRef: proof.authorRef,
            response: envelope(body, result) };
        });
        if (!registered)
          await this.#publishObjectInventoryChanged(body);
      }
      return envelope(body, result);
    } catch (error) {
      if (this.store?.unavailable) this.storageState = 'UNAVAILABLE';
      const publicError = error.publicError ??
        issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE').publicError;
      return operation === 'InspectPlacementRegion' ?
        placementEnvelope(body, null, publicError, error.unavailableSettings ?? null) :
        envelope(body, null, publicError);
    }
  }
}

export const name = 'hanaworlds-canvas';
export const inject = [];
export function apply(ctx, config = {}) {
  const adapter = ctx.get?.('hanaworldsWorldAdapterV4');
  const adapters = adapter && typeof config.adapterId === 'string' && config.adapterId ?
    [{ adapterId: config.adapterId, port: adapter }] : [];
  const service = new CanvasV4({ store: null, adapters,
    authority: ctx.get?.('hanaworldsAuthority'),
    adminAuthority: ctx.get?.('hanaworldsAdminAuthority') });
  ctx.provide?.('hanaworldsCanvasV4', service);
  service.storageState = 'INITIALIZING';
  service.ready = (async () => {
    try {
      const directory = await ctx.get?.('hanaworldsProfileStorage')?.canvasDirectory?.();
      if (directory) {
        service.store = await CanvasStore.open(directory);
        service.storageState = 'READY';
      } else service.storageState = 'UNAVAILABLE';
    } catch { service.storageState = 'UNAVAILABLE'; }
  })();
}
export default { name, inject, apply };
