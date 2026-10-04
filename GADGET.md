# HanaWorlds Canvas 0.2.0 component

Status: component candidate. `canvas/v4` is the public Canvas port;
`world-adapter/v4` is the only world transport port consumed. Contracts 0.3.2
is pinned to public revision `3d64364782181c8b5abc3150f8fa9f7ae20bf101`
through the byte-exact runtime subset in `vendor/contracts/`. Its provenance
manifest and verifier cover the complete current import closure and fixtures.
No sibling source path or developer profile is a runtime dependency. Stage 1
composition and human validation remain `UNPROVEN` and `ACCEPTED` unset.

## Host boundary

The DSH plugin `apply(ctx)` provides `hanaworldsCanvasV4` and consumes:

- native `dshHomePath()` for one isolated, durable Canvas directory with a
  single writer;
- `hanaworldsAuthority.verify(request, operation)` for current actor, Session,
  grant, trusted author, world revision, and authorized actions. For linked
  Undo/Redo it must also return the current `authorizationBinding` facts needed
  to form the Adapter's public binding; absent proof fails closed;
- `hanaworldsAdminAuthority.verify(context, 'UpdatePlacementSettings', worldRef)`
  for a current, world-bound Canvas admin proof before settings mutation;
- `hanaworldsWorldAdapterV4`, identified by the composition's `adapterId`.

Canvas checks the public ContractHandshake before Adapter calls. Adapter
requests use the Canvas service principal as `actorRef`; the grant and
`authorizationBinding` identify the acting user. The Canvas service exposes
`call(operation, request)`, `subscribeCanvasEvents(context, callback)`,
`adminProjection(worldRef)`, and `setPlacementSettings(worldRef, dottedSettings,
adminContext)`. A Shell management surface can render the returned descriptors,
current values, defaults and non-switchable invariants. The host must restrict
that administrative surface to current authorized administrators.

The four Canvas-owned per-world settings are
`placement.frontGapCells=2`, `placement.forwardSearchCells=16`,
`placement.lateralSearchCells=8`, and `placement.verticalSearchCells=4` when a
world is first bound. Stored values and their revision are durable. If any
setting is later unset or invalid, `InspectPlacementRegion` fails with
`CAPABILITY_UNAVAILABLE/validate/POLICY_UNAVAILABLE` and names the affected
settings in `unavailableSettings`; it never substitutes a default.

## Region inspection and Apply

`InspectPlacementRegion` generates and durably reserves an inspection ID,
relays the exact typed anchor, footprint and current settings to Adapter
`InspectRegion`, validates the returned public outcome, rechecks authorization,
and records the outcome durably before release. Only a currently world-authorized
principal with `INSPECT` receives `candidatePlayerNames`; those names are
returned only for `MULTIPLE_ONLINE_PLAYERS`, with typed `NAME_PLAYER` and
`PICK_WORLD_POINT` choices. Other asks offer `PICK_WORLD_POINT` only. Workshop
owns the Shell choice frame; the Adapter owns in-game point picking.

When an Apply's target-facts digest matches a Canvas-issued region inspection,
Canvas requires `regionInspectionBinding` and checks the record's world, Session,
principal, build and frame digests, and protection/body witness evidence and
position lists before calling Adapter. A stale record fails before mutation.
Adapter Prepare is the final per-cell protection and body recheck. An unrecorded
facts digest is not inferred to be a region inspection.

## Durable state and recovery

On DSH, Canvas resolves its own `data/hanaworlds-canvas` directory under the
native `dshHomePath` service. The path must be absolute, contained in the
configured DSH home and free of symlinked storage components; an unavailable or invalid
native path leaves Canvas storage unavailable before any world operation.
The same DSH home retains this directory across plugin restart and reinstall.

`CanvasStore` atomically writes `canvas-v2.json` with fsync and directory sync.
Fresh profiles use storage schema 3. Existing schema-2 profiles retain the
byte-exact original file as `canvas-v2.pre-v4.json`, fsynced before the first
schema-3 write; a conflicting or failed backup stops migration. Schema-1
profiles retain their byte-exact `canvas-v2.pre-v3.json` backup, then pass
through schema 2 and its pre-v4 backup before reaching schema 3. The
registry, per-author history, transaction state, settings and inspection records
survive restart. Older Canvas v3 and pre-repair v4 builds reject schema 3.
The pre-v4 backup is recovery evidence, not an automatic in-place downgrade;
later edits in the upgraded profile must be separately archived before a
snapshot restore. `ListObjects(expectedRevision:null)` returns a newly authorized
coherent current registry snapshot without a registry write or missed-event
replay. A nonnull revision remains a strict precondition. Selection checks the
returned stable ref against the current bound-world registry.

Canvas reserves an Apply before Adapter Prepare; the Adapter's public v4 Prepare
or QueryPrepared result includes the saved `beforeStateReadbackDigest`. Canvas
persists it before Apply, projects the seven-field `PreparedTransaction` for
Adapter Apply, and uses the separate digest for same-author linked history.
Undo/Redo check every affected object's author head and current revisions,
reserve the history transaction, then use public Adapter Prepare/Apply/Readback.
Only matched readback followed by one durable linked head commit returns VERIFIED.
Uncertain writes are queried on retry; another blind world write is prohibited.
Other-player and world-global history are outside this component.

`HistoryQuery(expectedHistoryRevision:null)` reads the current author's
durable history position for the bound world and registered object. It takes
the head and entries from one committed Canvas store state, then rechecks the
same author, current grant, object and world binding before release. A nonnull
revision remains a strict CAS precondition. A missed event or restart does not
require guessing a revision; query replay still requires the same author and
current binding. This query does not move history or write the game world.

Typed Canvas events are delivered only to current authorized subscriptions.
`ObjectCreated` follows verified durable registration; inventory, history,
selection and transaction events follow their actual durable changes. There is
no subscription snapshot or event replay. A client may recover missed object
changes through the authorized `ListObjects(expectedRevision:null)` query.

## Package and rollback

Build and test under Node 24 with isolated HOME and npm cache, then pack from
the exact public source revision. An isolated DSH profile must supply its own
HOME, cache, store, shim and `DSH_HOME`; the desktop-generated local `dsh` shim
points to a shared profile and is unsuitable. Preserve Canvas state and Adapter
journal across uninstall/reinstall. Roll back Canvas with the compatible whole
Contracts consumer set; stop writes and retain the schema-2 state before any
older-code restore. Public-origin fresh-clone, installed-byte, restart,
uninstall/reinstall and rollback results require separate evidence; a local
source test does not prove these lifecycle steps.

## Licenses

HanaWorlds-owned source is MIT. `canonicalize@5.1.0` (Apache-2.0) and
`icu@2.3.1` (Unicode-3.0) remain separate packages with their own notices.
WorldEdit's AGPL source and the Luanti Adapter are separate origins; neither is
copied or relicensed here.
