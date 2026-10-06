import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import canonicalize from 'canonicalize';
import { CanvasStore } from './store-v5.mjs';
import { admitRequest, validateRequest, validateResponse, validateBoundResponse,
  validateCurrentRequest, validateWorldSelection, validateCommitReadback,
  projectScopedPreparedTransaction, checkContractHandshake, contractHandshake,
  digestValue, requestDigest, publicError } from 'hanaworlds-contracts';

export { CanvasStore };
const WIRE = 'canvas/v5';
const ADAPTER = 'world-adapter/v6';
const hash = (kind, value) => digestValue(kind, value).sha256;
const stableHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rev = prefix => `${prefix}-${randomUUID()}`;
const same = (a, b) => canonicalize(a) === canonicalize(b);
const key = position => position.join(',');
function fail(code, reason = 'REVISION_CHANGED', phase = 'validate') {
  const error = new Error(code);
  error.publicError = { code, phase, retryability: 'AFTER_NEW_FACTS',
    mutationState: 'NONE', transactionRef: null, causeCode: null, reason };
  return error;
}
function answer(body, result, error = null) {
  return { contractVersion: WIRE, requestId: body.requestId, result, error };
}

/** Current local Canvas. Adapter is a public v6 port; it never decides history. */
export class CanvasV5 {
  constructor({ store, adapter, adapterId = 'hanaworlds-world-adapter' }) {
    checkContractHandshake(contractHandshake);
    this.store = store;
    this.adapter = adapter;
    this.adapterId = adapterId;
    this.ready = Promise.resolve();
    this.storageState = store ? 'READY' : 'UNAVAILABLE';
  }
  get contractHandshake() { return structuredClone(contractHandshake); }
  status() { return { component: 'hanaworlds-canvas', version: '0.3.0',
    canvasContract: WIRE, adapterContract: ADAPTER, storage: this.storageState,
    productReadiness: 'UNPROVEN' }; }
  current(sessionRef) { return this.store?.snapshot.sessions[sessionRef] ?? null; }
  async #adapter(operation, body) {
    if (!this.adapter?.call) throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    const response = await this.adapter.call(operation, body);
    validateBoundResponse(ADAPTER, operation, body, response);
    if (response.error) throw Object.assign(new Error(response.error.code),
      { publicError: response.error });
    return response.result;
  }
  #facts(body, operation) {
    const session = this.current(body.sessionRef);
    const replayKey = `${body.sessionRef}\0${operation}\0${body.requestId}`;
    const prior = this.store.snapshot.replay[replayKey] ?? null;
    return { replayKey, prior, facts: { sessionRef: body.sessionRef,
      currentContext: session?.localContext ?? null, currentTurnRevision: null,
      currentBriefDigest: null, requestState: prior ? 'COMPLETED' : 'ACTIVE',
      replay: prior ? prior.digest === requestDigest(WIRE, operation, body) ?
        'EXACT_REPLAY' : 'CONFLICT' : 'NEW',
      priorRequestDigest: prior?.digest ?? null } };
  }
  async #remember(replayKey, digest, response) {
    await this.store.commit(state => { state.replay[replayKey] = { digest, response }; });
    return response;
  }
  async #bound(operation, body) {
    const { replayKey, prior, facts } = this.#facts(body, operation);
    const admission = validateCurrentRequest(WIRE, operation, body, facts);
    if (prior) return { replayKey, prior, admission };
    const session = this.current(body.sessionRef);
    if (!session || session.activeWorldRef !== body.worldRef ||
        !same(session.localContext, body.localContext))
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    const connection = await this.#adapter('ReadLocalConnection', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:current-connection`,
      connectionRef: body.localContext.connectionRef });
    if (connection.worldRef !== body.worldRef ||
        connection.connectionIncarnationRef !== body.localContext.connectionIncarnationRef)
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    return { replayKey, prior, admission };
  }
  #positions(operations) {
    const positions = operations.effects.map(effect => effect.position);
    if (positions.length === 0 || new Set(positions.map(key)).size !== positions.length)
      throw fail('INVALID_OPERATIONS', 'PAYLOAD_CHANGED');
    return positions;
  }
  #affected(worldRef, positions) {
    const checked = new Set(positions.map(key));
    return Object.entries(this.store.snapshot.footprints[worldRef] ?? {})
      .filter(([, row]) => row.positions.some(position => checked.has(key(position))))
      .map(([objectRef]) => objectRef).sort();
  }
  async #analyze(body) {
    const { replayKey, prior, admission } = await this.#bound('AnalyzeAffectedObjects', body);
    if (prior) return prior.response;
    const session = this.current(body.sessionRef);
    if (body.expectedSelectionRevision !== session.selectionRevision ||
        body.expectedRegistryRevision !==
          (this.store.snapshot.registryRevisions[body.worldRef] ?? 'registry-0'))
      throw fail('STALE_REVISION');
    if (hash('operations', body.operations) !== body.operationDigest)
      throw fail('DIGEST_MISMATCH', 'PAYLOAD_CHANGED');
    const affectedObjectRefs = this.#affected(body.worldRef, this.#positions(body.operations));
    const analysis = { contractVersion: WIRE, worldRef: body.worldRef,
      worldRevision: body.expectedRevision,
      registryRevision: body.expectedRegistryRevision,
      selectionRevision: body.expectedSelectionRevision,
      operationDigest: body.operationDigest,
      orderedSelectedRefs: [...session.orderedSelectedObjectRefs], affectedObjectRefs };
    const response = validateResponse(WIRE, 'AnalyzeAffectedObjects', answer(body, analysis));
    await this.store.commit(state => {
      state.analyses[body.transactionId] = analysis;
      state.replay[replayKey] = { digest: admission.requestDigest, response };
    });
    return response;
  }
  async #read(body, positions, stateProfile, suffix) {
    const result = await this.#adapter('Readback', { contractVersion: ADAPTER,
      sessionRef: body.sessionRef, requestId: `${body.requestId}:${suffix}`,
      worldRef: body.worldRef, transactionId: body.transactionId,
      coveredPositions: positions, stateProfile, localContext: body.localContext });
    if (result.projection.worldRef !== body.worldRef ||
        !same(result.projection.coveredPositions, positions) ||
        !same(result.projection.records.map(record => record.position), positions) ||
        !same(result.projection.stateProfile, stateProfile) ||
        hash('readback', result.projection) !== result.readbackDigest)
      throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
    return result.projection;
  }
  async #apply(body) {
    const { replayKey, prior, admission } = await this.#bound('ApplyRecoverableCommit', body);
    if (prior) return prior.response;
    const analysis = this.store.snapshot.analyses[body.transactionId];
    if (!analysis || analysis.affectedObjectRefs.length ||
        analysis.worldRef !== body.worldRef || analysis.operationDigest !== body.operationDigest ||
        hash('affected-analysis', analysis) !== body.analysisDigest ||
        analysis.worldRevision !== body.expectedWorldRevision || body.decisionRevision !== null ||
        body.guarantee !== 'RECOVERABLE_VERIFIED' ||
        hash('operations', body.operations) !== body.operationDigest)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    const positions = this.#positions(body.operations);
    if (this.#affected(body.worldRef, positions).length)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    const stateProfile = this.store.snapshot.connections[body.sessionRef].capabilities.stateProfile;
    const before = await this.#read(body, positions, stateProfile, 'before');
    const effects = new Map(body.operations.effects.map(effect => [key(effect.position), effect]));
    const expected = { worldRef: body.worldRef, coveredPositions: positions,
      records: before.records.map(record => ({ ...record,
        nodeName: effects.get(key(record.position)).nodeName,
        param1: 0, param2: effects.get(key(record.position)).param2,
        metadata: {}, inventory: {}, timer: null })), stateProfile };
    const scope = { transactionId: body.transactionId, worldRef: body.worldRef,
      operationDigest: body.operationDigest, stateProfile, checkedPositions: positions,
      objects: [], cells: before.records.map(record => ({ position: record.position,
        availability: 'KNOWN', stateDigest: stableHash(record) })),
      localContext: body.localContext };
    const scopeDigest = hash('scoped-world', scope);
    // Reserve before any Adapter mutation. A repeated request never issues another write.
    await this.store.commit(state => {
      if (state.pending[body.transactionId] || state.transactions[body.transactionId])
        throw fail('TRANSACTION_CONFLICT', 'REVISION_CHANGED');
      state.pending[body.transactionId] = { body, before, expected, positions,
        replayKey, digest: admission.requestDigest, phase: 'RESERVED' };
    });
    let prepared;
    try {
      prepared = await this.#adapter('PrepareRecoverableTransaction', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:prepare`, worldRef: body.worldRef,
        transactionId: body.transactionId, operationDigest: body.operationDigest,
        operations: body.operations, scope, scopeDigest,
        guarantee: body.guarantee, localContext: body.localContext });
      if (prepared.scopeDigest !== scopeDigest ||
          prepared.beforeStateReadbackDigest !== hash('readback', before) ||
          !same(prepared.stateProfile, stateProfile))
        throw fail('PREPARED_TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(state => {
        state.pending[body.transactionId].prepared = prepared;
        state.pending[body.transactionId].phase = 'PREPARED';
      });
      const adapterReceipt = await this.#adapter('ApplyCompiledTransaction', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:apply`, worldRef: body.worldRef,
        transactionId: body.transactionId, operationDigest: body.operationDigest,
        operations: body.operations, scope, scopeDigest,
        preparedTransaction: projectScopedPreparedTransaction(prepared),
        guarantee: body.guarantee, localContext: body.localContext });
      if (adapterReceipt.status !== 'VERIFIED' ||
          adapterReceipt.previousWorldRevision !== body.expectedWorldRevision ||
          adapterReceipt.transactionPayloadDigest !== prepared.transactionPayloadDigest)
        throw fail('TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(state => { state.pending[body.transactionId].phase = 'APPLIED'; });
      const actual = await this.#read(body, positions, stateProfile, 'after');
      const receipt = { ...adapterReceipt, contractVersion: WIRE,
        operationDigest: body.operationDigest,
        transactionPayloadDigest: prepared.transactionPayloadDigest,
        status: 'VERIFIED', restoreStatus: 'NOT_REQUIRED', error: null,
        readbackDigest: hash('readback', actual), localContext: body.localContext };
      const objectRef = rev('object');
      const history = { transactionId: body.transactionId, originTransactionId: null,
        affectedObjectRefs: [objectRef], operationDigest: body.operationDigest,
        beforeImageDigest: prepared.beforeImageDigest,
        expectedAfterReadbackDigest: receipt.readbackDigest,
        receiptDigest: hash('receipt', receipt), historyRevision: rev('history'),
        status: 'VERIFIED' };
      validateCommitReadback(receipt, expected, actual, history);
      const response = validateResponse(WIRE, 'ApplyRecoverableCommit', answer(body, receipt));
      await this.store.commit(state => {
        state.transactions[body.transactionId] = { receipt, history, before, after: actual,
          objectRef, operationDigest: body.operationDigest, worldRef: body.worldRef,
          worldRevision: receipt.observedWorldRevision };
        state.history[objectRef] = [history];
        state.objects[body.worldRef] ??= {};
        state.objects[body.worldRef][objectRef] = {
          worldRef: body.worldRef, objectRef, objectRevision: rev('object'),
          displayName: null, nameRevision: null,
          creationSequence: Object.keys(state.objects[body.worldRef]).length,
          status: 'READY' };
        state.footprints[body.worldRef] ??= {};
        state.footprints[body.worldRef][objectRef] = { positions,
          footprintRevision: rev('footprint') };
        state.registryRevisions[body.worldRef] = rev('registry');
        state.replay[replayKey] = { digest: admission.requestDigest, response };
        delete state.pending[body.transactionId];
      });
      return response;
    } catch (error) {
      if (!prepared) {
        await this.store.commit(state => { delete state.pending[body.transactionId]; });
        throw error;
      }
      return this.#rollback(body, prepared, before, positions, stateProfile,
        replayKey, admission.requestDigest, error);
    }
  }
  async #rollback(body, prepared, before, positions, stateProfile, replayKey,
    requestHash, cause, operation = 'ApplyRecoverableCommit') {
    try {
      const restored = await this.#adapter('RestoreTransaction', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:restore`, worldRef: body.worldRef,
        originTransactionId: body.transactionId, operationDigest: body.operationDigest,
        beforeImageDigest: prepared.beforeImageDigest,
        restoreAttemptIdentity: stableHash(
          { transactionId: body.transactionId, beforeImageDigest: prepared.beforeImageDigest }),
        guarantee: body.guarantee, localContext: body.localContext });
      const actual = await this.#read(body, positions, stateProfile, 'restored');
      const receipt = { ...restored, contractVersion: WIRE,
        transactionId: body.transactionId, operationDigest: body.operationDigest,
        transactionPayloadDigest: prepared.transactionPayloadDigest,
        status: 'ROLLED_BACK', restoreStatus: 'VERIFIED_RESTORED',
        readbackDigest: hash('readback', actual), localContext: body.localContext };
      validateCommitReadback(receipt, before, actual, null);
      const response = validateResponse(WIRE, operation, answer(body, receipt));
      await this.store.commit(state => {
        state.transactions[body.transactionId] = { receipt, before, after: actual,
          worldRef: body.worldRef };
        state.replay[replayKey] = { digest: requestHash, response };
        delete state.pending[body.transactionId];
      });
      return response;
    } catch {
      const pending = fail('RECOVERY_PENDING', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
      pending.publicError.retryability = 'SAME_TRANSACTION_QUERY';
      pending.publicError.mutationState = 'UNKNOWN';
      pending.publicError.transactionRef = body.transactionId;
      pending.cause = cause;
      throw pending;
    }
  }
  async #undo(body) {
    const { replayKey, prior, admission } = await this.#bound('Undo', body);
    if (prior) return prior.response;
    const origin = this.store.snapshot.transactions[body.historyTransactionId];
    const object = this.store.snapshot.objects[body.worldRef]?.[body.objectRef];
    const historyRows = this.store.snapshot.history[body.objectRef] ?? [];
    if (!origin?.history || origin.objectRef !== body.objectRef ||
        origin.worldRef !== body.worldRef || historyRows.at(-1)?.transactionId !==
          body.historyTransactionId ||
        body.expectedHistoryRevision !== origin.history.historyRevision ||
        body.expectedWorldRevision !== origin.receipt.observedWorldRevision ||
        !object || Object.keys(body.expectedObjectRevisions).length !== 1 ||
        body.expectedObjectRevisions[body.objectRef] !== object.objectRevision)
      throw fail('STALE_REVISION');
    const positions = origin.after.coveredPositions;
    const stateProfile = origin.after.stateProfile;
    const beforeUndo = await this.#read(body, positions, stateProfile, 'before-undo');
    if (!same(beforeUndo, origin.after))
      throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
    const historyOperation = { contractVersion: ADAPTER, worldRef: body.worldRef,
      originTransactionId: body.historyTransactionId,
      transactionId: body.transactionId, direction: 'UNDO',
      affectedObjectRefs: [body.objectRef],
      originVerifiedReceiptDigest: origin.history.receiptDigest,
      originBeforeImageDigest: origin.history.beforeImageDigest,
      originBeforeStateReadbackDigest: hash('readback', origin.before),
      originAfterReadbackDigest: origin.history.expectedAfterReadbackDigest,
      expectedCurrentStateDigest: hash('readback', beforeUndo),
      targetStateDigest: hash('readback', origin.before),
      expectedHistoryRevision: body.expectedHistoryRevision,
      expectedWorldRevision: body.expectedWorldRevision,
      expectedObjectRevisions: body.expectedObjectRevisions,
      guarantee: 'RECOVERABLE_VERIFIED', localContext: body.localContext };
    const historyOperationDigest = hash('history-operation', historyOperation);
    await this.store.commit(state => {
      if (state.pending[body.transactionId] || state.transactions[body.transactionId])
        throw fail('TRANSACTION_CONFLICT');
      state.pending[body.transactionId] = { body, originTransactionId: body.historyTransactionId,
        before: beforeUndo, expected: origin.before, phase: 'RESERVED' };
    });
    let prepared;
    try {
      prepared = await this.#adapter('PrepareHistoryTransaction', {
        ...historyOperation, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:prepare-history`, historyOperationDigest });
      await this.store.commit(state => {
        state.pending[body.transactionId].prepared = prepared;
        state.pending[body.transactionId].phase = 'PREPARED';
      });
      const adapterReceipt = await this.#adapter('ApplyHistoryTransaction', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:apply-history`, worldRef: body.worldRef,
        originTransactionId: body.historyTransactionId,
        transactionId: body.transactionId, direction: 'UNDO',
        historyOperationDigest, expectedWorldRevision: body.expectedWorldRevision,
        expectedObjectRevisions: body.expectedObjectRevisions,
        preparedHistoryTransaction: prepared, localContext: body.localContext });
      if (adapterReceipt.status !== 'VERIFIED' ||
          adapterReceipt.previousWorldRevision !== body.expectedWorldRevision ||
          adapterReceipt.transactionPayloadDigest !== prepared.transactionPayloadDigest)
        throw fail('TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(state => { state.pending[body.transactionId].phase = 'APPLIED'; });
      const actual = await this.#read(body, positions, stateProfile, 'after-undo');
      const receipt = { ...adapterReceipt, contractVersion: WIRE,
        transactionId: body.transactionId, operationDigest: historyOperationDigest,
        transactionPayloadDigest: prepared.transactionPayloadDigest,
        status: 'VERIFIED', restoreStatus: 'NOT_REQUIRED', error: null,
        readbackDigest: hash('readback', actual), localContext: body.localContext };
      const history = { transactionId: body.transactionId,
        originTransactionId: body.historyTransactionId,
        affectedObjectRefs: [body.objectRef], operationDigest: historyOperationDigest,
        beforeImageDigest: prepared.beforeImageDigest,
        expectedAfterReadbackDigest: receipt.readbackDigest,
        receiptDigest: hash('receipt', receipt), historyRevision: rev('history'),
        status: 'VERIFIED' };
      validateCommitReadback(receipt, origin.before, actual, history);
      const response = validateResponse(WIRE, 'Undo', answer(body, receipt));
      await this.store.commit(state => {
        state.transactions[body.transactionId] = { receipt, history,
          before: beforeUndo, after: actual, originTransactionId: body.historyTransactionId,
          objectRef: body.objectRef, worldRef: body.worldRef };
        state.history[body.objectRef].push(history);
        state.objects[body.worldRef][body.objectRef].objectRevision = rev('object');
        state.footprints[body.worldRef][body.objectRef].positions = [];
        state.footprints[body.worldRef][body.objectRef].footprintRevision = rev('footprint');
        state.registryRevisions[body.worldRef] = rev('registry');
        state.replay[replayKey] = { digest: admission.requestDigest, response };
        delete state.pending[body.transactionId];
      });
      return response;
    } catch (error) {
      if (!prepared) {
        await this.store.commit(state => { delete state.pending[body.transactionId]; });
        throw error;
      }
      return this.#rollback({ ...body, operationDigest: historyOperationDigest,
        guarantee: 'RECOVERABLE_VERIFIED' }, prepared, beforeUndo, positions,
        stateProfile, replayKey, admission.requestDigest, error, 'Undo');
    }
  }
  async #listConnections(body, operation = 'ListWorldConnections') {
    const { replayKey, prior, facts } = this.#facts(body, operation);
    const admission = validateCurrentRequest(WIRE, operation, body, facts);
    if (prior) return prior.response;
    const inventory = await this.#adapter('DiscoverConnections', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:discover`, adapterId: this.adapterId });
    if (operation === 'ListWorldConnections' &&
        body.expectedCapabilityRevision !== inventory.capabilityRevision)
      throw fail('STALE_REVISION');
    const selection = this.current(body.sessionRef);
    const result = operation === 'ReadWorldSelectionContext' ? {
      sessionRef: body.sessionRef, worldRef: body.worldRef, inventory,
      selection: selection ? { status: 'BOUND', context: selection,
        connectionRef: selection.localContext.connectionRef } :
        { status: 'UNBOUND', sessionRef: body.sessionRef, sessionRevision: 'session-0' }
    } : inventory;
    const response = validateResponse(WIRE, operation, answer(body, result));
    return this.#remember(replayKey, admission.requestDigest, response);
  }
  async #listObjects(body) {
    const { replayKey, prior, admission } = await this.#bound('ListObjects', body);
    if (prior) return prior.response;
    const registryRevision = this.store.snapshot.registryRevisions[body.worldRef] ?? 'registry-0';
    if (body.expectedRevision !== null && body.expectedRevision !== registryRevision)
      throw fail('STALE_REVISION');
    const result = { worldRef: body.worldRef, registryRevision,
      objects: Object.values(this.store.snapshot.objects[body.worldRef] ?? {})
        .sort((a, b) => a.creationSequence - b.creationSequence) };
    const response = validateResponse(WIRE, 'ListObjects', answer(body, result));
    return this.#remember(replayKey, admission.requestDigest, response);
  }
  async #historyQuery(body) {
    const { replayKey, prior, admission } = await this.#bound('HistoryQuery', body);
    if (prior) return prior.response;
    const entries = this.store.snapshot.history[body.objectRef];
    if (!entries || !this.store.snapshot.objects[body.worldRef]?.[body.objectRef])
      throw fail('OBJECT_NOT_FOUND', 'SCOPE_DENIED');
    const head = entries.at(-1);
    if (body.expectedHistoryRevision !== null &&
        body.expectedHistoryRevision !== head.historyRevision)
      throw fail('STALE_REVISION');
    const result = { worldRef: body.worldRef, objectRef: body.objectRef,
      historyRevision: head.historyRevision,
      headTransactionId: head.transactionId, entries,
      undoAvailable: head.originTransactionId === null,
      redoAvailable: head.originTransactionId !== null };
    const response = validateResponse(WIRE, 'HistoryQuery', answer(body, result));
    return this.#remember(replayKey, admission.requestDigest, response);
  }
  async #select(body) {
    const { replayKey, prior, facts } = this.#facts(body, 'SelectWorldConnection');
    const admission = validateCurrentRequest(WIRE, 'SelectWorldConnection', body, facts);
    if (prior) return prior.response;
    const previous = this.current(body.sessionRef);
    if (body.expectedRevision !== (previous?.selectionRevision ?? 'selection-0'))
      throw fail('STALE_REVISION');
    const connection = await this.#adapter('ReadLocalConnection', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:connection`, connectionRef: body.connectionRef });
    validateWorldSelection(body, facts, connection);
    const selectionRevision = rev('selection');
    const context = { connectionRef: connection.connectionRef,
      connectionIncarnationRef: connection.connectionIncarnationRef,
      worldRef: connection.worldRef, selectionRevision };
    const current = { currentSession: body.sessionRef, activeWorldRef: body.worldRef,
      orderedSelectedObjectRefs: [], sessionRevision: rev('session'),
      selectionRevision, localContext: context };
    const response = validateResponse(WIRE, 'SelectWorldConnection', answer(body, current));
    await this.store.commit(state => {
      if (state.sessions[body.sessionRef]?.selectionRevision !== previous?.selectionRevision)
        throw fail('STALE_REVISION');
      state.sessions[body.sessionRef] = current;
      state.connections[body.sessionRef] = connection;
      state.replay[replayKey] = { digest: admission.requestDigest, response };
    });
    return response;
  }
  async call(operation, raw) {
    let body;
    try {
      body = raw instanceof Uint8Array || typeof raw === 'string' ?
        admitRequest(WIRE, operation, raw) : validateRequest(WIRE, operation, raw);
      await this.ready;
      if (!this.store || this.store.unavailable) throw fail('CAPABILITY_UNAVAILABLE',
        'REQUIRED_FACT_UNKNOWN');
      if (operation === 'SelectWorldConnection') return await this.#select(body);
      if (operation === 'AnalyzeAffectedObjects') return await this.#analyze(body);
      if (operation === 'ApplyRecoverableCommit') return await this.#apply(body);
      if (operation === 'Undo') return await this.#undo(body);
      if (operation === 'ListWorldConnections' || operation === 'ReadWorldSelectionContext')
        return await this.#listConnections(body, operation);
      if (operation === 'ListObjects') return await this.#listObjects(body);
      if (operation === 'HistoryQuery') return await this.#historyQuery(body);
      throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    } catch (error) {
      return answer(body ?? { requestId: raw?.requestId ?? 'invalid-request' },
        null, error.publicError ?? publicError(error));
    }
  }
}

