# HanaWorlds Canvas 0.13.4

Canvas owns local world selection, registered object footprints and transaction history.
The single Cordis entry is `src/index.mjs`; the DSH panel is `lib/client.js`.

Contracts is pinned to the formal release
`git+https://github.com/yzsnstotz/hanaworlds-contracts.git#v2.7.0`,
commit `b00dd055181c26fdea56e9ba6617ee4a5c3b92c3`.
Run `npm ci`, `npm run build`, `npm run verify:contracts`, `npm run typecheck`, and `npm test`.
The test command runs every retained test file, including Gateway/Remote, host storage,
selection, per-cell apply/history and region rollback/recovery.

Canvas provides `canvas/v7` minor 1 and `canvas-region/v3` minor 1.
It consumes `world-adapter/v8` and `world-adapter-region/v3` at minimum minor 0
with their published write-path capability tokens. Service keys remain
`hanaworldsCanvasV5`, `hanaworldsCanvasRegionV1`, `hanaworldsWorldAdapterV6`,
`hanaworldsWorldAdapterRegionV1`, and the `hanaworldsWorkshopV3` session port.

Placement requires an explicit `PlacementFootprint.geometryProfile`; missing facts
refuse `CAPABILITY_UNAVAILABLE`, unsupported/undeclared geometry refuses `CAPABILITY_GAP`.
Current `ReadLocalConnection.capabilities.worldGeometry` supplies geometry, partition
and post-write lighting. No profile or partition is filled by Canvas. The minor-0
Adapter InspectRegion request carries only its published footprint dimensions.
The later named `ReadWorldSourceCapabilities` port is outside this card.

Cell effects use opaque `materialRef` and neutral `orientation`, with explicit
`geometryProfile`. Readback and restore obey the world source's StateProfile:
engine-derived fields are excluded from comparisons; preserved fields keep their
before value; cleared fields disappear on write. Region operations use the declared
partition, compressed before snapshots, whole-transaction readback/rollback and Undo.
Engine guards are checked before writes; refusals preserve the public error and cause.
Uncertain outcomes stay pending for same-transaction query/recovery.

The fresh store is `<DSH home>/data/hanaworlds-canvas-v2/canvas-v7.json`, schema 7.
Older stores are not read or migrated. Compiler configuration contains an opaque
`writeBackend {profileId, revision}` from public loaded-payload engine facts;
missing, corrupt or stale facts refuse without defaults.

The App panel reads the selected session's objects/history and performs the published
latest-entry Undo. It has no display-fixture sample toggle. Test peer implementations
and the public NativeFacts fixture are explicitly SOURCE/FIXTURE. Independent legacy
pages, examples, probes and old evidence are archived in the canvas-01 run directory.
These checks do not establish a real-world GUI result or owner ACCEPTED.
