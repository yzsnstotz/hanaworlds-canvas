import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip, constants as zlib } from 'node:zlib';
import canonicalize from 'canonicalize';
import { comparePosition, validateBoundResponse, validateType } from 'hanaworlds-contracts';

/*
 * Region v1 transaction and whole-region Undo.
 *
 * FIXTURE BOUNDARY: Contracts has not delivered the public region v1 shape yet.
 * The block format, the Adapter region port operations and the digest domains
 * below are Canvas's narrowest explicit reading of the S1-CONTRACT-REGION-V1-01
 * card. They are switched to the actual Contracts exports when those bytes exist;
 * nothing here is a second transaction system — Canvas stays the only decider.
 */
export const REGION_WIRE = 'canvas-region/v1';
export const REGION_FORMAT = 'region-voxels/v1';
export const REGION_ADAPTER = 'world-adapter-region/v1';
export const REGION_PROTOCOL = { name: 'hanaworlds-region', version: '1.0.0' };
export const REGION_SHAPE_SOURCE = 'canvas-explicit-fixture';
export const CANVAS_REGION_CAPABILITIES = Object.freeze(['region-commit',
  'region-undo', 'explicit-air-dig', 'compressed-before-snapshot']);
export const ADAPTER_REGION_CAPABILITIES = Object.freeze(['chunked-read',
  'chunked-write', 'load-before-read', 'lighting-complete']);
const ADAPTER = 'world-adapter/v6';
const BLOCK = 16; // Luanti mapblock edge: chunks are mapblock-aligned.
const UNSPECIFIED = -1;
const gz = promisify(gzip);
const gunz = promisify(gunzip);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = (domain, value) => sha(`HanaWorlds|${domain}\n${canonicalize(value)}`);
const same = (a, b) => canonicalize(a) === canonicalize(b);
const rev = prefix => `${prefix}-${randomUUID()}`;
const key = position => position.join(',');
// Any unfinished Canvas transaction (cell or region) on the same world blocks a new reservation.
const inFlight = (state, worldRef) => Object.values(state.pending)
  .some(row => row.body?.worldRef === worldRef);

/** Self-description for the skill: purpose, typical scale and prerequisites, no thresholds. */
export const regionToolDescription = Object.freeze({
  tool: 'canvas.region',
  operations: ['ApplyRegionCommit', 'UndoRegion'],
  purpose: 'Write one rectangular region (fill and explicit air dig) as one ' +
    'logical transaction, and undo that whole region in one step.',
  typicalScale: 'Terrain shaping and large builds spanning several 16x16x16 ' +
    'mapblocks. Cell-by-cell BUILD with per-cell Undo stays the tool for fine ' +
    'adjustment; which one to use is the skill\'s choice.',
  prerequisites: ['a current world connection selected in Canvas',
    'expectedWorldRevision equal to the current Canvas world revision',
    'no registered object footprint inside the written cells',
    'every touched mapblock loadable and KNOWN after Adapter load',
    'no node metadata/inventory/timer in written cells (region v1 cannot restore it)',
    `region protocol major ${REGION_PROTOCOL.version.split('.')[0]} with the required capabilities`],
  unspecifiedCells: 'left untouched; only palette entry "air" digs',
});

export function regionFail(code, reason = 'REVISION_CHANGED', phase = 'validate') {
  const error = new Error(code);
  error.publicError = { code, phase, retryability: 'AFTER_NEW_FACTS',
    mutationState: 'NONE', transactionRef: null, causeCode: null, reason };
  return error;
}
const fail = regionFail;

/** Major + required-capability compatibility. Patch/minor or hash differences never reject. */
export function checkRegionProtocol(declared, offered, label) {
  const parse = text => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text ?? '');
  const ours = parse(REGION_PROTOCOL.version);
  const theirs = parse(declared?.version);
  if (declared?.name !== REGION_PROTOCOL.name || !theirs)
    throw fail('UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
  // Region v1 is major 1. A 0.x line is not treated as unconditionally compatible.
  if (theirs[1] !== ours[1]) throw fail('UNSUPPORTED_VERSION', 'VERSION_UNSUPPORTED', 'decode');
  const required = declared.requiredCapabilities ?? [];
  if (!Array.isArray(required) || required.some(name => !offered.includes(name))) {
    const error = fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN', 'decode');
    error.missingCapabilities = required.filter(name => !offered.includes(name));
    error.capabilitySide = label;
    throw error;
  }
}

