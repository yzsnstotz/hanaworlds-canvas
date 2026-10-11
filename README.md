# HanaWorlds Canvas

Canvas `0.13.2` manages local world selection, object footprints, recoverable
transactions and durable Undo/Redo history. It provides `canvas/v7` and
`canvas-region/v3`, using the formal Contracts `v2.2.1` git tag.

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
