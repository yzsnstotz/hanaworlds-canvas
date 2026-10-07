import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import canonicalize from 'canonicalize';
import { CanvasStore } from './store-v5.mjs';
import { admitRequest, validateRequest, validateResponse, validateBoundResponse,
  validateCurrentRequest, validateWorldSelection, validateCommitReadback,
  projectScopedPreparedTransaction, checkContractHandshake, contractHandshake,
  digestValue, requestDigest, publicError, validateExactEffects,
  validateRegionInspection } from 'hanaworlds-contracts';
import { protocolRequirement, validateType } from 'hanaworlds-contracts';
import { CanvasRegionV1 } from './region-v1.mjs';

export { CanvasStore, CanvasRegionV1 };
const WIRE = 'canvas/v5';
const ADAPTER = 'world-adapter/v6';
const PACKAGE_VERSION = '0.6.0';
// The public wire defines canvas major 5, minor 0. Contracts publishes no
// per-cell Canvas capability token; regional tokens describe the region port.
const cellRequirement = protocolRequirement(WIRE, []);
const cellProtocolHandshake = validateType('ProtocolHandshake', {
  profileVersion: 'protocol-handshake/v1', component: 'hanaworlds-canvas',
  protocols: [{ protocol: cellRequirement.protocol, major: cellRequirement.major,
    minor: cellRequirement.minMinor }], capabilities: [...cellRequirement.capabilities],
  provenance: { packageName: 'hanaworlds-canvas', packageVersion: PACKAGE_VERSION,
    sourceRevision: null, artifactDigest: null } });
// The one revision an unbound Session publishes (ReadWorldSelectionContext UNBOUND
// sessionRevision); a first SelectWorldConnection names exactly this value.
const UNBOUND_SESSION_REVISION = 'session-0';
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
function boxCells(box) {
  const cells = [];
  for (let z = box.min[2]; z <= box.max[2]; z++) for (let y = box.min[1]; y <= box.max[1]; y++)
    for (let x = box.min[0]; x <= box.max[0]; x++) cells.push([x, y, z]);
  return cells;
}
function answer(body, result, error = null) {
  return { contractVersion: WIRE, requestId: body.requestId, result, error };
}

