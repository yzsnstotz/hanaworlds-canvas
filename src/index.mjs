import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { CodePointSetData, ComposingNormalizer } from 'icu';
import { CanvasStore } from './store.mjs';
import { readJSON } from './strict-json.mjs';
export { CanvasStore };

const VERSION = 'canvas/v2';
const generic = ['contractVersion', 'actorRef', 'sessionRef', 'requestId', 'authorizationRef', 'worldRef'];
const fields = {
  ListWorldConnections: [...generic, 'expectedCapabilityRevision'],
  SelectWorldConnection: [...generic, 'connectionRef', 'expectedRevision'],
  SwitchWorldConnection: [...generic, 'fromWorldRef', 'toConnectionRef', 'toWorldRef', 'expectedRevision'],
  SetObjectSelection: [...generic, 'objectRefs', 'expectedSelectionRevision'],
  ListObjects: [...generic, 'expectedRevision'],
  NameObject: [...generic, 'objectRef', 'name', 'expectedRevision', 'expectedRegistryRevision'],
  RenameObject: [...generic, 'objectRef', 'name', 'expectedRevision', 'expectedRegistryRevision'],
  AnalyzeAffectedObjects: [...generic, 'transactionId', 'operations', 'operationDigest',
    'expectedRevision', 'expectedRegistryRevision', 'expectedSelectionRevision'],
  DecideAffectedObjectNotification: [...generic, 'transactionId', 'analysis',
    'analysisDigest', 'analysisRevision', 'decision', 'expectedDecisionRevision'],
  InspectObject: [...generic, 'objectRef', 'expectedRevision', 'sampledBounds'],
  HistoryQuery: [...generic, 'objectRef', 'expectedHistoryRevision'],
  CreateObject: [...generic, 'objectRef', 'transactionId', 'verifiedReceiptDigest', 'expectedRevision'],
};
const allowed = new Set(Object.keys(fields));
const refFields = new Set(['connectionRef', 'fromWorldRef', 'toConnectionRef', 'toWorldRef',
  'objectRef', 'transactionId']);
const revisionFields = new Set(['expectedCapabilityRevision', 'expectedRevision',
  'expectedRegistryRevision', 'expectedSelectionRevision', 'analysisRevision',
  'expectedHistoryRevision']);
