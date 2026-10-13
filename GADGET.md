# HanaWorlds Canvas 0.16.0

Canvas owns local world selection, registered object footprints and transaction history.
The single Cordis entry is `src/index.mjs`; the DSH panel is `lib/client.js`.

Canvas owns the structures, schemas and validators for project document contracts
C-canvas@2, C-world-adapter@2 and C-world-facts@2 in `src/protocol` and `types/protocol`.
The source manifest is `scripts/protocol-source.json`; no external contract package is needed.
Run `npm ci`, `npm run build`, `npm run verify:contracts`, `npm run typecheck`, and `npm test`.
The test command runs every retained test file, including Gateway/Remote, host storage,
selection, per-cell apply/history and region rollback/recovery.

Canvas provides `canvas/v7` minor 1 and `canvas-region/v3` minor 2.
It consumes `world-adapter/v8` and `world-adapter-region/v3` at minimum minor 0
with their published write-path capability tokens. Service keys remain
`hanaworldsCanvasV5`, `hanaworldsCanvasRegionV1`, `hanaworldsWorldAdapterV6`,
`hanaworldsWorldAdapterRegionV1`, and the `hanaworldsWorkshopV3` session port.
Configuration facts come from the world source's C-world-facts port `hanaworldsWorldFacts`
(`world-facts/v1` ReadCatalogue + ReadWriteProfile, the same key the desktop bridge reads);
`hanaworldsWorldFacts.readScopedState(connectionRef, positions)` supplies the documented
read-only scoped state through Canvas's active official Cordis context. Missing, malformed,
inactive or replaced peers refuse with named errors; digests remain opaque.
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
Compiler configuration is forwarded unchanged from
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
and the public NativeFacts fixture are explicitly SOURCE/FIXTURE. These checks do not establish a real-world GUI result or owner ACCEPTED.

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

D-21=A adds `UndoScopedRegionCommit` on canvas-region/v3 minor 2, requiring
`canvas-region/v3:confirmed-scope-undo`. It derives confirmed cells exclusively from
original successful operations and actual durable before/verified-after snapshots.
The retained origin request, transaction/world/context and both content digests bind
that scope across reopen. Missing/forged evidence, stale identity and in-scope changes
refuse before writing. The target combines confirmed before with actual outside current.
Full readback summaries remain truthful; source StateProfile, partition, lighting,
guards and expected-current CAS remain authoritative. The old UndoRegionCommit and
its full-block validator remain available unchanged.

The formal objects/history panel offers scoped region Undo independently of Redo;
region Redo is explicitly unavailable. Existing history without trusted scope evidence
is refused by name, without guessed state. Uncertain post-dispatch transport,
binding and lighting answers stay UNKNOWN until scoped rollback/readback proves the
same attempt's state. Exact initial and rollback source failures remain separately
available in pending recovery; a rollback NONE never proves whole-transaction NONE.
Reopened recovery preserves outside current and refuses unproved in-scope values.
SOURCE/FIXTURE tests, including residual-eight, are distinct from
REAL_ENGINE_WORLD_WRITE, REAL_HOST_WORLD_UI and I-K3-REGION-01. None imply owner ACCEPTED.

The client optionally accepts `{panelId: 'a-nonempty-key'}` at its public apply entry.
It registers that same key in official `main` and `sidebar.panellist`. Navigation reads
the live registry and uses `layout.selectPanel`; consumers do not infer an internal id.
Default registration and old calls stay unchanged. Layout rejects missing/stale targets.

## 官方组合中的安装、配置与启动停机

Canvas 的正式入口由官方 Loader 加载；Host 和客户端必须使用正常插件管理器
安装的同一个 Canvas 制品。保持本包声明的官方 Cordis、Typert、React、Zod peers，
不用另建 Context/Gateway 或直接导入源码代替实际安装。Desktop 的 `desktop`
profile 由 Electron 应用管理，通用 `dsh --profile desktop` 启动会被官方 CLI
拒绝；安装、重载及卸载均使用该应用的正常插件管理器。

正式 Host 供应公开入口是其供应目录中的
`node packaging/official-host-supply.mjs`。它生成收据和 `HOST-USAGE.md`，包含
同根 manager 安装、Loader 启动、配置 dump、本地登录/Remote 和 SIGTERM 停机
命令；使用生成文件的实际路径和隔离环境。Host 供应证明不替代完整 Desktop
客户端、真实 ACTIVE 对端或世界/授权供应。Canvas 构建制品用正常 `npm pack`
生成，随后由该正常 manager 安装，不修改官方 peer 或绕开 manager。

