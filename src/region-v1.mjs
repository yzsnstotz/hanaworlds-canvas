import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip, constants as zlib } from 'node:zlib';
import { canonicalJSON, checkProtocolCompatibility, comparePosition, contractProtocols, digestValue,
  expandRegionBlock, expectedRegionSummary, protocolRequirement, publicError,
  regionBlockBox, regionCapabilities, requireKnownRegion, guardRefusalError,
  summarizeRegionStates, unmetEngineGuards,
  validateBoundResponse, validateDigestBinding, validateRegionCommit, validateRegionRead,
  validateRegionSnapshotContent, validateRegionUndo, validateRegionWrite, validateRequest,
  validateResponse, validateType } from 'hanaworlds-contracts';

/*
 * canvas-region/v2 over the public Contracts 1.x region v2 shapes.
 * Canvas is the only transaction decider. The Adapter region port only reads
 * and writes mapblock chunks (world-adapter-region/v2) and advertises its own
 * ProtocolHandshake; compatibility is protocol major + minor + required capabilities.
 */
export const REGION_WIRE = 'canvas-region/v2';
export const REGION_ADAPTER = 'world-adapter-region/v2';
const ADAPTER = 'world-adapter/v7';
const PACKAGE_VERSION = '0.10.1';
export const CANVAS_REGION_CAPABILITIES = Object.freeze(regionCapabilities
  .filter(c => c.owner === 'hanaworlds-canvas').map(c => c.id).sort());
// A capability id is scoped by its wire ("<wire>:<name>"). Each Adapter requirement takes
// only its own wire's ids, at the minor the Contracts declare for that protocol, and is
// checked against the handshake of that port (G3: world-adapter/v7:* on the per-cell port,
// world-adapter-region/v2:* on the region port).
const ADAPTER_CAPABILITIES = regionCapabilities
  .filter(c => c.owner === 'hanaworlds-adapter-luanti').map(c => c.id);
const adapterRequirement = wire => {
  const declared = contractProtocols.find(p => `${p.protocol}/v${p.major}` === wire);
  if (!declared) throw new Error(`CANVAS_ADAPTER_PROTOCOL_UNDECLARED:${wire}`);
  return protocolRequirement(wire, ADAPTER_CAPABILITIES.filter(id => id.startsWith(`${wire}:`)),
    declared.minor);
};
export const ADAPTER_REGION_REQUIREMENT = adapterRequirement(REGION_ADAPTER);
export const ADAPTER_CELL_REQUIREMENT = adapterRequirement(ADAPTER);
{
  const unscoped = ADAPTER_CAPABILITIES.filter(id =>
    !id.startsWith(`${REGION_ADAPTER}:`) && !id.startsWith(`${ADAPTER}:`));
  if (unscoped.length) throw new Error(`CANVAS_ADAPTER_CAPABILITY_UNSCOPED:${unscoped.join(',')}`);
}
/*
 * Engine guards each Canvas write operation needs, as Contracts engine-guards/v1 guard x stage
 * requirements against the loaded payload's declaration (PublicCapabilities.engineGuards of the
 * current connection). A stage the declaration does not list is not covered; nothing is inferred
 * from a name, a version or another stage. Canvas's choice of stages (its judgment):
 * - every forward write stage needs all three guards (BODY_CLEARANCE, CELL_PROTECTION,
 *   PLAYER_ENCLOSURE);
 * - the rollback restore of a failed write needs BODY_CLEARANCE and CELL_PROTECTION (it reinstates
 *   the verified before image right after the attempt);
 * - a region Undo is a forward action that writes through REGION_RESTORE, so it needs all three;
 * - CELL_PROTECTION takes the declared protectionPrincipal as it is (ANONYMOUS satisfies it;
 *   no acting-principal source exists in this major).
 */
const ALL = ['BODY_CLEARANCE', 'CELL_PROTECTION', 'PLAYER_ENCLOSURE'];
const ROLLBACK = ['BODY_CLEARANCE', 'CELL_PROTECTION'];
const needs = (stages, guards) => stages.flatMap(stage => guards.map(guard => ({ guard, stage })));
export const ENGINE_GUARD_REQUIREMENTS = Object.freeze(Object.fromEntries(Object.entries({
  ApplyRecoverableCommit: [...needs(['PREPARE_RECOVERABLE', 'APPLY_COMPILED'], ALL),
    ...needs(['RESTORE'], ROLLBACK)],
  Undo: [...needs(['PREPARE_HISTORY', 'APPLY_HISTORY'], ALL), ...needs(['RESTORE'], ROLLBACK)],
  Redo: [...needs(['PREPARE_HISTORY', 'APPLY_HISTORY'], ALL), ...needs(['RESTORE'], ROLLBACK)],
  ApplyRegionCommit: [...needs(['REGION_APPLY'], ALL), ...needs(['REGION_RESTORE'], ROLLBACK)],
  UndoRegionCommit: needs(['REGION_RESTORE'], ALL),
  RecoverRegion: needs(['REGION_RESTORE'], ROLLBACK),
}).map(([operation, rows]) => [operation, Object.freeze(rows.map(row => Object.freeze(row)))])));
/** Uncovered guard x stage requirements of `operation` as Contracts GUARD_UNAVAILABLE refusals. */
export function unmetGuards(declaration, operation) {
  return unmetEngineGuards(declaration ?? null, ENGINE_GUARD_REQUIREMENTS[operation])
    .map(refusal => ({ ...refusal }));
}
/**
 * Pre-flight refusal of `operation` before any reservation or write when the current
 * connection's declaration does not cover a needed guard x stage. The public Error is
 * guardRefusalError(first refusal, preflight); every uncovered refusal stays on the error.
 */