const int = value => Number.isSafeInteger(value);
/** Decode a region block strictly. Unspecified (-1) is never the same as air. */
export function validateRegionBlock(block) {
  if (!block || block.format !== REGION_FORMAT || block.axisOrder !== 'x-y-z' ||
      !Array.isArray(block.origin) || block.origin.length !== 3 || !block.origin.every(int) ||
      !Array.isArray(block.size) || block.size.length !== 3 ||
      !block.size.every(n => int(n) && n > 0) ||
      !Array.isArray(block.palette) || block.palette.length === 0 ||
      !Array.isArray(block.cells))
    throw fail('BUILD_INVALID', 'INVALID_SHAPE', 'decode');
  const [sx, sy, sz] = block.size;
  if (block.cells.length !== sx * sy * sz)
    throw fail('BUILD_INVALID', 'INVALID_GEOMETRY', 'decode');
  const names = new Set();
  for (const entry of block.palette) {
    if (!entry || typeof entry.nodeName !== 'string' || !entry.nodeName ||
        !int(entry.param2) || entry.param2 < 0 || entry.param2 > 255 ||
        Object.keys(entry).some(k => k !== 'nodeName' && k !== 'param2') ||
        names.has(`${entry.nodeName}\0${entry.param2}`))
      throw fail('BUILD_INVALID', 'INVALID_SHAPE', 'decode');
    names.add(`${entry.nodeName}\0${entry.param2}`);
  }
  let specified = 0;
  for (const index of block.cells) {
    if (!int(index) || index < UNSPECIFIED || index >= block.palette.length)
      throw fail('BUILD_INVALID', 'INVALID_SHAPE', 'decode');
    if (index !== UNSPECIFIED) specified++;
  }
  if (specified === 0) throw fail('BUILD_INVALID', 'INVALID_GEOMETRY', 'decode');
  return block;
}

/** x fastest, then y, then z: the same order as Luanti VoxelArea. */
function* boxCells(min, size) {
  for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++)
    for (let x = 0; x < size[0]; x++) yield [min[0] + x, min[1] + y, min[2] + z];
}
const floorDiv = (n, d) => Math.floor(n / d);
/** Mapblock-aligned chunks of the box, each a sub-box, in z/y/x block order. */
export function regionChunks(block) {
  const max = block.origin.map((o, i) => o + block.size[i] - 1);
  const lo = block.origin.map(o => floorDiv(o, BLOCK));
  const hi = max.map(m => floorDiv(m, BLOCK));
  const chunks = [];
  for (let bz = lo[2]; bz <= hi[2]; bz++) for (let by = lo[1]; by <= hi[1]; by++)
    for (let bx = lo[0]; bx <= hi[0]; bx++) {
      const blockPos = [bx, by, bz];
      const cmin = blockPos.map((b, i) => Math.max(b * BLOCK, block.origin[i]));
      const cmax = blockPos.map((b, i) => Math.min(b * BLOCK + BLOCK - 1, max[i]));
      chunks.push({ blockPos, min: cmin, max: cmax,
        size: cmin.map((m, i) => cmax[i] - m + 1) });
    }
  return chunks;
}
const boxIndex = (block, p) => (p[2] - block.origin[2]) * block.size[0] * block.size[1] +
  (p[1] - block.origin[1]) * block.size[0] + (p[0] - block.origin[0]);

/** Records are [nodeName, param2] per cell in box order (light is recomputed, not compared). */
export const regionDigest = (worldRef, block, records) => digest('canvas-region-state/v1',
  { worldRef, origin: block.origin, size: block.size, axisOrder: 'x-y-z',
    records: records.map(r => [r.nodeName, r.param2]) });
export const blockDigest = block => digest('canvas-region-block/v1', block);

