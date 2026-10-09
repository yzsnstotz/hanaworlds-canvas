# HanaWorlds Canvas

Stage 1 local world Canvas `0.6.14` component candidate, exposing `canvas/v5`
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
Since 0.6.1 the client follows the public DSH Client Remote contract: it mounts
its descriptor with `ctx.remote.$mount()`, then registers the panel inside
`ctx.inject(['remote.hanaworldsCanvasDisplay', 'slots', 'sessions'])`, because
each mounted namespace is the traced child Service `remote.<namespace>`.
0.6.0 read it from the outer fiber, which DSH rejects with `cannot get property
"remote.hanaworldsCanvasDisplay" without inject`. `npm run test:display:gateway`
runs the shipped `lib/client.js` against the official Client registry/Remote and
Host Gateway over an explicit in-process FIXTURE carrier.
The Host selects the world from the stored Session binding; the renderer cannot
supply a world or transaction. The read waits for
pending store commits, uses current public footprints and returns a cloned
projection without a store commit or replay. Global history order follows
recorded commit times; old untimestamped rows keep their durable order.

### Adapter capability scope per port (0.6.3)

From Contracts 0.5.1 (G3 write-path scope) the Adapter-owned capability table also
holds `world-adapter/v6:*` ids. Canvas 0.6.2 put every Adapter-owned id into the
`world-adapter-region` requirement and checked it against the region port alone, so a
G3 Adapter, whose region handshake rightly carries no `world-adapter/v6:*` id, was
refused with `CAPABILITY_UNAVAILABLE/VERSION_UNSUPPORTED`. Canvas now builds one
requirement per wire (`ADAPTER_REGION_REQUIREMENT`, `ADAPTER_CELL_REQUIREMENT`), each with
only that wire's ids at the Contracts-declared minor, and before any region read or
write checks the region port's and the per-cell port's (`hanaworldsWorldAdapterV6`)
`protocolHandshake`. Nothing is dropped: an Adapter id outside both wires stops Canvas at
load.

### Stage 1 validation configuration supply (0.6.11)

See GADGET.md for keys, domain, field sources and refusals. Independent preparation page:
`node scripts/config-supply-web-server.mjs <run-dir> [port]` serves `/supply` on 127.0.0.1;
only its peers (Adapter connection, NativeFacts Catalogue, Session identity) are FIXTURE,
marked on the page. Canvas's supply, store and refusals are the real code.

### Released Contracts v0.5.4 (0.6.10)

Branch `codex/f-canvas-contract-adapt-01-v054`: the dependency resolves to the released tag
`v0.5.4` commit `85687fc3811e4c8ee6e69410d46d8026e19d2c75` (codeload tarball, lockfile
integrity); Canvas advertises `hanaworlds-contracts@0.5.4` and `canvas` 5.1 in its
`protocolHandshake` (the minor is the one the installed Contracts declare; 0.6.9 always
advertised 5.0). Otherwise identical to 0.6.9.

### Candidate pin: Contracts v0.5.4-rc.1 (0.6.8)

Candidate branch `codex/f-canvas-contract-adapt-01-v054-rc1`: the dependency resolves to
the public tag `v0.5.4-rc.1` commit `0beeff5774db476c0128683ca6107a28bdcdcbee`
(codeload tarball, lockfile integrity), so a fresh `npm ci` reproduces the candidate
package; Canvas advertises `hanaworlds-contracts@0.5.4-rc.1`. Code is identical to 0.6.7;
the released-v0.5.3 line stays on `codex/f-canvas-contract-adapt-01`.

### Session-world seam on the 0.5.4 candidate (0.6.7)

