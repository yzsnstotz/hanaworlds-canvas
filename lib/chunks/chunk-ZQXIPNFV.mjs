import {
  VOXEL_GRID,
  affectedObjectRefs,
  positionKey,
  regionPositions,
  requireVoxelGrid
} from "./chunk-EV5EIDTT.mjs";
import {
  trustedSessionWorld,
  withTargetWorld
} from "./chunk-VS6GPVBD.mjs";
import {
  canonicalJSON,
  checkConfirmedRegionPlacementCommit,
  checkProtocolCompatibility,
  composeScopedRegionUndoRecoveryTarget,
  composeScopedRegionUndoTarget,
  contractProtocols,
  deriveConfirmedRegionUndoScope,
  digestValue,
  expectedRegionSummary,
  guardRefusalError,
  protocolRequirement,
  publicError,
  regionBlockBox,
  regionCapabilities,
  requireKnownRegion,
  summarizeRegionStates,
  unmetEngineGuards,
  validateBoundResponse,
  validateRegionCommit,
  validateRegionCommitRequest,
  validateRegionRead,
  validateRegionSnapshotContent,
  validateRegionUndo,
  validateRegionWrite,
  validateRequest,
  validateResponse,
  validateScopedRegionUndo,
  validateScopedRegionUndoRequest,
  validateType
} from "./chunk-REOIFHVS.mjs";

