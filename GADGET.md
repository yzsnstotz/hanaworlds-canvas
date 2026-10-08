# HanaWorlds Canvas 0.6.10 local world component

The package exposes `hanaworldsCanvasV5` and consumes the public
`hanaworldsWorldAdapterV6` port. It uses the root export of the released
Contracts `v0.5.3` (tag commit `3457493da209178f815d6950e323e1dc462e8d6c`;
exact handshake `hanaworlds-contracts@0.5.3`). There is no
account, grant, epoch, authorization, or protected region dependency in this
local MVP protocol.

For per-cell peer admission read `ctx.get('hanaworldsCanvasV5').protocolHandshake`
(property, not method). It is Canvas's real `ProtocolHandshake`: canvas 5 at the
minor the installed Contracts declare (5.0 on 0.5.3, 5.1 on 0.5.4),
capabilities=[] because Contracts publishes no per-cell Canvas token. Check it
with `protocolRequirement('canvas/v5', [])` / `checkProtocolCompatibility`.

Session-world seam (0.6.7, active only when the installed Contracts declare canvas/v5
minor 1, i.e. the 0.5.4 candidate; on 0.5.3 nothing below applies):
- G-S: before Select/Switch, and for an UNBOUND read, Canvas reads `ReadSessionIdentity`
  on Workshop's public service `hanaworldsWorkshopV3` (the same WorkshopV3 instance Workshop
  0.4.12 provides; read per call, so a disposed provider fails closed
  `CAPABILITY_UNAVAILABLE`; no other key or alias is tried). `SESSION_NOT_FOUND` is refused. `sessionRevision`
  (CurrentContext and UNBOUND) is Workshop's revision; an UNBOUND Select expects it.
- G-U `UnselectWorldConnection`: CAS on `selectionRevision` and `expectedContext`; not the
  current world → `WORLD_NOT_BOUND`; returns `activeWorldRef`/`localContext` null.
- G-L `RetireSessionSelection`: called by Workshop only; clears the selection atomically,
  irreversible, idempotent; the Session is then `SESSION_NOT_FOUND` to every Canvas
  operation. Canvas never deletes a Session or reports one deleted. Refused while the
  Session has an unfinished transaction.
- G-D `ListWorldSelections` (derived from the one selection table), `ReserveWorldRetirement`
  (`requireWorldRetirable`, CAS on `inventoryRevision`), `ReleaseWorldRetirement`
  (`RETIRED` → `WORLD_NOT_FOUND`; `ABORTED` → selectable). Selecting a reserved world is
  refused `TRANSACTION_CONFLICT`/`SCOPE_DENIED`, also re-checked inside the durable commit.
- C1: a BOUND Session's read names its own current world even when `worldRef` differs.

Session↔World selection (0.6.6): Canvas alone decides it and alone generates
`selectionRevision`. `SwitchWorldConnection` moves one bound Session to another
connection/world (CAS on `selectionRevision` and `expectedContext`; target readback and
inventory row must agree; refused while the Session has an unfinished transaction);
`currentSession` is kept, a different world clears the object selection. Another
Session's selection never changes. `ReadWorldSelectionContext.inventory` lists only the
requested world's connections. An exact duplicate of a completed Select/Switch is refused
by name (the contracts `validateCurrentRequest` checks `expectedContext` first) and never
applies twice.

G3 write-before guard (0.6.4): before a BUILD (`ApplyRecoverableCommit`), `Undo`
or `Redo` reserves anything or calls a mutating Adapter operation, Canvas checks
the per-cell Adapter port's `protocolHandshake` (Host service
`hanaworldsWorldAdapterV6`, property) with `checkProtocolCompatibility` against
`ADAPTER_CELL_REQUIREMENT`: `world-adapter` major 6 at the Contracts-declared
minor with `world-adapter/v6:callback-free-write` and
`world-adapter/v6:write-path-state-facts`. A missing handshake, another
protocol or major, a lower minor or a missing id is refused with
`UNSUPPORTED_VERSION` or `CAPABILITY_UNAVAILABLE` (`phase: decode`,
`mutationState: NONE`); only Canvas's read-only current-world admission read
(`ReadLocalConnection`) precedes it. An exact replay of a completed request
still returns its stored result.
The public types and implemented-operation list are in `types/index.d.ts` and
README. Protocol declaration does not imply storage readiness or known world
facts. Region handshake is unchanged and stays distinct; exact ContractHandshake
and status text cannot establish per-cell protocol compatibility.

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