export function requireGuards(declaration, operation, transactionRef = null) {
  const unmet = unmetGuards(declaration, operation);
  if (!unmet.length) return;
  const error = regionFail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
  error.publicError = { ...guardRefusalError(unmet[0], { preflight: true, transactionRef }) };
  error.guardRefusal = unmet[0];
  error.unmetGuards = unmet;
  throw error;
}
export const SNAPSHOT_COMPRESSION = 'gzip'; // RFC 1952 via Node zlib
const gz = promisify(gzip);
const gunz = promisify(gunzip);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const D = (kind, value) => digestValue(kind, value).sha256;
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const rev = prefix => `${prefix}-${randomUUID()}`;
const key = position => position.join(',');
// Any unfinished Canvas transaction (cell or region) on the same world blocks a new reservation.
const inFlight = (state, worldRef) => Object.values(state.pending)
  .some(row => row.body?.worldRef === worldRef);

export const canvasProtocolHandshake = Object.freeze(validateType('ProtocolHandshake', {
  profileVersion: 'protocol-handshake/v1', component: 'hanaworlds-canvas',
  protocols: [{ protocol: 'canvas-region', major: 2, minor: 0 }],
  capabilities: [...CANVAS_REGION_CAPABILITIES],
  provenance: { packageName: 'hanaworlds-canvas', packageVersion: PACKAGE_VERSION,
    sourceRevision: null, artifactDigest: null } }));

/** Self-description for the skill: purpose, typical scale and prerequisites, no thresholds. */
export const regionToolDescription = Object.freeze({
  tool: 'canvas.region',
  operations: ['ApplyRegionCommit', 'UndoRegionCommit'],
  purpose: 'Commit one compiled region (fill and explicit air carve) across mapblocks ' +
    'as one logical transaction, and undo that whole region in one step.',
  typicalScale: 'Terrain shaping and large fills or carves spanning several 16x16x16 ' +
    'mapblocks. Cell-by-cell BUILD with per-cell Undo stays the tool for fine ' +
    'adjustment; which one to use is the skill\'s choice.',
  prerequisites: ['a current world connection selected in Canvas',
    'region operations compiled by Brush (region-operations/v1) with their digest',
    'no registered object footprint inside the specified cells',
    'every touched mapblock KNOWN after Adapter load',
    'Adapter advertising world-adapter-region major 1 and world-adapter major 6 at the ' +
      'Contracts-declared minors with every Adapter capability of that wire'],
  unspecifiedCells: 'left untouched; only an explicit air palette entry carves',
});

export function regionFail(code, reason = 'REVISION_CHANGED', phase = 'validate') {
  const error = new Error(code);
  error.publicError = { code, phase, retryability: 'AFTER_NEW_FACTS',
    mutationState: 'NONE', transactionRef: null, causeCode: null, reason };
  return error;
}
const fail = regionFail;

/**
 * A restore the engine refused (RESTORE_FAILED, e.g. a guard at RESTORE/REGION_RESTORE) as the
 * public pending-manual-recovery outcome: error = the restore failure whose causeCode names the
 * failure that made the restore necessary; guardRefusal = the restore's own reason; applyFailure =
 * that causing failure in full. Any other restore outcome returns null (RECOVERY_PENDING).
 */