在 Canvas 的公开插件配置表中保存下面的 `placement` 值，正常重载插件后生效：

```json
{
  "placement": {
    "frontGapCells": 0,
    "forwardSearchCells": 3,
    "lateralSearchCells": 0,
    "verticalSearchCells": 0
  }
}
```

| 字段 | 默认值 | 0 的作用 |
| --- | --- | --- |
| `frontGapCells` | 2 | 不留前方间隔 |
| `forwardSearchCells` | 16 | 不向前扩展搜索 |
| `lateralSearchCells` | 8 | 不做侧向扩展搜索 |
| `verticalSearchCells` | 4 | 不做竖向扩展搜索 |

四项均接受非负整数；正值是对应间隔或搜索距离。设置作用于全部已绑定世界，
不改变世界源事实或关闭保护/身体检查/事务恢复。保存重载保留对象与历史，
旧放置检查失效，确认前须取得新检查。停止应用后保留该隔离账户自己的
`data/hanaworlds-canvas-v2/canvas-v7.json`，再次启动读回历史，不导入个人旧数据。

以下启动示例使用已声明的 `HANAWORLDS_DESKTOP` 准备结果；目录与端口属于段级启动设定；实现 worker 也可按该公开 prepare 入口在本卡运行目录
自备隔离资源。这里不承诺程序会自动给每次实现 worker 注入变量。用户无需填写工程路径、profile 或调试端口。它启动真实已准备的应用，
不构造 Host。前台按 Ctrl+C，或向该 Node 进程发送 SIGTERM，会把 SIGTERM 转交
给本次应用并等待退出；没有自动重试、强杀或默认端口。

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
const env = process.env;
assert.ok(env.SEGFLOW_ENV_DIR && env.SEGFLOW_PORT_HANAWORLDS_DESKTOP,
  'CANVAS_VERIFY_ENV_MISSING: declared HANAWORLDS_DESKTOP environment required');
const root = await realpath(env.SEGFLOW_ENV_DIR);
const port = Number(env.SEGFLOW_PORT_HANAWORLDS_DESKTOP);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3080,
  'CANVAS_VERIFY_PORT_INVALID');
const product = JSON.parse(await readFile(join(root, 'product-environment.json'), 'utf8'));
for (const key of ['app', 'dshHome', 'profile', 'electronUserData']) {
  assert.equal(typeof product[key], 'string', `Missing product ${key}`);
  assert.ok((await realpath(product[key])).startsWith(root + sep), `Outside run: ${key}`);
}
assert.equal(product.dshHome, join(root, 'dsh-home'));
assert.equal(product.profile, join(product.dshHome, 'profiles/desktop'));
assert.equal(product.electronUserData, join(root, 'electron-user-data'));
await access(join(product.profile, 'package.json'));
const executable = execFileSync('/usr/libexec/PlistBuddy',
  ['-c', 'Print :CFBundleExecutable', join(product.app, 'Contents/Info.plist')],
  { encoding: 'utf8' }).trim();
assert.ok(executable && basename(executable) === executable);
const command = join(product.app, 'Contents/MacOS', executable);
await access(command, constants.X_OK);
const child = spawn(command, [
  `--user-data-dir=${product.electronUserData}`,
  '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
], { cwd: root, stdio: 'inherit', env: { ...env, DSH_HOME: product.dshHome,
  DSH_DESKTOP_DIAGNOSTIC_FILE: join(root, 'app-error.log') } });
