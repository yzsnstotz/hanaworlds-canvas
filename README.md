# HanaWorlds Canvas

Canvas `0.16.0` manages local world selection, object footprints, recoverable
transactions and durable Undo/Redo history. It provides `canvas/v7` and
`canvas-region/v3`, with Canvas-owned structures and schemas following the formal
C-canvas, C-world-adapter and C-world-facts documents.

Host compatibility is pinned to the official DSH `0.2.1-alpha.2` Typert protocol
and Cordis `4.0.5-alpha.1`; no other host version is declared supported.

Install with Node `24.13.1` and run:

```sh
npm ci
npm run build
npm run verify:contracts
npm run typecheck
node --test test/protocol-handshake.test.mjs test/session-world-seam.test.mjs && npm test
```

[Host services and transaction behavior](GADGET.md) describe the module boundary.
The single package entry includes the DSH objects/history panel; its bundle has no
fixture switch. Isolated mocks and public NativeFacts fixtures exercise Canvas's real
store and transaction paths. Retired fixture pages and evidence are preserved in the
canvas-01 runtime archive and Git history.

When Canvas fails closed because the world an admitted request needs is unavailable
(no store, no Adapter service, Adapter unreachable, a missing port or capability), the
public error carries the Contracts 2.7.0 optional `worldRef`: the request's own world, or
for a selector-less request only that Session's durable binding. Nothing is written, all
other error fields are kept, and undecoded input never names a world. The panel shows that
reference; Canvas keeps no world-name list and generates no name. Relayable examples:
`hanaworlds-canvas/fixtures/world-error.json` (regenerate: `node scripts/world-error-fixture.mjs`).

Source, fixture, bundle and package checks remain distinct from real-world GUI
validation and owner ACCEPTED. Product readiness is `UNPROVEN`.

The host plugin management form exposes `Config.placement`. Save changes to
reload Canvas; the policy applies to placement inspections in every bound world,
including worlds selected before the reload. Existing placement inspections and
their replay responses are invalidated when the policy changes; obtain a new
inspection before confirming a placement. Object history is retained.

| Setting | Default | Scope and effect of 0 |
| --- | --- | --- |
| `frontGapCells` — 前方间隔 | 2 cells | Placement search; no front gap |
| `forwardSearchCells` — 前向搜索距离 | 16 cells | Placement search; no forward expansion |
| `lateralSearchCells` — 侧向搜索距离 | 8 cells | Placement search; no lateral expansion |
| `verticalSearchCells` — 竖向搜索距离 | 4 cells | Placement search; no vertical expansion |

Each setting accepts nonnegative integers. Positive values enable the corresponding
gap or search extent. Setting 0 leaves world-source guards and transaction recovery
in effect. These settings are Canvas policy, independent of engine capabilities.

Call `await region.describe(sessionRef)` for the current world's geometry profiles,
partition size, bounds and lighting declaration, read through the published Adapter
connection port on each call. `await region.describe()` returns an unbound description
with unknown world geometry. Missing geometry is refused with `CAPABILITY_GAP`.
The exported `regionToolDescription(capabilities)` generates the same description
from an explicit world-source declaration.

`src/voxel-grid.mjs` owns cell footprints, region specified-cell expansion, bounds
and overlap calculation. Admission checks the payload's explicit geometry profile
against the current world source before interpreting cells. Unsupported placement
selectors and undeclared voxel geometry return `CAPABILITY_GAP` without writing;
placement forwards its profile unchanged to `InspectRegion`. The Contracts v2
cell/region payload schemas define only `voxel-grid/v1`; malformed variants still
fail strict contract decoding.

When `AnalyzeAffectedObjects` finds affected objects outside the current selection,
Canvas durably records a `BLOCK_AND_NOTIFY` policy decision beside the analysis and
emits `AffectedObjectNotificationRequired`. Its receipt carries `transactionId`,
`analysisDigest`, `decisionRevision`, `affectedObjectRefs` and `orderedSelectedRefs`.
The object references identify exactly which registered objects overlap; material
references and orientation indices remain opaque to Canvas. Apply still refuses
overlapping writes with `OTHER_OBJECTS_AFFECTED`. Disjoint or wholly selected overlap
analyses emit no notification. Exact replay, including after reopening the store,
returns the stored analysis without repeating the event. A consumer failure leaves
the durable analysis and blocking decision intact.

[`fixtures/affected-object-notification.json`](fixtures/affected-object-notification.json)
is a validated illustrative event (its IDs and digest are explicit fixture data).
`test/voxel-grid.test.mjs` uses the minimal isolated Adapter/Session implementations
in `test/support/undo-fixture-world.mjs` and `scripts/fixture-sessions.mjs` to exercise
analysis, refusal, notification and reopen through the public Canvas operations.