/** Before-image snapshot: gzip (RFC 1952, zlib) over canonical JSON of a palette+index image. */
export async function encodeSnapshot(worldRef, block, records) {
  const palette = [];
  const seen = new Map();
  const indexes = records.map(r => {
    const k = `${r.nodeName}\0${r.param2}\0${r.param1}`;
    if (!seen.has(k)) { seen.set(k, palette.length); palette.push([r.nodeName, r.param2, r.param1]); }
    return seen.get(k);
  });
  const raw = Buffer.from(canonicalize({ format: 'canvas-region-snapshot/v1', worldRef,
    origin: block.origin, size: block.size, axisOrder: 'x-y-z', palette, indexes }));
  const compressed = await gz(raw, { level: zlib.Z_BEST_COMPRESSION });
  return { raw, compressed, rawSha256: sha(raw), compressedSha256: sha(compressed),
    regionDigest: regionDigest(worldRef, block, records) };
}
export async function decodeSnapshot(compressed, meta, worldRef, block) {
  if (sha(compressed) !== meta.compressedSha256)
    throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
  const raw = await gunz(compressed);
  if (sha(raw) !== meta.rawSha256) throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
  const image = JSON.parse(raw.toString('utf8'));
  if (image.format !== 'canvas-region-snapshot/v1' || image.worldRef !== worldRef ||
      !same(image.origin, block.origin) || !same(image.size, block.size))
    throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
  const records = image.indexes.map(i => ({ nodeName: image.palette[i][0],
    param2: image.palette[i][1], param1: image.palette[i][2] }));
  if (regionDigest(worldRef, block, records) !== meta.regionDigest)
    throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
  return records;
}

