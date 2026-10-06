# HanaWorlds Canvas 0.4.0 local world component

The package exposes `hanaworldsCanvasV5` and consumes the public
`hanaworldsWorldAdapterV6` port. It uses the Contracts 0.4.2 root export from
source revision `aad7c0ea2a4a9a93dfb13555c46cd98b9b5da777`. There is no
account, grant, epoch, authorization, or protected region dependency in this
local MVP protocol.

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

## Region v1 transaction and whole-region Undo (0.4.0)

`apply(ctx)` also provides `hanaworldsCanvasRegionV1` (`canvas-region/v1`),
backed by the same durable store, world revisions, footprints and history rows
as cell BUILD. Canvas stays the only transaction decider; the Adapter region
port (`hanaworldsWorldAdapterRegionV1`, `world-adapter-region/v1`) only loads,
reads and writes mapblock chunks.

- `DescribeRegionTool` returns the tool's purpose, typical scale and
  prerequisites for the skill. There is no system threshold or setting: the
  skill chooses between region writes and cell-by-cell BUILD.
- `ApplyRegionCommit` takes one `region-voxels/v1` block (origin, size,
  `x-y-z` order as in Luanti VoxelArea, palette of `nodeName`+`param2`, cells
  as palette index or `-1`). `-1` is unspecified and never touched; only the
  palette entry `air` digs. Canvas checks protocol major/capabilities, current
  world and connection, current world revision and registered footprints, then
  asks the Adapter to load and read every mapblock chunk of the box. Any chunk
  still unknown, or written cells with metadata/inventory/timer state, rejects
  before a write.
- The complete before image of the box (node, param2, param1) is saved as
  gzip (RFC 1952, Node zlib) over canonical JSON, in a content-addressed 0600
  file under `data/hanaworlds-canvas/region-snapshots/`, and referenced from a
  durable reservation before the first chunk write. Each chunk with specified
  cells is written once. The complete box is read back and its digest must
  equal the expected after image (written cells changed, all others unchanged)
  before the receipt, object, footprint and history row commit together.
- Any write or readback failure writes every started chunk back from the
  before image and verifies the full box digest (`ROLLED_BACK`). If that
  restore cannot be verified the reservation stays `RESTORE_PENDING`;
  `recoverPending()` after a normal reopen restores it from the snapshot file.
- `UndoRegion` names the region history transaction and object. Canvas checks
  current world/connection, history head, object revision, world revision and
  other registered footprints, reads the box, refuses to overwrite when the
  written cells no longer hold the committed state, decompresses and verifies
  the snapshot (compressed hash, raw hash, region digest) and writes the
  written cells back. Cell `Undo` refuses a region transaction and the
  original cell BUILD/Undo path is unchanged.
- Compatibility is by region protocol major (1) plus required capabilities on
  both Canvas and Adapter sides; a different minor/patch or package hash is
  accepted, another major or a 0.x line is rejected before any write.

The block format, Adapter region operations and digest domains are Canvas's
explicit fixture reading of the S1-CONTRACT-REGION-V1-01 card until Contracts
delivers region v1 bytes (`REGION_SHAPE_SOURCE = 'canvas-explicit-fixture'`).
