# HanaWorlds Canvas

Stage 1 local world Canvas `0.6.0` component candidate, exposing `canvas/v5`
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
minor **0**, capabilities **[]**, provenance `hanaworlds-canvas@0.5.3`.
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

## Complete NativeFacts injection input (0.5.3)

This documents the method already consumed by Canvas0.5.2 artifact
`6d5905f033882cae36de463aab838c495d42604c`; it introduces no new wire or
Contracts type. In `apply(ctx)`, the Host supplies `hanaworldsLuantiNativeFacts`.
Direct constructor consumers supply `nativeFacts: NativeFactsPort`.

```ts
readScopedState(connectionRef: Ref, positions: Positions): NativeFactsScopedState | Promise<NativeFactsScopedState>
// Complete raw return, not an array or a transaction/request/response envelope:
interface NativeFactsScopedState {
  worldRef: Ref;
  stateProfile: StateProfile;
  cells: ScopedCells;
}
```

Canvas awaits either a raw object or a Promise of it; the fixed normal example is async.
There is no third argument. `connectionRef` comes from the current Canvas
selection's `localContext.connectionRef`; `positions` comes from compiled
operation effects, retaining the complete ordered position set. `worldRef`,
`stateProfile`, and `cells` are all required at the raw return's top level.
Additional wrapper fields are not consumed. The Host must read actual current
facts from the selected Adapter connection; no Session/transaction id is passed
into this method and no result/error/contractVersion wrapper is expected.

| Field | Current meaning/source and mapping |
| --- | --- |
| `worldRef: Ref` | World actually read through the selected connection; must exactly match the commit's bound world. |
| `stateProfile: StateProfile` | That connection's complete read/restore profile. Canvas compares it with `ReadLocalConnection.result.capabilities.stateProfile`, saved in its durable connection binding. All six fields required: `profileVersion: 'state-profile/v2'`, `nodeFields: ['nodeName','param1','param2']`, `metadataMode: 'exact'`, `inventoryMode: 'exact'`, `timerMode: 'exact'`, `derivedLightMode: 'recompute-with-readback'`. No profile is inferred from cells. |
| `cells: ScopedCells` | Nonempty, ordered by numeric position x/y/z, unique by position; one cell per requested position, exact coverage/order. Each cell has exactly `position`, `availability: 'KNOWN'\|'UNKNOWN'\|'UNLOADED'`, `stateDigest: Digest\|null`. Public Contracts validation enforces subtypes/order/uniqueness and KNOWN digest constraints. Canvas refuses any non-KNOWN cell before reservation/Prepare; no default KNOWN. |
| `cells[].stateDigest` | Opaque Adapter scoped-cell digest from the complete current native state under this profile, never a BUILD/readback digest. Canvas passes it unchanged into later `ScopedWorldBinding.cells`. The public normal fixture reproduces the existing canonical `{profile,record}` digest and exact domain, with full record and basis in its provenance file; this fixture is not a real-world fact source. |

`ScopedWorldBinding` is created later by Canvas, adding its transactionId,
operationDigest, checkedPositions, objects and localContext. It is **not** this
method's raw return. Canvas retains world/profile/coverage/KNOWN checks before
its existing `validateType('ScopedCells', raw.cells)` consumption; production
transaction/validation code is unchanged in 0.5.3.

Public files (also npm `exports` paths):

- `hanaworlds-canvas/fixtures/native-facts-scoped-state.json`: one complete fixed normal raw return, without metadata inserted into the return.
- `hanaworlds-canvas/fixtures/native-facts-scoped-state.source.json`: package0.5.3, inherited consumer source/SHA, actual Contracts050/052 source/tar SHA, call arguments, fixture SHA, full native record/profile and opaque digest basis. Explicit SOURCE/FIXTURE.
- `hanaworlds-canvas/fixtures/native-facts-scoped-state.schema.json`: full raw-return schema using byte-identical existing Contracts050/052 definitions and their transitive subtypes. The wrapper allows unconsumed extras, as the existing method does. JSON Schema alone does not implement the Contracts semantic `x-order`/`x-uniqueBy` rules.
- `types/native-facts.d.ts`: full method and raw return types, exported from package root; constructor no longer uses `nativeFacts:any`.
- `hanaworlds-canvas/examples/native-facts-consumer.mjs`: public consumer and an explicitly named fixed fixture provider.

Legal validation uses existing public Contracts APIs on all required parts:
`validateType('Ref', raw.worldRef)`, `validateType('StateProfile', raw.stateProfile)`,
`validateType('ScopedCells', raw.cells)`. The published example combines these
checks without inventing `validateType('NativeFactsScopedState', ...)`. It
preserves UNKNOWN/UNLOADED and does not weaken Canvas context checks.

```js
import * as consumer from 'hanaworlds-contracts'; // actual independent 0.5.2 consumer
import { createFixtureNativeFactsPort, validateNativeFactsScopedState }
  from 'hanaworlds-canvas/examples/native-facts-consumer.mjs';
const nativeFacts = await createFixtureNativeFactsPort(consumer); // SOURCE/FIXTURE only
const raw = await nativeFacts.readScopedState('local-connection', [[0, 1, 3]]);
validateNativeFactsScopedState(raw, consumer);
// Supply nativeFacts to the real Canvas constructor or Host injection for the
// documented fixture connection/world. A real Host must provide actual facts.
```

`scripts/gate-nativefacts-053.sh <clean-full-commit> <new-absolute-E>` runs only
the public fixture consumer and its normal real Canvas BUILD/readback/reopen/
same-transaction Undo path, from frozen source and an independent installed tar
with an actual Contracts0.5.2 consumer. Complete raw call/return and durable
before/Undo states are retained. Prior declaration, G1 and region gates are not
rerun. Real peers, Luanti, UI, model, clean-machine and product gates remain open.

## Objects and history panel (0.6.0)

The Canvas bundle provides its own sidebar entry **对象与历史（Canvas）** through
DSH's public client slots. Its `hanaworldsCanvasDisplay.read(sessionRef)` Typert
Remote returns the new Canvas-owned `readObjectsHistory` display projection.
The Host selects the world from the stored Session binding; the renderer cannot
supply a world or transaction. No write method is exposed. The read waits for
pending store commits, uses current public footprints and returns a cloned
projection without a store commit or replay. Global history order follows
recorded commit times; old untimestamped rows keep their durable order.

Successful per-cell BUILD/Undo and regional commit/Undo save `displayMetadata`
in the same finalized durable transaction as history: `committedAt` is captured
inside the final commit callback after verification, `mode` records the actual
production path, and `affectedCells` counts its verified complete positions.
These are display facts only; they never participate in transaction decisions.
Replays reuse the stored timestamp. Rolled-back or pending work creates no
visible committed history. Old records are not backfilled: missing values read
as null and the panel says 未记录时间 / 方式未记录 / 影响格数未记录.

Objects show the current footprint's minimum coordinate, bounding size, and
actual occupied cells; a withdrawn object with no footprint says 当前无占地.
The **查看示例数据** switch shows fixed, visibly labelled illustrative data and
writes no Canvas/world data. The switch preference belongs to browser local
storage, while live content remains Canvas durable state.

Build with Node24.13.1: `npm run build`. Install the resulting Canvas tarball
through the product **Plugins → Add plugin** path. The host needs the official
DSH0.2.0-rc.2 Typert/registry/gateway services, Cordis4.0.4 and Zod4.6.5 from the
composed application; these optional peers allow independent Canvas component
checks without a DSH installation. The client bundle includes its Zod codec
and expects the application's shared React18 seed. Actual product installation
and first-step screenshots are recorded separately in the card REPORT.
