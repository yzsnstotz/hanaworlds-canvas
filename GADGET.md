# HanaWorlds Canvas 0.15.1

Canvas owns local world selection, registered object footprints and transaction history.
The single Cordis entry is `src/index.mjs`; the DSH panel is `lib/client.js`.

Contracts is pinned to the formal release
`git+https://github.com/yzsnstotz/hanaworlds-contracts.git#v2.8.0`,
commit `5af62be25dcab110fcbb8502183922010f078f04`.
Run `npm ci`, `npm run build`, `npm run verify:contracts`, `npm run typecheck`, and `npm test`.
The test command runs every retained test file, including Gateway/Remote, host storage,
selection, per-cell apply/history and region rollback/recovery.

Canvas provides `canvas/v7` minor 1 and `canvas-region/v3` minor 1.
It consumes `world-adapter/v8` and `world-adapter-region/v3` at minimum minor 0
with their published write-path capability tokens. Service keys remain
`hanaworldsCanvasV5`, `hanaworldsCanvasRegionV1`, `hanaworldsWorldAdapterV6`,
`hanaworldsWorldAdapterRegionV1`, and the `hanaworldsWorkshopV3` session port.
Configuration facts come from the world source's C-world-facts port `hanaworldsWorldFacts`
(`world-facts/v1` ReadCatalogue + ReadWriteProfile, the same key the desktop bridge reads);
`hanaworldsLuantiNativeFacts` is used only for per-cell `readScopedState`.
Region ownership is read by role: the Adapter must cover every capability Contracts assigns
to `owner: world-source`; Canvas advertises the capabilities scoped to `canvas-region/v3`.

Placement requires an explicit `PlacementFootprint.geometryProfile`; missing facts
refuse `CAPABILITY_UNAVAILABLE`, unsupported/undeclared geometry refuses `CAPABILITY_GAP`.
Current `ReadLocalConnection.capabilities.worldGeometry` supplies geometry, partition
and post-write lighting. No profile or partition is filled by Canvas. The minor-0
Adapter InspectRegion request carries only its published footprint dimensions.
The later named `ReadWorldSourceCapabilities` port is outside this card.

Cell effects use opaque `materialRef` and neutral `orientation`, with explicit
`geometryProfile`. Readback and restore obey the world source's StateProfile:
engine-derived fields are excluded from comparisons (including their disappearance); preserved fields keep their
before value; cleared fields disappear on write. History preparation binds the expected-current digest to the original verified image,
after comparing the live readback by StateProfile; exact live bytes remain the rollback image.
Region operations use the declared
partition, compressed before snapshots, whole-transaction readback/rollback and Undo.
Engine guards are checked before writes; refusals preserve the public error and cause.
Uncertain outcomes stay pending for same-transaction query/recovery.

Events (`emitEvent` → Cordis `ctx.parallel(event.event, event)`, each validated by
`validateCanvasEvent`, published only after the fsynced commit, never on replay, refusal,
rollback or pending): `TransactionVerified` (operation `Readback`, the verified
ApplyRecoverableCommit receipt) after full matched readback and its durable history row;
`HistoryPositionChanged` (operation `Undo`/`Redo`) after a VERIFIED history move, including
one finalized by recovery. A rejected event shape or a consumer failure is logged and never
fails the committed call. Region commits have no `canvas-region/v3` event in Contracts.

History recovery after stop/reconnect (Contracts 2.8.0): once the Session re-selected the
same world over a new incarnation, `resolvePendingHistory` queries with the current context
and reads the answer through `readHistoricalReceipt`. The receipt must keep this
transaction's original written context; another world, a receipt re-bound to the current
context, or a pre-2.8.0 answer without `currentLocalContext`/`receiptDigest` stays pending
with the cause named. A stored Abort request from the earlier context is not re-issued.

The fresh store is `<DSH home>/data/hanaworlds-canvas-v2/canvas-v7.json`, schema 7.
Older stores are not read or migrated. Compiler configuration is forwarded unchanged from
the world source's `ReadWriteProfile.compilationConfig` (opaque `writeBackend
{profileId, revision}` included), checked against the current connection and the
`ReadCatalogue` digest; an undeclared backend, absent port, peer error, corrupt or stale
facts refuse by name without defaults. No engine, mod or package name is read.

The App panel reads the selected session's objects/history and performs the published
latest-entry Undo and the corresponding Redo. It follows `hanaworldsCanvasDisplay/changes`, a Typert stream that yields
a data-free notice after every durable commit changing that Session's objects, history,
footprints, pending rows or bound world (cell, region, Undo/Redo, recovery), and re-reads; a
build made from Workshop or skills appears without a manual refresh. A broken stream is shown
with its cause and the manual refresh remains. It has no display-fixture sample toggle. Test peer implementations
and the public NativeFacts fixture are explicitly SOURCE/FIXTURE. Independent legacy
pages, examples, probes and old evidence are archived in the canvas-01 run directory.
These checks do not establish a real-world GUI result or owner ACCEPTED.

Storage startup failures are logged with the original error and exposed as
`status().storageFailure = {code, message}` with `storage = UNAVAILABLE`.
The display Gateway carries this cause in `canvas/storage-unavailable` details;
the objects/history panel renders it as a read failure. No startup retry or
fallback store is created. The display action descriptor now publishes both
`undo` and `redo`, and both share one host queue. Redo uses Canvas's own published
origin/revisions/context and refuses a stale clicked row before writing.

`npm run test:undo` runs cell, region, history recovery, StateProfile and shipped
client/Gateway regressions with explicit isolated contract peers. They are not
real-world GUI acceptance evidence.