World selection follows the documented `canvas/v7` wire using owned validators.
`ReadWorldSelectionContext` always returns that Session's current selection; its
`worldRef` argument only scopes the connection inventory. Two Sessions can share
one world and switch independently.

Subscribe on the host Cordis context to `WorldConnectionSelectionChanged`
(a successful `SelectWorldConnection` changes the connection, incarnation or world)
and `ActiveWorldChanged` (`SwitchWorldConnection` moves to another world):

```js
ctx.on('ActiveWorldChanged', event => {
  const { currentSession, activeWorldRef, orderedSelectedObjectRefs } = event.receipt.result;
  // Refresh only currentSession; switching worlds clears its object selection.
});
```

Events contain validated immutable Contracts receipts and are dispatched after
the store's durable commit. Reads, failed commits, refused or repeated requests,
unchanged selections and same-world switches emit no corresponding change event.
Consumer failures are reported separately and do not change the committed receipt;
delivery is not retried or replayed after restart. Cordis disposes subscriptions
with the consumer fiber. For standalone `CanvasV5`, supply `emitEvent(event)` in
the constructor; the two session-world test files contain minimal Adapter/Session
stand-ins and receipt examples for this seam.


### Independent production artifact

Canvas owns project document contract structures in `src/protocol` and `types/protocol`,
with auditable hashes in `scripts/protocol-source.json`. Normal build/prepack embeds
validators/schema into all Host, display and public consumer entries. Development, fixture,
type and production graphs require no external contract package. Historical MIT attribution
remains. Installed Canvas version readback stays dynamic. Official Cordis, Typert,
Schemastery, canonicalize, ICU, Host Zod and Client React keep their existing external roles.

`npm run test:package-boundary` runs a normal `npm pack` lifecycle, inspects the
actual tgz manifest and every runtime artifact (static/dynamic imports, require,
resolve, package imports, package-relative resource URLs and JSON/schema references),
and rejects external Contracts resolution or missing local artifacts. `npm test`,
normal build and prepack include this gate. Child prepack rebuilds and verifies
without recursively starting another boundary pack. The gate then installs the
actual tgz under pnpm **11.28.5 default strict policies** in a new production-only
project, loads all public entries, runs the official Cordis Host and shared React
loader, and exercises durable cell Undo/Redo and region transactions using explicit
fixture peers. The development fixture validators are compiled only into that test
harness; they are absent from the product tgz and production dependency graph.
Negative artifact/policy/runtime checks must fail. Evidence includes exact production
lock, full resolution graph, tgz SHA256 and generated source hashes.
By default, evidence and fresh production projects live in
`~/.cache/hanaworlds-canvas/package-boundary`, outside the development source tree
so Node cannot find its development dependencies through parent directories.
`CANVAS_BOUNDARY_EVIDENCE` may select another location outside that tree. Child npm
pack uses a writable cache owned by each isolated proof, overriding both inherited
npm cache spellings. `command-context.json` records that location and the normal
pack command; pnpm security policies remain at their defaults.

Public declarations resolve to Canvas-owned local types. Cross-provider errors are
consumed by their documented JSON fields, without shared private exception identity.
The neutral scoped read is `hanaworldsWorldFacts.readScopedState(connectionRef, positions)`
through the active Canvas provider's official Cordis context. It preserves input order,
world/profile and opaque digests and performs no writes. Missing, malformed, inactive,
replaced or unauthorized sources refuse by name; there is no alternate source.

The client registers matching official `main` and `sidebar.panellist` keys. Its apply entry
accepts an optional nonempty `panelId` for a renamed registration. Consumers discover the
live target and select it through `layout.selectPanel`; absent/stale targets are rejected.

These gates prove component production install/runtime with fixture peers. Stable guards,
synchronous races, real world product Host/UI and owner acceptance remain separate gates.

`await canvas.readToolSummary({sessionRef})` returns `canvas-tool-summary/v1` for
that Session's current selected world. It includes the complete sourced tools,
unit, Frame and native partition from the registered world's `readCanvasFacts`
port, plus Canvas's current objects/history display. Optional complete
`expectedConnection` and `expectedProvider` compare prior public facts. The read
checks the actual selection and source identities before and after awaiting,
keeps physical-unit nulls and opaque provenance unchanged, and performs no writes.
Missing facts or stale providers are named refusals. These component fixtures are
not native world-source evidence or real UI/owner acceptance.