`expectedRevision` of `SelectWorldConnection` is always a revision Canvas has
published: for an unbound Session it is the `sessionRevision` of the UNBOUND
`ReadWorldSelectionContext` result (`session-0`); for a bound Session it is the
current `selectionRevision` read back from the BOUND context. A caller never
needs a private constant. Any other value is `STALE_REVISION`, and a bound
Session never accepts the unbound revision again.

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

## Region v1 transaction and whole-region Undo (0.5.0)

`apply(ctx)` also provides `hanaworldsCanvasRegionV1`, implementing the public
Contracts 0.5.0 `canvas-region/v1` wire (`ApplyRegionCommit`,
`UndoRegionCommit`) over the same durable store, world revisions, footprints
and history rows as cell BUILD. Canvas stays the only transaction decider. It
consumes the Adapter's `world-adapter-region/v1` port (`ReadRegion`,
`WriteRegion`) from the Host service `hanaworldsWorldAdapterRegionV1`; the
Adapter only loads, reads and writes mapblock chunks and reports per-chunk facts.

- Compatibility: before any read or write Canvas runs
  `checkProtocolCompatibility` on both Adapter ports' `ProtocolHandshake`s:
  the region port (`hanaworldsWorldAdapterRegionV1`) against
  `ADAPTER_REGION_REQUIREMENT` and the per-cell port
  (`hanaworldsWorldAdapterV6`) against `ADAPTER_CELL_REQUIREMENT`. Each
  requirement holds only the Adapter capabilities of its own wire, at the
  minor the Contracts declare for that protocol (with the G3 write-path scope:
  `world-adapter-region/v1:callback-free-write` on the region port,
  `world-adapter/v6:callback-free-write` and
  `world-adapter/v6:write-path-state-facts` on the per-cell port). Another
  major, a lower minor, a missing handshake on either port (for example the
  exact-package 0.4.2 handshake) or a missing capability is rejected; a higher
  minor, patch, source or artifact digest is accepted. Canvas advertises its own handshake (`canvas-region` 1.0,
  four `canvas-region/v1:*` capabilities) as `protocolHandshake`.
- `describe()` gives the skill the tool's purpose, typical scale and
  prerequisites. There is no system threshold or setting.
- Commit: the request carries Brush's `region-operations/v1` chunks and digest
  (checked with `validateDigestBinding`). Canvas checks current world and
  connection and registered footprints, reads the before image of every
  compiled chunk (`requireKnownRegion`; still unknown rejects), and stores the
  complete `RegionSnapshotContent` (node, param2, air and extras) as gzip
  (RFC 1952, Node zlib) over its canonical JSON in a content-addressed 0600
  file under `data/hanaworlds-canvas/region-snapshots/`, recorded as
  `RegionSnapshotRef`, before a durable reservation and the single `APPLY`
  `WriteRegion`. Success needs every chunk `WRITTEN`, lighting `COMPLETE` and a
  full readback summary equal to `expectedRegionSummary`; then receipt, object,
  footprint and history commit together. The result is checked with
  `validateRegionCommit`.
- Any failed, unknown or mismatching chunk restores the whole region: Canvas
  reads the current state and writes `RESTORE` with the snapshot state for
  every chunk that differs, then requires the before summary (`ROLLED_BACK`).
  If that cannot be verified the reservation stays `RESTORE_PENDING`, and
  `recoverPending()` after a normal reopen restores it from the snapshot file.
