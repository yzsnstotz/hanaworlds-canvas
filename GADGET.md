# HanaWorlds Canvas 0.5.3 local world component

The package exposes `hanaworldsCanvasV5` and consumes the public
`hanaworldsWorldAdapterV6` port. It uses the Contracts 0.5.0 root export from
source revision `c006a839a6e6c2c63d57a14b72e4e6b26fa717f1`. There is no
account, grant, epoch, authorization, or protected region dependency in this
local MVP protocol.

For per-cell peer admission read `ctx.get('hanaworldsCanvasV5').protocolHandshake`
(property, not method). It is Canvas's real `ProtocolHandshake`: canvas 5.0,
capabilities=[] because Contracts publishes no per-cell Canvas token. Check it
with `protocolRequirement('canvas/v5', [])` / `checkProtocolCompatibility`.
The public types and implemented-operation list are in `types/index.d.ts` and
README. Protocol declaration does not imply storage readiness or known world
facts. Region handshake is unchanged and stays distinct; exact ContractHandshake
and status text cannot establish per-cell protocol compatibility.

The host provides `dshHomePath()` and one Canvas writer per profile. Canvas
stores fresh schema 5 in `data/hanaworlds-canvas/canvas-v5.json` with fsynced
atomic replacement. Previous Canvas files are left untouched; migration and
mixed protocol compatibility are outside this component card.

`ReadWorldSelectionContext` returns the public connection inventory stored at
selection for a bound Session; an unbound read asks Adapter for inventory.
`SelectWorldConnection` reads the actual local connection and records its
connection incarnation, world and Canvas selection revision. Each bound call
compares its local context with this durable selection and reads the current
connection again. An old connection incarnation or wrong world fails before
world mutation.

`expectedRevision` of `SelectWorldConnection` is always a revision Canvas has
published: for an unbound Session it is the `sessionRevision` of the UNBOUND
`ReadWorldSelectionContext` result (`session-0`); for a bound Session it is the
current `selectionRevision` read back from the BOUND context. A caller never
needs a private constant. Any other value is `STALE_REVISION`, and a bound
Session never accepts the unbound revision again.

The DSH host receives three Canvas-owned read services from `apply(ctx)`:
`hanaworldsCanvasFootprintRegistry.readFootprints`,
`hanaworldsCanvasHistoryFacts.read`, and
`hanaworldsWorldRevisionOracle.read`. They read one current durable Canvas
snapshot and reject an unbound Session or mismatched local context. The
Adapter can call them without a nested Adapter request. `ReadWorldSelectionContext`
returns the current selection from durable Canvas state and the public
connection inventory saved at selection, also without a nested Adapter call.
The Host composes `hanaworldsLuantiInspectionContext` from Canvas's current
selection/object list and logical revision together with Adapter-native
inspection facts; Canvas does not provide that Host composition service.

`InspectPlacementRegion` uses per-world durable placement defaults (2/16/8/4)
and the current Canvas world revision to ask Adapter's public `InspectRegion`
operation. Canvas validates and persists the returned inspection, then binds
the inspection ID, target facts digest, frame, catalogue, world and local
context to a later BUILD commit. `InspectObject` checks Canvas's current object
revision and asks Adapter's public `InspectWorld`, rejecting a mismatched
object, bounds or world revision. `Readback` checks the saved verified commit
and re-reads its complete after image through Adapter before returning the
same durable receipt.

`AnalyzeAffectedObjects` uses Canvas's durable object footprints. A fresh
build can commit only when the affected set is empty. When a BUILD document is
bound, Canvas also checks its digest and exact compiled geometry before world
readback or mutation. `ApplyRecoverableCommit`
gets opaque cell digests from the public
`hanaworldsLuantiNativeFacts.readScopedState` port. It reserves the transaction
before Adapter prepare/apply, reads and saves the complete before state after
Prepare, and compares the actual complete after state with the compiled
effects and Adapter receipt. The verified receipt, object footprint and history row commit in one
Canvas store update. Exact replay returns the stored result without another
Adapter write. A mismatch invokes full Adapter restore and verifies a complete
before state readback before reporting `ROLLED_BACK`. Unknown restore outcome
stays reserved as `RECOVERY_PENDING`.

