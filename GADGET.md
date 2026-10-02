# HanaWorlds Canvas 0.1.1 candidate

Status: `PARTIAL / SOURCE+FIXTURE`. Stage 1 composition and human validation are
`UNPROVEN`; this source is not a release, deployment, or user `ACCEPTED` receipt.

Canvas is the engine-neutral owner of world selection, the named object registry,
affected-object analysis and decisions, atomic apply/readback orchestration, and
author-scoped linked object history. Workshop owns Sessions and intent. Brush
compiles BUILD/V2. The Luanti Adapter owns world transport, protected state,
restoration, and its journal. Canvas calls its public `world-adapter/v3` port only.

## Public host boundary

The package exports a DSH plugin `apply(ctx)` and `CanvasV3.call(operation, raw)`.
The plugin provides `hanaworldsCanvasV3` and consumes:

- `hanaworldsAuthority.verify` for current actor, Session, authorization, action,
  author identity, and world revision proof;
- `hanaworldsProfileStorage.canvasDirectory()` for a writable isolated profile
  directory; and
- `hanaworldsWorldAdapterV3` with the composition-supplied `adapterId`.

The Canvas service also provides `subscribeCanvasEvents(context, callback)`.
Subscriptions verify current `ListObjects` permission for the bound world and
trusted author at registration and again before each delivery. The current
source emits a typed `ObjectCreated` event only after verified durable
registration to the creating author. It emits `ObjectInventoryChanged` with
the current authorized inventory and registry revision after durable creation
or name changes to subscriptions still authorized for `ListObjects`. Failed
readback and revoked subscriptions receive no success event. The other frozen
typed signals follow observed Adapter inventory changes, durable connection,
world, name and selection changes, completed analysis and blocking decisions,
pending and verified transaction phases, linked history inventory changes,
and invalidation of a prior inspected snapshot by a newly observed world
revision. Private receipts stay with the initiating actor, Session and grant;
history receipts also require the trusted author. `HistoryPositionChanged`
waits for the upstream history-prepare digest and successful linked Undo/Redo.
The returned function unsubscribes. There is no initial snapshot or event
replay. A caller retaining
the latest name receipt or inventory event can use its registry revision after
restart; one holding only an old revision cannot bootstrap a missed change
through current `ListObjects`. This remains an open product consumer gate.

The implementation admits the strict `canvas/v3` request and response schemas
from the pinned Contracts source. Malformed raw UTF-8, duplicate decoded keys,
unknown nested fields, and unsafe JavaScript values fail before authority or
Adapter entry. Authority and revocation are checked before persisted replay.
Author-scoped replay is also bound to the current trusted author.

The v3 source implements ListWorldConnections, SelectWorldConnection,
SwitchWorldConnection, SetObjectSelection, ListObjects, NameObject, RenameObject,
AnalyzeAffectedObjects, DecideAffectedObjectNotification, InspectObject,
HistoryQuery, ApplyRecoverableCommit, Readback, and trusted CreateObject. Canvas
generates a stable object ref after verified creation readback; an arbitrary
caller-provided ref cannot register an object. Undo and Redo reject other-player
origins and currently fail closed for an otherwise valid linked origin. The
approved dependency repair must expose the distinct original before-state
readback digest before those paths can be enabled. No world-global or
other-player history policy is implemented.

## Durable state and recovery

Canvas stores `canvas-v2.json` under the host-provided profile directory. A
single writer instance per profile is required. Each commit writes a mode-0600
temporary snapshot, fsyncs it, atomically renames it, and fsyncs the directory.
If directory synchronization fails after rename, that writer refuses further
requests until reopened. Unknown schema versions fail closed.

Version 0.1.1 upgrades schema 1 to schema 2. Before conversion it durably saves
the exact old bytes as `canvas-v2.pre-v3.json`. The old 0.1.0 package cannot open
schema 2. Code rollback therefore requires stopping the profile and restoring
the schema 1 backup together with the matching earlier package. Preserve both
Canvas state and the Adapter journal when uninstalling; deleting one side can
erase the evidence needed to recover a pending world transaction.

Apply reserves the Canvas transaction before Adapter Prepare, persists the
prepared payload before Apply, and never issues a second world write on an
uncertain retry. It queries the public Adapter transaction status, then verifies
readback and durably settles linked history. Related new edits settle verified
pending history first. Unknown write or storage outcomes return
`RECOVERY_PENDING/UNKNOWN` rather than claiming no mutation.

## Build and install boundary

Run `npm ci` from the exact lock under an isolated HOME and npm cache, then
`npm run build`, `npm test`, and `npm pack --ignore-scripts`. The package has
`private: true` as a registry publication guard. The exact public source branch
must be pushed and read back before a public-origin DSH install is claimed.
An isolated DSH profile must supply its own HOME, cache, store, shim and
`DSH_HOME`; the desktop-generated `~/.local/bin/dsh` shim points at the shared
HanaMesh profile and is unsuitable for this proof. Real Shell, Luanti, restart,
uninstall/reinstall, and rollback results belong in separate labeled evidence.

## Licenses

HanaWorlds-owned source is MIT; see `LICENSE` and `LICENSE_AUDIT.md`. Preserve
the separate `canonicalize@5.1.0` Apache-2.0 and `icu@2.3.1` Unicode-3.0
notices recorded in `NOTICE`. Neither dependency is relicensed as MIT.
