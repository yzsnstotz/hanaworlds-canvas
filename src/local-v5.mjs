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
  validateRegionInspection, checkConfirmedPlacementApply,
  validatePlacementRegionRequest, validatePlacementRegionResponse } from 'hanaworlds-contracts';
import { checkProtocolCompatibility, contractProtocols, protocolRequirement,
  validateType, requireGeometryProfile } from 'hanaworlds-contracts';
import * as contractsSdk from 'hanaworlds-contracts';
import { CanvasRegionV1, ADAPTER_CELL_REQUIREMENT, ENGINE_GUARD_REQUIREMENTS, requireGuards,
  unmetGuards, failureDetail, restoreFailure } from './region-v1.mjs';
import { CanvasConfigSupply } from './config-supply.mjs';
import { expectedWrittenRecord, withDerivedReadback } from './state-profile.mjs';
import { resolveHistoryOutcome } from './history-recovery.mjs';
import { Config } from './placement-config.mjs';
import { nameTargetWorld, refOrUndefined, trustedSessionWorld, withTargetWorld } from './world-error.mjs';
import packageJson from '../package.json' with { type: 'json' };

export { CanvasStore, CanvasRegionV1, CanvasConfigSupply };
export { Config };
const WIRE = 'canvas/v7';
const ADAPTER = 'world-adapter/v8';
const SESSION = 'session/v5';
// canvas/v7 (Contracts 1.x) carries the session-world seam operations at minor 0; there is no
// pre-seam canvas behaviour left to switch to.
const canvasProtocol = contractProtocols.find(row => row.protocol === 'canvas');
if (!canvasProtocol || canvasProtocol.major !== 7) throw new Error('CANVAS_PROTOCOL_UNDECLARED');
const PACKAGE_VERSION = packageJson.version;
// The public wire defines canvas major 6, minor 0. Contracts publishes no
// per-cell Canvas capability token; regional tokens describe the region port.
const cellRequirement = protocolRequirement(WIRE, []);
const cellProtocolHandshake = validateType('ProtocolHandshake', {
  profileVersion: 'protocol-handshake/v1', component: 'hanaworlds-canvas',
  // The advertised minor is the one the installed Contracts declare for canvas/v7: Canvas
  // implements every operation of that minor (including the session-world seam).
  protocols: [{ protocol: cellRequirement.protocol, major: cellRequirement.major,
    minor: canvasProtocol.minor }], capabilities: [...cellRequirement.capabilities],
  provenance: { packageName: 'hanaworlds-canvas', packageVersion: PACKAGE_VERSION,
    sourceRevision: null, artifactDigest: null } });
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
// canvas/v7 envelopes that carry guardRefusal beside error (Contracts 1.0.0-rc.4 relay): null
// unless the error is a guard refusal (Canvas's pre-flight GUARD_UNAVAILABLE or an engine
// refusal Canvas forwards unchanged).
const GUARDED_OPERATIONS = new Set(contractsSdk.operationContracts[WIRE]
  .filter(row => contractsSdk.schemaBundle.definitions[row.response].properties.guardRefusal)
  .map(row => row.operation));
function respond(operation, value) {
  return validateResponse(WIRE, operation, GUARDED_OPERATIONS.has(operation) &&
    !Object.hasOwn(value, 'guardRefusal') ? { ...value, guardRefusal: null } : value);
}
/** An Adapter receipt that reports an engine refusal (error + guardRefusal) as a thrown cause. */
function engineRefusal(receipt) {
  return Object.assign(new Error(receipt.error.code),
    { publicError: receipt.error, guardRefusal: receipt.guardRefusal });
}