export function failureDetail(cause) {
  const error = cause?.publicError ?? { code: 'APPLY_FAILED', phase: 'apply',
    retryability: 'AFTER_NEW_FACTS', mutationState: 'UNKNOWN', transactionRef: null,
    causeCode: null, reason: 'APPLY_ERROR' };
  return { error: validateType('Error', error), guardRefusal: cause?.guardRefusal ?? null };
}
/** A restore-stage guard refusal in the Contracts engine form: no cause, nothing written. */
export function engineFormRefusal(error) {
  const e = error?.publicError;
  return !!error?.guardRefusal && e?.phase === 'restore' && e.causeCode === null &&
    e.mutationState === 'NONE';
}
export function restoreFailure(restoreError, applyFailure, transactionRef) {
  // Only the engine's own restore refusal (phase restore): the transaction form (RESTORE_FAILED)
  // or the engine form (a guard refusal with no cause, nothing written), which the transaction
  // owner turns into the transaction form here. Canvas's own unverified restore and a lost
  // transport stay RECOVERY_PENDING, which recoverPending() may finish.
  const refused = restoreError?.publicError;
  if (refused?.phase !== 'restore' ||
      (refused.code !== 'RESTORE_FAILED' && !restoreError.guardRefusal)) return null;
  const guardRefusal = restoreError.guardRefusal ?? null;
  const cause = applyFailure.error.code;
  const error = guardRefusal ? { ...guardRefusalError(guardRefusal, { transactionRef, cause }) } :
    { ...restoreError.publicError, transactionRef, causeCode: cause };
  return { error, guardRefusal };
}
export function restoreFailedResponse(body, operation, restoreError, cause) {
  try {
    const applyFailure = failureDetail(cause);
    const failure = restoreFailure(restoreError, applyFailure, body.transactionId);
    if (!failure) return null;
    return validateResponse(REGION_WIRE, operation, { contractVersion: REGION_WIRE,
      requestId: body.requestId, result: null, error: failure.error,
      guardRefusal: failure.guardRefusal, applyFailure });
  } catch (shapeError) {
    // The Contracts cannot express this outcome (e.g. a region Undo whose causing failure is
    // itself a restore): not repaired; the caller records it and answers RECOVERY_PENDING.
    restoreError.receiptRejected = shapeError.publicError?.code ?? shapeError.code ?? shapeError.message;
    return null;
  }
}

/** Compressed RegionSnapshotContent: gzip over its canonical JSON, bound by RegionSnapshotRef. */
export async function encodeSnapshot(content, beforeSummary) {
  const raw = Buffer.from(canonicalJSON(content));
  const compressed = await gz(raw, { level: zlib.Z_BEST_COMPRESSION });
  const ref = validateType('RegionSnapshotRef', { profileVersion: 'region-snapshot/v1',
    contentDigest: D('region-snapshot-content', content),
    beforeSummaryDigest: D('region-summary', beforeSummary),
    compression: SNAPSHOT_COMPRESSION, compressedSha256: sha(compressed),
    compressedByteLength: compressed.length });
  return { ref, compressed, rawByteLength: raw.length };
}
export async function decodeSnapshot(compressed, ref, beforeSummary) {
  if (ref.compression !== SNAPSHOT_COMPRESSION || sha(compressed) !== ref.compressedSha256 ||
      compressed.length !== ref.compressedByteLength)
    throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
  const content = JSON.parse((await gunz(compressed)).toString('utf8'));
  return validateRegionSnapshotContent(content, ref, beforeSummary);
}

/** Content-addressed, fsynced 0600 snapshot files beside the Canvas durable store. */
class SnapshotFiles {
  constructor(directory) { this.directory = join(directory, 'region-snapshots'); }
  path(ref) { return join(this.directory, `${ref.compressedSha256}.json.gz`); }
  async write(snapshot) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.snapshot-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(snapshot.compressed); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.path(snapshot.ref));
  }
  read(ref) { return readFile(this.path(ref)); }
}

function unionBox(boxes) {
  return { min: [0, 1, 2].map(a => Math.min(...boxes.map(b => b.min[a]))),
    max: [0, 1, 2].map(a => Math.max(...boxes.map(b => b.max[a]))) };
}
function specifiedPositions(operations) {
  const positions = [];
  for (const chunk of operations.chunks) {
    const { box, indices } = expandRegionBlock(chunk.block);
    const sx = box.max[0] - box.min[0] + 1, sy = box.max[1] - box.min[1] + 1;
    indices.forEach((v, i) => { if (v !== -1) positions.push([box.min[0] + i % sx,
      box.min[1] + Math.floor(i / sx) % sy, box.min[2] + Math.floor(i / (sx * sy))]); });
  }
  return positions.sort(comparePosition);
}

/**
 * Region transactions over the same Canvas durable store, world revisions,
 * footprints and history rows as cell BUILD. Not a second transaction system.
 */
export class CanvasRegionV1 {
  constructor(canvas, regionAdapter) {
    this.canvas = canvas;
    this.regionAdapter = regionAdapter;
  }
  get protocolHandshake() { return structuredClone(canvasProtocolHandshake); }
  describe() { return structuredClone({ ...regionToolDescription,
    protocolHandshake: canvasProtocolHandshake }); }
  get store() { return this.canvas.store; }
  #snapshots() { return new SnapshotFiles(this.store.directory); }

