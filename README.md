# HanaWorlds Canvas

Stage 1 local world Canvas `0.5.2` component candidate, exposing `canvas/v5`
and consuming the public `world-adapter/v6` port. It owns current local world
selection, object footprints, recoverable apply/readback, durable history and
same-transaction Undo. `0.5.0` implements Contracts 0.5.0 `canvas-region/v1`: region commits over
mapblock chunks with a compressed before snapshot and whole-region Undo
(`hanaworldsCanvasRegionV1`).

Source and fixture checks are separate from an installed player-visible product
path. Stage 1 product readiness remains `UNPROVEN`; user `ACCEPTED` is unset.

See [GADGET.md](GADGET.md) for host services, durable transactions and the
current component boundary. [GADGET-v4-legacy.md](GADGET-v4-legacy.md) preserves
the previous component guidance as historical evidence.

## Public per-cell protocol declaration (0.5.2)

After the Canvas plugin is loaded into Cordis, read the actual service property:

```js
const canvas = ctx.get('hanaworldsCanvasV5');
const advertised = canvas.protocolHandshake;
checkProtocolCompatibility(advertised, [protocolRequirement('canvas/v5', [])]);
await canvas.ready; // Protocol admission alone does not establish storage readiness.
```

`ProtocolHandshake` comes from the public Contracts definition. The Canvas-owned
getter returns a fresh validated declaration: protocol `canvas`, major **5**,
minor **0**, capabilities **[]**, provenance `hanaworlds-canvas@0.5.2`.
`sourceRevision` and `artifactDigest` are null in this declaration; exact source
and tar identities are recorded in the gate evidence, never guessed inside a
self-referential package. Contracts 0.5.0 and current consumer 0.5.2 define
`canvas/v5`; neither publishes a per-cell Canvas capability token. No regional
capability is relabeled as a per-cell capability. Types are shipped at
`types/index.d.ts` (`CanvasV5ProtocolSource`, `CanvasV5.protocolHandshake`).

Implemented cell operations are `ListWorldConnections`, `ReadWorldSelectionContext`,
`SelectWorldConnection`, `ListObjects`, `SetObjectSelection`, `InspectPlacementRegion`,
`InspectObject`, `AnalyzeAffectedObjects`, `ApplyRecoverableCommit`, `Readback`,
`Undo`, and `HistoryQuery`. Other operations in the public wire return
`CAPABILITY_UNAVAILABLE`; this declaration does not promise their implementation.

Wrong/missing major or no declaration is `UNSUPPORTED_VERSION`; a missing
required published capability is `CAPABILITY_UNAVAILABLE`, both at the consumer's
decode stage. There is no missing-per-cell-token case for the current empty
requirement. The gate checks missing capabilities using the existing public
region requirement, and separately runs real cell BUILD/readback/reopen/Undo.
Storage, selection, world facts and business invariants still require their
normal checks after admission. Exact `contractHandshake` and `status()` text are
not substitutes for this property. The region service and root
`canvasProtocolHandshake` remain region-only (`canvas-region` 1.0 + four existing
tokens); neither satisfies a `canvas/v5` requirement.

`scripts/gate-cell-protocol-052.sh <clean-commit> <new-absolute-E>` freezes source,
checks the real Cordis service with an independent actual Contracts 0.5.2
consumer, then installs the real tar and repeats the affected cell checks.
Canvas/Cordis/fsynced storage are real; Host path and Adapter/world facts are
explicit fixtures. Real Luanti, Desktop UI, model and product gates remain open.