/** Current local Canvas. Adapter is a public v6 port; it never decides history. */
export class CanvasV5 {
  constructor({ store, adapter, nativeFacts, worldFacts, sessions, config,
    emitEvent, adapterId = 'hanaworlds-world-adapter' }) {
    checkContractHandshake(contractHandshake);
    this.store = store;
    this.adapter = adapter;
    // Host-bound session/v5 port (Workshop). Its ReadSessionIdentity is the only evidence
    // that a Session exists; Canvas never infers that from a Ref.
    this.sessions = sessions;
    this.nativeFacts = nativeFacts;
    this.worldFacts = worldFacts;
    this.adapterId = adapterId;
    this.emitEvent = emitEvent;
    this.placementConfig = structuredClone(Config(config).placement);
    this.ready = Promise.resolve();
    this.storageState = store ? 'READY' : 'UNAVAILABLE';
    this.activeHistoryTransactions = new Set();
    this.historyRecoveryRuns = new Map();
  }
  get contractHandshake() { return structuredClone(contractHandshake); }
  /** @returns {import('hanaworlds-contracts').ProtocolHandshake} */
  get protocolHandshake() { return structuredClone(cellProtocolHandshake); }
  status() { return { component: 'hanaworlds-canvas', version: PACKAGE_VERSION,
    canvasContract: WIRE, adapterContract: ADAPTER, storage: this.storageState,
    productReadiness: 'UNPROVEN' }; }
  current(sessionRef) { return this.store?.snapshot.sessions[sessionRef] ?? null; }
  // Called during host startup, before any request can observe an old search policy.
  async syncPlacementSettings() {
    await this.store.commit(state => {
      for (const worldRef of Object.keys(state.placementSettings))
        this.#placementSettings(state, worldRef);
    });
  }
  #placementSettings(state, worldRef) {
    const previous = state.placementSettings[worldRef];
    const values = previous && Object.fromEntries(Object.keys(this.placementConfig)
      .map(key => [key, previous[key]]));
    if (same(values, this.placementConfig)) return;
    state.placementSettings[worldRef] = { ...this.placementConfig,
      settingsRevision: previous ? rev('placement') : 'placement-0' };
    if (!previous) return;
    for (const [id, row] of Object.entries(state.placementInspections))
      if (row.worldRef === worldRef) delete state.placementInspections[id];
    // An inspection replay cannot continue to return the old settings after a reload.
    for (const [id, row] of Object.entries(state.replay)) {
      const result = row.response?.result;
      const settings = result?.inspection?.placementSettings ?? result?.choice?.placementSettings;
      if (settings && same(settings, previous)) delete state.replay[id];
    }
  }
  /** Plugin-owned same-transaction query/recovery, scoped to its active Session and context. */
  async resolvePendingHistory(request) {
    await this.ready;
    const row = this.store?.snapshot.pending[request.transactionId] ??
      this.store?.snapshot.transactions[request.transactionId];
    const current = this.current(request.sessionRef);
    if (!row?.body || row.body.sessionRef !== request.sessionRef ||
        this.store.snapshot.retiredSessions?.[request.sessionRef] || !current ||
        current.activeWorldRef !== row.body.worldRef || !same(current.localContext, row.body.localContext))
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    await this.#identity({ ...row.body, requestId: `history-recovery-${randomUUID()}` });
    // An in-flight Apply owns its transaction until its outcome is processed.
    if (this.activeHistoryTransactions.has(request.transactionId))
      throw fail('TRANSACTION_CONFLICT', 'REVISION_CHANGED');
    return this.#resolveHistoryOutcome(request);
  }
  async #resolveHistoryOutcome(request) {
    const key = request.transactionId;
    if (this.historyRecoveryRuns.has(key)) return this.historyRecoveryRuns.get(key);
    const run = (async () => {
      try { return await resolveHistoryOutcome(this, request); }
      catch (error) {
        const row = this.store?.snapshot.pending[key];
        if (row?.body.sessionRef === request.sessionRef) {
          await this.store.commit(next => {
            if (next.pending[key]) next.pending[key].queryFailure = error.publicError?.code ?? error.message;
          });
          const pending = fail('RECOVERY_PENDING', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
          Object.assign(pending.publicError, { retryability: 'SAME_TRANSACTION_QUERY',
            mutationState: row.abortConfirmation?.mutationState === 'NONE' ? 'NONE' : 'UNKNOWN',
            transactionRef: key,
            causeCode: error.publicError?.causeCode ?? error.publicError?.code ?? 'TARGET_FACTS_INCOMPLETE' });
          throw pending;
        }
        throw error;
      }
    })();
    this.historyRecoveryRuns.set(key, run);
    try { return await run; } finally { this.historyRecoveryRuns.delete(key); }
  }
  /**
   * G3 write-before guard for the per-cell port: its ProtocolHandshake must name
   * world-adapter major 6 at the Contracts-declared minor with every world-adapter/v8
   * Adapter capability (callback-free-write, write-path-state-facts). Runs before any
   * reservation or Adapter call of a BUILD, Undo, Redo or region write.
   */
  adapterCompatible() {
    const advertised = this.adapter?.protocolHandshake;
    if (!this.adapter?.call || advertised === undefined)
      throw fail('UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
    return checkProtocolCompatibility(advertised, [ADAPTER_CELL_REQUIREMENT]);
  }
  /**
   * Canvas-own readback for one Session: for every write operation, the engine guard x stage
   * requirements and which of them the bound connection's declaration (engine-guards/v1, as last
   * read back at selection) does not cover. Read-only; each write re-reads the connection.
   */
  readEngineSafety(sessionRef) {
    const capabilities = this.store?.snapshot.connections?.[sessionRef]?.capabilities ?? null;
    const declaration = capabilities?.engineGuards ?? null;
    return structuredClone({ sessionRef, bound: capabilities !== null, declaration,
      operations: Object.entries(ENGINE_GUARD_REQUIREMENTS).map(([operation, required]) => {
        const unmet = unmetGuards(declaration, operation);
        return { operation, required: required.map(row => ({ ...row })), unmet,
          status: unmet.length ? 'CAPABILITY_UNAVAILABLE' : 'COVERED' };
      }) });
  }
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
      return { objectRef, worldRef, geometryProfile: 'voxel-grid/v1', footprintRevision: registered.footprintRevision,
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
    const recovery = Object.entries(s.pending)
      .filter(([, row]) => (row.body?.worldRef ?? row.worldRef) === worldRef)
      .map(([transactionId, row]) => ({ transactionId, mode: row.kind === 'REGION' ? 'REGION' : 'CELL',
        phase: row.phase, recoveryPending: row.phase === 'RESTORE_PENDING',
        receiptStatus: row.receiptStatus ?? null, guardRefusal: row.guardRefusal ?? null,
        restoreCode: row.restoreCode ?? null, causeCode: row.causeCode ?? null,
        // NONE requires the exact public Abort confirmation, never just the Apply error.
        // Keep the original failure separate from a later query/readback failure.
        mutationState: row.abortConfirmation?.mutationState === 'NONE' ? 'NONE' :
          row.queriedReceipt?.error?.mutationState ?? 'UNKNOWN',
        abortConfirmation: row.abortConfirmation ?? null,
        originalFailure: row.applyFailure ?? row.failure ?? null,
        queryFailure: row.queryFailure ?? null }))
      .sort((a, b) => a.transactionId.localeCompare(b.transactionId));
    const pending = recovery.length > 0;
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
          // canvas-region/v3 publishes ApplyRegionCommit and UndoRegionCommit only. A move is
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
    // Unfinished transactions of this World, including a rollback waiting for recovery.
    return structuredClone({ state: objects.length ? 'READY' : 'EMPTY', worldRef,
      worldRevision, localContext: session.localContext, objects, recovery });
  }
  /** Host port. A world-unavailability refusal names the request's own world (Contracts 2.7.0). */
  async readHistoryFacts(request) {
    try { return await this.#historyFacts(request); }
    catch (error) { throw nameTargetWorld(error, { worldRef: refOrUndefined(request?.worldRef) }); }
  }
  async #historyFacts(request) {
    const state = await this.#durable();
    this.#currentFacts(state, request, request?.worldRef);
    const origin = state.transactions[request?.originTransactionId];
    const head = origin ? state.history[origin.objectRef]?.at(-1) : null;
    // The origin of a history move is either the head itself (Undo) or the transaction the
    // head Undo row undid (Redo). historyRevision is the head's: the revision the move checks.
    const movable = head && (head.transactionId === request.originTransactionId ||
      head.originTransactionId === request.originTransactionId && this.#undoRow(head));
    if (!origin?.history || origin.worldRef !== request.worldRef ||
        origin.receipt.status !== 'VERIFIED' || !movable)
      throw fail('UNDO_CONFLICT', 'REVISION_CHANGED');
    const object = state.objects[request.worldRef]?.[origin.objectRef];
    const worldRevision = state.worldRevisions[request.worldRef];
    if (!object || !worldRevision) throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    return structuredClone({ current: true, durable: true, worldRef: request.worldRef,
      originTransactionId: request.originTransactionId,
      historyRevision: head.historyRevision, worldRevision,
      objectRevisions: { [origin.objectRef]: object.objectRevision },
      affectedObjectRefs: [...origin.history.affectedObjectRefs],
      originVerifiedReceiptDigest: origin.history.receiptDigest });
  }
  /** Host port. A world-unavailability refusal names the asked world (Contracts 2.7.0). */
  async readWorldRevision(worldRef) {
    try { return await this.#worldRevision(worldRef); }
    catch (error) { throw nameTargetWorld(error, { worldRef: refOrUndefined(worldRef) }); }
  }
  async #worldRevision(worldRef) {
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
      { publicError: response.error, guardRefusal: response.guardRefusal ?? null });
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
    return { replayKey, prior, admission, connection };
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
    const { replayKey, prior, admission, connection } = await this.#bound('AnalyzeAffectedObjects', body);
    if (prior) return prior.response;
    for (const effect of body.operations.effects) requireGeometryProfile(connection.capabilities.worldGeometry, effect.geometryProfile);
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
    const response = respond('AnalyzeAffectedObjects', answer(body, analysis));
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
    const { replayKey, prior, admission, connection } = await this.#bound('ApplyRecoverableCommit', body);
    if (prior) return prior.response;
    this.adapterCompatible();
    for (const effect of body.operations.effects) requireGeometryProfile(connection.capabilities.worldGeometry, effect.geometryProfile);
    requireGuards(connection.capabilities.engineGuards, 'ApplyRecoverableCommit');
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
          recorded.worldRef !== body.worldRef || !same(recorded.localContext, body.localContext))
        throw fail('INSPECTION_FAILED', 'REQUIRED_FACT_UNKNOWN');
      // Canvas's retained source and current revision, before scoped facts/reservation/write.
      checkConfirmedPlacementApply(body, inspection, this.store.snapshot.worldRevisions[body.worldRef]);
      if (recorded.worldRevision !== body.expectedWorldRevision ||
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
    // The NativeFacts port may throw a plain Error naming its code. A known public code is kept
    // (never re-labelled as a decode failure); anything else is the facts being unavailable.
    // The provider's own message stays on the error as nativeCause.
    let facts;
    try {
      facts = await this.nativeFacts.readScopedState(body.localContext.connectionRef, positions);
    } catch (error) {
      if (error?.publicError) throw error;
      const named = typeof error?.message === 'string' &&
        contractsSdk.schemaBundle.definitions.ErrorCode.enum.includes(error.message);
      throw Object.assign(fail(named ? error.message : 'TARGET_FACTS_INCOMPLETE',
        'REQUIRED_FACT_UNKNOWN'), { nativeCause: String(error?.message ?? error) });
    }
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
      if (adapterReceipt.status !== 'VERIFIED' && adapterReceipt.guardRefusal && adapterReceipt.error)
        throw engineRefusal(adapterReceipt);
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
          return effect ? expectedWrittenRecord(record, effect, actual.records[index], stateProfile) : record;
        }), stateProfile };
      const receipt = { ...adapterReceipt, contractVersion: WIRE,
        operationDigest: body.operationDigest,
        transactionPayloadDigest: prepared.transactionPayloadDigest,
        status: 'VERIFIED', restoreStatus: 'NOT_REQUIRED', error: null,
        guardRefusal: null, applyFailure: null,
        readbackDigest: hash('readback', actual), localContext: body.localContext };
      const objectRef = rev('object');
      const history = { transactionId: body.transactionId, originTransactionId: null,
        affectedObjectRefs: [objectRef], operationDigest: body.operationDigest,
        beforeImageDigest: prepared.beforeImageDigest,
        expectedAfterReadbackDigest: receipt.readbackDigest,
        receiptDigest: hash('receipt', receipt), historyRevision: rev('history'),
        status: 'VERIFIED' };
      validateCommitReadback(receipt, expected, actual, history);
      const response = respond('ApplyRecoverableCommit', answer(body, receipt));
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
        // A rollback caused by an engine refusal keeps that refusal and its error, unchanged.
        error: cause?.guardRefusal ? cause.publicError : restored.error ?? null,
        guardRefusal: cause?.guardRefusal ?? null, applyFailure: null,
        readbackDigest: hash('readback', actual), localContext: body.localContext };
      validateCommitReadback(receipt, withDerivedReadback(before, actual), actual, null);
      const response = respond(operation, answer(body, receipt));
      await this.store.commit(state => {
        state.transactions[body.transactionId] = { receipt, before, after: actual,
          worldRef: body.worldRef };
        if (receipt.observedWorldRevision)
          state.worldRevisions[body.worldRef] = receipt.observedWorldRevision;
        state.replay[replayKey] = { digest: requestHash, response };
        delete state.pending[body.transactionId];
      });
      return response;
    } catch (restoreError) {
      // G1: a rollback the engine could not finish (e.g. RESTORE_FAILED when a real body
      // blocks a solid target cell) is never reported as success or swallowed. The reservation
      // stays as an explicit, durable recovery-pending row and blocks the World.
      const restoreCode = restoreError?.publicError?.code ?? restoreError?.code ?? 'RESTORE_FAILED';
      let applyFailure = failureDetail(cause);
      // Adapter may report only RESTORE_FAILED on the write/restore call. Its durable
      // QueryTransaction receipt retains the restore guard and the original write failure.
      // Query once for this prepared payload; never infer those facts from the error code.
      if (restoreCode === 'RESTORE_FAILED') {
        try {
          const queried = await this.#adapter('QueryTransaction', {
            contractVersion: ADAPTER, sessionRef: body.sessionRef,
            requestId: `${body.requestId}:restore-receipt`, worldRef: body.worldRef,
            transactionId: body.transactionId,
            transactionPayloadDigest: prepared.transactionPayloadDigest,
            localContext: body.localContext });
          if (queried.status !== 'RESTORE_FAILED' ||
              queried.transactionId !== body.transactionId ||
              queried.operationDigest !== body.operationDigest ||
              queried.transactionPayloadDigest !== prepared.transactionPayloadDigest ||
              !same(queried.localContext, body.localContext))
            throw fail('TRANSACTION_MISMATCH', 'PAYLOAD_CHANGED');
          restoreError = engineRefusal(queried);
          applyFailure = queried.applyFailure;
        } catch (queryError) {
          restoreError.receiptRejected = queryError.publicError?.code ?? queryError.message;
        }
      }
      const causeCode = applyFailure.error.code;
      // An engine RESTORE_FAILED (phase restore, e.g. a guard at RESTORE) is answered with the
      // canvas/v7 RESTORE_FAILED receipt pending manual recovery: error.causeCode names the
      // failure that made the restore necessary, guardRefusal the restore's own reason and
      // applyFailure that causing failure in full. A receipt the Contracts reject is not repaired
      // and falls through to RECOVERY_PENDING below, with the rejection recorded.
      let response = null;
      const failure = restoreFailure(restoreError, applyFailure, body.transactionId);
      if (failure) {
        try {
          response = respond(operation, answer(body, {
            contractVersion: WIRE, transactionId: body.transactionId,
            operationDigest: body.operationDigest,
            transactionPayloadDigest: prepared.transactionPayloadDigest, status: 'RESTORE_FAILED',
            previousWorldRevision: body.expectedWorldRevision, observedWorldRevision: null,
            readbackDigest: null, restoreStatus: failure.error.mutationState === 'UNKNOWN' ?
              'UNKNOWN' : 'FAILED', error: failure.error, guardRefusal: failure.guardRefusal,
            applyFailure, localContext: body.localContext }));
        } catch (shapeError) {
          response = null;
          restoreError.receiptRejected = shapeError.publicError?.code ?? shapeError.message;
        }
      }
      await this.store.commit(state => {
        const row = state.pending[body.transactionId];
        if (row) Object.assign(row, { phase: 'RESTORE_PENDING', restoreCode, causeCode,
          receiptStatus: response ? 'RESTORE_FAILED' : 'RECOVERY_PENDING',
          guardRefusal: restoreError?.guardRefusal ?? null,
          receiptRejected: restoreError?.receiptRejected ?? null });
        if (response) state.replay[replayKey] = { digest: requestHash, response };
      });
      if (response) return response;
      const pending = fail('RECOVERY_PENDING', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
      pending.publicError.retryability = 'SAME_TRANSACTION_QUERY';
      pending.publicError.mutationState = 'UNKNOWN';
      pending.publicError.transactionRef = body.transactionId;
      pending.publicError.causeCode = restoreCode;
      pending.cause = cause;
      throw pending;
    }
  }
  /** Undo and Redo share one history-transaction path; only the target image differs. */
  async #history(operation, body) {
    const { replayKey, prior, admission, connection } = await this.#bound(operation, body);
    if (prior) return prior.response;
    this.adapterCompatible();
    requireGuards(connection.capabilities.engineGuards, operation);
    const redo = operation === 'Redo';
    const state = this.store.snapshot;
    const origin = state.transactions[body.historyTransactionId];
    const object = state.objects[body.worldRef]?.[body.objectRef];
    const historyRows = state.history[body.objectRef] ?? [];
    const head = historyRows.at(-1);
    // A region transaction is undone as a whole region through hanaworldsCanvasRegionV1;
    // canvas-region/v3 defines no region Redo.
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
    for (const record of [...expectedCurrent.records, ...target.records])
      requireGeometryProfile(connection.capabilities.worldGeometry, record.geometryProfile);
    const current = await this.#read({ ...body,
      transactionId: body.historyTransactionId }, positions, stateProfile,
    redo ? 'before-redo' : 'before-undo');
    if (!same(current, withDerivedReadback(expectedCurrent, current))) throw redo ?
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
    this.activeHistoryTransactions.add(body.transactionId);
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
      if (adapterReceipt.status !== 'VERIFIED' && adapterReceipt.guardRefusal && adapterReceipt.error)
        throw engineRefusal(adapterReceipt);
      if (adapterReceipt.status !== 'VERIFIED') {
        // ROLLED_BACK and RESTORE_FAILED are valid outcomes, not malformed successful receipts.
        // Query/readback their exact outcome; never invent an ErrorCode for their status.
        throw Object.assign(new Error(adapterReceipt.error?.code ?? 'APPLY_FAILED'), {
          publicError: adapterReceipt.error ?? fail('APPLY_FAILED', 'APPLY_ERROR', 'apply').publicError,
          guardRefusal: adapterReceipt.guardRefusal ?? null });
      }
      if (adapterReceipt.previousWorldRevision !== body.expectedWorldRevision ||
          adapterReceipt.transactionPayloadDigest !== prepared.transactionPayloadDigest)
        throw fail('REPLAY_MISMATCH', 'PAYLOAD_CHANGED');
      await this.store.commit(next => { next.pending[body.transactionId].phase = 'APPLIED'; });
      const actual = await this.#read(body, positions, stateProfile,
        redo ? 'after-redo' : 'after-undo');
      const receipt = { ...adapterReceipt, contractVersion: WIRE,
        transactionId: body.transactionId, operationDigest: historyOperationDigest,
        transactionPayloadDigest: prepared.transactionPayloadDigest,
        status: 'VERIFIED', restoreStatus: 'NOT_REQUIRED', error: null,
        guardRefusal: null, applyFailure: null,
        readbackDigest: hash('readback', actual), localContext: body.localContext };
      const history = { transactionId: body.transactionId,
        originTransactionId: body.historyTransactionId,
        affectedObjectRefs: [body.objectRef], operationDigest: historyOperationDigest,
        beforeImageDigest: prepared.beforeImageDigest,
        expectedAfterReadbackDigest: receipt.readbackDigest,
        receiptDigest: hash('receipt', receipt), historyRevision: rev('history'),
        status: 'VERIFIED' };
      validateCommitReadback(receipt, withDerivedReadback(target, actual), actual, history);
      const response = respond(operation, answer(body, receipt));
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
      // Never Restore from a lost/error reply: the exact public query decides whether it
      // remained prepared, completed, or still has an unknown outcome. No new transaction.
      await this.store.commit(next => {
        Object.assign(next.pending[body.transactionId], { failure: failureDetail(error),
          causeCode: error.publicError?.code ?? 'TARGET_FACTS_INCOMPLETE',
          phase: 'RESTORE_PENDING', receiptStatus: 'RECOVERY_PENDING' });
      });
      return (await this.#resolveHistoryOutcome({ sessionRef: body.sessionRef,
        transactionId: body.transactionId })).response;
    } finally { this.activeHistoryTransactions.delete(body.transactionId); }
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
    // C1: ReadWorldSelectionContext.worldRef names whose inventory is returned; it never
    // selects, and a BOUND Session may have another current world.
    if (!inventory) throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    const identity = operation === 'ReadWorldSelectionContext' && !selection ?
      await this.#identity(body) : null;
    if (operation === 'ListWorldConnections' &&
        body.expectedCapabilityRevision !== inventory.capabilityRevision)
      throw fail('STALE_REVISION');
    // WorldSelectionContext carries only the requested world's connections (contracts
    // domain rule); the Adapter inventory may list several worlds.
    const result = operation === 'ReadWorldSelectionContext' ? {
      sessionRef: body.sessionRef, worldRef: body.worldRef,
      inventory: { capabilityRevision: inventory.capabilityRevision,
        connections: inventory.connections.filter(row => row.worldRef === body.worldRef) },
      selection: selection ? { status: 'BOUND', context: selection,
        connectionRef: selection.localContext.connectionRef } :
        { status: 'UNBOUND', sessionRef: body.sessionRef,
          sessionRevision: identity.sessionRevision }
    } : inventory;
    const response = respond(operation, answer(body, result));
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
    const response = respond('ListObjects', answer(body, result));
    return this.#remember(replayKey, admission.requestDigest, response);
  }
  async #inspectPlacementRegion(body) {
    const { replayKey, prior, admission, connection } = await this.#bound('InspectPlacementRegion', body);
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
    validatePlacementRegionRequest(body, connection);
    const worldRevision = state.worldRevisions[body.worldRef];
    const inspectionId = rev('inspection');
    const result = await this.#adapter('InspectRegion', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:region`, worldRef: body.worldRef,
      expectedWorldRevision: worldRevision, inspectionId,
      anchor: body.anchor, footprint: { widthCells: body.footprint.widthCells,
        depthCells: body.footprint.depthCells, heightCells: body.footprint.heightCells },
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
    const response = validatePlacementRegionResponse(body, respond('InspectPlacementRegion',
      { ...answer(body, result), unavailableSettings: null }), connection);
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
    const response = respond('Readback', answer(body, saved.receipt));
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
    const response = respond('InspectObject', answer(body, result));
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
    const response = respond('SetObjectSelection', answer(body, result));
    await this.store.commit(state => {
      const current = state.sessions[body.sessionRef];
      if (!current || current.selectionRevision !== body.expectedSelectionRevision)
        throw fail('STALE_REVISION');
      current.orderedSelectedObjectRefs = [...body.objectRefs];
      current.selectionRevision = selectionRevision;
      // sessionRevision is Workshop's revision; Canvas does not change it.
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
    const response = respond('HistoryQuery', answer(body, result));
    return this.#remember(replayKey, admission.requestDigest, response);
  }
  async #select(body) {
    const { replayKey, prior, facts } = this.#facts(body, 'SelectWorldConnection');
    const admission = validateCurrentRequest(WIRE, 'SelectWorldConnection', body, facts);
    if (prior) return prior.response;
    const previous = this.current(body.sessionRef);
    const identity = await this.#identity(body);
    this.#worldOpen(this.store.snapshot, body.worldRef);
    // Bound: the published selectionRevision. Unbound: the published UNBOUND sessionRevision
    // (Workshop's SessionIdentity.sessionRevision).
    const unbound = identity.sessionRevision;
    if (body.expectedRevision !== (previous ? previous.selectionRevision : unbound))
      throw fail('STALE_REVISION');
    const connection = await this.#adapter('ReadLocalConnection', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:connection`, connectionRef: body.connectionRef });
    validateWorldSelection(body, facts, connection);
    const inventory = await this.#inventoryFor(body, connection, body.worldRef);
    const selectionRevision = rev('selection');
    const current = { currentSession: body.sessionRef, activeWorldRef: body.worldRef,
      orderedSelectedObjectRefs: [],
      sessionRevision: identity.sessionRevision,
      selectionRevision, localContext: this.#context(connection, selectionRevision) };
    const response = respond('SelectWorldConnection', answer(body, current));
    await this.#commitSelection(body, previous, current, connection, inventory,
      replayKey, admission, response);
    const oldConnection = previous?.localContext;
    if (!oldConnection || oldConnection.worldRef !== connection.worldRef ||
        oldConnection.connectionRef !== connection.connectionRef ||
        oldConnection.connectionIncarnationRef !== connection.connectionIncarnationRef)
      await this.#publishSelectionEvent('WorldConnectionSelectionChanged', 'SelectWorldConnection', response);
    return response;
  }
  /**
   * canvas/v7 SwitchWorldConnection: the bound Session moves from its current world to
   * `toWorldRef` over `toConnectionRef`. Canvas alone decides it: CAS on the published
   * selectionRevision (the same convention as SelectWorldConnection) and on the current
   * localContext (`expectedContext`), the target connection's actual readback and
   * inventory row, and no unfinished transaction of this Session. currentSession is
   * kept; a different world clears the object selection (canvasEventRules
   * ActiveWorldChanged). Other Sessions' selections are untouched.
   */
  async #switch(body) {
    const { replayKey, prior, facts } = this.#facts(body, 'SwitchWorldConnection');
    const admission = validateCurrentRequest(WIRE, 'SwitchWorldConnection', body, facts);
    if (prior) return prior.response;
    const previous = this.current(body.sessionRef);
    if (!previous) throw fail('WORLD_NOT_BOUND', 'SCOPE_DENIED');
    if (previous.activeWorldRef !== body.fromWorldRef || body.worldRef !== body.fromWorldRef)
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    const identity = await this.#identity(body);
    this.#worldOpen(this.store.snapshot, body.toWorldRef);
    if (body.expectedRevision !== previous.selectionRevision) throw fail('STALE_REVISION');
    if (Object.values(this.store.snapshot.pending)
      .some(row => row.body?.sessionRef === body.sessionRef))
      throw fail('TRANSACTION_CONFLICT');
    const connection = await this.#adapter('ReadLocalConnection', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:connection`, connectionRef: body.toConnectionRef });
    if (connection.connectionRef !== body.toConnectionRef ||
        connection.worldRef !== body.toWorldRef ||
        connection.capabilities.worldRef !== connection.worldRef)
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    const inventory = await this.#inventoryFor(body, connection, body.toWorldRef);
    const selectionRevision = rev('selection');
    const sameWorld = body.toWorldRef === body.fromWorldRef;
    const current = { currentSession: body.sessionRef, activeWorldRef: body.toWorldRef,
      orderedSelectedObjectRefs: sameWorld ? [...previous.orderedSelectedObjectRefs] : [],
      sessionRevision: identity.sessionRevision, selectionRevision,
      localContext: this.#context(connection, selectionRevision) };
    const response = respond('SwitchWorldConnection', answer(body, current));
    await this.#commitSelection(body, previous, current, connection, inventory,
      replayKey, admission, response);
    if (!sameWorld)
      await this.#publishSelectionEvent('ActiveWorldChanged', 'SwitchWorldConnection', response);
    return response;
  }
  /** Observers receive a validated immutable receipt only after the fsynced commit. */
  async #publishSelectionEvent(event, operation, receipt) {
    const payload = contractsSdk.validateCanvasEvent(event,
      { contractVersion: WIRE, event, operation, receipt });
    try { await this.emitEvent?.(payload); }
    catch (error) {
      // A consumer failure cannot turn a successful durable selection into a failed call.
      // Surface it separately; never retry the event or the already committed operation.
      console.error('Canvas selection event delivery failed', event, error);
    }
  }
  #context(connection, selectionRevision) {
    return { connectionRef: connection.connectionRef,
      connectionIncarnationRef: connection.connectionIncarnationRef,
      worldRef: connection.worldRef, selectionRevision };
  }
  /** The Adapter's inventory row must match the connection readback exactly. */
  async #inventoryFor(body, connection, worldRef) {
    const inventory = await this.#adapter('DiscoverConnections', {
      contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:discover`, adapterId: this.adapterId });
    const descriptor = inventory.connections.find(row =>
      row.connectionRef === connection.connectionRef);
    if (!descriptor || descriptor.worldRef !== worldRef ||
        descriptor.connectionIncarnationRef !== connection.connectionIncarnationRef ||
        descriptor.payloadVersion !== connection.payloadVersion ||
        descriptor.capabilityRevision !== connection.capabilities.capabilityRevision)
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    return inventory;
  }
  async #commitSelection(body, previous, current, connection, inventory, replayKey,
    admission, response) {
    const worldRef = current.activeWorldRef;
    await this.store.commit(state => {
      if (state.sessions[body.sessionRef]?.selectionRevision !== previous?.selectionRevision)
        throw fail('STALE_REVISION');
      // Serialized with ReserveWorldRetirement in the same durable commit order.
      this.#worldOpen(state, worldRef);
      if (previous?.activeWorldRef !== worldRef) {
        if (previous) this.#bumpWorld(state, previous.activeWorldRef);
        this.#bumpWorld(state, worldRef);
      }
      state.sessions[body.sessionRef] = current;
      state.connections[body.sessionRef] = connection;
      state.connectionInventories[body.sessionRef] = inventory;
      state.worldRevisions[worldRef] ??= 'world-0';
      this.#placementSettings(state, worldRef);
      state.replay[replayKey] = { digest: admission.requestDigest, response };
    });
  }
  /** G-S: the Session's identity from Workshop's Host-bound session/v5 port. */
  async #identity(body) {
    if (typeof this.sessions?.call !== 'function')
      throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    const request = { contractVersion: SESSION, requestId: `${body.requestId}:session`,
      sessionRef: body.sessionRef };
    const response = await this.sessions.call('ReadSessionIdentity', request);
    validateBoundResponse(SESSION, 'ReadSessionIdentity', request, response);
    if (response.error) throw Object.assign(new Error(response.error.code),
      { publicError: response.error });
    if (response.result.sessionRef !== body.sessionRef) throw fail('SESSION_NOT_FOUND', 'SCOPE_DENIED');
    return response.result;
  }
  #worldRow(state, worldRef) {
    return state.worldSelections?.[worldRef] ??
      { inventoryRevision: 'inventory-0', reservationRef: null, retired: false, lastRelease: null };
  }
  /** A retired world is unknown; a world under retirement reservation cannot be selected. */
  #worldOpen(state, worldRef) {
    const row = this.#worldRow(state, worldRef);
    if (row.retired) throw fail('WORLD_NOT_FOUND', 'SCOPE_DENIED');
    if (row.reservationRef !== null) throw fail('TRANSACTION_CONFLICT', 'SCOPE_DENIED');
  }
  #bumpWorld(state, worldRef) {
    state.worldSelections ??= {};
    state.worldSelections[worldRef] ??= { inventoryRevision: 'inventory-0',
      reservationRef: null, retired: false, lastRelease: null };
    state.worldSelections[worldRef].inventoryRevision = rev('inventory');
  }
  /** G-D: derived from the one selection table (sessions); no second association table. */
  #worldInventory(state, worldRef) {
    const row = this.#worldRow(state, worldRef);
    return { worldRef, inventoryRevision: row.inventoryRevision,
      sessionRefs: Object.keys(state.sessions)
        .filter(sessionRef => state.sessions[sessionRef].activeWorldRef === worldRef).sort(),
      retirementReservationRef: row.reservationRef };
  }
  async #listWorldSelections(body) {
    const state = this.store.snapshot;
    if (this.#worldRow(state, body.worldRef).retired) throw fail('WORLD_NOT_FOUND', 'SCOPE_DENIED');
    return respond('ListWorldSelections',
      answer(body, this.#worldInventory(state, body.worldRef)));
  }
  async #reserveWorld(body) {
    const check = state => {
      if (this.#worldRow(state, body.worldRef).retired) throw fail('WORLD_NOT_FOUND', 'SCOPE_DENIED');
      const inventory = this.#worldInventory(state, body.worldRef);
      contractsSdk.requireWorldRetirable(inventory);
      if (inventory.inventoryRevision !== body.expectedInventoryRevision) throw fail('STALE_REVISION');
      return inventory;
    };
    const inventory = check(this.store.snapshot);
    const result = { worldRef: body.worldRef, reservationRef: rev('retirement'),
      inventoryRevision: inventory.inventoryRevision };
    const response = respond('ReserveWorldRetirement', answer(body, result));
    await this.store.commit(state => {
      check(state);
      state.worldSelections ??= {};
      state.worldSelections[body.worldRef] ??= { inventoryRevision: 'inventory-0',
        reservationRef: null, retired: false, lastRelease: null };
      state.worldSelections[body.worldRef].reservationRef = result.reservationRef;
    });
    return response;
  }
  async #releaseWorld(body) {
    const row = this.#worldRow(this.store.snapshot, body.worldRef);
    // An exact repeat of the release already applied returns that release, never a second one.
    if (row.lastRelease?.reservationRef === body.reservationRef &&
        row.lastRelease.outcome === body.outcome)
      return respond('ReleaseWorldRetirement', answer(body, row.lastRelease));
    if (row.retired) throw fail('WORLD_NOT_FOUND', 'SCOPE_DENIED');
    if (row.reservationRef !== body.reservationRef) throw fail('STALE_REVISION');
    const result = { worldRef: body.worldRef, reservationRef: body.reservationRef,
      outcome: body.outcome, inventoryRevision: rev('inventory') };
    const response = respond('ReleaseWorldRetirement', answer(body, result));
    await this.store.commit(state => {
      const current = state.worldSelections?.[body.worldRef];
      if (!current || current.reservationRef !== body.reservationRef) throw fail('STALE_REVISION');
      current.reservationRef = null;
      current.retired = body.outcome === 'RETIRED';
      current.inventoryRevision = result.inventoryRevision;
      current.lastRelease = result;
    });
    return response;
  }
  /** G-U: the bound Session returns to UNBOUND; CAS on selectionRevision and expectedContext. */
  async #unselect(body) {
    const { replayKey, prior, facts } = this.#facts(body, 'UnselectWorldConnection');
    const previous = this.current(body.sessionRef);
    if (!prior && (!previous || previous.activeWorldRef !== body.worldRef))
      throw fail('WORLD_NOT_BOUND', 'SCOPE_DENIED');
    const admission = validateCurrentRequest(WIRE, 'UnselectWorldConnection', body, facts);
    if (prior) return prior.response;
    if (body.expectedRevision !== previous.selectionRevision) throw fail('STALE_REVISION');
    if (Object.values(this.store.snapshot.pending)
      .some(row => row.body?.sessionRef === body.sessionRef))
      throw fail('TRANSACTION_CONFLICT');
    const current = { currentSession: body.sessionRef, activeWorldRef: null,
      orderedSelectedObjectRefs: [], sessionRevision: previous.sessionRevision,
      selectionRevision: rev('selection'), localContext: null };
    const response = respond('UnselectWorldConnection', answer(body, current));
    await this.store.commit(state => {
      if (state.sessions[body.sessionRef]?.selectionRevision !== previous.selectionRevision)
        throw fail('STALE_REVISION');
      delete state.sessions[body.sessionRef];
      delete state.connections[body.sessionRef];
      delete state.connectionInventories[body.sessionRef];
      this.#bumpWorld(state, previous.activeWorldRef);
      state.replay[replayKey] = { digest: admission.requestDigest, response };
    });
    return response;
  }
  /**
   * G-L: Workshop calls this only after its provider confirmed persistent deletion support
   * (requireSessionDeleteSupported), before deleting. Canvas atomically clears any selection
   * and from then on answers SESSION_NOT_FOUND for this sessionRef. Irreversible. Canvas
   * never deletes a Session and never reports one deleted.
   */
  async #retire(body) {
    const { replayKey, prior, facts } = this.#facts(body, 'RetireSessionSelection');
    const admission = validateCurrentRequest(WIRE, 'RetireSessionSelection', body, facts);
    if (prior) return prior.response;
    const retired = this.store.snapshot.retiredSessions?.[body.sessionRef];
    // Already retired (e.g. Workshop retrying after a failed deletion): same retirement.
    if (retired) return respond('RetireSessionSelection', answer(body,
      { sessionRef: body.sessionRef, releasedWorldRef: null,
        selectionRevision: retired.selectionRevision }));
    if (Object.values(this.store.snapshot.pending)
      .some(row => row.body?.sessionRef === body.sessionRef))
      throw fail('TRANSACTION_CONFLICT');
    const previous = this.current(body.sessionRef);
    const result = { sessionRef: body.sessionRef,
      releasedWorldRef: previous ? previous.activeWorldRef : null,
      selectionRevision: rev('selection') };
    const response = respond('RetireSessionSelection', answer(body, result));
    await this.store.commit(state => {
      if (state.sessions[body.sessionRef]?.selectionRevision !== previous?.selectionRevision ||
          state.retiredSessions?.[body.sessionRef]) throw fail('STALE_REVISION');
      delete state.sessions[body.sessionRef];
      delete state.connections[body.sessionRef];
      delete state.connectionInventories[body.sessionRef];
      if (previous) this.#bumpWorld(state, previous.activeWorldRef);
      state.retiredSessions ??= {};
      state.retiredSessions[body.sessionRef] = { selectionRevision: result.selectionRevision };
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
      // G-L: a retired Session is unknown to every Canvas operation but its own retirement.
      if (body.sessionRef !== undefined && operation !== 'RetireSessionSelection' &&
          this.store.snapshot.retiredSessions?.[body.sessionRef])
        throw fail('SESSION_NOT_FOUND', 'SCOPE_DENIED');
      if (operation === 'SelectWorldConnection') return await this.#select(body);
      if (operation === 'UnselectWorldConnection') return await this.#unselect(body);
      if (operation === 'RetireSessionSelection') return await this.#retire(body);
      if (operation === 'ListWorldSelections') return await this.#listWorldSelections(body);
      if (operation === 'ReserveWorldRetirement') return await this.#reserveWorld(body);
      if (operation === 'ReleaseWorldRetirement') return await this.#releaseWorld(body);
      if (operation === 'SwitchWorldConnection') return await this.#switch(body);
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
      const failure = error.publicError ?? publicError(error);
      // Contracts 2.7.0: only an admitted request may name its target world; an undecoded raw
      // selector is never echoed.
      const response = answer(body ?? { requestId: raw?.requestId ?? 'invalid-request' }, null,
        body ? withTargetWorld(failure, body, trustedSessionWorld(this.store, body)) : failure);
      // Guard refusals (pre-flight or forwarded from the Adapter) travel with their error.
      if (GUARDED_OPERATIONS.has(operation)) response.guardRefusal = error.guardRefusal ?? null;
      return operation === 'InspectPlacementRegion' ?
        { ...response, unavailableSettings: error.unavailableSettings ?? null } : response;
    }
  }
}

export const name = 'hanaworlds-canvas';
export const inject = [];
export const STORE_ROOT = 'hanaworlds-canvas-v2';
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
  // New root for the 1.x store; the 0.x root (data/hanaworlds-canvas) is left untouched.
  const directory = join(root, 'data', STORE_ROOT);
  if (homePath('data', STORE_ROOT) !== directory)
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
export function apply(ctx, config) {
  const service = new CanvasV5({ store: null, config,
    // Cordis parallel dispatch settles every consumer (including async listeners), and its
    // fiber-owned ctx.on subscriptions are removed on disposal. No private bridge import.
    emitEvent: event => ctx.parallel?.(event.event, event),
    adapter: {
      get protocolHandshake() { return ctx.get?.('hanaworldsWorldAdapterV6')?.protocolHandshake; },
      // No Adapter service on the Host (world not started) is the world being unavailable,
      // never an undecodable Adapter response.
      call: (...args) => {
        const port = ctx.get?.('hanaworldsWorldAdapterV6');
        if (typeof port?.call !== 'function') throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
        return port.call(...args);
      } },
    // Workshop's published session/v5 provider (public service key hanaworldsWorkshopV3,
    // one WorkshopV3 instance; Workshop 0.4.12 4547f3cf). Read on every call, so a disposed
    // provider is absent → fail closed. No other key is tried.
    sessions: { call: (...args) => {
      const port = ctx.get?.('hanaworldsWorkshopV3');
      if (typeof port?.call !== 'function') throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
      return port.call(...args);
    } },
    nativeFacts: { readScopedState: (...args) => {
      const current = ctx.get?.('hanaworldsLuantiNativeFacts');
      if (typeof current?.readScopedState !== 'function')
        throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
      return current.readScopedState(...args);
    } },
    // C-world-facts (world-facts/v1) of the bound World's source, under the Host key the world
    // source publishes (the same neutral key the desktop bridge reads). Read on every call; no
    // engine-named service is consulted. Absent → the supply names WORLD_FACTS_PORT_ABSENT.
    worldFacts: {
      get protocolHandshake() { return ctx.get?.('hanaworldsWorldFacts')?.protocolHandshake; },
      get contractHandshake() { return ctx.get?.('hanaworldsWorldFacts')?.contractHandshake; },
      get call() {
        const current = ctx.get?.('hanaworldsWorldFacts');
        return typeof current?.call === 'function' ? (...args) => current.call(...args) : undefined;
      } } });
  ctx.provide?.('hanaworldsCanvasV5', service);
  // Host service names are Canvas's choice; the wire shapes are Contracts canvas-/world-adapter-region/v3.
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
  // Stage 1 validation configuration supply: the CompilerConfig consumer key and Canvas's own
  // provenance/revision/invalidation readback. Canvas provides no SafetyProfile service.
  const supply = new CanvasConfigSupply(service);
  ctx.provide?.('hanaworldsCompilerConfig', { read: worldRef => supply.readCompilerConfig(worldRef) });
  ctx.provide?.('hanaworldsCanvasConfigSupply', { read: worldRef => supply.read(worldRef) });
  // One Loader entry per package; the display binds inside Canvas's own fiber.
  ctx.inject?.(['typert'], async displayCtx => {
    const display = await import('./display-host.mjs');
    display.apply(displayCtx);
  });
  service.storageState = 'INITIALIZING';
  service.ready = (async () => {
    try { service.store = await CanvasStore.open(await nativeDirectory(ctx));
      await service.syncPlacementSettings();
      service.storageState = 'READY'; }
    catch { service.storageState = 'UNAVAILABLE'; }
  })();
  return service;
}
export default { name, inject, Config, apply };