// src/region-v1.mjs
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip, constants as zlib } from "node:zlib";
import packageJson from "../../package.json" with { type: "json" };
var REGION_WIRE = "canvas-region/v3";
var REGION_ADAPTER = "world-adapter-region/v3";
var ADAPTER = "world-adapter/v8";
var PACKAGE_VERSION = packageJson.version;
var CANVAS_REGION_CAPABILITIES = Object.freeze(regionCapabilities.filter((c) => c.id.startsWith(`${REGION_WIRE}:`)).map((c) => c.id).sort());
var WORLD_SOURCE_ROLE = "world-source";
var ADAPTER_CAPABILITIES = regionCapabilities.filter((c) => c.owner === WORLD_SOURCE_ROLE).map((c) => c.id);
if (!ADAPTER_CAPABILITIES.length) throw new Error(`CANVAS_ADAPTER_ROLE_UNDECLARED:${WORLD_SOURCE_ROLE}`);
var adapterRequirement = (wire) => {
  const declared = contractProtocols.find((p) => `${p.protocol}/v${p.major}` === wire);
  if (!declared) throw new Error(`CANVAS_ADAPTER_PROTOCOL_UNDECLARED:${wire}`);
  return protocolRequirement(
    wire,
    ADAPTER_CAPABILITIES.filter((id) => id.startsWith(`${wire}:`)),
    0
  );
};
var ADAPTER_REGION_REQUIREMENT = adapterRequirement(REGION_ADAPTER);
var ADAPTER_CELL_REQUIREMENT = adapterRequirement(ADAPTER);
{
  const unscoped = ADAPTER_CAPABILITIES.filter((id) => !id.startsWith(`${REGION_ADAPTER}:`) && !id.startsWith(`${ADAPTER}:`));
  if (unscoped.length) throw new Error(`CANVAS_ADAPTER_CAPABILITY_UNSCOPED:${unscoped.join(",")}`);
}
var ALL = ["BODY_CLEARANCE", "CELL_PROTECTION", "PLAYER_ENCLOSURE"];
var ROLLBACK = ["BODY_CLEARANCE", "CELL_PROTECTION"];
var needs = (stages, guards) => stages.flatMap((stage) => guards.map((guard) => ({ guard, stage })));
var ENGINE_GUARD_REQUIREMENTS = Object.freeze(Object.fromEntries(Object.entries({
  ApplyRecoverableCommit: [...needs(["APPLY_COMPILED"], ALL), ...needs(["RESTORE"], ROLLBACK)],
  Undo: [...needs(["APPLY_HISTORY"], ALL), ...needs(["RESTORE"], ROLLBACK)],
  Redo: [...needs(["APPLY_HISTORY"], ALL), ...needs(["RESTORE"], ROLLBACK)],
  ApplyRegionCommit: [...needs(["REGION_APPLY"], ALL), ...needs(["REGION_RESTORE"], ROLLBACK)],
  UndoRegionCommit: needs(["REGION_RESTORE"], ALL),
  UndoScopedRegionCommit: needs(["REGION_RESTORE"], ALL),
  RecoverRegion: needs(["REGION_RESTORE"], ROLLBACK)
}).map(([operation, rows]) => [operation, Object.freeze(rows.map((row) => Object.freeze(row)))])));
function unmetGuards(declaration, operation) {
  return unmetEngineGuards(declaration ?? null, ENGINE_GUARD_REQUIREMENTS[operation]).map((refusal) => ({ ...refusal }));
}
function requireGuards(declaration, operation, transactionRef = null) {
  const unmet = unmetGuards(declaration, operation);
  if (!unmet.length) return;
  const error = regionFail("CAPABILITY_UNAVAILABLE", "REQUIRED_FACT_UNKNOWN");
  error.publicError = { ...guardRefusalError(unmet[0], { preflight: true, transactionRef }) };
  error.guardRefusal = unmet[0];
  error.unmetGuards = unmet;
  throw error;
}
var SNAPSHOT_COMPRESSION = "gzip";
var gz = promisify(gzip);
var gunz = promisify(gunzip);
var sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
var D = (kind, value) => digestValue(kind, value).sha256;
var same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
var rev = (prefix) => `${prefix}-${randomUUID()}`;
var inFlight = (state, worldRef) => Object.values(state.pending).some((row) => row.body?.worldRef === worldRef);
var canvasProtocolHandshake = Object.freeze(validateType("ProtocolHandshake", {
  profileVersion: "protocol-handshake/v1",
  component: "hanaworlds-canvas",
  protocols: [{ protocol: "canvas-region", major: 3, minor: 2 }],
  capabilities: [...CANVAS_REGION_CAPABILITIES],
  provenance: {
    packageName: "hanaworlds-canvas",
    packageVersion: PACKAGE_VERSION,
    sourceRevision: null,
    artifactDigest: null
  }
}));
function regionToolDescription(capabilities = null) {
  const geometry = capabilities && requireVoxelGrid(VOXEL_GRID, capabilities.worldGeometry);
  return {
    tool: "canvas.region",
    operations: ["ApplyRegionCommit", "UndoRegionCommit", "UndoScopedRegionCommit"],
    purpose: "Commit one compiled region (fill and explicit empty-material carve) across world-source partitions as one logical transaction; scoped undo restores only committed confirmed cells and preserves current outside state. Region Redo is unavailable.",
    typicalScale: "Terrain shaping and large fills or carves spanning world-source partitions" + (geometry ? ` (${geometry.partition.edge.join("x")} cells per partition). ` : "; select a world to read its partition size. ") + "Cell-by-cell BUILD with per-cell Undo stays the tool for fine adjustment; which one to use is the skill's choice.",
    prerequisites: [
      "a current world connection selected in Canvas",
      "region operations compiled by Brush (region-operations/v2) with their digest",
      "no registered object footprint inside the specified cells",
      "every touched partition KNOWN after world-source load",
      `world source advertising ${ADAPTER_REGION_REQUIREMENT.protocol} major ${ADAPTER_REGION_REQUIREMENT.major} and ${ADAPTER_CELL_REQUIREMENT.protocol} major ${ADAPTER_CELL_REQUIREMENT.major} at the Contracts-declared minors with every required capability`
    ],
    unspecifiedCells: "left untouched; only an explicit empty-material palette entry carves",
    worldSource: geometry ? {
      status: "AVAILABLE",
      worldRef: capabilities.worldRef,
      capabilityRevision: capabilities.capabilityRevision,
      geometryProfiles: structuredClone(capabilities.worldGeometry.geometryProfiles),
      partition: structuredClone(geometry.partition),
      engineBounds: structuredClone(capabilities.engineBounds),
      postWriteLighting: geometry.postWriteLighting
    } : {
      status: "UNBOUND",
      geometryProfiles: null,
      partition: null,
      engineBounds: null,
      postWriteLighting: null
    }
  };
}
function regionFail(code, reason = "REVISION_CHANGED", phase = "validate") {
  const error = new Error(code);
  error.publicError = {
    code,
    phase,
    retryability: "AFTER_NEW_FACTS",
    mutationState: "NONE",
    transactionRef: null,
    causeCode: null,
    reason
  };
  return error;
}
var fail = regionFail;
function applyProgressFailure(body, written, before, code = "APPLY_FAILED", reason = "APPLY_ERROR", phase = "apply") {
  const chunks = written.response.result.chunks;
  const mutationState = chunks.some((c) => c.status === "UNKNOWN") ? "UNKNOWN" : chunks.some((c, i) => c.status === "WRITTEN" && c.readbackDigest !== before.chunks[i].stateDigest) ? "PARTIAL" : chunks.every((c) => c.status === "NOT_WRITTEN") ? "NONE" : "UNKNOWN";
  const error = fail(code, reason, phase);
  error.publicError.mutationState = mutationState;
  error.publicError.transactionRef = body.transactionId;
  return error;
}
function observedRollbackCause(cause, transactionId) {
  const error = cause?.publicError;
  if (!error || error.phase === "restore" || !["NONE", "PARTIAL", "UNKNOWN"].includes(error.mutationState) || error.transactionRef !== null && error.transactionRef !== transactionId) return null;
  try {
    return validateType("FailureDetail", { error, guardRefusal: cause.guardRefusal ?? null });
  } catch {
    return null;
  }
}
function failureDetail(cause) {
  const error = cause?.publicError ?? {
    code: "APPLY_FAILED",
    phase: "apply",
    retryability: "AFTER_NEW_FACTS",
    mutationState: "UNKNOWN",
    transactionRef: null,
    causeCode: null,
    reason: "APPLY_ERROR"
  };
  return { error: validateType("Error", error), guardRefusal: cause?.guardRefusal ?? null };
}
function engineFormRefusal(error) {
  const e = error?.publicError;
  return !!error?.guardRefusal && e?.phase === "restore" && e.causeCode === null && e.mutationState === "NONE";
}
function restoreFailure(restoreError, applyFailure, transactionRef) {
  const refused = restoreError?.publicError;
  if (refused?.phase !== "restore" || refused.code !== "RESTORE_FAILED" && !restoreError.guardRefusal) return null;
  const guardRefusal = restoreError.guardRefusal ?? null;
  const cause = applyFailure.error.code;
  const error = guardRefusal ? { ...guardRefusalError(guardRefusal, { transactionRef, cause }) } : { ...restoreError.publicError, transactionRef, causeCode: cause };
  return { error, guardRefusal };
}
function restoreFailedResponse(body, operation, restoreError, cause) {
  try {
    const applyFailure = failureDetail(cause);
    const failure = restoreFailure(restoreError, applyFailure, body.transactionId);
    if (!failure) return null;
    return validateResponse(REGION_WIRE, operation, {
      contractVersion: REGION_WIRE,
      requestId: body.requestId,
      result: null,
      error: failure.error,
      guardRefusal: failure.guardRefusal,
      applyFailure
    });
  } catch (shapeError) {
    restoreError.receiptRejected = shapeError.publicError?.code ?? shapeError.code ?? shapeError.message;
    return null;
  }
}
async function encodeSnapshot(content, beforeSummary) {
  const raw = Buffer.from(canonicalJSON(content));
  const compressed = await gz(raw, { level: zlib.Z_BEST_COMPRESSION });
  const ref = validateType("RegionSnapshotRef", {
    profileVersion: "region-snapshot/v1",
    contentDigest: D("region-snapshot-content", content),
    beforeSummaryDigest: D("region-summary", beforeSummary),
    compression: SNAPSHOT_COMPRESSION,
    compressedSha256: sha(compressed),
    compressedByteLength: compressed.length
  });
  return { ref, compressed, rawByteLength: raw.length };
}
async function decodeSnapshot(compressed, ref, beforeSummary) {
  if (ref.compression !== SNAPSHOT_COMPRESSION || sha(compressed) !== ref.compressedSha256 || compressed.length !== ref.compressedByteLength)
    throw fail("READBACK_MISMATCH", "PAYLOAD_CHANGED", "readback");
  const content = JSON.parse((await gunz(compressed)).toString("utf8"));
  return validateRegionSnapshotContent(content, ref, beforeSummary);
}
var SnapshotFiles = class {
  constructor(directory) {
    this.directory = join(directory, "region-snapshots");
  }
  path(ref) {
    return join(this.directory, `${ref.compressedSha256}.json.gz`);
  }
  async write(snapshot) {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    const temporary = join(this.directory, `.snapshot-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 384);
    try {
      await file.writeFile(snapshot.compressed);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path(snapshot.ref));
  }
  read(ref) {
    return readFile(this.path(ref));
  }
};
function unionBox(boxes) {
  return {
    min: [0, 1, 2].map((a) => Math.min(...boxes.map((b) => b.min[a]))),
    max: [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b.max[a])))
  };
}
var CanvasRegionV1 = class {
  constructor(canvas, regionAdapter) {
    this.canvas = canvas;
    this.regionAdapter = regionAdapter;
  }
  get protocolHandshake() {
    return structuredClone(canvasProtocolHandshake);
  }
  async describe(sessionRef = null) {
    await this.canvas.ready;
    let capabilities = null;
    if (sessionRef !== null) {
      const session = this.canvas.current(sessionRef);
      if (!session) throw fail("WORLD_NOT_BOUND", "SCOPE_DENIED");
      const body = {
        sessionRef,
        worldRef: session.activeWorldRef,
        localContext: session.localContext,
        requestId: `describe-${randomUUID()}`
      };
      const connection = await this.#current(body);
      const current = this.canvas.current(sessionRef);
      if (!current || !same(current.localContext, body.localContext) || connection.connectionRef !== body.localContext.connectionRef || connection.capabilities.worldRef !== body.worldRef)
        throw fail("CURRENT_WORLD_MISMATCH", "SCOPE_DENIED");
      capabilities = connection.capabilities;
    }
    return structuredClone({
      ...regionToolDescription(capabilities),
      protocolHandshake: canvasProtocolHandshake
    });
  }
  get store() {
    return this.canvas.store;
  }
  #snapshots() {
    return new SnapshotFiles(this.store.directory);
  }
  /** Adapter compatibility (region port and per-cell port) before any region read or write. */
  #adapterCompatible() {
    const region = this.regionAdapter?.protocolHandshake;
    if (!this.regionAdapter?.call || region === void 0)
      throw fail("UNSUPPORTED_VERSION", "VERSION_UNSUPPORTED", "decode");
    this.canvas.adapterCompatible();
    return checkProtocolCompatibility(region, [ADAPTER_REGION_REQUIREMENT]);
  }
  /** The current connection, then the engine guards `operation` needs from its declaration. */
  async #guarded(body, operation) {
    const connection = await this.#current(body);
    const geometry = requireVoxelGrid(VOXEL_GRID, connection.capabilities.worldGeometry);
    for (const chunk of body.operations?.chunks ?? [])
      requireVoxelGrid(chunk.block.geometryProfile, geometry);
    if (body.operations && !same(body.operations.partition, geometry.partition))
      throw fail("CAPABILITY_GAP", "GEOMETRY_PROFILE_UNSUPPORTED");
    requireGuards(connection.capabilities.engineGuards, operation);
    return connection;
  }
  async #current(body) {
    const session = this.store.snapshot.sessions[body.sessionRef];
    if (!session || session.activeWorldRef !== body.worldRef || !same(session.localContext, body.localContext))
      throw fail("CURRENT_WORLD_MISMATCH", "SCOPE_DENIED");
    if (!this.canvas.adapter?.call) throw fail("CAPABILITY_UNAVAILABLE", "REQUIRED_FACT_UNKNOWN");
    const request = {
      contractVersion: ADAPTER,
      sessionRef: body.sessionRef,
      requestId: `${body.requestId}:current-connection`,
      connectionRef: body.localContext.connectionRef
    };
    const response = await this.canvas.adapter.call("ReadLocalConnection", request);
    validateBoundResponse(ADAPTER, "ReadLocalConnection", request, response);
    if (response.error || response.result.worldRef !== body.worldRef || response.result.connectionIncarnationRef !== body.localContext.connectionIncarnationRef)
      throw fail("CURRENT_WORLD_MISMATCH", "SCOPE_DENIED");
    return response.result;
  }
  /**
   * Load-then-know read of every world-source partition of `box`; still unknown rejects. The
   * result is aligned to `layout` ([chunkPos, box] of the compiled chunks): Brush
   * omits partitions without specified cells, and every compiled chunk must be read.
   */
  async #read(body, box, purpose, suffix, layout) {
    const request = {
      contractVersion: REGION_ADAPTER,
      sessionRef: body.sessionRef,
      requestId: `${body.requestId}:${suffix}`,
      worldRef: body.worldRef,
      box,
      purpose,
      partition: (await this.#geometry(body)).partition,
      localContext: body.localContext
    };
    const response = validateRegionRead(request, await this.regionAdapter.call("ReadRegion", request));
    if (response.error) throw Object.assign(
      new Error(response.error.code),
      { publicError: response.error }
    );
    const read = requireKnownRegion(response.result);
    const byPos = new Map(read.chunks.map((c) => [positionKey(c.chunkPos), c]));
    const chunks = layout.map(([chunkPos, chunkBox]) => {
      const chunk = byPos.get(positionKey(chunkPos));
      if (!chunk || !same(chunk.box, chunkBox))
        throw fail("TARGET_FACTS_INCOMPLETE", "REQUIRED_FACT_UNKNOWN", "readback");
      return chunk;
    });
    return { worldRef: read.worldRef, partition: read.partition, chunks };
  }
  async #write(body, transactionId, purpose, writes, suffix, scoped = false) {
    const request = {
      contractVersion: REGION_ADAPTER,
      sessionRef: body.sessionRef,
      requestId: `${body.requestId}:${suffix}`,
      worldRef: body.worldRef,
      transactionId,
      purpose,
      writes,
      partition: (await this.#geometry(body)).partition,
      localContext: body.localContext
    };
    let written;
    const uncertain = (cause) => {
      if (!scoped) return cause;
      const error = fail("RECOVERY_PENDING", "TRANSPORT_OUTCOME_UNKNOWN", "restore");
      error.publicError.mutationState = "UNKNOWN";
      error.publicError.transactionRef = transactionId;
      error.publicError.causeCode = cause.publicError?.code ?? null;
      error.sourceValidationFailure = cause.sourceFailure ?? (cause.publicError ? failureDetail(cause) : null);
      error.scopedWriteAccepted = true;
      return error;
    };
    try {
      written = validateRegionWrite(request, await this.regionAdapter.call("WriteRegion", request));
      const sourceError = written.response.error;
      if (scoped && sourceError && (sourceError.transactionRef !== null && sourceError.transactionRef !== transactionId || sourceError.worldRef !== void 0 && sourceError.worldRef !== body.worldRef)) {
        const cause = fail("TRANSACTION_CONFLICT", "PAYLOAD_CHANGED", "restore");
        cause.sourceFailure = failureDetail({
          publicError: sourceError,
          guardRefusal: written.response.guardRefusal ?? null
        });
        throw cause;
      }
    } catch (cause) {
      throw uncertain(cause);
    }
    if (written.response.error) throw Object.assign(
      new Error(written.response.error.code),
      { publicError: written.response.error, guardRefusal: written.response.guardRefusal ?? null }
    );
    try {
      if (written.response.result.postWriteLighting !== (await this.#geometry(body)).postWriteLighting)
        throw fail("CAPABILITY_GAP", "GEOMETRY_PROFILE_UNSUPPORTED");
    } catch (cause) {
      throw uncertain(cause);
    }
    return written;
  }
  async #geometry(body) {
    const connection = await this.#current(body);
    return requireVoxelGrid(VOXEL_GRID, connection.capabilities.worldGeometry);
  }
  #content(worldRef, read) {
    return validateType("RegionSnapshotContent", {
      profileVersion: "region-snapshot-content/v2",
      worldRef,
      partition: read.partition,
      chunks: read.chunks.map((c) => ({ chunkPos: c.chunkPos, state: c.state, stateDigest: c.stateDigest }))
    });
  }
  #summary(worldRef, read) {
    return summarizeRegionStates(worldRef, read.partition, read.chunks.map((c) => ({
      chunkPos: c.chunkPos,
      state: c.state
    })));
  }
  #footprintConflicts(worldRef, positions, exceptObjectRef = null) {
    return affectedObjectRefs(
      this.store.snapshot.footprints[worldRef],
      positions,
      VOXEL_GRID,
      exceptObjectRef
    );
  }
  #replay(body, operation) {
    const replayKey = `${body.sessionRef}\0${REGION_WIRE}:${operation}\0${body.requestId}`;
    const requestHash = sha(`${REGION_WIRE}|${operation}
${canonicalJSON(body)}`);
    const prior = this.store.snapshot.replay[replayKey] ?? null;
    if (prior && prior.digest !== requestHash) throw fail("REPLAY_MISMATCH", "PAYLOAD_CHANGED");
    return { replayKey, requestHash, prior };
  }
  #answer(body, operation, result) {
    return validateResponse(REGION_WIRE, operation, {
      contractVersion: REGION_WIRE,
      requestId: body.requestId,
      result,
      error: null,
      guardRefusal: null,
      applyFailure: null
    });
  }
  async #pendingPhase(transactionId, phase, extra = {}) {
    await this.store.commit((next) => {
      if (next.pending[transactionId])
        Object.assign(next.pending[transactionId], { phase, ...extra });
    });
  }
  async #commit(body) {
    const { replayKey, requestHash, prior } = this.#replay(body, "ApplyRegionCommit");
    if (prior) return prior.response;
    this.#adapterCompatible();
    await this.#guarded(body, "ApplyRegionCommit");
    const state = this.store.snapshot;
    if (body.confirmedPlacement !== void 0) {
      const recorded = state.placementInspections[body.confirmedPlacement.placement.source.inspectionId];
      if (!recorded?.inspection || recorded.sessionRef !== body.sessionRef || recorded.worldRef !== body.worldRef || !same(recorded.localContext, body.localContext))
        throw fail("INSPECTION_FAILED", "REQUIRED_FACT_UNKNOWN");
      checkConfirmedRegionPlacementCommit(body, recorded.inspection, state.worldRevisions[body.worldRef]);
    }
    const positions = regionPositions(body.operations);
    if (this.#footprintConflicts(body.worldRef, positions).length)
      throw fail("OTHER_OBJECTS_AFFECTED", "SCOPE_DENIED");
    if (state.pending[body.transactionId] || state.transactions[body.transactionId] || inFlight(state, body.worldRef))
      throw fail("TRANSACTION_CONFLICT");
    const layout = body.operations.chunks.map((c) => [c.chunkPos, regionBlockBox(c.block)]);
    const box = unionBox(layout.map(([, b]) => b));
    const before = await this.#read(body, box, "BEFORE_IMAGE", "before", layout);
    const content = validateType("RegionSnapshotContent", {
      profileVersion: "region-snapshot-content/v2",
      worldRef: body.worldRef,
      partition: (await this.#geometry(body)).partition,
      chunks: before.chunks.map((c) => ({
        chunkPos: c.chunkPos,
        state: c.state,
        stateDigest: c.stateDigest
      }))
    });
    const beforeSummary = this.#summary(body.worldRef, before);
    const expectedAfterSummary = expectedRegionSummary(content, body.operations);
    const snapshot = await encodeSnapshot(content, beforeSummary);
    await this.#snapshots().write(snapshot);
    const worldRevision = state.worldRevisions[body.worldRef];
    await this.store.commit((next) => {
      if (next.pending[body.transactionId] || next.transactions[body.transactionId] || inFlight(next, body.worldRef) || next.worldRevisions[body.worldRef] !== worldRevision)
        throw fail("TRANSACTION_CONFLICT");
      next.pending[body.transactionId] = {
        kind: "REGION",
        direction: "APPLY",
        body,
        snapshot: snapshot.ref,
        beforeSummary,
        box,
        layout,
        phase: "SNAPSHOTTED"
      };
    });
    let lighting = null;
    try {
      await this.#pendingPhase(body.transactionId, "WRITING");
      const written = await this.#write(
        body,
        body.transactionId,
        "APPLY",
        body.operations.chunks.map((c, i) => ({
          chunkPos: c.chunkPos,
          expectedCurrentDigest: before.chunks[i].stateDigest,
          ops: c.block,
          state: null
        })),
        "apply"
      );
      lighting = written.response.result?.lighting ?? null;
      if (!written.allWritten) throw applyProgressFailure(body, written, before);
      const after = await this.#read(body, box, "READBACK", "after", layout);
      const actualSummary = this.#summary(body.worldRef, after);
      if (!same(actualSummary, expectedAfterSummary))
        throw applyProgressFailure(
          body,
          written,
          before,
          "READBACK_MISMATCH",
          "READBACK_ERROR",
          "readback"
        );
      return await this.#record(body, {
        beforeSummary,
        expectedAfterSummary,
        actualSummary,
        snapshot: snapshot.ref,
        lighting,
        positions,
        box,
        layout,
        replayKey,
        requestHash,
        beforeContent: content,
        after
      });
    } catch (cause) {
      if (cause?.guardRefusal && cause.publicError?.mutationState === "NONE") {
        const now = await this.#read(body, box, "INSPECT", "apply-refused", layout);
        if (same(this.#summary(body.worldRef, now), beforeSummary)) {
          const response = validateResponse(REGION_WIRE, "ApplyRegionCommit", {
            contractVersion: REGION_WIRE,
            requestId: body.requestId,
            result: null,
            error: { ...cause.publicError },
            guardRefusal: { ...cause.guardRefusal },
            applyFailure: null
          });
          await this.store.commit((state2) => {
            state2.replay[replayKey] = { digest: requestHash, response };
            delete state2.pending[body.transactionId];
          });
          return response;
        }
      }
      return this.#rollback(body, {
        content,
        beforeSummary,
        expectedAfterSummary,
        snapshot: snapshot.ref,
        box,
        lighting,
        replayKey,
        requestHash,
        cause
      });
    }
  }
  async #record(body, facts) {
    const {
      beforeSummary,
      expectedAfterSummary,
      actualSummary,
      snapshot,
      lighting,
      positions,
      box,
      layout,
      replayKey,
      requestHash
    } = facts;
    const objectRef = rev("object");
    const historyRevision = rev("history");
    const worldRevision = rev("world");
    const result = {
      transactionId: body.transactionId,
      worldRef: body.worldRef,
      status: "VERIFIED",
      operationDigest: body.operationDigest,
      beforeSummary,
      expectedAfterSummary,
      actualSummary,
      snapshot,
      historyRevision,
      postWriteLighting: (await this.#geometry(body)).postWriteLighting,
      lighting,
      affectedObjectRefs: [],
      localContext: body.localContext
    };
    const response = this.#answer(body, "ApplyRegionCommit", result);
    validateRegionCommit(body, response);
    const history = validateType("HistoryEntry", {
      transactionId: body.transactionId,
      originTransactionId: null,
      affectedObjectRefs: [objectRef],
      operationDigest: body.operationDigest,
      beforeImageDigest: D("region-summary", beforeSummary),
      expectedAfterReadbackDigest: D("region-summary", actualSummary),
      receiptDigest: sha(canonicalJSON(result)),
      historyRevision,
      status: "VERIFIED"
    });
    const afterContent = this.#content(body.worldRef, facts.after);
    const afterSnapshot = await encodeSnapshot(afterContent, actualSummary);
    await this.#snapshots().write(afterSnapshot);
    const confirmedUndoScope = deriveConfirmedRegionUndoScope({ request: body, result, before: facts.beforeContent, after: afterContent });
    await this.store.commit((state) => {
      state.transactions[body.transactionId] = {
        kind: "REGION",
        result,
        history,
        box,
        layout,
        originRequest: body,
        verifiedAfterSnapshot: afterSnapshot.ref,
        confirmedUndoScope,
        confirmedUndoScopeDigest: D("confirmed-region-undo-scope", confirmedUndoScope),
        displayMetadata: {
          committedAt: (/* @__PURE__ */ new Date()).toISOString(),
          mode: "REGION",
          affectedCells: positions.length
        },
        objectRef,
        worldRef: body.worldRef,
        operations: body.operations,
        worldRevision,
        receipt: { status: "VERIFIED", localContext: body.localContext }
      };
      state.history[objectRef] = [history];
      state.objects[body.worldRef] ??= {};
      state.objects[body.worldRef][objectRef] = {
        worldRef: body.worldRef,
        objectRef,
        objectRevision: rev("object"),
        displayName: null,
        nameRevision: null,
        creationSequence: Object.keys(state.objects[body.worldRef]).length,
        status: "READY"
      };
      state.footprints[body.worldRef] ??= {};
      state.footprints[body.worldRef][objectRef] = {
        positions,
        footprintRevision: rev("footprint"),
        provenance: "CANVAS_REGISTERED"
      };
      state.worldRevisions[body.worldRef] = worldRevision;
      state.registryRevisions[body.worldRef] = rev("registry");
      state.replay[replayKey] = { digest: requestHash, response };
      delete state.pending[body.transactionId];
    });
    return response;
  }
  /**
   * Whole-region restore to `content` (a durable image): read current,
   * RESTORE the target image, read back, require the target summary. A required
   * light pass covers the entire saved layout; NONE only rewrites changed chunks.
   */
  async #restore(body, transactionId, content, targetSummary, box, suffix) {
    const geometry = await this.#geometry(body);
    if (!same(content.partition, geometry.partition))
      throw fail("CAPABILITY_GAP", "GEOMETRY_PROFILE_UNSUPPORTED");
    const layout = content.chunks.map((c) => [c.chunkPos, regionBlockBox(c.state.block)]);
    const current = await this.#read(body, box, "INSPECT", `${suffix}-current`, layout);
    const targets = content.chunks.map((c, i) => ({
      chunkPos: c.chunkPos,
      expectedCurrentDigest: current.chunks[i].stateDigest,
      ops: null,
      state: c.state
    }));
    const changed = targets.filter((w, i) => w.expectedCurrentDigest !== content.chunks[i].stateDigest);
    const writes = geometry.postWriteLighting === "NONE" ? changed : targets;
    let lighting = null;
    if (writes.length) {
      const written = await this.#write(body, transactionId, "RESTORE", writes, suffix);
      lighting = written.response.result?.lighting ?? null;
      if (!written.allWritten) throw fail("RESTORE_FAILED", "RESTORE_ERROR", "apply");
    }
    const after = await this.#read(body, box, "READBACK", `${suffix}-readback`, layout);
    const actual = this.#summary(body.worldRef, after);
    if (!same(actual, targetSummary)) throw fail("ROLLBACK_FAILED", "RESTORE_ERROR", "apply");
    return { actual, lighting };
  }
  async #rollback(body, facts) {
    const {
      content,
      beforeSummary,
      expectedAfterSummary,
      snapshot,
      box,
      replayKey,
      requestHash,
      cause
    } = facts;
    let restored;
    try {
      restored = await this.#restore(
        body,
        body.transactionId,
        content,
        beforeSummary,
        box,
        "restore"
      );
    } catch (restoreError) {
      const restoreCode = restoreError?.publicError?.code ?? restoreError?.code ?? "RESTORE_FAILED";
      const failed = restoreFailedResponse(body, "ApplyRegionCommit", restoreError, cause);
      await this.#pendingPhase(body.transactionId, "RESTORE_PENDING", {
        restoreCode,
        causeCode: cause?.publicError?.code ?? cause?.code ?? null,
        receiptStatus: failed ? "RESTORE_FAILED" : "RECOVERY_PENDING",
        guardRefusal: restoreError?.guardRefusal ?? null,
        receiptRejected: restoreError?.receiptRejected ?? null
      });
      if (failed) {
        await this.store.commit((state) => {
          state.replay[replayKey] = { digest: requestHash, response: failed };
        });
        return failed;
      }
      const pending = fail("RECOVERY_PENDING", "TRANSPORT_OUTCOME_UNKNOWN", "apply");
      pending.publicError.retryability = "SAME_TRANSACTION_QUERY";
      pending.publicError.mutationState = "UNKNOWN";
      pending.publicError.transactionRef = body.transactionId;
      pending.publicError.causeCode = restoreCode;
      throw pending;
    }
    const lighting = restored.lighting;
    const result = {
      transactionId: body.transactionId,
      worldRef: body.worldRef,
      status: "ROLLED_BACK",
      operationDigest: body.operationDigest,
      beforeSummary,
      expectedAfterSummary,
      actualSummary: restored.actual,
      snapshot,
      historyRevision: rev("history-none"),
      postWriteLighting: (await this.#geometry(body)).postWriteLighting,
      lighting,
      affectedObjectRefs: [],
      localContext: body.localContext
    };
    const rollbackCause = observedRollbackCause(cause, body.transactionId);
    if (rollbackCause) result.rollbackCause = rollbackCause;
    const response = this.#answer(body, "ApplyRegionCommit", result);
    validateRegionCommit(body, response);
    await this.store.commit((state) => {
      state.transactions[body.transactionId] = {
        kind: "REGION",
        result,
        worldRef: body.worldRef,
        causeCode: cause?.publicError?.code ?? cause?.code ?? "APPLY_FAILED",
        receipt: { status: "ROLLED_BACK", localContext: body.localContext }
      };
      state.replay[replayKey] = { digest: requestHash, response };
      delete state.pending[body.transactionId];
    });
    return response;
  }
  async #originEvidence(origin) {
    if (!origin.originRequest || !origin.verifiedAfterSnapshot || !origin.confirmedUndoScope)
      throw fail("CAPABILITY_UNAVAILABLE", "REQUIRED_FACT_UNKNOWN");
    const before = await decodeSnapshot(
      await this.#snapshots().read(origin.result.snapshot),
      origin.result.snapshot,
      origin.result.beforeSummary
    );
    const after = await decodeSnapshot(
      await this.#snapshots().read(origin.verifiedAfterSnapshot),
      origin.verifiedAfterSnapshot,
      origin.result.actualSummary
    );
    const evidence = { request: origin.originRequest, result: origin.result, before, after };
    const scope = deriveConfirmedRegionUndoScope(evidence);
    if (!same(origin.operations, evidence.request.operations) || origin.worldRef !== evidence.request.worldRef)
      throw fail("UNDO_CONFLICT", "PAYLOAD_CHANGED");
    if (!same(scope, origin.confirmedUndoScope) || D("confirmed-region-undo-scope", scope) !== origin.confirmedUndoScopeDigest)
      throw fail("UNDO_CONFLICT", "PAYLOAD_CHANGED");
    return evidence;
  }
  async #scopedRestore(body, target, baseline, origin, suffix, guardOperation = "UndoScopedRegionCommit") {
    const connection = await this.#guarded(body, guardOperation);
    const geometry = requireVoxelGrid(VOXEL_GRID, connection.capabilities.worldGeometry);
    if (target.chunks.some((c) => !same(c.state.stateProfile, connection.capabilities.stateProfile)) || baseline.chunks.some((c) => !same(c.state.stateProfile, connection.capabilities.stateProfile)))
      throw fail("CAPABILITY_GAP", "GEOMETRY_PROFILE_UNSUPPORTED");
    if (!same(target.partition, geometry.partition)) throw fail("CAPABILITY_GAP", "GEOMETRY_PROFILE_UNSUPPORTED");
    const writes = target.chunks.map((c, i) => ({
      chunkPos: c.chunkPos,
      expectedCurrentDigest: baseline.chunks[i].stateDigest,
      ops: null,
      state: c.state
    }));
    const selected = geometry.postWriteLighting === "NONE" ? writes.filter((w, i) => w.expectedCurrentDigest !== target.chunks[i].stateDigest) : writes;
    let lighting = null, accepted = false;
    try {
      if (selected.length) {
        const written = await this.#write(body, body.undoTransactionId, "RESTORE", selected, suffix, true);
        accepted = written.response.result.chunks.some((c) => c.status !== "NOT_WRITTEN");
        lighting = written.response.result.lighting;
        if (!written.allWritten) {
          const selectedBaseline = { chunks: baseline.chunks.filter((c) => selected.some((w) => same(w.chunkPos, c.chunkPos))) };
          throw applyProgressFailure({ ...body, transactionId: body.undoTransactionId }, written, selectedBaseline, "RESTORE_FAILED", "RESTORE_ERROR", "restore");
        }
      }
      const after = await this.#read(body, origin.box, "READBACK", `${suffix}-readback`, origin.layout);
      const actualContent = this.#content(body.worldRef, after);
      if (!same(actualContent, target)) {
        const e = fail("READBACK_MISMATCH", "READBACK_ERROR", "readback");
        e.publicError.mutationState = accepted ? "UNKNOWN" : "NONE";
        e.publicError.transactionRef = body.undoTransactionId;
        throw e;
      }
      return { actualContent, lighting };
    } catch (e) {
      if (accepted) e.scopedWriteAccepted = true;
      throw e;
    }
  }
  async #scopedResponse(body, origin, evidence, scope, preUndoContent, preRestoreContent, actualContent, status, lighting, undoFailure = null) {
    const outcome = await this.#undoResult(
      body,
      origin,
      status,
      summarizeRegionStates(body.worldRef, preUndoContent.partition, preUndoContent.chunks),
      summarizeRegionStates(body.worldRef, actualContent.partition, actualContent.chunks),
      rev(status === "VERIFIED" ? "history" : "history-none"),
      lighting
    );
    const response = {
      contractVersion: REGION_WIRE,
      requestId: body.requestId,
      result: { outcome, scope, preUndoContent, preRestoreContent, actualContent },
      error: null,
      guardRefusal: null,
      applyFailure: null,
      undoFailure
    };
    return validateScopedRegionUndo(body, response, evidence);
  }
  async #finishScoped(body, origin, response, replayKey, requestHash) {
    const { outcome, scope } = response.result;
    const verified = outcome.status === "VERIFIED";
    const history = verified ? validateType("HistoryEntry", {
      transactionId: body.undoTransactionId,
      originTransactionId: body.originTransactionId,
      affectedObjectRefs: [origin.objectRef],
      operationDigest: body.expectedScopeDigest,
      beforeImageDigest: D("region-summary", outcome.preUndoSummary),
      expectedAfterReadbackDigest: D("region-summary", outcome.actualSummary),
      receiptDigest: sha(canonicalJSON(response.result)),
      historyRevision: outcome.historyRevision,
      status: "VERIFIED"
    }) : null;
    await this.store.commit((next) => {
      if (verified && next.history[origin.objectRef]?.at(-1)?.transactionId !== body.originTransactionId)
        throw fail("TRANSACTION_CONFLICT");
      next.transactions[body.undoTransactionId] = {
        kind: "REGION_UNDO",
        direction: "UNDO",
        result: outcome,
        scopedResult: response.result,
        confirmedUndoScope: scope,
        originTransactionId: body.originTransactionId,
        objectRef: origin.objectRef,
        worldRef: body.worldRef,
        undoFailure: response.undoFailure,
        sourceValidationFailure: next.pending[body.undoTransactionId]?.sourceValidationFailure ?? null,
        receipt: { status: outcome.status, localContext: body.localContext },
        ...verified ? {
          history,
          displayMetadata: { committedAt: (/* @__PURE__ */ new Date()).toISOString(), mode: "REGION", affectedCells: scope.positions.length }
        } : {}
      };
      if (verified) {
        next.history[origin.objectRef].push(history);
        next.objects[body.worldRef][origin.objectRef].objectRevision = rev("object");
        next.footprints[body.worldRef][origin.objectRef].positions = [];
        next.footprints[body.worldRef][origin.objectRef].footprintRevision = rev("footprint");
        next.worldRevisions[body.worldRef] = rev("world");
        next.registryRevisions[body.worldRef] = rev("registry");
      }
      next.replay[replayKey] = { digest: requestHash, response };
      delete next.pending[body.undoTransactionId];
    });
    return response;
  }
  async #scopedRollback(body, origin, evidence, scope, preUndoContent, undoFailure, replayKey, requestHash) {
    const current = await this.#read(body, origin.box, "INSPECT", "scoped-rollback-current", origin.layout);
    const preRestoreContent = this.#content(body.worldRef, current);
    const target = composeScopedRegionUndoRecoveryTarget(evidence, preUndoContent, preRestoreContent);
    const restored = await this.#scopedRestore(body, target, current, origin, "scoped-rollback", "RecoverRegion");
    const response = await this.#scopedResponse(
      body,
      origin,
      evidence,
      scope,
      preUndoContent,
      preRestoreContent,
      restored.actualContent,
      "ROLLED_BACK",
      restored.lighting,
      undoFailure
    );
    return this.#finishScoped(body, origin, response, replayKey, requestHash);
  }
  async #scopedUndo(body) {
    const { replayKey, requestHash, prior } = this.#replay(body, "UndoScopedRegionCommit");
    this.#adapterCompatible();
    await this.#guarded(body, "UndoScopedRegionCommit");
    const state = this.store.snapshot, origin = state.transactions[body.originTransactionId];
    if (origin?.kind !== "REGION" || origin.result.status !== "VERIFIED") throw fail("UNDO_CONFLICT", "PAYLOAD_CHANGED");
    const evidence = await this.#originEvidence(origin), scope = deriveConfirmedRegionUndoScope(evidence);
    validateScopedRegionUndoRequest(body, evidence);
    if (prior) return prior.response;
    await this.#guarded({ ...body, operations: origin.operations }, "UndoScopedRegionCommit");
    if (state.history[origin.objectRef]?.at(-1)?.transactionId !== body.originTransactionId)
      throw fail("UNDO_CONFLICT");
    if (this.#footprintConflicts(body.worldRef, scope.positions, origin.objectRef).length)
      throw fail("OTHER_OBJECTS_AFFECTED", "SCOPE_DENIED");
    if (state.pending[body.undoTransactionId] || state.transactions[body.undoTransactionId] || inFlight(state, body.worldRef))
      throw fail("TRANSACTION_CONFLICT");
    const current = await this.#read(body, origin.box, "INSPECT", "before-scoped-undo", origin.layout);
    const preUndoContent = this.#content(body.worldRef, current);
    const target = composeScopedRegionUndoTarget(evidence, preUndoContent);
    const declared = await this.#current(body);
    if (current.chunks.some((c) => !same(c.state.stateProfile, declared.capabilities.stateProfile)))
      throw fail("CAPABILITY_GAP", "GEOMETRY_PROFILE_UNSUPPORTED");
    const preUndoSummary = this.#summary(body.worldRef, current);
    const snapshot = await encodeSnapshot(preUndoContent, preUndoSummary);
    await this.#snapshots().write(snapshot);
    const worldRevision = state.worldRevisions[body.worldRef];
    await this.store.commit((next) => {
      if (next.pending[body.undoTransactionId] || next.transactions[body.undoTransactionId] || inFlight(next, body.worldRef) || next.worldRevisions[body.worldRef] !== worldRevision || next.history[origin.objectRef]?.at(-1)?.transactionId !== body.originTransactionId) throw fail("TRANSACTION_CONFLICT");
      next.pending[body.undoTransactionId] = {
        kind: "REGION",
        direction: "SCOPED_UNDO",
        body,
        originTransactionId: body.originTransactionId,
        snapshot: snapshot.ref,
        beforeSummary: preUndoSummary,
        confirmedUndoScope: scope,
        confirmedUndoScopeDigest: body.expectedScopeDigest,
        box: origin.box,
        layout: origin.layout,
        phase: "RESERVED"
      };
    });
    let restored;
    try {
      await this.#pendingPhase(body.undoTransactionId, "WRITING");
      restored = await this.#scopedRestore(body, target, current, origin, "scoped-undo");
    } catch (cause) {
      const undoFailure = failureDetail(cause);
      if (cause.publicError?.mutationState === "NONE" && !cause.scopedWriteAccepted) {
        const response2 = validateResponse(REGION_WIRE, "UndoScopedRegionCommit", {
          contractVersion: REGION_WIRE,
          requestId: body.requestId,
          result: null,
          error: cause.publicError,
          guardRefusal: cause.guardRefusal ?? null,
          applyFailure: null,
          undoFailure
        });
        await this.store.commit((next) => {
          next.replay[replayKey] = { digest: requestHash, response: response2 };
          delete next.pending[body.undoTransactionId];
        });
        return response2;
      }
      await this.#pendingPhase(body.undoTransactionId, "RESTORE_PENDING", {
        undoFailure,
        causeCode: undoFailure.error.code,
        sourceValidationFailure: cause.sourceValidationFailure ?? null,
        receiptStatus: "RECOVERY_PENDING"
      });
      try {
        return await this.#scopedRollback(body, origin, evidence, scope, preUndoContent, undoFailure, replayKey, requestHash);
      } catch (restoreError) {
        await this.#pendingPhase(body.undoTransactionId, "RESTORE_PENDING", {
          restoreFailure: failureDetail(restoreError),
          restoreCode: restoreError.publicError?.code ?? "RECOVERY_PENDING",
          guardRefusal: restoreError.guardRefusal ?? null
        });
        if (restoreError.publicError) {
          restoreError.undoFailure = undoFailure;
          throw restoreError;
        }
        const pending = fail("RECOVERY_PENDING", "TRANSPORT_OUTCOME_UNKNOWN", "restore");
        pending.publicError.mutationState = "UNKNOWN";
        pending.publicError.transactionRef = body.undoTransactionId;
        pending.publicError.causeCode = undoFailure.error.code;
        pending.undoFailure = undoFailure;
        throw pending;
      }
    }
    const response = await this.#scopedResponse(
      body,
      origin,
      evidence,
      scope,
      preUndoContent,
      preUndoContent,
      restored.actualContent,
      "VERIFIED",
      restored.lighting
    );
    return this.#finishScoped(body, origin, response, replayKey, requestHash);
  }
  async #undo(body) {
    const { replayKey, requestHash, prior } = this.#replay(body, "UndoRegionCommit");
    if (prior) return prior.response;
    this.#adapterCompatible();
    await this.#guarded(body, "UndoRegionCommit");
    const state = this.store.snapshot;
    const origin = state.transactions[body.originTransactionId];
    if (origin?.kind !== "REGION" || origin.result.status !== "VERIFIED")
      throw fail("UNDO_CONFLICT", "PAYLOAD_CHANGED");
    if (origin.worldRef !== body.worldRef) throw fail("CURRENT_WORLD_MISMATCH", "SCOPE_DENIED");
    await this.#guarded({ ...body, operations: origin.operations }, "UndoRegionCommit");
    if (state.history[origin.objectRef]?.at(-1)?.transactionId !== body.originTransactionId || origin.result.historyRevision !== body.expectedHistoryRevision)
      throw fail("UNDO_CONFLICT");
    const positions = regionPositions(origin.operations);
    if (this.#footprintConflicts(body.worldRef, positions, origin.objectRef).length)
      throw fail("OTHER_OBJECTS_AFFECTED", "SCOPE_DENIED");
    if (state.pending[body.undoTransactionId] || state.transactions[body.undoTransactionId] || inFlight(state, body.worldRef))
      throw fail("TRANSACTION_CONFLICT");
    const current = await this.#read(body, origin.box, "INSPECT", "before-undo", origin.layout);
    const preUndoSummary = this.#summary(body.worldRef, current);
    if (!same(preUndoSummary, origin.result.actualSummary))
      throw fail("UNDO_CONFLICT", "EXTERNAL_EDIT_CONFLICT", "readback");
    const originBefore = await decodeSnapshot(
      await this.#snapshots().read(origin.result.snapshot),
      origin.result.snapshot,
      origin.result.beforeSummary
    );
    const preUndoContent = validateType("RegionSnapshotContent", {
      profileVersion: "region-snapshot-content/v2",
      worldRef: body.worldRef,
      partition: (await this.#geometry(body)).partition,
      chunks: current.chunks.map((c) => ({
        chunkPos: c.chunkPos,
        state: c.state,
        stateDigest: c.stateDigest
      }))
    });
    const preUndoSnapshot = await encodeSnapshot(preUndoContent, preUndoSummary);
    await this.#snapshots().write(preUndoSnapshot);
    const worldRevision = state.worldRevisions[body.worldRef];
    await this.store.commit((next) => {
      if (next.pending[body.undoTransactionId] || next.transactions[body.undoTransactionId] || inFlight(next, body.worldRef) || next.worldRevisions[body.worldRef] !== worldRevision)
        throw fail("TRANSACTION_CONFLICT");
      next.pending[body.undoTransactionId] = {
        kind: "REGION",
        direction: "UNDO",
        body,
        originTransactionId: body.originTransactionId,
        snapshot: preUndoSnapshot.ref,
        beforeSummary: preUndoSummary,
        box: origin.box,
        layout: origin.layout,
        phase: "RESERVED"
      };
    });
    const tx = { ...body, transactionId: body.undoTransactionId };
    let restored;
    try {
      await this.#pendingPhase(body.undoTransactionId, "WRITING");
      restored = await this.#restore(
        tx,
        body.undoTransactionId,
        originBefore,
        origin.result.beforeSummary,
        origin.box,
        "undo"
      );
    } catch (cause) {
      if (engineFormRefusal(cause)) {
        const now = await this.#read(tx, origin.box, "INSPECT", "undo-refused", origin.layout);
        if (same(this.#summary(body.worldRef, now), preUndoSummary)) {
          const response3 = validateResponse(REGION_WIRE, "UndoRegionCommit", {
            contractVersion: REGION_WIRE,
            requestId: body.requestId,
            result: null,
            error: { ...cause.publicError },
            guardRefusal: { ...cause.guardRefusal },
            applyFailure: null
          });
          await this.store.commit((next) => {
            next.replay[replayKey] = { digest: requestHash, response: response3 };
            delete next.pending[body.undoTransactionId];
          });
          return response3;
        }
      }
      let back;
      try {
        back = await this.#restore(
          tx,
          body.undoTransactionId,
          preUndoContent,
          preUndoSummary,
          origin.box,
          "undo-restore"
        );
      } catch (restoreError) {
        const restoreCode = restoreError?.publicError?.code ?? restoreError?.code ?? "RESTORE_FAILED";
        const failed = restoreFailedResponse(
          { ...body, transactionId: body.undoTransactionId },
          "UndoRegionCommit",
          restoreError,
          cause
        );
        await this.#pendingPhase(body.undoTransactionId, "RESTORE_PENDING", {
          restoreCode,
          causeCode: cause?.publicError?.code ?? cause?.code ?? null,
          receiptStatus: failed ? "RESTORE_FAILED" : "RECOVERY_PENDING",
          guardRefusal: restoreError?.guardRefusal ?? null,
          receiptRejected: restoreError?.receiptRejected ?? null
        });
        if (failed) {
          await this.store.commit((next) => {
            next.replay[replayKey] = { digest: requestHash, response: failed };
          });
          return failed;
        }
        const pending = fail("RECOVERY_PENDING", "TRANSPORT_OUTCOME_UNKNOWN", "apply");
        pending.publicError.retryability = "SAME_TRANSACTION_QUERY";
        pending.publicError.mutationState = "UNKNOWN";
        pending.publicError.transactionRef = body.undoTransactionId;
        pending.publicError.causeCode = cause?.publicError?.code ?? "RESTORE_FAILED";
        throw pending;
      }
      const result2 = await this.#undoResult(
        body,
        origin,
        "ROLLED_BACK",
        preUndoSummary,
        back.actual,
        rev("history-none"),
        back.lighting
      );
      const response2 = this.#answer(body, "UndoRegionCommit", result2);
      validateRegionUndo(body, response2, origin.result);
      await this.store.commit((next) => {
        next.transactions[body.undoTransactionId] = {
          kind: "REGION_UNDO",
          result: result2,
          worldRef: body.worldRef,
          receipt: {
            status: "ROLLED_BACK",
            localContext: body.localContext
          }
        };
        next.replay[replayKey] = { digest: requestHash, response: response2 };
        delete next.pending[body.undoTransactionId];
      });
      return response2;
    }
    const historyRevision = rev("history");
    const result = await this.#undoResult(
      body,
      origin,
      "VERIFIED",
      preUndoSummary,
      restored.actual,
      historyRevision,
      restored.lighting
    );
    const response = this.#answer(body, "UndoRegionCommit", result);
    validateRegionUndo(body, response, origin.result);
    const history = validateType("HistoryEntry", {
      transactionId: body.undoTransactionId,
      originTransactionId: body.originTransactionId,
      affectedObjectRefs: [origin.objectRef],
      operationDigest: D("region-summary", origin.result.beforeSummary),
      beforeImageDigest: D("region-summary", preUndoSummary),
      expectedAfterReadbackDigest: D("region-summary", restored.actual),
      receiptDigest: sha(canonicalJSON(result)),
      historyRevision,
      status: "VERIFIED"
    });
    await this.store.commit((next) => {
      next.transactions[body.undoTransactionId] = {
        kind: "REGION_UNDO",
        result,
        history,
        displayMetadata: {
          committedAt: (/* @__PURE__ */ new Date()).toISOString(),
          mode: "REGION",
          affectedCells: positions.length
        },
        originTransactionId: body.originTransactionId,
        objectRef: origin.objectRef,
        worldRef: body.worldRef,
        receipt: { status: "VERIFIED", localContext: body.localContext }
      };
      next.history[origin.objectRef].push(history);
      next.objects[body.worldRef][origin.objectRef].objectRevision = rev("object");
      next.footprints[body.worldRef][origin.objectRef].positions = [];
      next.footprints[body.worldRef][origin.objectRef].footprintRevision = rev("footprint");
      next.worldRevisions[body.worldRef] = rev("world");
      next.registryRevisions[body.worldRef] = rev("registry");
      next.replay[replayKey] = { digest: requestHash, response };
      delete next.pending[body.undoTransactionId];
    });
    return response;
  }
  async #undoResult(body, origin, status, preUndoSummary, actualSummary, historyRevision, lighting) {
    const { postWriteLighting } = await this.#geometry(body);
    return {
      originTransactionId: body.originTransactionId,
      undoTransactionId: body.undoTransactionId,
      worldRef: body.worldRef,
      status,
      originBeforeSummaryDigest: D("region-summary", origin.result.beforeSummary),
      originAfterSummaryDigest: D("region-summary", origin.result.actualSummary),
      preUndoSummary,
      actualSummary,
      historyRevision,
      postWriteLighting,
      lighting: postWriteLighting === "NONE" ? null : lighting,
      localContext: body.localContext
    };
  }
  /**
   * After a normal reopen, a region transaction left RESTORE_PENDING is restored
   * from its durable compressed snapshot. Nothing new is applied.
   */
  async recoverPending() {
    await this.canvas.ready;
    const outcomes = [];
    for (const [transactionId, row] of Object.entries(this.store.snapshot.pending)) {
      if (row.kind !== "REGION") continue;
      const body = row.direction === "SCOPED_UNDO" ? { ...row.body } : { ...row.body, requestId: `${row.body.requestId}:recover` };
      try {
        this.#adapterCompatible();
        await this.#guarded(body, "RecoverRegion");
        const content = await decodeSnapshot(
          await this.#snapshots().read(row.snapshot),
          row.snapshot,
          row.beforeSummary
        );
        if (row.direction === "SCOPED_UNDO") {
          const origin = this.store.snapshot.transactions[row.originTransactionId];
          const evidence = await this.#originEvidence(origin);
          validateScopedRegionUndoRequest(body, evidence);
          const scope = deriveConfirmedRegionUndoScope(evidence);
          if (!same(scope, row.confirmedUndoScope) || D("confirmed-region-undo-scope", scope) !== row.confirmedUndoScopeDigest) throw fail("UNDO_CONFLICT", "PAYLOAD_CHANGED");
          const { replayKey, requestHash } = this.#replay(row.body, "UndoScopedRegionCommit");
          await this.#scopedRollback(body, origin, evidence, scope, content, row.undoFailure ?? failureDetail({ publicError: { code: "RECOVERY_PENDING", phase: "restore", retryability: "SAME_TRANSACTION_QUERY", mutationState: "UNKNOWN", transactionRef: transactionId, causeCode: null, reason: "TRANSPORT_OUTCOME_UNKNOWN" } }), replayKey, requestHash);
          outcomes.push({ transactionId, status: "ROLLED_BACK" });
          continue;
        }
        await this.#restore(body, transactionId, content, row.beforeSummary, row.box, "recover");
        await this.store.commit((state) => {
          state.transactions[transactionId] = {
            kind: row.direction === "APPLY" ? "REGION" : "REGION_UNDO",
            worldRef: row.body.worldRef,
            recovered: true,
            receipt: { status: "ROLLED_BACK", localContext: row.body.localContext }
          };
          delete state.pending[transactionId];
        });
        outcomes.push({ transactionId, status: "ROLLED_BACK" });
      } catch (error) {
        outcomes.push({
          transactionId,
          status: "RECOVERY_PENDING",
          code: error.publicError?.code ?? error.code ?? "RECOVERY_PENDING"
        });
      }
    }
    return outcomes;
  }
  async call(operation, raw) {
    let body;
    try {
      if (operation === "ApplyRegionCommit") body = validateRegionCommitRequest(raw);
      else if (operation === "UndoRegionCommit" || operation === "UndoScopedRegionCommit") body = validateRequest(REGION_WIRE, operation, raw);
      else throw fail("UNSUPPORTED_OPERATION", "INVALID_SHAPE", "decode");
      await this.canvas.ready;
      if (!this.store || this.store.unavailable)
        throw fail("CAPABILITY_UNAVAILABLE", "REQUIRED_FACT_UNKNOWN");
      return operation === "ApplyRegionCommit" ? await this.#commit(body) : operation === "UndoScopedRegionCommit" ? await this.#scopedUndo(body) : await this.#undo(body);
    } catch (error) {
      const failure = error.publicError ?? publicError(error);
      return {
        contractVersion: REGION_WIRE,
        requestId: (body ?? raw)?.requestId ?? "invalid-request",
        result: null,
        error: body ? withTargetWorld(failure, body, trustedSessionWorld(this.store, body)) : failure,
        guardRefusal: error.guardRefusal ?? null,
        applyFailure: null,
        ...operation === "UndoScopedRegionCommit" ? { undoFailure: error.undoFailure ?? null } : {}
      };
    }
  }
};

export {
  REGION_WIRE,
  REGION_ADAPTER,
  CANVAS_REGION_CAPABILITIES,
  ADAPTER_REGION_REQUIREMENT,
  ADAPTER_CELL_REQUIREMENT,
  ENGINE_GUARD_REQUIREMENTS,
  unmetGuards,
  requireGuards,
  SNAPSHOT_COMPRESSION,
  canvasProtocolHandshake,
  regionToolDescription,
  regionFail,
  failureDetail,
  engineFormRefusal,
  restoreFailure,
  restoreFailedResponse,
  encodeSnapshot,
  decodeSnapshot,
  CanvasRegionV1
};