export const name = 'hanaworlds-canvas';
export const inject = [];
async function nativeDirectory(ctx) {
  const homePath = ctx.get?.('dshHomePath');
  if (typeof homePath !== 'function') throw new Error('CANVAS_STORAGE_UNAVAILABLE');
  const root = homePath();
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root)
    throw new Error('CANVAS_STORAGE_UNAVAILABLE');
  const configured = process.env.DSH_HOME;
  if (configured?.trim()) {
    const expanded = configured === '~' ? homedir() : configured.startsWith('~/') ?
      join(homedir(), configured.slice(2)) : configured;
    if (root !== resolve(expanded)) throw new Error('CANVAS_STORAGE_UNAVAILABLE');
  }
  const directory = join(root, 'data', 'hanaworlds-canvas');
  if (homePath('data', 'hanaworlds-canvas') !== directory)
    throw new Error('CANVAS_STORAGE_UNAVAILABLE');
  const canonicalRoot = await realpath(root);
  for (const path of [root, join(root, 'data'), directory]) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          await realpath(path) !== join(canonicalRoot, ...path.slice(root.length).split('/').filter(Boolean)))
        throw new Error('CANVAS_STORAGE_UNAVAILABLE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return directory;
}
export function apply(ctx) {
  const service = new CanvasV5({ store: null,
    adapter: { call: (...args) => ctx.get?.('hanaworldsWorldAdapterV6')?.call(...args) } });
  ctx.provide?.('hanaworldsCanvasV5', service);
  service.storageState = 'INITIALIZING';
  service.ready = (async () => {
    try { service.store = await CanvasStore.open(await nativeDirectory(ctx));
      service.storageState = 'READY'; }
    catch { service.storageState = 'UNAVAILABLE'; }
  })();
  return service;
}
export default { name, inject, apply };
