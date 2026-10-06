# HanaWorlds Canvas 0.3.2 local world component

The package exposes `hanaworldsCanvasV5` and consumes the public
`hanaworldsWorldAdapterV6` port. It uses the Contracts 0.4.0 root export from
source revision `8cfb18f8e13aa33d7a942f230ec6117914322cdd`. There is no
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