/** Content-addressed, fsynced snapshot files beside the Canvas durable store. */
class SnapshotFiles {
  constructor(directory) { this.directory = join(directory, 'region-snapshots'); }
  path(meta) { return join(this.directory, `${meta.compressedSha256}.json.gz`); }
  async write(snapshot) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(snapshot);
    const temporary = join(this.directory, `.snapshot-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(snapshot.compressed); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
    return target;
  }
  read(meta) { return readFile(this.path(meta)); }
}

/**
 * Region transactions over the same Canvas durable store, world revisions,
 * footprints and history rows as cell BUILD. Adapter only transports chunks.
 */
export class CanvasRegionV1 {
  constructor(canvas, regionAdapter) {
    this.canvas = canvas;
    this.regionAdapter = regionAdapter;
  }
  describe() { return structuredClone({ ...regionToolDescription,
    protocol: REGION_PROTOCOL, capabilities: [...CANVAS_REGION_CAPABILITIES],
    shapeSource: REGION_SHAPE_SOURCE }); }
  get store() { return this.canvas.store; }
  #snapshots() { return new SnapshotFiles(this.store.directory); }
  async #region(operation, body) {
    if (!this.regionAdapter?.call) throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    const response = await this.regionAdapter.call(operation, body);
    if (!response || response.contractVersion !== REGION_ADAPTER ||
        response.requestId !== body.requestId)
      throw fail('ADAPTER_UNAVAILABLE', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
    if (response.error) throw Object.assign(new Error(response.error.code),
      { publicError: response.error });
    return response.result;
  }
  /** Current session/world/connection, re-read from the public v6 port before any write. */
  async #current(body) {
    const state = this.store.snapshot;
    const session = state.sessions[body.sessionRef];
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
  }
  async #adapterProtocol(body) {
    const offered = await this.#region('DescribeRegionIO', { contractVersion: REGION_ADAPTER,
      requestId: `${body.requestId}:describe-region-io`, worldRef: body.worldRef,
      localContext: body.localContext });
    // The Adapter declares its own region protocol; Canvas needs major 1 + its transport caps.
    checkRegionProtocol({ ...offered.protocol,
      requiredCapabilities: [...ADAPTER_REGION_CAPABILITIES] },
    offered.capabilities ?? [], 'adapter');
  }
  /** Load-then-read every chunk; anything still unknown or unrestorable rejects before writes. */
  async #readBox(body, block, suffix, transactionId) {
    const chunks = regionChunks(block);
    const result = await this.#region('ReadRegionChunks', { contractVersion: REGION_ADAPTER,
      requestId: `${body.requestId}:${suffix}`, worldRef: body.worldRef,
      transactionId, localContext: body.localContext,
      chunks: chunks.map(({ blockPos, min, max }) => ({ blockPos, min, max })) });
    if (result?.worldRef !== body.worldRef || !Array.isArray(result.chunks) ||
        result.chunks.length !== chunks.length)
      throw fail('TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN', 'readback');
    const records = new Array(block.cells.length);
    chunks.forEach((chunk, i) => {
      const read = result.chunks[i];
      const cells = [...boxCells(chunk.min, chunk.size)];
      if (!same(read?.blockPos, chunk.blockPos) || read.availability !== 'KNOWN' ||
          read.loaded !== true || !Array.isArray(read.records) ||
          read.records.length !== cells.length)
        throw fail('TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN', 'readback');
      cells.forEach((position, j) => {
        const r = read.records[j];
        if (typeof r?.nodeName !== 'string' || !int(r.param2) || !int(r.param1))
          throw fail('TARGET_FACTS_INCOMPLETE', 'REQUIRED_FACT_UNKNOWN', 'readback');
        records[boxIndex(block, position)] = { nodeName: r.nodeName, param2: r.param2,
          param1: r.param1, extraState: r.extraState === true };
      });
    });
    return records;
  }
  #expected(block, before) {
    return before.map((record, i) => block.cells[i] === UNSPECIFIED ? record :
      { ...record, nodeName: block.palette[block.cells[i]].nodeName,
        param2: block.palette[block.cells[i]].param2 });
  }
  #specifiedPositions(block) {
    const positions = [];
    for (const position of boxCells(block.origin, block.size))
      if (block.cells[boxIndex(block, position)] !== UNSPECIFIED) positions.push(position);
    return positions;
  }
  #footprintConflicts(worldRef, positions, exceptObjectRef = null) {
    const checked = new Set(positions.map(key));
    return Object.entries(this.store.snapshot.footprints[worldRef] ?? {})
      .filter(([objectRef, row]) => objectRef !== exceptObjectRef &&
        row.positions.some(position => checked.has(key(position))))
      .map(([objectRef]) => objectRef).sort();
  }
  /** One write per chunk that has specified cells; target records come from `image`. */
  async #writeChunks(body, block, image, transactionId, phase, onChunk, only = null) {
    for (const chunk of regionChunks(block)) {
      if (only && !only.has(key(chunk.blockPos))) continue;
      const cells = [...boxCells(chunk.min, chunk.size)];
      const palette = [];
      const seen = new Map();
      const indexes = cells.map(position => {
        const i = boxIndex(block, position);
        if (block.cells[i] === UNSPECIFIED) return UNSPECIFIED;
        const r = image[i];
        const k = `${r.nodeName}\0${r.param2}`;
        if (!seen.has(k)) { seen.set(k, palette.length);
          palette.push({ nodeName: r.nodeName, param2: r.param2 }); }
        return seen.get(k);
      });
      if (!palette.length) continue;
      await onChunk?.('WRITING', chunk.blockPos);
      const written = await this.#region('WriteRegionChunk', {
        contractVersion: REGION_ADAPTER, requestId: `${body.requestId}:${phase}:${key(chunk.blockPos)}`,
        worldRef: body.worldRef, transactionId, localContext: body.localContext,
        chunk: { format: REGION_FORMAT, axisOrder: 'x-y-z', blockPos: chunk.blockPos,
          origin: chunk.min, size: chunk.size, palette, cells: indexes } });
      if (!same(written?.blockPos, chunk.blockPos) || written.lightingComplete !== true ||
          written.writtenCells !== indexes.filter(i => i !== UNSPECIFIED).length)
        throw fail('APPLY_FAILED', 'APPLY_ERROR', 'apply');
      await onChunk?.('WRITTEN', chunk.blockPos);
    }
  }
  #replay(body, operation) {
    const replayKey = `${body.sessionRef}\0region:${operation}\0${body.requestId}`;
    const requestHash = digest('canvas-region-request/v1', { operation, body });
    const prior = this.store.snapshot.replay[replayKey] ?? null;
    if (prior && prior.digest !== requestHash) throw fail('REPLAY_MISMATCH', 'PAYLOAD_CHANGED');
    return { replayKey, requestHash, prior };
  }
  #answer(body, result, error = null) {
    return { contractVersion: REGION_WIRE, requestId: body.requestId, result, error };
  }
  #shape(body, fields) {
    if (!body || typeof body !== 'object' || body.contractVersion !== REGION_WIRE ||
        fields.some(field => !(field in body)) ||
        Object.keys(body).some(field => !fields.includes(field) && field !== 'contractVersion') ||
        ['sessionRef', 'requestId', 'worldRef', 'transactionId']
          .some(field => typeof body[field] !== 'string' || !body[field]))
      throw fail('SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
  }

  async #commit(body) {
    this.#shape(body, ['sessionRef', 'requestId', 'worldRef', 'localContext',
      'transactionId', 'protocol', 'region', 'regionDigest', 'expectedWorldRevision']);
    checkRegionProtocol(body.protocol, CANVAS_REGION_CAPABILITIES, 'canvas');
    const { replayKey, requestHash, prior } = this.#replay(body, 'ApplyRegionCommit');
    if (prior) return prior.response;
    const block = validateRegionBlock(body.region);
    if (blockDigest(block) !== body.regionDigest)
      throw fail('MEDIA_DIGEST_MISMATCH', 'PAYLOAD_CHANGED', 'decode');
    await this.#current(body);
    await this.#adapterProtocol(body);
    const state = this.store.snapshot;
    if (body.expectedWorldRevision !== state.worldRevisions[body.worldRef])
      throw fail('STALE_REVISION');
    const positions = this.#specifiedPositions(block);
    if (this.#footprintConflicts(body.worldRef, positions).length)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    if (state.pending[body.transactionId] || state.transactions[body.transactionId])
      throw fail('TRANSACTION_CONFLICT');
    const before = await this.#readBox(body, block, 'before', body.transactionId);
    if (before.some((record, i) => block.cells[i] !== UNSPECIFIED && record.extraState))
      throw fail('UNSUPPORTED_MUTATION_SEMANTICS', 'UNSUPPORTED_STATE_COVERAGE');
    const expected = this.#expected(block, before);
    const snapshot = await encodeSnapshot(body.worldRef, block, before);
    await this.#snapshots().write(snapshot);
    const snapshotMeta = { compressedSha256: snapshot.compressedSha256,
      rawSha256: snapshot.rawSha256, regionDigest: snapshot.regionDigest,
      rawBytes: snapshot.raw.length, compressedBytes: snapshot.compressed.length,
      encoding: 'gzip/rfc1952+canonical-json', cells: before.length };
    const afterDigest = regionDigest(body.worldRef, block, expected);
    // Durable reservation with the snapshot reference before the first chunk write.
    await this.store.commit(next => {
      if (next.pending[body.transactionId] || next.transactions[body.transactionId] ||
          inFlight(next, body.worldRef) ||
          next.worldRevisions[body.worldRef] !== body.expectedWorldRevision)
        throw fail('TRANSACTION_CONFLICT');
      next.pending[body.transactionId] = { kind: 'REGION', direction: 'APPLY', body,
        snapshot: snapshotMeta, expectedAfterDigest: afterDigest,
        phase: 'SNAPSHOTTED', touchedChunks: [] };
    });
    try {
      await this.#writeChunks(body, block, expected, body.transactionId, 'apply',
        (phase, blockPos) => this.store.commit(next => {
          const row = next.pending[body.transactionId];
          if (phase === 'WRITING') row.touchedChunks.push(blockPos);
          row.phase = phase === 'WRITING' ? 'WRITING' : 'CHUNK_WRITTEN';
        }));
      const actual = await this.#readBox(body, block, 'after', body.transactionId);
      if (regionDigest(body.worldRef, block, actual) !== afterDigest)
        throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
      return await this.#record(body, block, positions, snapshotMeta, afterDigest,
        replayKey, requestHash);
    } catch (cause) {
      return this.#rollback(body, block, before, snapshotMeta.regionDigest,
        replayKey, requestHash, cause);
    }
  }
  async #record(body, block, positions, snapshotMeta, afterDigest, replayKey, requestHash) {
    const objectRef = rev('object');
    const worldRevision = rev('world');
    const receipt = { contractVersion: REGION_WIRE, transactionId: body.transactionId,
      worldRef: body.worldRef, objectRef, status: 'VERIFIED', restoreStatus: 'NOT_REQUIRED',
      previousWorldRevision: body.expectedWorldRevision, observedWorldRevision: worldRevision,
      regionDigest: body.regionDigest, beforeRegionDigest: snapshotMeta.regionDigest,
      afterRegionDigest: afterDigest, chunkCount: regionChunks(block).length,
      writtenCells: positions.length, snapshot: snapshotMeta, localContext: body.localContext };
    const history = validateType('HistoryEntry', { transactionId: body.transactionId,
      originTransactionId: null, affectedObjectRefs: [objectRef],
      operationDigest: body.regionDigest, beforeImageDigest: snapshotMeta.regionDigest,
      expectedAfterReadbackDigest: afterDigest,
      receiptDigest: digest('canvas-region-receipt/v1', receipt),
      historyRevision: rev('history'), status: 'VERIFIED' });
    const response = this.#answer(body, receipt);
    await this.store.commit(state => {
      state.transactions[body.transactionId] = { kind: 'REGION', receipt, history,
        region: block, snapshot: snapshotMeta, objectRef, worldRef: body.worldRef,
        operationDigest: body.regionDigest, worldRevision };
      state.history[objectRef] = [history];
      state.objects[body.worldRef] ??= {};
      state.objects[body.worldRef][objectRef] = { worldRef: body.worldRef, objectRef,
        objectRevision: rev('object'), displayName: null, nameRevision: null,
        creationSequence: Object.keys(state.objects[body.worldRef]).length, status: 'READY' };
      state.footprints[body.worldRef] ??= {};
      // Registered footprints use the public canonical position order (ScopedObjectFootprints).
      state.footprints[body.worldRef][objectRef] = {
        positions: [...positions].sort(comparePosition),
        footprintRevision: rev('footprint'), provenance: 'CANVAS_REGISTERED' };
      state.worldRevisions[body.worldRef] = worldRevision;
      state.registryRevisions[body.worldRef] = rev('registry');
      state.replay[replayKey] = { digest: requestHash, response };
      delete state.pending[body.transactionId];
    });
    return response;
  }
  /** Whole-region rollback: every touched chunk back to `target`, then a full-box readback. */
  async #rollback(body, block, target, targetDigest, replayKey, requestHash, cause) {
    // Only chunks whose write was started can differ; an in-flight chunk counts as touched.
    const touched = new Set((this.store.snapshot.pending[body.transactionId]?.touchedChunks ?? [])
      .map(key));
    try {
      await this.#writeChunks(body, block, target, body.transactionId, 'restore', null, touched);
      const actual = await this.#readBox(body, block, 'restored', body.transactionId);
      if (regionDigest(body.worldRef, block, actual) !== targetDigest)
        throw fail('ROLLBACK_FAILED', 'RESTORE_ERROR', 'apply');
    } catch (restoreError) {
      await this.store.commit(state => {
        const row = state.pending[body.transactionId];
        if (row) { row.phase = 'RESTORE_PENDING'; row.causeCode = cause?.publicError?.code ?? null; }
      });
      const pending = fail('RECOVERY_PENDING', 'TRANSPORT_OUTCOME_UNKNOWN', 'apply');
      pending.publicError.retryability = 'SAME_TRANSACTION_QUERY';
      pending.publicError.mutationState = 'UNKNOWN';
      pending.publicError.transactionRef = body.transactionId;
      pending.publicError.causeCode = restoreError?.publicError?.code ?? 'RESTORE_FAILED';
      throw pending;
    }
    const receipt = { contractVersion: REGION_WIRE, transactionId: body.transactionId,
      worldRef: body.worldRef, status: 'ROLLED_BACK', restoreStatus: 'VERIFIED_RESTORED',
      restoredRegionDigest: targetDigest, causeCode: cause?.publicError?.code ?? 'APPLY_FAILED',
      localContext: body.localContext };
    const response = this.#answer(body, receipt);
    await this.store.commit(state => {
      state.transactions[body.transactionId] = { kind: 'REGION', receipt, worldRef: body.worldRef };
      state.replay[replayKey] = { digest: requestHash, response };
      delete state.pending[body.transactionId];
    });
    return response;
  }

  async #undo(body) {
    this.#shape(body, ['sessionRef', 'requestId', 'worldRef', 'localContext',
      'transactionId', 'protocol', 'historyTransactionId', 'objectRef',
      'expectedHistoryRevision', 'expectedWorldRevision', 'expectedObjectRevision']);
    checkRegionProtocol(body.protocol, CANVAS_REGION_CAPABILITIES, 'canvas');
    const { replayKey, requestHash, prior } = this.#replay(body, 'UndoRegion');
    if (prior) return prior.response;
    await this.#current(body);
    await this.#adapterProtocol(body);
    const state = this.store.snapshot;
    const origin = state.transactions[body.historyTransactionId];
    const object = state.objects[body.worldRef]?.[body.objectRef];
    if (origin?.kind !== 'REGION' || origin.receipt.status !== 'VERIFIED' ||
        origin.objectRef !== body.objectRef || origin.worldRef !== body.worldRef ||
        state.history[body.objectRef]?.at(-1)?.transactionId !== body.historyTransactionId ||
        origin.history.historyRevision !== body.expectedHistoryRevision ||
        object?.objectRevision !== body.expectedObjectRevision)
      throw fail('UNDO_CONFLICT');
    if (body.expectedWorldRevision !== state.worldRevisions[body.worldRef])
      throw fail('STALE_REVISION');
    const block = origin.region;
    const positions = this.#specifiedPositions(block);
    if (this.#footprintConflicts(body.worldRef, positions, body.objectRef).length)
      throw fail('OTHER_OBJECTS_AFFECTED', 'SCOPE_DENIED');
    if (state.pending[body.transactionId] || state.transactions[body.transactionId])
      throw fail('TRANSACTION_CONFLICT');
    // The written cells must still hold exactly what this transaction committed.
    const current = await this.#readBox(body, block, 'before-undo', body.transactionId);
    const restoreTarget = await decodeSnapshot(await this.#snapshots().read(origin.snapshot),
      origin.snapshot, body.worldRef, block);
    const committed = this.#expected(block, restoreTarget);
    const specifiedOnly = records => records.filter((_, i) => block.cells[i] !== UNSPECIFIED)
      .map(r => [r.nodeName, r.param2]);
    if (!same(specifiedOnly(current), specifiedOnly(committed)))
      throw fail('READBACK_MISMATCH', 'EXTERNAL_EDIT_CONFLICT', 'readback');
    // Unspecified cells keep their current value; written cells return to the snapshot.
    const target = current.map((record, i) => block.cells[i] === UNSPECIFIED ? record :
      { ...record, nodeName: restoreTarget[i].nodeName, param2: restoreTarget[i].param2 });
    const targetDigest = regionDigest(body.worldRef, block, target);
    const currentDigest = regionDigest(body.worldRef, block, current);
    await this.store.commit(next => {
      if (next.pending[body.transactionId] || next.transactions[body.transactionId] ||
          inFlight(next, body.worldRef) ||
          next.worldRevisions[body.worldRef] !== body.expectedWorldRevision)
        throw fail('TRANSACTION_CONFLICT');
      next.pending[body.transactionId] = { kind: 'REGION', direction: 'UNDO', body,
        originTransactionId: body.historyTransactionId, phase: 'RESERVED', touchedChunks: [] };
    });
    try {
      await this.#writeChunks(body, block, target, body.transactionId, 'undo',
        (phase, blockPos) => this.store.commit(next => {
          const row = next.pending[body.transactionId];
          if (phase === 'WRITING') row.touchedChunks.push(blockPos);
          row.phase = phase === 'WRITING' ? 'WRITING' : 'CHUNK_WRITTEN';
        }));
      const actual = await this.#readBox(body, block, 'after-undo', body.transactionId);
      if (regionDigest(body.worldRef, block, actual) !== targetDigest)
        throw fail('READBACK_MISMATCH', 'PAYLOAD_CHANGED', 'readback');
    } catch (cause) {
      return this.#rollback(body, block, current, currentDigest, replayKey, requestHash, cause);
    }
    const worldRevision = rev('world');
    const receipt = { contractVersion: REGION_WIRE, transactionId: body.transactionId,
      worldRef: body.worldRef, objectRef: body.objectRef, status: 'VERIFIED',
      restoreStatus: 'NOT_REQUIRED', originTransactionId: body.historyTransactionId,
      previousWorldRevision: body.expectedWorldRevision, observedWorldRevision: worldRevision,
      beforeRegionDigest: currentDigest, afterRegionDigest: targetDigest,
      restoredWrittenCellsDigest: origin.snapshot.regionDigest,
      writtenCells: positions.length, localContext: body.localContext };
    const history = validateType('HistoryEntry', { transactionId: body.transactionId,
      originTransactionId: body.historyTransactionId, affectedObjectRefs: [body.objectRef],
      operationDigest: digest('canvas-region-undo/v1', { origin: body.historyTransactionId,
        before: currentDigest, after: targetDigest }),
      beforeImageDigest: currentDigest, expectedAfterReadbackDigest: targetDigest,
      receiptDigest: digest('canvas-region-receipt/v1', receipt),
      historyRevision: rev('history'), status: 'VERIFIED' });
    const response = this.#answer(body, receipt);
    await this.store.commit(next => {
      next.transactions[body.transactionId] = { kind: 'REGION_UNDO', receipt, history,
        originTransactionId: body.historyTransactionId, objectRef: body.objectRef,
        worldRef: body.worldRef };
      next.history[body.objectRef].push(history);
      next.objects[body.worldRef][body.objectRef].objectRevision = rev('object');
      next.footprints[body.worldRef][body.objectRef].positions = [];
      next.footprints[body.worldRef][body.objectRef].footprintRevision = rev('footprint');
      next.worldRevisions[body.worldRef] = worldRevision;
      next.registryRevisions[body.worldRef] = rev('registry');
      next.replay[replayKey] = { digest: requestHash, response };
      delete next.pending[body.transactionId];
    });
    return response;
  }

  /**
   * After a normal reopen, a region APPLY left pending (e.g. restore failed) is
   * rolled back from its durable compressed snapshot. Nothing new is applied.
   */
  async recoverPending() {
    await this.canvas.ready;
    const outcomes = [];
    for (const [transactionId, row] of Object.entries(this.store.snapshot.pending)) {
      if (row.kind !== 'REGION' || row.direction !== 'APPLY') continue;
      const body = { ...row.body, requestId: `${row.body.requestId}:recover` };
      const block = row.body.region;
      try {
        await this.#current(body);
        const before = await decodeSnapshot(await this.#snapshots().read(row.snapshot),
          row.snapshot, body.worldRef, block);
        const replayKey = `${row.body.sessionRef}\0region:ApplyRegionCommit\0${row.body.requestId}`;
        const requestHash = digest('canvas-region-request/v1',
          { operation: 'ApplyRegionCommit', body: row.body });
        // Restore writes only the specified cells, so the full before image is the target.
        const response = await this.#rollback({ ...body, transactionId }, block, before,
          row.snapshot.regionDigest, replayKey, requestHash,
          regionFail(row.causeCode ?? 'RECOVERY_PENDING'));
        outcomes.push({ transactionId, status: response.result.status });
      } catch (error) {
        outcomes.push({ transactionId, status: 'RECOVERY_PENDING',
          code: error.publicError?.code ?? 'RECOVERY_PENDING' });
      }
    }
    return outcomes;
  }

  async call(operation, body) {
    try {
      await this.canvas.ready;
      if (!this.store || this.store.unavailable)
        throw fail('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
      if (operation === 'DescribeRegionTool') return this.#answer(body ?? {}, this.describe());
      if (operation === 'ApplyRegionCommit') return await this.#commit(body);
      if (operation === 'UndoRegion') return await this.#undo(body);
      throw fail('UNSUPPORTED_OPERATION', 'INVALID_SHAPE', 'decode');
    } catch (error) {
      const publicError = error.publicError ?? { code: 'APPLY_FAILED', phase: 'apply',
        retryability: 'AFTER_NEW_FACTS', mutationState: 'UNKNOWN', transactionRef: null,
        causeCode: null, reason: 'APPLY_ERROR' };
      const response = this.#answer(body ?? { requestId: 'invalid-request' }, null, publicError);
      if (error.missingCapabilities) response.missingCapabilities = error.missingCapabilities;
      return response;
    }
  }
}