`Undo` names the original history transaction and object. Canvas checks the
current world, history head, object revision and actual current state before
issuing one Adapter history transaction. The saved original before state is
the expected Undo readback. Receipt, history move and footprint update commit
together. `ListObjects` and `HistoryQuery` read the durable registry.

The card's component gate uses an installed Canvas tarball and a public
Adapter fixture. It does not prove a Luanti world or Desktop UI. Complex RPC
uncertainty, restart recovery, concurrent writers, broad negative matrices,
and older profile migration are deferred by CONTRACT 4.3.0. Old v4 source and
tests remain in the repository for evidence, outside this package's runtime.

## Region v1 transaction and whole-region Undo (0.5.0)

`apply(ctx)` also provides `hanaworldsCanvasRegionV1`, implementing the public
Contracts 0.5.0 `canvas-region/v1` wire (`ApplyRegionCommit`,
`UndoRegionCommit`) over the same durable store, world revisions, footprints
and history rows as cell BUILD. Canvas stays the only transaction decider. It
consumes the Adapter's `world-adapter-region/v1` port (`ReadRegion`,
`WriteRegion`) from the Host service `hanaworldsWorldAdapterRegionV1`; the
Adapter only loads, reads and writes mapblock chunks and reports per-chunk facts.

- Compatibility: before any read or write Canvas runs
  `checkProtocolCompatibility` on the Adapter's `ProtocolHandshake` with
  `world-adapter-region` major 1 and its five capabilities. Another major, a
  missing handshake (for example the exact-package 0.4.2 handshake) or a
  missing capability is rejected; a different minor, patch, source or artifact
  digest is accepted. Canvas advertises its own handshake (`canvas-region` 1.0,
  four `canvas-region/v1:*` capabilities) as `protocolHandshake`.
- `describe()` gives the skill the tool's purpose, typical scale and
  prerequisites. There is no system threshold or setting.
- Commit: the request carries Brush's `region-operations/v1` chunks and digest
  (checked with `validateDigestBinding`). Canvas checks current world and
  connection and registered footprints, reads the before image of every
  compiled chunk (`requireKnownRegion`; still unknown rejects), and stores the
  complete `RegionSnapshotContent` (node, param2, air and extras) as gzip
  (RFC 1952, Node zlib) over its canonical JSON in a content-addressed 0600
  file under `data/hanaworlds-canvas/region-snapshots/`, recorded as
  `RegionSnapshotRef`, before a durable reservation and the single `APPLY`
  `WriteRegion`. Success needs every chunk `WRITTEN`, lighting `COMPLETE` and a
  full readback summary equal to `expectedRegionSummary`; then receipt, object,
  footprint and history commit together. The result is checked with
  `validateRegionCommit`.
- Any failed, unknown or mismatching chunk restores the whole region: Canvas
  reads the current state and writes `RESTORE` with the snapshot state for
  every chunk that differs, then requires the before summary (`ROLLED_BACK`).
  If that cannot be verified the reservation stays `RESTORE_PENDING`, and
  `recoverPending()` after a normal reopen restores it from the snapshot file.
- Undo: only the head history transaction of the same world, after current
  world/connection, history revision and other footprints are checked, and only
  while the current region summary still equals the verified after summary
  (otherwise `UNDO_CONFLICT/EXTERNAL_EDIT_CONFLICT`, no write). The snapshot is
  decompressed and checked with `validateRegionSnapshotContent`, the pre-Undo
  image is snapshotted too, and `RESTORE` must read back the origin before
  summary; a failed Undo restores the pre-Undo image. Cell `Undo` refuses a
  region transaction; the cell BUILD/Undo path is unchanged.


## NativeFacts method input (0.5.3 public supplement)

The actual Host injection `hanaworldsLuantiNativeFacts.readScopedState` is called
with `(connectionRef, positions)` only and returns the complete raw object
`{ worldRef, stateProfile, cells }`. It is not a ScopedCells array or
ScopedWorldBinding/request/response envelope. Constructor typing is
`nativeFacts?: NativeFactsPort` with the same complete method/return definition.
README's NativeFacts section lists every required field, current source/mapping,
normal raw fixture/schema/provenance, and legal public Contracts subtype checks.
The package exports the full fixed fixture and consumer example; both are
explicit SOURCE/FIXTURE and must not supply facts for an actual Luanti world.
Canvas's current world/profile/positions/KNOWN checks and transactions are
unchanged; only this new public input is verified by gate-nativefacts-053.