  /** Adapter compatibility (region port and per-cell port) before any region read or write. */
  #adapterCompatible() {
    const region = this.regionAdapter?.protocolHandshake;
    if (!this.regionAdapter?.call || region === undefined)
      throw fail('UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
    this.canvas.adapterCompatible();
    return checkProtocolCompatibility(region, [ADAPTER_REGION_REQUIREMENT]);
  }
  /** The current connection, then the engine guards `operation` needs from its declaration. */
  async #guarded(body, operation) {
    const connection = await this.#current(body);
    requireGuards(connection.capabilities.engineGuards, operation);
    return connection;
  }
  async #current(body) {
    const session = this.store.snapshot.sessions[body.sessionRef];
    if (!session || session.activeWorldRef !== body.worldRef ||
        !same(session.localContext, body.localContext))
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    if (!this.canvas.adapter?.call) throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    const request = { contractVersion: ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:current-connection`,
      connectionRef: body.localContext.connectionRef };
    const response = await this.canvas.adapter.call('ReadLocalConnection', request);
    validateBoundResponse(ADAPTER, 'ReadLocalConnection', request, response);
    if (response.error || response.result.worldRef !== body.worldRef ||
        response.result.connectionIncarnationRef !== body.localContext.connectionIncarnationRef)
      throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    return response.result;
  }
  /**
   * Load-then-know read of every mapblock of `box`; still unknown rejects. The
   * result is aligned to `layout` ([chunkPos, box] of the compiled chunks): Brush
   * omits mapblocks without specified cells, and every compiled chunk must be read.
   */
  async #read(body, box, purpose, suffix, layout) {
    const request = { contractVersion: REGION_ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:${suffix}`, worldRef: body.worldRef, box, purpose,
      localContext: body.localContext };
    const response = validateRegionRead(request, await this.regionAdapter.call('ReadRegion', request));
    if (response.error) throw Object.assign(new Error(response.error.code),
      { publicError: response.error });
    const read = requireKnownRegion(response.result);
    const byPos = new Map(read.chunks.map(c => [key(c.chunkPos), c]));
    const chunks = layout.map(([chunkPos, chunkBox]) => {
      const chunk = byPos.get(key(chunkPos));
      if (!chunk || !same(chunk.box, chunkBox))
        throw fail('TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN', 'readback');
      return chunk;
    });
    return { worldRef: read.worldRef, chunks };
  }
  async #write(body, transactionId, purpose, writes, suffix) {
    const request = { contractVersion: REGION_ADAPTER, sessionRef: body.sessionRef,
      requestId: `${body.requestId}:${suffix}`, worldRef: body.worldRef, transactionId,
      purpose, writes, localContext: body.localContext };
    const written = validateRegionWrite(request, await this.regionAdapter.call('WriteRegion', request));
    // A refused write keeps the Adapter's public Error and its GuardRefusal (if any) as the cause.
    if (written.response.error) throw Object.assign(new Error(written.response.error.code),
      { publicError: written.response.error, guardRefusal: written.response.guardRefusal ?? null });
    return written;
  }
  #summary(worldRef, read) {
    return summarizeRegionStates(worldRef, read.chunks.map(c => ({ chunkPos: c.chunkPos,
      state: c.state })));
  }
  #footprintConflicts(worldRef, positions, exceptObjectRef = null) {
    const checked = new Set(positions.map(key));
    return Object.entries(this.store.snapshot.footprints[worldRef] ?? {})
      .filter(([objectRef, row]) => objectRef !== exceptObjectRef &&
        row.positions.some(position => checked.has(key(position))))
      .map(([objectRef]) => objectRef).sort();
  }
  #replay(body, operation) {
    const replayKey = `${body.sessionRef}\0${REGION_WIRE}:${operation}\0${body.requestId}`;
    const requestHash = sha(`${REGION_WIRE}|${operation}\n${canonicalJSON(body)}`);
    const prior = this.store.snapshot.replay[replayKey] ?? null;
    if (prior && prior.digest !== requestHash) throw fail('REPLAY_MISMATCH', 'PAYLOAD_CHANGED');
    return { replayKey, requestHash, prior };
  }
  #answer(body, operation, result) {
    return validateResponse(REGION_WIRE, operation, { contractVersion: REGION_WIRE,
      requestId: body.requestId, result, error: null, guardRefusal: null, applyFailure: null });
  }
  async #pendingPhase(transactionId, phase, extra = {}) {
    await this.store.commit(next => { if (next.pending[transactionId])
      Object.assign(next.pending[transactionId], { phase, ...extra }); });
  }

  async #commit(raw) {
    const body = validateRequest(REGION_WIRE, 'ApplyRegionCommit', raw);
    validateDigestBinding('region-operations', body.operations, body.operationDigest);
    const { replayKey, requestHash, prior } = this.#replay(body, 'ApplyRegionCommit');
    if (prior) return prior.response;
    this.#adapterCompatible();
    await this.#guarded(body, 'ApplyRegionCommit');
    const state = this.store.snapshot;
    const positions = specifiedPositions(body.operations);
    if (this.#footprintConflicts(body.worldRef, positions).length)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    if (state.pending[body.transactionId] || state.transactions[body.transactionId] ||
        inFlight(state, body.worldRef))
      throw fail('TRANSACTION_CONFLICT');
    const layout = body.operations.chunks.map(c => [c.chunkPos, regionBlockBox(c.block)]);
    const box = unionBox(layout.map(([, b]) => b));
    const before = await this.#read(body, box, 'BEFORE_IMAGE', 'before', layout);
    const content = validateType('RegionSnapshotContent', {
      profileVersion: 'region-snapshot-content/v1', worldRef: body.worldRef,
      chunks: before.chunks.map(c => ({ chunkPos: c.chunkPos, state: c.state,
        stateDigest: c.stateDigest })) });
    const beforeSummary = this.#summary(body.worldRef, before);
    const expectedAfterSummary = expectedRegionSummary(content, body.operations);
    const snapshot = await encodeSnapshot(content, beforeSummary);
    await this.#snapshots().write(snapshot);
    const worldRevision = state.worldRevisions[body.worldRef];
    // Durable reservation referencing the snapshot before the only APPLY write.
    await this.store.commit(next => {
      if (next.pending[body.transactionId] || next.transactions[body.transactionId] ||
          inFlight(next, body.worldRef) || next.worldRevisions[body.worldRef] !== worldRevision)
        throw fail('TRANSACTION_CONFLICT');
      next.pending[body.transactionId] = { kind: 'REGION', direction: 'APPLY', body,
        snapshot: snapshot.ref, beforeSummary, box, layout, phase: 'SNAPSHOTTED' };
    });
    let lighting = null;
    try {
      await this.#pendingPhase(body.transactionId, 'WRITING');
      const written = await this.#write(body, body.transactionId, 'APPLY',
        body.operations.chunks.map((c, i) => ({ chunkPos: c.chunkPos,
          expectedCurrentDigest: before.chunks[i].stateDigest, ops: c.block, state: null })),
        'apply');
      lighting = written.response.result?.lighting ?? null;
      if (!written.allWritten) throw fail('APPLY_FAILED', 'APPLY_ERROR', 'apply');
      const after = await this.#read(body, box, 'READBACK', 'after', layout);
      const actualSummary = this.#summary(body.worldRef, after);
      if (!same(actualSummary, expectedAfterSummary))
        throw fail('READBACK_MISMATCH', 'READBACK_ERROR', 'readback');
      return await this.#record(body, { beforeSummary, expectedAfterSummary, actualSummary,
        snapshot: snapshot.ref, lighting, positions, box, layout, replayKey, requestHash });
    } catch (cause) {
      // An engine guard that refused the APPLY write without writing anything (mutationState
      // NONE) is forwarded unchanged with its error once the region reads back unchanged; the
      // transaction ends there (nothing to roll back, not pending). Anything else rolls back.
      if (cause?.guardRefusal && cause.publicError?.mutationState === 'NONE') {
        const now = await this.#read(body, box, 'INSPECT', 'apply-refused', layout);
        if (same(this.#summary(body.worldRef, now), beforeSummary)) {
          const response = validateResponse(REGION_WIRE, 'ApplyRegionCommit', {
            contractVersion: REGION_WIRE, requestId: body.requestId, result: null,
            error: { ...cause.publicError }, guardRefusal: { ...cause.guardRefusal },
            applyFailure: null });
          await this.store.commit(state => {
            state.replay[replayKey] = { digest: requestHash, response };
            delete state.pending[body.transactionId];
          });
          return response;
        }
      }
      return this.#rollback(body, { content, beforeSummary, expectedAfterSummary,
        snapshot: snapshot.ref, box, lighting, replayKey, requestHash, cause });
    }
  }
  async #record(body, facts) {
    const { beforeSummary, expectedAfterSummary, actualSummary, snapshot, lighting,
      positions, box, layout, replayKey, requestHash } = facts;
    const objectRef = rev('object');
    const historyRevision = rev('history');
    const worldRevision = rev('world');
    const result = { transactionId: body.transactionId, worldRef: body.worldRef,
      status: 'VERIFIED', operationDigest: body.operationDigest, beforeSummary,
      expectedAfterSummary, actualSummary, snapshot, historyRevision, lighting,
      affectedObjectRefs: [], localContext: body.localContext };
    const response = this.#answer(body, 'ApplyRegionCommit', result);
    validateRegionCommit(body, response);
    const history = validateType('HistoryEntry', { transactionId: body.transactionId,
      originTransactionId: null, affectedObjectRefs: [objectRef],
      operationDigest: body.operationDigest,
      beforeImageDigest: D('region-summary', beforeSummary),
      expectedAfterReadbackDigest: D('region-summary', actualSummary),
      receiptDigest: sha(canonicalJSON(result)), historyRevision, status: 'VERIFIED' });
    await this.store.commit(state => {
      state.transactions[body.transactionId] = { kind: 'REGION', result, history, box, layout,
        displayMetadata: { committedAt: new Date().toISOString(), mode: 'REGION',
          affectedCells: positions.length },
        objectRef, worldRef: body.worldRef, operations: body.operations, worldRevision,
        receipt: { status: 'VERIFIED', localContext: body.localContext } };
      state.history[objectRef] = [history];
      state.objects[body.worldRef] ??= {};
      state.objects[body.worldRef][objectRef] = { worldRef: body.worldRef, objectRef,
        objectRevision: rev('object'), displayName: null, nameRevision: null,
        creationSequence: Object.keys(state.objects[body.worldRef]).length, status: 'READY' };
      state.footprints[body.worldRef] ??= {};
      // Specified cells (fill and carve) in the public canonical position order.
      state.footprints[body.worldRef][objectRef] = { positions,
        footprintRevision: rev('footprint'), provenance: 'CANVAS_REGISTERED' };
      state.worldRevisions[body.worldRef] = worldRevision;
      state.registryRevisions[body.worldRef] = rev('registry');
      state.replay[replayKey] = { digest: requestHash, response };
      delete state.pending[body.transactionId];
    });
    return response;
  }
  /**
   * Whole-region restore to `content` (a durable image): read current,
   * RESTORE every chunk that differs, read back, require the target summary.
   */
  async #restore(body, transactionId, content, targetSummary, box, suffix) {
    const layout = content.chunks.map(c => [c.chunkPos, regionBlockBox(c.state.block)]);
    const current = await this.#read(body, box, 'INSPECT', `${suffix}-current`, layout);
    const writes = content.chunks.map((c, i) => ({ chunkPos: c.chunkPos,
      expectedCurrentDigest: current.chunks[i].stateDigest, ops: null, state: c.state }))
      .filter((w, i) => w.expectedCurrentDigest !== content.chunks[i].stateDigest);
    let lighting = null;
    if (writes.length) {
      const written = await this.#write(body, transactionId, 'RESTORE', writes, suffix);
      lighting = written.response.result?.lighting ?? null;
      if (!written.allWritten) throw fail('RESTORE_FAILED', 'RESTORE_ERROR', 'apply');
    }
    const after = await this.#read(body, box, 'READBACK', `${suffix}-readback`, layout);
    const actual = this.#summary(body.worldRef, after);
    if (!same(actual, targetSummary)) throw fail('ROLLBACK_FAILED', 'RESTORE_ERROR', 'apply');
    return { actual, lighting };
  }
  async #rollback(body, facts) {
    const { content, beforeSummary, expectedAfterSummary, snapshot, box, replayKey,
      requestHash, cause } = facts;
    let restored;
    try {
      restored = await this.#restore(body, body.transactionId, content, beforeSummary, box,
        'restore');
    } catch (restoreError) {
      // G1: an unfinished rollback stays a durable, readable recovery-pending row.
      const restoreCode = restoreError?.publicError?.code ?? restoreError?.code ?? 'RESTORE_FAILED';
      const failed = restoreFailedResponse(body, 'ApplyRegionCommit', restoreError, cause);
      await this.#pendingPhase(body.transactionId, 'RESTORE_PENDING', { restoreCode,
        causeCode: cause?.publicError?.code ?? cause?.code ?? null,
        receiptStatus: failed ? 'RESTORE_FAILED' : 'RECOVERY_PENDING',
        guardRefusal: restoreError?.guardRefusal ?? null,
        receiptRejected: restoreError?.receiptRejected ?? null });
      if (failed) {
        await this.store.commit(state => { state.replay[replayKey] = { digest: requestHash, response: failed }; });
        return failed;
      }
      const pending = fail('RECOVERY_PENDING', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
      pending.publicError.retryability = 'SAME_TRANSACTION_QUERY';
      pending.publicError.mutationState = 'UNKNOWN';
      pending.publicError.transactionRef = body.transactionId;
      pending.publicError.causeCode = restoreCode;
      throw pending;
    }
    const lighting = restored.lighting ?? facts.lighting ??
      { status: 'NOT_COMPLETE', box, method: 'canvas:no-write-observed' };
    const result = { transactionId: body.transactionId, worldRef: body.worldRef,
      status: 'ROLLED_BACK', operationDigest: body.operationDigest, beforeSummary,
      expectedAfterSummary, actualSummary: restored.actual, snapshot,
      historyRevision: rev('history-none'), lighting, affectedObjectRefs: [],
      localContext: body.localContext };
    const response = this.#answer(body, 'ApplyRegionCommit', result);
    validateRegionCommit(body, response);
    await this.store.commit(state => {
      state.transactions[body.transactionId] = { kind: 'REGION', result, worldRef: body.worldRef,
        causeCode: cause?.publicError?.code ?? cause?.code ?? 'APPLY_FAILED',
        receipt: { status: 'ROLLED_BACK', localContext: body.localContext } };
      state.replay[replayKey] = { digest: requestHash, response };
      delete state.pending[body.transactionId];
    });
    return response;
  }

  async #undo(raw) {
    const body = validateRequest(REGION_WIRE, 'UndoRegionCommit', raw);
    const { replayKey, requestHash, prior } = this.#replay(body, 'UndoRegionCommit');
    if (prior) return prior.response;
    this.#adapterCompatible();
    await this.#guarded(body, 'UndoRegionCommit');
    const state = this.store.snapshot;
    const origin = state.transactions[body.originTransactionId];
    if (origin?.kind !== 'REGION' || origin.result.status !== 'VERIFIED')
      throw fail('UNDO_CONFLICT', 'PAYLOAD_CHANGED');
    if (origin.worldRef !== body.worldRef) throw fail('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    await this.#current(body);
    if (state.history[origin.objectRef]?.at(-1)?.transactionId !== body.originTransactionId ||
        origin.result.historyRevision !== body.expectedHistoryRevision)
      throw fail('UNDO_CONFLICT');
    const positions = specifiedPositions(origin.operations);
    if (this.#footprintConflicts(body.worldRef, positions, origin.objectRef).length)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    if (state.pending[body.undoTransactionId] || state.transactions[body.undoTransactionId] ||
        inFlight(state, body.worldRef))
      throw fail('TRANSACTION_CONFLICT');
    const current = await this.#read(body, origin.box, 'INSPECT', 'before-undo', origin.layout);
    const preUndoSummary = this.#summary(body.worldRef, current);
    // Never overwrite an external edit: the whole region must still be the verified after state.
    if (!same(preUndoSummary, origin.result.actualSummary))
      throw fail('UNDO_CONFLICT', 'EXTERNAL_EDIT_CONFLICT', 'readback');
    const originBefore = await decodeSnapshot(await this.#snapshots().read(origin.result.snapshot),
      origin.result.snapshot, origin.result.beforeSummary);
    // The pre-Undo image is snapshotted too, so a failed Undo can restore it after reopen.
    const preUndoContent = validateType('RegionSnapshotContent', {
      profileVersion: 'region-snapshot-content/v1', worldRef: body.worldRef,
      chunks: current.chunks.map(c => ({ chunkPos: c.chunkPos, state: c.state,
        stateDigest: c.stateDigest })) });
    const preUndoSnapshot = await encodeSnapshot(preUndoContent, preUndoSummary);
    await this.#snapshots().write(preUndoSnapshot);
    const worldRevision = state.worldRevisions[body.worldRef];
    await this.store.commit(next => {
      if (next.pending[body.undoTransactionId] || next.transactions[body.undoTransactionId] ||
          inFlight(next, body.worldRef) || next.worldRevisions[body.worldRef] !== worldRevision)
        throw fail('TRANSACTION_CONFLICT');
      next.pending[body.undoTransactionId] = { kind: 'REGION', direction: 'UNDO', body,
        originTransactionId: body.originTransactionId, snapshot: preUndoSnapshot.ref,
        beforeSummary: preUndoSummary, box: origin.box, layout: origin.layout,
        phase: 'RESERVED' };
    });
    const tx = { ...body, transactionId: body.undoTransactionId };
    let restored;
    try {
      await this.#pendingPhase(body.undoTransactionId, 'WRITING');
      restored = await this.#restore(tx, body.undoTransactionId, originBefore,
        origin.result.beforeSummary, origin.box, 'undo');
    } catch (cause) {
      // An Undo the engine refuses in the engine form (no cause, nothing written) is returned
      // unchanged with applyFailure null, once Canvas has read back that the region is still the
      // pre-Undo image; it is not pending. Anything else rolls back to the pre-Undo image.
      if (engineFormRefusal(cause)) {
        const now = await this.#read(tx, origin.box, 'INSPECT', 'undo-refused', origin.layout);
        if (same(this.#summary(body.worldRef, now), preUndoSummary)) {
          const response = validateResponse(REGION_WIRE, 'UndoRegionCommit', {
            contractVersion: REGION_WIRE, requestId: body.requestId, result: null,
            error: { ...cause.publicError }, guardRefusal: { ...cause.guardRefusal },
            applyFailure: null });
          await this.store.commit(next => {
            next.replay[replayKey] = { digest: requestHash, response };
            delete next.pending[body.undoTransactionId];
          });
          return response;
        }
      }
      let back;
      try {
        back = await this.#restore(tx, body.undoTransactionId, preUndoContent, preUndoSummary,
          origin.box, 'undo-restore');
      } catch (restoreError) {
        const restoreCode = restoreError?.publicError?.code ?? restoreError?.code ?? 'RESTORE_FAILED';
        const failed = restoreFailedResponse({ ...body, transactionId: body.undoTransactionId },
          'UndoRegionCommit', restoreError, cause);
        await this.#pendingPhase(body.undoTransactionId, 'RESTORE_PENDING', { restoreCode,
          causeCode: cause?.publicError?.code ?? cause?.code ?? null,
          receiptStatus: failed ? 'RESTORE_FAILED' : 'RECOVERY_PENDING',
          guardRefusal: restoreError?.guardRefusal ?? null,
          receiptRejected: restoreError?.receiptRejected ?? null });
        if (failed) {
          await this.store.commit(next => { next.replay[replayKey] = { digest: requestHash, response: failed }; });
          return failed;
        }
        const pending = fail('RECOVERY_PENDING', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
        pending.publicError.retryability = 'SAME_TRANSACTION_QUERY';
        pending.publicError.mutationState = 'UNKNOWN';
        pending.publicError.transactionRef = body.undoTransactionId;
        pending.publicError.causeCode = cause?.publicError?.code ?? 'RESTORE_FAILED';
        throw pending;
      }
      const result = this.#undoResult(body, origin, 'ROLLED_BACK', preUndoSummary, back.actual,
        rev('history-none'), back.lighting ?? { status: 'NOT_COMPLETE', box: origin.box,
          method: 'canvas:no-write-observed' });
      const response = this.#answer(body, 'UndoRegionCommit', result);
      validateRegionUndo(body, response, origin.result);
      await this.store.commit(next => {
        next.transactions[body.undoTransactionId] = { kind: 'REGION_UNDO', result,
          worldRef: body.worldRef, receipt: { status: 'ROLLED_BACK',
            localContext: body.localContext } };
        next.replay[replayKey] = { digest: requestHash, response };
        delete next.pending[body.undoTransactionId];
      });
      return response;
    }
    const historyRevision = rev('history');
    const result = this.#undoResult(body, origin, 'VERIFIED', preUndoSummary, restored.actual,
      historyRevision, restored.lighting);
    const response = this.#answer(body, 'UndoRegionCommit', result);
    validateRegionUndo(body, response, origin.result);
    const history = validateType('HistoryEntry', { transactionId: body.undoTransactionId,
      originTransactionId: body.originTransactionId, affectedObjectRefs: [origin.objectRef],
      operationDigest: D('region-summary', origin.result.beforeSummary),
      beforeImageDigest: D('region-summary', preUndoSummary),
      expectedAfterReadbackDigest: D('region-summary', restored.actual),
      receiptDigest: sha(canonicalJSON(result)), historyRevision, status: 'VERIFIED' });
    await this.store.commit(next => {
      next.transactions[body.undoTransactionId] = { kind: 'REGION_UNDO', result, history,
        displayMetadata: { committedAt: new Date().toISOString(), mode: 'REGION',
          affectedCells: positions.length },
        originTransactionId: body.originTransactionId, objectRef: origin.objectRef,
        worldRef: body.worldRef, receipt: { status: 'VERIFIED', localContext: body.localContext } };
      next.history[origin.objectRef].push(history);
      next.objects[body.worldRef][origin.objectRef].objectRevision = rev('object');
      next.footprints[body.worldRef][origin.objectRef].positions = [];
      next.footprints[body.worldRef][origin.objectRef].footprintRevision = rev('footprint');
      next.worldRevisions[body.worldRef] = rev('world');
      next.registryRevisions[body.worldRef] = rev('registry');
      next.replay[replayKey] = { digest: requestHash, response };
      delete next.pending[body.undoTransactionId];
    });
    return response;
  }
  #undoResult(body, origin, status, preUndoSummary, actualSummary, historyRevision, lighting) {
    return { originTransactionId: body.originTransactionId,
      undoTransactionId: body.undoTransactionId, worldRef: body.worldRef, status,
      originBeforeSummaryDigest: D('region-summary', origin.result.beforeSummary),
      originAfterSummaryDigest: D('region-summary', origin.result.actualSummary),
      preUndoSummary, actualSummary, historyRevision, lighting,
      localContext: body.localContext };
  }

  /**
   * After a normal reopen, a region transaction left RESTORE_PENDING is restored
   * from its durable compressed snapshot. Nothing new is applied.
   */
  async recoverPending() {
    await this.canvas.ready;
    const outcomes = [];
    for (const [transactionId, row] of Object.entries(this.store.snapshot.pending)) {
      if (row.kind !== 'REGION') continue;
      const body = { ...row.body, requestId: `${row.body.requestId}:recover` };
      try {
        // Recovery restores the snapshot (a rollback): REGION_RESTORE body clearance + protection.
        this.#adapterCompatible();
        await this.#guarded(body, 'RecoverRegion');
        const content = await decodeSnapshot(await this.#snapshots().read(row.snapshot),
          row.snapshot, row.beforeSummary);
        await this.#restore(body, transactionId, content, row.beforeSummary, row.box, 'recover');
        await this.store.commit(state => {
          state.transactions[transactionId] = { kind: row.direction === 'APPLY' ? 'REGION' :
            'REGION_UNDO', worldRef: row.body.worldRef, recovered: true,
            receipt: { status: 'ROLLED_BACK', localContext: row.body.localContext } };
          delete state.pending[transactionId];
        });
        outcomes.push({ transactionId, status: 'ROLLED_BACK' });
      } catch (error) {
        outcomes.push({ transactionId, status: 'RECOVERY_PENDING',
          code: error.publicError?.code ?? error.code ?? 'RECOVERY_PENDING' });
      }
    }
    return outcomes;
  }

  async call(operation, body) {
    try {
      await this.canvas.ready;
      if (!this.store || this.store.unavailable)
        throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
      if (operation === 'ApplyRegionCommit') return await this.#commit(body);
      if (operation === 'UndoRegionCommit') return await this.#undo(body);
      throw fail('UNSUPPORTED_OPERATION', 'INVALID_SHAPE', 'decode');
    } catch (error) {
      return { contractVersion: REGION_WIRE, requestId: body?.requestId ?? 'invalid-request',
        result: null, error: error.publicError ?? publicError(error),
        guardRefusal: error.guardRefusal ?? null, applyFailure: null };
    }
  }
}