const digestFields = new Set(['operationDigest', 'analysisDigest', 'verifiedReceiptDigest']);
function validRequest(operation, body) {
  if (!allowed.has(operation)) throw issue('UNKNOWN_ACTION', 'decode', 'INVALID_SHAPE');
  try { body = readJSON(body); }
  catch (error) { throw issue(error.code, 'decode', error.reason); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  if (body.contractVersion !== VERSION) throw issue('UNSUPPORTED_VERSION', 'decode', 'VERSION_UNSUPPORTED');
  if (Object.keys(body).some(key => !fields[operation].includes(key))) throw issue('UNKNOWN_REQUIRED_FIELD', 'decode', 'UNKNOWN_FIELD');
  if (fields[operation].some(key => !Object.hasOwn(body, key))) throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  for (const key of generic) if (typeof body[key] !== 'string' || !body[key]) throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  for (const [key, value] of Object.entries(body)) {
    if ((refFields.has(key) || revisionFields.has(key)) &&
        (typeof value !== 'string' || !value))
      throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
    if (digestFields.has(key) && (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)))
      throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  }
  if (Object.hasOwn(body, 'expectedDecisionRevision') &&
      body.expectedDecisionRevision !== null &&
      (typeof body.expectedDecisionRevision !== 'string' || !body.expectedDecisionRevision))
    throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  if (Object.hasOwn(body, 'name') && typeof body.name !== 'string')
    throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  if (Object.hasOwn(body, 'objectRefs') &&
      (!Array.isArray(body.objectRefs) || body.objectRefs.some(ref => typeof ref !== 'string' || !ref)))
    throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  if (Object.hasOwn(body, 'decision') && typeof body.decision !== 'string')
    throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  if (Object.hasOwn(body, 'sampledBounds') &&
      (!body.sampledBounds || typeof body.sampledBounds !== 'object' ||
       !Array.isArray(body.sampledBounds.min) || !Array.isArray(body.sampledBounds.max) ||
       body.sampledBounds.min.length !== 3 || body.sampledBounds.max.length !== 3 ||
       [...body.sampledBounds.min, ...body.sampledBounds.max].some(x => !Number.isSafeInteger(x))))
    throw issue('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  return body;
}
function issue(code, phase, reason, transactionRef = null) {
  const error = new Error(code);
  error.publicError = { code, phase, retryability: phase === 'authorize' ? 'AFTER_NEW_AUTH' :
    phase === 'validate' ? 'AFTER_NEW_FACTS' : 'NEVER', mutationState: 'NONE',
    transactionRef, causeCode: null, reason };
  return error;
}
function envelope(body, result, error = null) {
  return { contractVersion: VERSION, requestId: body?.requestId ?? null, result, error };
}
function revision(value) { return String(Number(value ?? '0') + 1); }
function identity(body) { return createHash('sha256').update(canonicalize(body)).digest('hex'); }
function projectionDigest(kind, value) {
  return createHash('sha256').update(`HanaWorlds|contracts@0.1.0|${kind}\n${canonicalize(value)}`).digest('hex');
}
function compareUtf16(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
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
    throw issue('NON_CANONICAL_AMBIGUITY', 'validate', 'PAYLOAD_CHANGED');
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

export class CanvasV2 {
  constructor({ store, adapter, adapters, authority }) {
    this.store = store;
    this.storageState = store ? 'READY' : 'UNAVAILABLE';
    this.ready = Promise.resolve();
    this.adapters = adapters ?? (adapter ? [{ adapterId: null, port: adapter }] : []);
    this.authority = authority;
  }
  status() {
    return { component: name, version: '0.1.0', canvasContract: VERSION,
      adapterContract: 'world-adapter/v2', storage: this.storageState,
      productReadiness: 'UNPROVEN' };
  }
  async #inventory(body) {
    if (!this.adapters.length) throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
    const groups = [];
    for (const entry of this.adapters) {
      const answer = await entry.port?.call?.('DiscoverConnections', {
        contractVersion: 'world-adapter/v2', actorRef: body.actorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:discover:${entry.adapterId}`,
        authorizationRef: body.authorizationRef, adapterId: entry.adapterId });
      if (answer?.error || !Array.isArray(answer?.result?.connections))
        throw issue(answer?.error?.code ?? 'ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      if (answer.result.connections.some(row => row.adapterId !== entry.adapterId))
        throw issue('ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      groups.push(answer.result);
    }
    const connections = groups.flatMap(group => group.connections).sort((a, b) =>
      compareUtf16(a.adapterId, b.adapterId) || compareUtf16(a.connectionRef, b.connectionRef) ||
      compareUtf16(a.worldRef, b.worldRef));
    const capabilityRevision = groups.length === 1 ? groups[0].capabilityRevision :
      identity(groups.map(group => group.capabilityRevision));
    return { capabilityRevision, connections };
  }
  async #bind(body, connectionRef, worldRef) {
    for (const entry of this.adapters) {
      const listed = await entry.port?.call?.('ListWorlds', {
        contractVersion: 'world-adapter/v2', actorRef: body.actorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:list:${entry.adapterId}`,
        authorizationRef: body.authorizationRef, connectionRef });
      if (listed?.error?.code === 'CONNECTION_NOT_FOUND') continue;
      if (listed?.error || !Array.isArray(listed?.result?.connections))
        throw issue(listed?.error?.code ?? 'ADAPTER_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      const descriptor = listed.result.connections.find(row =>
        row.connectionRef === connectionRef && row.worldRef === worldRef);
      if (!descriptor) continue;
      if (descriptor.payloadVersion !== '0.1.0')
        throw issue('PAYLOAD_VERSION_MISMATCH', 'validate', 'PAYLOAD_CHANGED');
      const connected = await entry.port.call('AuthorizeBinding', {
        contractVersion: 'world-adapter/v2', actorRef: body.actorRef,
        sessionRef: body.sessionRef, requestId: `${body.requestId}:bind`,
        authorizationRef: body.authorizationRef, worldRef, connectionRef,
        expectedCapabilityRevision: descriptor.capabilityRevision,
      });
      if (connected?.error || connected?.result?.worldRef !== worldRef ||
          connected?.result?.connectionRef !== connectionRef ||
          connected?.result?.payloadVersion !== '0.1.0' ||
          connected?.result?.binding?.actorRef !== body.actorRef ||
          connected?.result?.binding?.worldRef !== worldRef)
        throw issue(connected?.error?.code ?? 'CONNECTION_UNAUTHORIZED', 'validate', 'POLICY_UNAVAILABLE');
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
      body = validRequest(operation, raw);
      const proof = await this.authority?.verify?.(body, operation);
      if (!proof?.current || proof.actorRef !== body.actorRef ||
          proof.sessionRef !== body.sessionRef || proof.authorizationRef !== body.authorizationRef ||
          !proof.allowedActions?.includes(operation))
        throw issue('AUTHORIZATION_REVOKED', 'authorize', 'GRANT_REVOKED');
      await this.ready;
      if (!this.store) throw issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE');
      const replayKey = `${body.sessionRef}\u0000${operation}\u0000${body.requestId}`;
      const prior = this.store.snapshot.replay[replayKey];
      const digest = identity(body);
      if (prior) {
        if (prior.digest !== digest) throw issue('REPLAY_MISMATCH', 'replay', 'PAYLOAD_CHANGED');
        return structuredClone(prior.response);
      }
      let result;
      if (operation === 'ListWorldConnections') {
        result = await this.#inventory(body);
        if (body.expectedCapabilityRevision !== result.capabilityRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        await this.store.commit(state => { state.replay[replayKey] = { digest, response: envelope(body, result) }; });
      } else if (operation === 'SelectWorldConnection') {
        const old = this.store.snapshot.sessions[body.sessionRef];
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
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
      } else if (operation === 'SwitchWorldConnection') {
        const old = this.store.snapshot.sessions[body.sessionRef];
        if (!old || old.activeWorldRef !== body.fromWorldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        if (old.sessionRevision !== body.expectedRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        if (Object.values(this.store.snapshot.pending).some(tx =>
            tx.worldRef === body.fromWorldRef && tx.status !== 'VERIFIED'))
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
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
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
      } else if (operation === 'ListObjects') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const registryRevision = this.store.snapshot.registryRevisions[body.worldRef] ?? '0';
        if (body.expectedRevision !== registryRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        result = { worldRef: body.worldRef, registryRevision,
          objects: Object.values(this.store.snapshot.objects[body.worldRef] ?? {}).sort((a, b) =>
            a.creationSequence - b.creationSequence ||
            (a.objectRef < b.objectRef ? -1 : a.objectRef > b.objectRef ? 1 : 0)) };
        await this.store.commit(state => {
          if ((state.registryRevisions[body.worldRef] ?? '0') !== registryRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
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
        result = { contractVersion: VERSION, worldRef: body.worldRef,
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
        const answer = await adapter.call('InspectWorld', {
          contractVersion: 'world-adapter/v2', actorRef: body.actorRef,
          sessionRef: body.sessionRef, requestId: `${body.requestId}:inspect`,
          authorizationRef: body.authorizationRef, worldRef: body.worldRef,
          expectedWorldRevision: proof.currentWorldRevision, sampledBounds: body.sampledBounds });
        if (answer?.error || answer?.result?.source !== 'INSPECTED' ||
            answer?.result?.objectRef !== body.objectRef ||
            answer?.result?.objectRevision !== body.expectedRevision ||
            answer?.result?.worldRevision !== proof.currentWorldRevision ||
            canonicalize(answer?.result?.sampledBounds) !== canonicalize(body.sampledBounds))
          throw issue(answer?.error?.code ?? 'INSPECTION_FAILED', 'validate', 'REQUIRED_FACT_UNKNOWN');
        result = answer.result;
        await this.store.commit(state => {
          if (state.sessions[body.sessionRef]?.activeWorldRef !== body.worldRef ||
              state.objects[body.worldRef]?.[body.objectRef]?.objectRevision !== body.expectedRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
      } else if (operation === 'HistoryQuery') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const object = this.store.snapshot.objects[body.worldRef]?.[body.objectRef];
        if (!object) throw issue('OBJECT_NOT_FOUND', 'validate', 'SCOPE_DENIED');
        const history = this.store.snapshot.history[body.worldRef]?.[body.objectRef] ??
          { historyRevision: '0', headTransactionId: null, entries: [],
            undoAvailable: false, redoAvailable: false };
        if (history.historyRevision !== body.expectedHistoryRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        result = { worldRef: body.worldRef, objectRef: body.objectRef, ...history };
        await this.store.commit(state => {
          if (state.sessions[body.sessionRef]?.activeWorldRef !== body.worldRef ||
              !state.objects[body.worldRef]?.[body.objectRef] ||
              (state.history[body.worldRef]?.[body.objectRef]?.historyRevision ?? '0') !==
                body.expectedHistoryRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
      } else if (operation === 'CreateObject') {
        const context = this.store.snapshot.sessions[body.sessionRef];
        if (!context || context.activeWorldRef !== body.worldRef)
          throw issue('WORLD_NOT_BOUND', 'validate', 'SCOPE_DENIED');
        const transaction = this.store.snapshot.transactions[body.worldRef]?.[body.transactionId];
        if (transaction?.status !== 'VERIFIED' ||
            transaction.receiptDigest !== body.verifiedReceiptDigest ||
            transaction.reservedObjectRef !== body.objectRef)
          throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
        if ((this.store.snapshot.registryRevisions[body.worldRef] ?? '0') !== body.expectedRevision)
          throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
        if (this.store.snapshot.objects[body.worldRef]?.[body.objectRef])
          throw issue('TRANSACTION_CONFLICT', 'validate', 'POLICY_UNAVAILABLE');
        result = { worldRef: body.worldRef, objectRef: body.objectRef,
          objectRevision: '1', displayName: null, nameRevision: null,
          creationSequence: Object.values(this.store.snapshot.objects[body.worldRef] ?? {})
            .reduce((max, row) => Math.max(max, row.creationSequence), 0) + 1,
          status: 'READY' };
        await this.store.commit(state => {
          state.objects[body.worldRef] ??= Object.create(null);
          if (state.objects[body.worldRef][body.objectRef] ||
              (state.registryRevisions[body.worldRef] ?? '0') !== body.expectedRevision)
            throw issue('STALE_REVISION', 'validate', 'REVISION_CHANGED');
          state.objects[body.worldRef][body.objectRef] = result;
          state.footprints[body.worldRef] ??= Object.create(null);
          state.footprints[body.worldRef][body.objectRef] = transaction.positions;
          state.registryRevisions[body.worldRef] = revision(body.expectedRevision);
          state.replay[replayKey] = { digest, response: envelope(body, result) };
        });
      }
      return envelope(body, result);
    } catch (error) {
      return envelope(body, null, error.publicError ?? issue('CAPABILITY_UNAVAILABLE', 'validate', 'POLICY_UNAVAILABLE').publicError);
    }
  }
}

export const name = 'hanaworlds-canvas';
export const inject = [];
export function apply(ctx, config = {}) {
  const adapter = ctx.get?.('hanaworldsWorldAdapterV2');
  const adapters = adapter && typeof config.adapterId === 'string' && config.adapterId ?
    [{ adapterId: config.adapterId, port: adapter }] : [];
  const service = new CanvasV2({ store: null, adapters,
    authority: ctx.get?.('hanaworldsAuthority') });
  ctx.provide?.('hanaworldsCanvasV2', service);
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