let stopping = false;
const stop = () => { stopping = true; child.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve([code, signal]));
  });
  if (code !== 0 && !(stopping && signal === 'SIGTERM')) {
    console.error('CANVAS_DESKTOP_EXIT', { code, signal });
    process.exitCode = code ?? 1;
  }
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
JS
```

准备结果或真实服务缺失会具名失败。应用载入后，从实际侧栏登记的
「对象与历史（Canvas）」进入面板；在正式 Session/世界流程中建立并读回对象，
检查非空历史和撤回/重做。错误应显示在该面板，不能用「尚未接入」替代。
正常 manager 卸载后，侧栏/main/remote 注册和旧导航目标均应清理。
这些动作仍须在实际组合中验证；上述说明和 Host/组件测试不代表产品验收完成。

## Current world tool summary

The registered `hanaworldsCanvasV5` service exposes
`readToolSummary({sessionRef, expectedConnection?, expectedProvider?})` as a local
Host method. `expectedConnection` requires worldRef, connectionRef and
connectionIncarnationRef; `expectedProvider` requires providerRef and
providerRevision. Comparisons do not grant source permissions or change selection.

The `canvas-tool-summary/v1` result preserves the complete `CanvasSourceFacts`
read from the official current `hanaworldsWorldFacts.readCanvasFacts(scope)` port
and Canvas's existing `ObjectsHistoryDisplay`. Every tool purpose and typical
size carries its original source; units retain their explicit physical conversion
or null, and Frame carries origin, axes, handedness and transform revision.
Partition remains a native sourced observation and sourceRevision binds the
complete canonical source body. Canvas never infers these fields from objects,
transport budgets, fixed geometry or engine files. Provider replacement, invalid
scope, missing facts or invalid payload refuses with the documented public JSON
error and mutationState NONE. Reads do not commit observations or history.

## 同源官方 Web 的安装、启动与停止示例

在本工作树使用 Node24.13.1，执行无需工程参数的实际产品观察入口：

```sh
node tools/client-verification/run.mjs
```

它在本卡新 run 目录调用公开 `prepareOfficialHostSupply({root})`，读取当次真实
`official-host-supply.json`、`HOST-USAGE.md` 和完整 env-i 命令。供方须提供该 run 内的
批准同源 CLI 安装、正常 `web` profile 及依赖；外部 checkout 或跨根链接具名拒绝。
批准来源为 `dsh-v0.2.1-alpha.2`，commit
`d743267388641bc76f17c45ce8b4c231aed1d32c`；实际 tag archive 和原 lock bytes 独立核验。
同版本 npm release 不能自行替代该批准归档。用户不填写安装根、profile、token 或调试端口。

正常 `npm pack` 生成本次 Canvas 生产 tgz，由同源官方公开 manager 在正常 Web profile
安装；原固定 peers、bundle patch、manager 策略保持。普通 Loader 本地工具 entry 只负责观察，
不发布测试包、不在生产 Canvas client 增加验证页。工具对照实际已装制品的 build-source 输入和 bytes。

实际启动使用生成说明的正常公开命令形式：

```sh
dsh --profile web --no-open --host 127.0.0.1 --port 0
```

runner 直接执行收据中的实际可执行文件、参数和完整隔离环境，使用官方 web-app、
FrontendStatic、ClientModules、frontend 和 `__DSH_BOOT__`。原打印的本地 token URL
在本次无头 Chromium 中完成原 cookie 交换；随后使用干净同源根地址。
Chromium 带 `--enable-automation`、本次实际 user-data-dir 和独立 CDP listener；
token/cookie 只在内存中处理，输出流脱敏保存。禁止个人 profile、凭据或 3080。

实际 inspection 须证明同 root、官方 Loader 来源及真正 ACTIVE 的 Canvas、region、
Workshop、Adapter/WorldFacts 等提供方。仅 Skills 供应不证明这些对端、真实世界、配对、材料、
历史或 pending 场景已经存在；缺项具名失败，不制造数据或把文档样例当实际返回。
随后 runner 内部提供仅含实际路径/地址/source 文件的资源定位记录，运行全部锁定客户端候选：

```sh
node --test test/client-verification/*.test.mjs
```

finally 关闭 CDP，对本次自有 CLI/浏览器进程组发送 SIGTERM、等实际退出并验证端口释放；
超过具名停止预算时仅终止自有组，保留主错与清理错。保留本次数据和历史资源，不重试或清理其他 PID。
实际供应、隔离、安装、鉴权、对端及功能测试分别记录；未到达的产品阶段为 `NOT_RUN`。
Web 不替代上述 Desktop 原示例、九插件、完整 App、订阅、段级或 owner 验收。

默认准备预算 `HANAWORLDS_HOST_PREPARE_TIMEOUT_MS=120000`、停止预算
`HANAWORLDS_HOST_PREPARE_STOP_TIMEOUT_MS=10000`、观察预算
`CANVAS_CLIENT_VERIFY_WAIT_MS=30000`，均须为正整数；可选正常端口
`CANVAS_CLIENT_VERIFY_PORT=0`，0 由 OS 分配，拒绝 3080。
公开 manager 返回的输出预算 `CANVAS_CLIENT_VERIFY_MANAGER_OUTPUT_BYTES=4194304` 可改，
完整日志另留；归档和实际脚本证据没有额外隐藏输出字节上限。
供方入口与实际 Chromium 的自动默认位置及全部可选设置见
`tools/client-verification/README.md`。本次完整证据保存在 `evidence/d91/web-run-*/runner-result.json`。