With Contracts declaring canvas/v5 minor 1 (`hanaworlds-contracts@0.5.4-rc.1`), Canvas
implements its side of session-world-seam/v1: G-S identity read before Select/Switch
(Workshop's public service `hanaworldsWorkshopV3`, fail closed without it), G-U
`UnselectWorldConnection`, G-L `RetireSessionSelection`, G-D `ListWorldSelections` /
`ReserveWorldRetirement` / `ReleaseWorldRetirement`. The committed dependency stays the
released v0.5.3 until v0.5.4 is published; on it Canvas behaves exactly as 0.6.6. See
GADGET.md for the rules.

### Session↔World selection: SwitchWorldConnection and per-world inventory (0.6.6)

Canvas is the only Session↔World selection authority and the only producer of
`selectionRevision` (canvas/v5 `ReadWorldSelectionContext` / `SelectWorldConnection` /
`SwitchWorldConnection`). 0.6.6 implements the published `SwitchWorldConnection`, which
the current runtime had left unimplemented: CAS on the published `selectionRevision` (the
`SelectWorldConnection` convention) and on `expectedContext`, `fromWorldRef`/`worldRef` =
the Session's current world, the target connection's actual readback and inventory row
(same incarnation), and no unfinished transaction of this Session. `currentSession` is kept;
another world clears the object selection, a same-world reconnect keeps it. Other Sessions
are untouched. `ReadWorldSelectionContext` now returns only the requested world's inventory
rows, as the contracts `WorldSelectionContext` rule requires (a multi-world Adapter
inventory previously failed `SCHEMA_INVALID`).

Typed selected-object snapshot over existing routes: `ReadWorldSelectionContext` (typed
`CurrentContext`, 0..n `orderedSelectedObjectRefs`, revisions, `localContext` with the
connection incarnation) → `ListObjects` with that `localContext` (Canvas re-checks Session,
world, exact `localContext` and the live incarnation) → `ReadWorldSelectionContext` again;
consistent only if the context is unchanged. No new operation.

### Released Contracts v0.5.3 (0.6.5)

The dependency is pinned to the `v0.5.3` tag commit
(`codeload …/tar.gz/3457493da209178f815d6950e323e1dc462e8d6c`, lockfile integrity),
not to the version string: an unreleased stage-A package also called itself `0.5.3`.
Canvas advertises `hanaworlds-contracts@0.5.3`. No behaviour changed from 0.6.4.

### G3 write-before guard on the per-cell port (0.6.4)

BUILD (`ApplyRecoverableCommit`), `Undo` and `Redo` now refuse before any reservation or
mutating Adapter call unless the per-cell port (`hanaworldsWorldAdapterV6`) advertises a
`protocolHandshake` that meets `ADAPTER_CELL_REQUIREMENT` (`world-adapter` 6 at the
declared minor, `callback-free-write`, `write-path-state-facts`). The region path checks
the same per-cell requirement plus `ADAPTER_REGION_REQUIREMENT` on the region port.

### Undo from the App panel (0.6.2)

The panel's live mode (not the sample) offers **撤回这笔** on each object's latest
entry when Canvas's own `readHistoryActions` offers it, and asks **确认撤回** first.
Two more Typert methods on `hanaworldsCanvasDisplay`:

- `actions(sessionRef)` → `{state, worldRef, objects:[{objectRef, mode, applied,
  undo:{available, reason, historyTransactionId}}]}`. Read-only. Reasons are Canvas's:
  `NOTHING_TO_UNDO`, `WORLD_CHANGED_SINCE`, `TRANSACTION_PENDING`, `REGION_UNDO_HAS_NO_REDO`.
- `undo(sessionRef, objectRef, historyTransactionId)` → `{status:'VERIFIED',
  transactionId, originTransactionId, objectRef, view}`. The renderer sends only the
  clicked row. The Host re-reads `readHistoryActions` for the Session's stored binding,
  refuses with `canvas/undo-rejected` (`details.reason`: Canvas's reason, `HISTORY_MOVED`
  when the clicked row is no longer the latest entry, `OBJECT_NOT_FOUND`, `NO_WORLD`),
  and otherwise sends one canvas/v5 `Undo` with exactly the published revisions and
  localContext. Canvas re-checks the head, revisions and actual cells; a failure is
  `canvas/undo-failed` with Canvas's code (e.g. `READBACK_MISMATCH`, `ROLLED_BACK`,
  `RECOVERY_PENDING`) and writes nothing visible. `view` is Canvas's own read after commit.
  Calls are serialised in the service; a repeated click finds `NOTHING_TO_UNDO`.

This is Canvas's own transaction path and it does not call Workshop. An Undo made here
is a Canvas history row like any other; how Workshop's `ReadCurrentUndoStatus` presents
it afterwards is Workshop's public behaviour and is not tested here. Region entries stay named, not offered. Redo is not offered in the panel.
`test/display-client-remote.test.mjs` runs the shipped `lib/client.js` through the
official Client Remote and Host Gateway (FIXTURE carrier) against a FIXTURE world file.

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


## Independent objects/history development page