- Undo: only the head history transaction of the same world, after current
  world/connection, history revision and other footprints are checked, and only
  while the current region summary still equals the verified after summary
  (otherwise `UNDO_CONFLICT/EXTERNAL_EDIT_CONFLICT`, no write). The snapshot is
  decompressed and checked with `validateRegionSnapshotContent`, the pre-Undo
  image is snapshotted too, and `RESTORE` must read back the origin before
  summary; a failed Undo restores the pre-Undo image. Cell `Undo` refuses a
  region transaction; the cell BUILD/Undo path is unchanged.


## NativeFacts method input (0.5.3 public supplement)

The actual Host injection `hanaworldsLuantiNativeFacts.readScopedState` is called
with `(connectionRef, positions)` only and returns the complete raw object
`{ worldRef, stateProfile, cells }`. It is not a ScopedCells array or
ScopedWorldBinding/request/response envelope. Constructor typing is
`nativeFacts?: NativeFactsPort` with the same complete method/return definition.
README's NativeFacts section lists every required field, current source/mapping,
normal raw fixture/schema/provenance, and legal public Contracts subtype checks.
The package exports the full fixed fixture and consumer example; both are
explicit SOURCE/FIXTURE and must not supply facts for an actual Luanti world.
Canvas's current world/profile/positions/KNOWN checks and transactions are
unchanged; only this new public input is verified by gate-nativefacts-053.

## Canvas objects/history display

The single Canvas Loader entry binds its display service when Typert is present, registering
`hanaworldsCanvasDisplay.read` through the public DSH Typert registry and Gateway.
The client mounts the same strict descriptor through `ctx.remote.$mount`, then reads
`remote.hanaworldsCanvasDisplay` only inside a fiber that injects it (0.6.1).
The global sidebar/main slot id is `hanaworlds-canvas-objects-history`.
No Desktop private transport or sibling plugin imports are used. All visible
history metadata is owned by Canvas and is separate from Contracts wire rows.

Since 0.6.2 the same namespace also has `actions(sessionRef)` and
`undo(sessionRef, objectRef, historyTransactionId)` (strict descriptors, mounted
together). `actions` is Canvas's `readHistoryActions` reduced to Undo: per object,
whether its latest entry can be undone now, or Canvas's named reason. `undo` is one
canvas/v5 `Undo` of exactly the clicked entry. The Host builds the request only from
what Canvas published for the Session's stored binding (world, revisions, localContext);
the renderer cannot supply a world, revision or context. Canvas re-validates the history
head, revisions and actual world cells, then commits the whole transaction or rolls it
back. The App panel shows 撤回这笔 → 确认撤回 only on that entry and re-reads afterwards.
Sample mode and the 47601 `/objects` page stay read-only. Redo stays out of the panel.


## 本机对象与历史网页

试用入口：http://127.0.0.1:47601/objects。由本origin自起只读开发服务；不依赖App安装、GUI锁或私有profile。网页复用对象/历史纯展示视图与既有Canvas公开readObjectsHistory，持有自己run下的真实CanvasStore。没有连接世界的会话时明确为空；示例记录从显式隔离的耐久存储读取、醒目标注，不写入真实世界记录。真实世界连接/写入/撤回不从此页执行；App内组合留整合卡。

启动：Node24.13.1下 `npm run build:objects` 生成本卡run两项资源，首次在全新隔离目录运行 `npm run prepare:objects-example`，再 `npm run dev:objects`。资源与本服务data位于本卡 `objects-web/`；停止服务使用正常SIGINT/SIGTERM，不清data。页面关闭/重开保留示例开关，服务重开重新读取本origin存储。API仅GET/HEAD，其他方法返回READ_ONLY；没有世界写入端点。

本轮独立网页的示例不再使用客户端硬编码记录。`objects-web/isolated-example` 的记录经本插件公开会话选择、区域提交、逐格提交与区域Undo实际产生，环境/Adapter/输入为显式fixture，Canvas事务与耐久存储为真实运行时。准备命令仅允许全新目录，服务只读该目录且重开不重建记录。示例始终醒目标注，名称未保存时如实显示未命名；真实数据目录`objects-web/data`与其分离，不写真实世界。App面板及封存060tar不变。