/** Current local Canvas. Adapter is a public v6 port; it never decides history. */
export class CanvasV5 {
  constructor({ store, adapter, nativeFacts, adapterId = 'hanaworlds-world-adapter' }) {
    checkContractHandshake(contractHandshake);
    this.store = store;
    this.adapter = adapter;
    this.nativeFacts = nativeFacts;
    this.adapterId = adapterId;
    this.ready = Promise.resolve();
    this.storageState = store ? 'READY' : 'UNAVAILABLE';
  }
  get contractHandshake() { return structuredClone(contractHandshake); }
  /** @returns {import('hanaworlds-contracts').ProtocolHandshake} */
  get protocolHandshake() { return structuredClone(cellProtocolHandshake); }
  status() { return { component: 'hanaworlds-canvas', version: PACKAGE_VERSION,
    canvasContract: WIRE, adapterContract: ADAPTER, storage: this.storageState,
    productReadiness: 'UNPROVEN' }; }
  current(sessionRef) { return this.store?.snapshot.sessions[sessionRef] ?? null; }
  async #durable() {
    await this.ready;
    if (!this.store || this.store.unavailable) throw fail('CAPABILITY_UNAVAILABLE',
      'REQUIRED_FACT_UNKNOWN');
    return this.store.snapshot;
  }
  #currentFacts(state, request, worldRef) {
    const session = state.sessions[request?.sessionRef];
    if (!session || session.activeWorldRef !== worldRef ||
        request?.worldRef !== worldRef ||
        !same(session.localContext, request.localContext))
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    return session;
  }
  async readFootprints(worldRef, objectRefs, request) {
    const state = await this.#durable();
    this.#currentFacts(state, request, worldRef);
    if (!Array.isArray(objectRefs) || objectRefs.some((ref, i) =>
      typeof ref !== 'string' || !ref || i > 0 && objectRefs[i - 1] >= ref))
      throw fail('SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
    const objects = objectRefs.map(objectRef => {
      const registered = state.footprints[worldRef]?.[objectRef];
      const object = state.objects[worldRef]?.[objectRef];
      if (!registered || !object) throw fail('OBJECT_NOT_FOUND', 'SCOPE_DENIED');
      return { objectRef, worldRef, footprintRevision: registered.footprintRevision,
        provenance: 'CANVAS_REGISTERED', positions: registered.positions };
    });
    return structuredClone({ current: true, durable: true, worldRef,
      objects: validateType('ScopedObjectFootprints', objects) });
  }
  /** Plugin-owned display API. No Adapter writes, replay or store commit. */
  async readObjectsHistory(sessionRef) {
    await this.#durable();
    await this.store.busy;
    await this.#durable();
    const snapshot = this.store.snapshot;
    if (sessionRef === null) return { state: 'NO_SESSION', worldRef: null, objects: [], history: [] };
    if (typeof sessionRef !== 'string' || !sessionRef) throw fail('SCHEMA_INVALID', 'INVALID_SHAPE');
    const session = snapshot.sessions[sessionRef];
    if (!session) return { state: 'NO_WORLD', worldRef: null, objects: [], history: [] };
    const worldRef = session.activeWorldRef;
    const registered = Object.values(snapshot.objects[worldRef] ?? {})
      .sort((a, b) => a.creationSequence - b.creationSequence);
    const footprints = registered.length ? await this.readFootprints(worldRef,
      registered.map(row => row.objectRef).sort(), { sessionRef, worldRef,
        localContext: session.localContext }) : { objects: [] };
    if (this.store.snapshot !== snapshot) throw fail('STALE_REVISION');
    const objects = registered.map(object => {
      const positions = footprints.objects.find(row => row.objectRef === object.objectRef).positions;
      let bounds = null;
      if (positions.length) {
        const min = [0,1,2].map(axis => positions.reduce((v, p) => Math.min(v, p[axis]), Infinity));
        const max = [0,1,2].map(axis => positions.reduce((v, p) => Math.max(v, p[axis]), -Infinity));
        bounds = { min, max, size: min.map((v, axis) => max[axis] - v + 1) };
      }
      return { objectRef: object.objectRef, name: object.displayName,
        occupiedCells: positions.length, bounds };
    });
    const history = registered.flatMap(object => {
      const entries = snapshot.history[object.objectRef] ?? [];
      const isRedo = row => snapshot.transactions[row.transactionId]?.direction === 'REDO';
      // An applied row reads UNDONE once its latest history move is an Undo; a Redo
      // re-applies it, and that Redo row carries the state from then on.
      const undone = row => {
        const move = entries.findLast(next => next.originTransactionId === row.transactionId);
        return !move ? false : isRedo(move) ? undone(move) : true;
      };
      return entries.map((entry, index) => {
        const transaction = snapshot.transactions[entry.transactionId];
        const metadata = transaction?.worldRef === worldRef && transaction.objectRef === object.objectRef ?
          transaction.displayMetadata : null;
        return { transactionId: entry.transactionId, objectRef: object.objectRef,
          objectName: object.displayName, sequence: index + 1,
          committedAt: metadata?.committedAt ?? null, mode: metadata?.mode ?? null,
          affectedCells: metadata?.affectedCells ?? null,
          status: entry.originTransactionId && !isRedo(entry) || undone(entry) ?
            'UNDONE' : 'COMMITTED' };
      });
    });
    history.sort((a, b) => a.committedAt === null ? b.committedAt === null ? 0 : 1 :
      b.committedAt === null ? -1 : a.committedAt.localeCompare(b.committedAt));
    // Old entries retain their durable order after timestamped rows; no invented time.
    return structuredClone({ state: registered.length ? 'READY' : 'EMPTY',
      worldRef, objects, history });
  }
  /**
   * Plugin-owned read of what each object's history can do next. Canvas states the
   * public operation, the exact revisions it will check, or the reason it cannot run.
   * Every offered Undo has a Redo for the same entry; it never executes anything, and
   * Undo/Redo re-validate on call.
   */
  async readHistoryActions(sessionRef) {
    await this.#durable();
    await this.store.busy;
    const s = this.store.snapshot;
    if (typeof sessionRef !== 'string' || !sessionRef) throw fail('SCHEMA_INVALID', 'INVALID_SHAPE');
    const session = s.sessions[sessionRef];
    if (!session) return structuredClone({ state: 'NO_WORLD', worldRef: null, objects: [] });
    const worldRef = session.activeWorldRef;
    const worldRevision = s.worldRevisions[worldRef];
    const pending = Object.values(s.pending).some(row =>
      (row.body?.worldRef ?? row.worldRef) === worldRef);
    const objects = Object.values(s.objects[worldRef] ?? {})
      .sort((a, b) => a.creationSequence - b.creationSequence).map(object => {
        const rows = s.history[object.objectRef] ?? [];
        const head = rows.at(-1);
        const headTransaction = head ? s.transactions[head.transactionId] : null;
        const region = s.transactions[rows[0]?.transactionId]?.kind === 'REGION';
        const undone = head ? this.#undoRow(head) : false;
        const blocked = pending ? 'TRANSACTION_PENDING' : null;
        let undo, redo;
        if (region) {
          // canvas-region/v1 publishes ApplyRegionCommit and UndoRegionCommit only. A move is
          // offered only when the same entry can be moved back, so region Undo is named, not offered.
          undo = { available: false, reason: undone ? 'NOTHING_TO_UNDO' : 'REGION_UNDO_HAS_NO_REDO' };
          redo = { available: false, reason: undone ? 'REGION_REDO_NOT_IN_PROTOCOL' : 'NOTHING_TO_REDO' };
        } else {
          const expected = { expectedHistoryRevision: head.historyRevision,
            expectedWorldRevision: headTransaction.receipt.observedWorldRevision,
            expectedObjectRevisions: { [object.objectRef]: object.objectRevision } };
          const stale = expected.expectedWorldRevision !== worldRevision ? 'WORLD_CHANGED_SINCE' : null;
          undo = undone ? { available: false, reason: 'NOTHING_TO_UNDO' } :
            blocked || stale ? { available: false, reason: blocked ?? stale } :
            { available: true, operation: 'Undo', historyTransactionId: head.transactionId, ...expected };
          redo = !undone ? { available: false, reason: 'NOTHING_TO_REDO' } :
            blocked || stale ? { available: false, reason: blocked ?? stale } :
            { available: true, operation: 'Redo', historyTransactionId: head.originTransactionId, ...expected };
        }
        return { objectRef: object.objectRef, mode: region ? 'REGION' : 'CELL',
          originTransactionId: rows[0]?.transactionId ?? null, applied: !undone,
          footprint: s.footprints[worldRef]?.[object.objectRef]?.positions ?? [],
          // Cells this entry changes: the verified cell scope, or the committed region box.
          cells: region ? boxCells(s.transactions[rows[0].transactionId].box) :
            s.transactions[rows[0].transactionId].after.coveredPositions,
          undo, redo };
      });
    return structuredClone({ state: objects.length ? 'READY' : 'EMPTY', worldRef,
      worldRevision, localContext: session.localContext, objects });
  }
  async readHistoryFacts(request) {
    const state = await this.#durable();
    this.#currentFacts(state, request, request?.worldRef);
    const origin = state.transactions[request?.originTransactionId];
    if (!origin?.history || origin.worldRef !== request.worldRef ||
        origin.receipt.status !== 'VERIFIED' ||
        state.history[origin.objectRef]?.at(-1)?.transactionId !== request.originTransactionId)
      throw fail('UNDO_CONFLICT', 'REVISION_CHANGED');
    const object = state.objects[request.worldRef]?.[origin.objectRef];
    const worldRevision = state.worldRevisions[request.worldRef];
    if (!object || !worldRevision) throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    return structuredClone({ current: true, durable: true, worldRef: request.worldRef,
      originTransactionId: request.originTransactionId,
      historyRevision: origin.history.historyRevision, worldRevision,
      objectRevisions: { [origin.objectRef]: object.objectRevision },
      affectedObjectRefs: [...origin.history.affectedObjectRefs],
      originVerifiedReceiptDigest: origin.history.receiptDigest });
  }
  async readWorldRevision(worldRef) {
    const state = await this.#durable();
    if (!Object.values(state.sessions).some(session => session.activeWorldRef === worldRef))
      throw fail('WORLD_NOT_BOUND', 'SCOPE_DENIED');
    const revision = state.worldRevisions[worldRef];
    if (!revision) throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    return revision;
  }
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
          (this.store.snapshot.registryRevisions[body.worldRef] ?? 'registry-0') ||
        body.expectedRevision !== this.store.snapshot.worldRevisions[body.worldRef])
      throw fail('STALE_REVISION');
    if (hash('operations', body.operations) !== body.operationDigest)
      throw fail('DIGEST_MISMATCH', 'PAYLOAD_CHANGED');
    const affectedObjectRefs = this.#affected(body.worldRef, this.#positions(body.operations));
    const analysis = { contractVersion: WIRE, worldRef: body.worldRef,
      worldRevision: this.store.snapshot.worldRevisions[body.worldRef],
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
        this.store.snapshot.worldRevisions[body.worldRef] !== body.expectedWorldRevision ||
        hash('operations', body.operations) !== body.operationDigest)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    if (body.regionInspectionBinding) {
      const build = body.regionInspectionBinding.build;
      const recorded = this.store.snapshot.placementInspections[
        body.regionInspectionBinding.inspectionId];
      const inspection = recorded?.inspection;
      if (!inspection || recorded.sessionRef !== body.sessionRef ||
          recorded.worldRef !== body.worldRef ||
          recorded.worldRevision !== body.expectedWorldRevision ||
          !same(recorded.localContext, body.localContext) ||
          inspection.targetFactsDigest !== body.operations.targetFactsDigest ||
          build.targetFactsDigest !== inspection.targetFactsDigest ||
          !same(build.coordinateFrame, inspection.frame) ||
          build.catalogueDigest !== inspection.targetFacts.catalogueDigest)
        throw fail('INSPECTION_FAILED', 'REQUIRED_FACT_UNKNOWN');
      if (hash('build', build) !== body.operations.buildDigest)
        throw fail('DIGEST_MISMATCH', 'PAYLOAD_CHANGED');
      validateExactEffects(build.operations, build.materials, body.operations.effects);
    }
    const positions = this.#positions(body.operations);
    if (this.#affected(body.worldRef, positions).length)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    const stateProfile = this.store.snapshot.connections[body.sessionRef].capabilities.stateProfile;
    if (typeof this.nativeFacts?.readScopedState !== 'function')
      throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    const facts = await this.nativeFacts.readScopedState(
      body.localContext.connectionRef, positions);
    if (facts?.worldRef !== body.worldRef || !same(facts.stateProfile, stateProfile) ||
        !Array.isArray(facts.cells) ||
        !same(facts.cells.map(cell => cell.position), positions) ||
        facts.cells.some(cell => cell.availability !== 'KNOWN'))
      throw fail('TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN');
    const scope = { transactionId: body.transactionId, worldRef: body.worldRef,
      operationDigest: body.operationDigest, stateProfile, checkedPositions: positions,
      objects: [], cells: validateType('ScopedCells', facts.cells),
      localContext: body.localContext };
    const scopeDigest = hash('scoped-world', scope);
    // Reserve before any Adapter mutation. A repeated request never issues another write.
    await this.store.commit(state => {
      if (state.pending[body.transactionId] || state.transactions[body.transactionId])
        throw fail('TRANSACTION_CONFLICT', 'REVISION_CHANGED');
      state.pending[body.transactionId] = { body, positions,
        replayKey, digest: admission.requestDigest, phase: 'RESERVED' };
    });
    let prepared, before;
    try {
      prepared = await this.#adapter('PrepareRecoverableTransaction', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:prepare`, worldRef: body.worldRef,
        transactionId: body.transactionId, operationDigest: body.operationDigest,
        operations: body.operations, scope, scopeDigest,
        guarantee: body.guarantee, localContext: body.localContext });
      if (prepared.scopeDigest !== scopeDigest || !same(prepared.stateProfile, stateProfile))
        throw fail('PREPARED_TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(state => {
        state.pending[body.transactionId].prepared = prepared;
        state.pending[body.transactionId].phase = 'PREPARED';
      });
      before = await this.#read(body, positions, stateProfile, 'before');
      if (prepared.beforeStateReadbackDigest !== hash('readback', before))
        throw fail('PREPARED_TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(state => {
        state.pending[body.transactionId].before = before;
        state.pending[body.transactionId].phase = 'BEFORE_VERIFIED';
      });
      const adapterReceipt = await this.#adapter('ApplyCompiledTransaction', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:apply`, worldRef: body.worldRef,
        transactionId: body.transactionId, operationDigest: body.operationDigest,
        operations: body.operations, scope, scopeDigest,
        preparedTransaction: projectScopedPreparedTransaction(prepared),
        guarantee: body.guarantee, localContext: body.localContext });
      if (adapterReceipt.status !== 'VERIFIED' ||
          adapterReceipt.transactionPayloadDigest !== prepared.transactionPayloadDigest)
        throw fail('TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(state => { state.pending[body.transactionId].phase = 'APPLIED'; });
      const actual = await this.#read(body, positions, stateProfile, 'after');
      if (adapterReceipt.readbackDigest !== hash('readback', actual))
        throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
      const effects = new Map(body.operations.effects.map(effect => [key(effect.position), effect]));
      const expected = { worldRef: body.worldRef, coveredPositions: positions,
        records: before.records.map((record, index) => {
          const effect = effects.get(key(record.position));
          return effect ? { ...record, nodeName: effect.nodeName,
            param2: effect.param2, param1: actual.records[index].param1 } : record;
        }), stateProfile };
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
          displayMetadata: { committedAt: new Date().toISOString(), mode: 'CELL',
            affectedCells: positions.length },
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
          footprintRevision: rev('footprint'), provenance: 'CANVAS_REGISTERED' };
        state.worldRevisions[body.worldRef] = receipt.observedWorldRevision;
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
      if (!before) {
        const pending = fail('RECOVERY_PENDING', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
        pending.publicError.mutationState = 'UNKNOWN';
        pending.publicError.transactionRef = body.transactionId;
        throw pending;
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
        if (receipt.observedWorldRevision)
          state.worldRevisions[body.worldRef] = receipt.observedWorldRevision;
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
  /** Undo and Redo share one history-transaction path; only the target image differs. */
  async #history(operation, body) {
    const { replayKey, prior, admission } = await this.#bound(operation, body);
    if (prior) return prior.response;
    const redo = operation === 'Redo';
    const state = this.store.snapshot;
    const origin = state.transactions[body.historyTransactionId];
    const object = state.objects[body.worldRef]?.[body.objectRef];
    const historyRows = state.history[body.objectRef] ?? [];
    const head = historyRows.at(-1);
    // A region transaction is undone as a whole region through hanaworldsCanvasRegionV1;
    // canvas-region/v1 defines no region Redo.
    if (origin?.kind === 'REGION') throw fail(redo ? 'REDO_UNAVAILABLE' : 'UNDO_CONFLICT',
      redo ? 'POLICY_UNAVAILABLE' : 'REVISION_CHANGED');
    if (!origin?.history || origin.objectRef !== body.objectRef ||
        origin.worldRef !== body.worldRef || !object)
      throw fail('STALE_REVISION');
    // Undo: the head row itself, never an Undo row. Redo: the head row must be the
    // Undo of exactly this transaction.
    const headTransaction = head ? state.transactions[head.transactionId] : null;
    if (redo ? !head || !this.#undoRow(head) ||
          head.originTransactionId !== body.historyTransactionId :
        head?.transactionId !== body.historyTransactionId || this.#undoRow(head))
      throw fail(redo ? 'REDO_UNAVAILABLE' : 'UNDO_CONFLICT',
        redo ? 'POLICY_UNAVAILABLE' : 'REVISION_CHANGED');
    if (body.expectedHistoryRevision !== head.historyRevision ||
        body.expectedWorldRevision !== headTransaction.receipt.observedWorldRevision ||
        Object.keys(body.expectedObjectRevisions).length !== 1 ||
        body.expectedObjectRevisions[body.objectRef] !== object.objectRevision)
      throw fail('STALE_REVISION');
    const positions = origin.after.coveredPositions;
    const stateProfile = origin.after.stateProfile;
    const expectedCurrent = redo ? origin.before : origin.after;
    const target = redo ? origin.after : origin.before;
    const current = await this.#read({ ...body,
      transactionId: body.historyTransactionId }, positions, stateProfile,
    redo ? 'before-redo' : 'before-undo');
    if (!same(current, expectedCurrent)) throw redo ?
      fail('REDO_CONFLICT', 'EXTERNAL_EDIT_CONFLICT', 'readback') :
      fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
    const direction = redo ? 'REDO' : 'UNDO';
    const historyOperation = { contractVersion: ADAPTER, worldRef: body.worldRef,
      originTransactionId: body.historyTransactionId,
      transactionId: body.transactionId, direction,
      affectedObjectRefs: [body.objectRef],
      originVerifiedReceiptDigest: origin.history.receiptDigest,
      originBeforeImageDigest: origin.history.beforeImageDigest,
      originBeforeStateReadbackDigest: hash('readback', origin.before),
      originAfterReadbackDigest: origin.history.expectedAfterReadbackDigest,
      expectedCurrentStateDigest: hash('readback', current),
      targetStateDigest: hash('readback', target),
      expectedHistoryRevision: body.expectedHistoryRevision,
      expectedWorldRevision: body.expectedWorldRevision,
      expectedObjectRevisions: body.expectedObjectRevisions,
      guarantee: 'RECOVERABLE_VERIFIED', localContext: body.localContext };
    const historyOperationDigest = hash('history-operation', historyOperation);
    await this.store.commit(next => {
      if (next.pending[body.transactionId] || next.transactions[body.transactionId])
        throw fail('TRANSACTION_CONFLICT');
      next.pending[body.transactionId] = { body, direction,
        originTransactionId: body.historyTransactionId,
        before: current, expected: target, phase: 'RESERVED' };
    });
    let prepared;
    try {
      prepared = await this.#adapter('PrepareHistoryTransaction', {
        ...historyOperation, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:prepare-history`, historyOperationDigest });
      await this.store.commit(next => {
        next.pending[body.transactionId].prepared = prepared;
        next.pending[body.transactionId].phase = 'PREPARED';
      });
      const adapterReceipt = await this.#adapter('ApplyHistoryTransaction', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:apply-history`, worldRef: body.worldRef,
        originTransactionId: body.historyTransactionId,
        transactionId: body.transactionId, direction,
        historyOperationDigest, expectedWorldRevision: body.expectedWorldRevision,
        expectedObjectRevisions: body.expectedObjectRevisions,
        preparedHistoryTransaction: prepared, localContext: body.localContext });
      if (adapterReceipt.status !== 'VERIFIED' ||
          adapterReceipt.previousWorldRevision !== body.expectedWorldRevision ||
          adapterReceipt.transactionPayloadDigest !== prepared.transactionPayloadDigest)
        throw fail('TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(next => { next.pending[body.transactionId].phase = 'APPLIED'; });
      const actual = await this.#read(body, positions, stateProfile,
        redo ? 'after-redo' : 'after-undo');
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
      validateCommitReadback(receipt, target, actual, history);
      const response = validateResponse(WIRE, operation, answer(body, receipt));
      await this.store.commit(next => {
        next.transactions[body.transactionId] = { receipt, history, direction,
          displayMetadata: { committedAt: new Date().toISOString(), mode: 'CELL',
            affectedCells: positions.length },
          before: current, after: actual, originTransactionId: body.historyTransactionId,
          objectRef: body.objectRef, worldRef: body.worldRef };
        next.history[body.objectRef].push(history);
        next.objects[body.worldRef][body.objectRef].objectRevision = rev('object');
        // Redo restores the footprint the original verified transaction registered.
        next.footprints[body.worldRef][body.objectRef].positions = redo ? positions : [];
        next.footprints[body.worldRef][body.objectRef].footprintRevision = rev('footprint');
        next.worldRevisions[body.worldRef] = receipt.observedWorldRevision;
        next.registryRevisions[body.worldRef] = rev('registry');
        next.replay[replayKey] = { digest: admission.requestDigest, response };
        delete next.pending[body.transactionId];
      });
      return response;
    } catch (error) {
      if (!prepared) {
        await this.store.commit(next => { delete next.pending[body.transactionId]; });
        throw error;
      }
      return this.#rollback({ ...body, operationDigest: historyOperationDigest,
        guarantee: 'RECOVERABLE_VERIFIED' }, prepared, current, positions,
        stateProfile, replayKey, admission.requestDigest, error, operation);
    }
  }
  /** An Undo history row: cell Undo (direction UNDO) or whole-region Undo. */
  #undoRow(row) {
    const transaction = this.store.snapshot.transactions[row.transactionId];
    return row.originTransactionId !== null && transaction?.direction !== 'REDO';
  }
  async #listConnections(body, operation = 'ListWorldConnections') {
    const { replayKey, prior, facts } = this.#facts(body, operation);
    const admission = validateCurrentRequest(WIRE, operation, body, facts);
    if (prior && operation !== 'ReadWorldSelectionContext') return prior.response;
    const selection = this.current(body.sessionRef);
    const inventory = operation === 'ReadWorldSelectionContext' && selection ?
      this.store.snapshot.connectionInventories[body.sessionRef] :
      await this.#adapter('DiscoverConnections', {
        contractVersion: ADAPTER, sessionRef: body.sessionRef,
        requestId: `${body.requestId}:discover`, adapterId: this.adapterId });
    if (!inventory || selection && operation === 'ReadWorldSelectionContext' &&
        selection.activeWorldRef !== body.worldRef)
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    if (operation === 'ListWorldConnections' &&
        body.expectedCapabilityRevision !== inventory.capabilityRevision)
      throw fail('STALE_REVISION');
    const result = operation === 'ReadWorldSelectionContext' ? {
      sessionRef: body.sessionRef, worldRef: body.worldRef, inventory,
      selection: selection ? { status: 'BOUND', context: selection,
        connectionRef: selection.localContext.connectionRef } :
        { status: 'UNBOUND', sessionRef: body.sessionRef,
          sessionRevision: UNBOUND_SESSION_REVISION }
    } : inventory;
    const response = validateResponse(WIRE, operation, answer(body, result));
    if (operation === 'ReadWorldSelectionContext') return response;
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
  async #inspectPlacementRegion(body) {
    const { replayKey, prior, admission } = await this.#bound('InspectPlacementRegion', body);
    const state = this.store.snapshot;
    if (state.sessions[body.sessionRef]?.activeWorldRef !== body.worldRef ||
        !same(state.sessions[body.sessionRef]?.localContext, body.localContext))
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    const settings = state.placementSettings[body.worldRef];
    if (!settings) {
      const error = fail('CAPABILITY_UNAVAILABLE', 'POLICY_UNAVAILABLE');
      error.unavailableSettings = ['placement.forwardSearchCells',
        'placement.frontGapCells', 'placement.lateralSearchCells',
        'placement.verticalSearchCells'];
      throw error;
    }
    if (prior) {
      const old = prior.response.result;
      const revision = old.outcome === 'REGION_INSPECTED' ?
        old.inspection.targetFacts.worldRevision : old.choice.observedWorldRevision;
      if (revision !== state.worldRevisions[body.worldRef]) throw fail('STALE_REVISION');
      return prior.response;
    }
    const worldRevision = state.worldRevisions[body.worldRef];
    const inspectionId = rev('inspection');
    const result = await this.#adapter('InspectRegion', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:region`, worldRef: body.worldRef,
      expectedWorldRevision: worldRevision, inspectionId,
      anchor: body.anchor, footprint: body.footprint,
      placementSettings: settings, localContext: body.localContext });
    if (result.outcome === 'REGION_INSPECTED') {
      const inspection = validateRegionInspection(result.inspection);
      if (inspection.inspectionId !== inspectionId ||
          inspection.anchorKind !== body.anchor.kind ||
          inspection.targetFacts.worldRef !== body.worldRef ||
          inspection.targetFacts.worldRevision !== worldRevision ||
          inspection.evidence.worldRef !== body.worldRef ||
          inspection.evidence.worldRevision !== worldRevision ||
          inspection.targetFactsDigest !== hash('target-facts', inspection.targetFacts) ||
          !same(inspection.placementSettings, settings))
        throw fail('INSPECTION_FAILED', 'REQUIRED_FACT_UNKNOWN');
    } else if (result.outcome === 'PLACEMENT_CHOICE_REQUIRED') {
      if (result.choice.observedWorldRevision !== worldRevision ||
          !same(result.choice.placementSettings, settings))
        throw fail('INSPECTION_FAILED', 'REQUIRED_FACT_UNKNOWN');
    } else throw fail('INSPECTION_FAILED', 'REQUIRED_FACT_UNKNOWN');
    const response = validateResponse(WIRE, 'InspectPlacementRegion',
      { ...answer(body, result), unavailableSettings: null });
    await this.store.commit(next => {
      if (!same(next.sessions[body.sessionRef]?.localContext, body.localContext) ||
          next.worldRevisions[body.worldRef] !== worldRevision ||
          !same(next.placementSettings[body.worldRef], settings))
        throw fail('STALE_REVISION');
      if (result.outcome === 'REGION_INSPECTED')
        next.placementInspections[inspectionId] = { sessionRef: body.sessionRef,
          worldRef: body.worldRef, localContext: body.localContext,
          worldRevision, inspection: result.inspection };
      next.replay[replayKey] = { digest: admission.requestDigest, response };
    });
    return response;
  }
  async #publicReadback(body) {
    const { replayKey, prior, admission } = await this.#bound('Readback', body);
    if (this.store.snapshot.sessions[body.sessionRef]?.activeWorldRef !== body.worldRef ||
        !same(this.store.snapshot.sessions[body.sessionRef]?.localContext, body.localContext))
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    const saved = this.store.snapshot.transactions[body.transactionId];
    if (!saved || saved.kind || saved.worldRef !== body.worldRef ||
        !same(saved.receipt?.localContext, body.localContext))
      throw fail('TRANSACTION_NOT_FOUND', 'SCOPE_DENIED');
    if (saved.receipt.status !== 'VERIFIED' ||
        saved.receipt.observedWorldRevision !== body.commitRevision ||
        saved.receipt.transactionPayloadDigest !== body.transactionPayloadDigest ||
        saved.receipt.operationDigest !== hash('operations', body.expectedOperations) ||
        this.store.snapshot.worldRevisions[body.worldRef] !== body.commitRevision)
      throw fail('STALE_REVISION');
    if (prior) return prior.response;
    const actual = await this.#read(body, saved.after.coveredPositions,
      saved.after.stateProfile, 'public-readback');
    if (!same(actual, saved.after) ||
        hash('readback', actual) !== saved.receipt.readbackDigest)
      throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
    const response = validateResponse(WIRE, 'Readback', answer(body, saved.receipt));
    await this.store.commit(state => {
      const current = state.transactions[body.transactionId];
      if (!same(current?.receipt, saved.receipt) ||
          state.worldRevisions[body.worldRef] !== body.commitRevision ||
          !same(state.sessions[body.sessionRef]?.localContext, body.localContext))
        throw fail('STALE_REVISION');
      state.replay[replayKey] = { digest: admission.requestDigest, response };
    });
    return response;
  }
  async #inspectObject(body) {
    const { replayKey, prior, admission } = await this.#bound('InspectObject', body);
    const state = this.store.snapshot;
    if (state.sessions[body.sessionRef]?.activeWorldRef !== body.worldRef ||
        !same(state.sessions[body.sessionRef]?.localContext, body.localContext))
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    const object = state.objects[body.worldRef]?.[body.objectRef];
    if (!object) throw fail('OBJECT_NOT_FOUND', 'SCOPE_DENIED');
    if (object.objectRevision !== body.expectedRevision) throw fail('STALE_REVISION');
    const worldRevision = state.worldRevisions[body.worldRef];
    if (prior) {
      if (prior.response.result.worldRevision !== worldRevision)
        throw fail('STALE_REVISION');
      return prior.response;
    }
    const result = await this.#adapter('InspectWorld', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:inspect`, worldRef: body.worldRef,
      expectedWorldRevision: worldRevision, sampledBounds: body.sampledBounds,
      localContext: body.localContext });
    if (result.source !== 'INSPECTED' ||
        result.worldRef !== body.worldRef ||
        result.objectRef !== body.objectRef ||
        result.objectRevision !== body.expectedRevision ||
        result.worldRevision !== worldRevision ||
        !same(result.sampledBounds, body.sampledBounds))
      throw fail('INSPECTION_FAILED', 'REQUIRED_FACT_UNKNOWN');
    const response = validateResponse(WIRE, 'InspectObject', answer(body, result));
    await this.store.commit(next => {
      if (!same(next.sessions[body.sessionRef]?.localContext, body.localContext) ||
          next.worldRevisions[body.worldRef] !== worldRevision ||
          next.objects[body.worldRef]?.[body.objectRef]?.objectRevision !== body.expectedRevision)
        throw fail('STALE_REVISION');
      next.replay[replayKey] = { digest: admission.requestDigest, response };
    });
    return response;
  }
  async #setObjectSelection(body) {
    const { replayKey, prior, admission } = await this.#bound('SetObjectSelection', body);
    if (prior) return prior.response;
    const session = this.current(body.sessionRef);
    if (body.expectedSelectionRevision !== session.selectionRevision ||
        body.objectRefs.some(ref => !this.store.snapshot.objects[body.worldRef]?.[ref]))
      throw fail('STALE_REVISION');
    const selectionRevision = rev('selection');
    const result = { sessionRef: body.sessionRef, worldRef: body.worldRef,
      selectedObjectRefs: [...body.objectRefs], selectionRevision };
    const response = validateResponse(WIRE, 'SetObjectSelection', answer(body, result));
    await this.store.commit(state => {
      const current = state.sessions[body.sessionRef];
      if (!current || current.selectionRevision !== body.expectedSelectionRevision)
        throw fail('STALE_REVISION');
      current.orderedSelectedObjectRefs = [...body.objectRefs];
      current.selectionRevision = selectionRevision;
      current.sessionRevision = rev('session');
      current.localContext.selectionRevision = selectionRevision;
      state.replay[replayKey] = { digest: admission.requestDigest, response };
    });
    return response;
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
      undoAvailable: !this.#undoRow(head),
      redoAvailable: this.#undoRow(head) &&
        this.store.snapshot.transactions[head.originTransactionId]?.kind !== 'REGION' };
    const response = validateResponse(WIRE, 'HistoryQuery', answer(body, result));
    return this.#remember(replayKey, admission.requestDigest, response);
  }
  async #select(body) {
    const { replayKey, prior, facts } = this.#facts(body, 'SelectWorldConnection');
    const admission = validateCurrentRequest(WIRE, 'SelectWorldConnection', body, facts);
    if (prior) return prior.response;
    const previous = this.current(body.sessionRef);
    // Bound: the published selectionRevision. Unbound: the published UNBOUND sessionRevision.
    if (body.expectedRevision !== (previous ? previous.selectionRevision : UNBOUND_SESSION_REVISION))
      throw fail('STALE_REVISION');
    const connection = await this.#adapter('ReadLocalConnection', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:connection`, connectionRef: body.connectionRef });
    validateWorldSelection(body, facts, connection);
    const inventory = await this.#adapter('DiscoverConnections', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:discover`, adapterId: this.adapterId });
    const descriptor = inventory.connections.find(row => row.connectionRef === body.connectionRef);
    if (!descriptor || descriptor.worldRef !== body.worldRef ||
        descriptor.connectionIncarnationRef !== connection.connectionIncarnationRef ||
        descriptor.payloadVersion !== connection.payloadVersion ||
        descriptor.capabilityRevision !== connection.capabilities.capabilityRevision)
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
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
      state.connectionInventories[body.sessionRef] = inventory;
      state.worldRevisions[body.worldRef] ??= 'world-0';
      state.placementSettings[body.worldRef] ??= {
        frontGapCells: 2, forwardSearchCells: 16,
        lateralSearchCells: 8, verticalSearchCells: 4,
        settingsRevision: 'placement-0' };
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
      if (operation === 'Undo' || operation === 'Redo') return await this.#history(operation, body);
      if (operation === 'ListWorldConnections' || operation === 'ReadWorldSelectionContext')
        return await this.#listConnections(body, operation);
      if (operation === 'ListObjects') return await this.#listObjects(body);
      if (operation === 'SetObjectSelection') return await this.#setObjectSelection(body);
      if (operation === 'InspectPlacementRegion')
        return await this.#inspectPlacementRegion(body);
      if (operation === 'Readback') return await this.#publicReadback(body);
      if (operation === 'InspectObject') return await this.#inspectObject(body);
      if (operation === 'HistoryQuery') return await this.#historyQuery(body);
      throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    } catch (error) {
      const response = answer(body ?? { requestId: raw?.requestId ?? 'invalid-request' },
        null, error.publicError ?? publicError(error));
      return operation === 'InspectPlacementRegion' ?
        { ...response, unavailableSettings: error.unavailableSettings ?? null } : response;
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
    adapter: { call: (...args) => ctx.get?.('hanaworldsWorldAdapterV6')?.call(...args) },
    nativeFacts: { readScopedState: (...args) => {
      const current = ctx.get?.('hanaworldsLuantiNativeFacts');
      if (typeof current?.readScopedState !== 'function')
        throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
      return current.readScopedState(...args);
    } } });
  ctx.provide?.('hanaworldsCanvasV5', service);
  // Host service names are Canvas's choice; the wire shapes are Contracts canvas-/world-adapter-region/v1.
  ctx.provide?.('hanaworldsCanvasRegionV1', new CanvasRegionV1(service, {
    get protocolHandshake() {
      return ctx.get?.('hanaworldsWorldAdapterRegionV1')?.protocolHandshake; },
    call: (...args) => ctx.get?.('hanaworldsWorldAdapterRegionV1')?.call(...args) }));
  ctx.provide?.('hanaworldsCanvasFootprintRegistry', {
    readFootprints: (...args) => service.readFootprints(...args) });
  ctx.provide?.('hanaworldsCanvasHistoryFacts', {
    read: request => service.readHistoryFacts(request) });
  ctx.provide?.('hanaworldsWorldRevisionOracle', {
    read: worldRef => service.readWorldRevision(worldRef) });
  // One Loader entry per package; the display binds inside Canvas's own fiber.
  ctx.inject?.(['typert'], async displayCtx => {
    const display = await import('./display-host.mjs');
    display.apply(displayCtx);
  });
  service.storageState = 'INITIALIZING';
  service.ready = (async () => {
    try { service.store = await CanvasStore.open(await nativeDirectory(ctx));
      service.storageState = 'READY'; }
    catch { service.storageState = 'UNAVAILABLE'; }
  })();
  return service;
}
export default { name, inject, apply };