The Canvas-owned page runs at `http://127.0.0.1:47601/objects`. App installation,
GUI locks and the DSH browser module graph are unnecessary for this entry. The
existing App client remains in this package; App integration is a separate gate.

With Node24.13.1 and this checkout's installed development dependencies:

```sh
npm run build:objects
npm run prepare:objects-example # once, fresh isolated example directory
npm run dev:objects
```

`build:objects` writes only two web assets under
`~/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01/objects-web/assets`.
`dev:objects` binds 127.0.0.1:47601 and opens Canvas's own store under that run's
`objects-web/data`. It reads no App profile or peer private data. The server has
only GET/HEAD routes; it uses the existing `CanvasV5.readObjectsHistory()` for
record projection. A session selector uses the local Canvas session catalog.
A fresh store has no connected session and explains its empty view. This page
does not create connections or transactions. Actual world bindings and commits
must already belong to Canvas; no example or fabricated history fills the live store.

The **查看示例数据** switch now reads a second, explicitly isolated durable
CanvasStore from `objects-web/isolated-example`. The one-time
`prepare:objects-example` command supplies fixture Adapter/world/Brush inputs to
real public Canvas selection, region commit, per-cell analysis/commit and region
Undo. Canvas's production code owns every stored transaction, timestamp,
footprint and history row; the producer never inserts Store records directly.
It refuses an already populated example directory. The server requires the
prepared durable file and never regenerates data on reads or startup. Actual
world data under `objects-web/data` remains separate and empty when unbound.
No request from the webpage can run the producer or mutate either store.

The page starts with the visibly marked isolated example, explains that it does
not come from the real world, and says unnamed when production saved no name.
Switching the example off shows the actual world store and its honest empty
reason. Both modes fetch the public read projection; Refresh reads the selected
store. The example preference persists across page reopen, and a service
restart opens the same durable bytes rather than creating new timestamps.
React18.3.1 and ReactDOM18.3.1 (MIT) remain bundled locally without a CDN; their
complete notices are in `LICENSES/`. `test:objects-example` verifies the public
transaction-produced records, HTTP display, store isolation, rejection of
writes, unchanged durable bytes and service reopen. Fixture runtime/UI evidence
never establishes a real world commit or owner acceptance.

## Undo and redo development page (shared host)

The same Canvas-owned host serves `http://127.0.0.1:47601/objects` (unchanged
read-only view) and `http://127.0.0.1:47601/undo`. With Node24.13.1:

```sh
npm run build:objects        # objects + undo assets -> ~/.cache/hanaworlds-runs/F-CANVAS-UNDO-01/undo-web/assets
npm run prepare:undo-example # once, fresh isolated /undo example directory
npm run dev:objects          # binds 127.0.0.1:47601; `-- --port N` only for pre-switch checks
```

`/objects` still reads the F-CANVAS-OBJECTS-HISTORY-01 stores and never writes.
`/undo` acts only on `undo-web/isolated-example`: a durable CanvasStore plus an
explicit fixture world file (`fixture-world.json`) standing in for the world and
its Adapter. The one-time producer makes two per-cell commits through Canvas's
public canvas/v5 operations (no region example) and refuses an existing directory.

Canvas now implements the canvas/v5 **Redo** operation defined by Contracts
(previously `CAPABILITY_UNAVAILABLE`). Undo and Redo share one history
transaction path: Canvas checks the history head, world/object revisions and
the actual current cells, prepares and applies one Adapter history
transaction, reads it back against the saved target image and commits receipt,
history row and footprint together, or rolls back. Redo names the transaction
whose Undo is the head and restores its footprint; an Undo row itself cannot be
undone. `CanvasV5.readHistoryActions(sessionRef)` publishes, per object, the
exact public operation and revisions for Undo/Redo or a named reason:
`NOTHING_TO_UNDO`, `NOTHING_TO_REDO`, `WORLD_CHANGED_SINCE` (Canvas only moves
the latest world change), `TRANSACTION_PENDING`, `REGION_UNDO_HAS_NO_REDO` and
`REGION_REDO_NOT_IN_PROTOCOL`. Every Undo it offers has a Redo for the same
entry; canvas-region/v1 defines whole-region Undo but no region Redo, so region
Undo is named rather than offered (UndoRegionCommit itself is unchanged). A page click posts only `{objectRef}` from the same origin; the
host executes what Canvas published and returns the read-back view.
`readObjectsHistory` keeps its published `COMMITTED | UNDONE` statuses.
