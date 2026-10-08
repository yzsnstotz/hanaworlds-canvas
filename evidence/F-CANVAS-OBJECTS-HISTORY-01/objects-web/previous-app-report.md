入口：/Applications/HanaWorlds.app

# F-CANVAS-OBJECTS-HISTORY-01 REPORT

状态：PARTIAL。Canvas0.6.0 安装与启用已实达，自己的侧栏首步未达。此报告补交已结束窗口与本轮源码调查，不是产品交测/完成/接受。

- 改了什么：前轮0.6.0提供自身只读对象/历史服务、面板与显式fixture、新提交展示元数据。本轮仅新增 origin evidence 的 `gui-build03-060/` 与 `client-entry-investigation/` 共13项：首次真实缺口截图/AX/退出/receipt，以及两项针对性官方SDK装配复现和失败准备记录。未改 package/client/Host/事务源码、版本或冻结包；尚无已证自身代码缺陷可修，不能猜根因更改有效声明。
- git：source `/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-REGION-UNDO-01/source`；任务分支 `codex/s1-canvas-region-undo-01`；最新 evidence commit `ba6c600b3ff45df4cc46a67f8f3551cacd2c55fb` 已普通push，实际 ls-remote 同 SHA；git status --porcelain 空，工作树干净。原冻结源码 `b16fe3bfe849cf340b4b5c447446a880d606e251`、原证据HEAD60954667246987a01141eb045f0fde70ac691f73仍保留。未merge/main push/tag/release/publish/deploy。
- 构建清理：本轮无构建、无新候选；图缓存探针自己的临时fixture目录已finally删除。唯一0.6.0 tar与原E保留，新GUI/调查E已归档进任务分支；不清源码、world/profile/rollback、卡外残留。
- 自测：原封存 SOURCE16/16、DSH Gateway2/2、独立tar受影响组件13/13不复跑。新针对性检查：Node24.13.1跑 `client-entry-investigation/probe.mjs` exit0，实际官方Cordis plugin生命周期/ClientRemote/TypertRegistry/SlotRegistry成功挂载只读read、主面板和侧栏注册，显式断言通过；document/Connection/session/layout及父slot声明为FIXTURE，未渲染浏览器/读取App。`graph-cache-probe.mjs` exit0，实际官方ClientModuleRegistry/Context + 本卡临时package/Loader行FIXTURE：原无client→同实例换有client并生命周期事件，图仍空；新Registry图出现Canvas。两者是REAL_RUNTIME SDK组件 + FIXTURE，不签REAL_UI首步。
- 已装进统一客户端：Canvas0.6.0 · `/Applications/HanaWorlds.app`，经 Welcome Add API Key → Set up later → Plugins/Add plugin/准确唯一tar/Install一次/Enable now。产品详情显示0.5.3→0.6.0、Installed、Done13.3s，安装目标 `/Users/yzliu/.hanaworlds/profiles/desktop`（仅UI读到，未直接访问）。Plugins显示v0.6.0/on/1 total·1 running。App build03/source e5f554975/0.2.0-rc.2来自PM供给，不是本worker字节审计。首步成功截图：无，未达；安装/缺失入口截图 `/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01/_evidence/gui-build03-060/installed-running-missing-sidebar.png`，19:48:50 JST。随后正常Cmd+Q、CUA inventory isRunning:false、GUI-lock RELEASED exit0，未重开/Retry/重装/禁用删除Brush/Painter。本轮源码调查未取得GUI锁或操作App。
- 完成判据逐条：①自己的侧栏入口可开→FAIL，首次缺口即停止；②当前世界真实存储、对象/历史及空原因→App NOT_RUN，组件有证据但不代产品；③醒目标示例的样例→App NOT_RUN；④正常退出重开面板/内容保留→NOT_RUN（正常退出本身已达）；⑤面板只读→SOURCE/官方SDK注册检查仅read成立，App面板未达。未签真实世界新提交展示、TO_TEST或owner ACCEPTED。无可执行 USER_CHECKLIST。
- 整合卡改动分类：不适用。
- 研发依赖：Node24.13.1、原own source依赖/React18.3.1、现App内公开SDK。新探针以VM加载SDK/client bundle与官方Cordis模块，固定路径/fixture与SDK SHA见调查README/sdk-files.json；源码开发链接只用于组件，不代产品安装。唯一tar154190B、SHA256 `1d43d34bccf7b83f97b1cf9bee649ef21f2426784438947e048708444fd8e870` 本轮GUI前已匹配，产品Installed状态不能单独证明全字节运行实例更新。无手工profile/peer私有/凭据。
- 未解决项：App实际缺侧栏根因仍未直接证实。公开SDK自身缓存条件已复现；未读取App内部graph/cache/profile来签根因。ClientModules缓存与当时Host实例的关系需新生命周期产品核验。未补超时/重试/兜底；无新协议或第二writer。
- 需要PM知道的：不要把Installed/on/Running视为client装配成功，或安排同包再Install重演。请路由下一独立GUI窗口在新的Host生命周期上检查已装Canvas的自身入口；这与重复同输入安装不同，当前尚无源码新字节或新tar需要发布。若新生命周期仍缺，需公开页面local synchronization失败/boot audit的最小事实再分流，非owner工程操作。Inspector使用现App不受本轮源码调查影响。

## 最小公开接口事实

官方 `dsh-client-modules` README「Declaring a client plugin」「Live plugin composition」「Sharing modules」与 exported `ClientModuleRegistry.graph()`说明并由实际入口实现核证：客户端声明是 `dsh.client`/`./client`，包注入行与模块external分工不同。本包声明有效；0.5.3基线43e4dacf实际client/clientExport均null，0.6.0两者存在。

当前官方 `dsh-client-modules/lib/index.js` 114–124明确负的“非client包”判定按Loader specifier/base URL缓存直到restart，702–729代码保存null；README134明确已有消费者的换代码不属普通enable/disable同步。用公开 `ClientModuleRegistry`/`graph()` 与生命周期复现条件，fresh Registry恢复Canvas行。已证的是SDK条件，推断是可能解释安装窗口；没有把推断写成App已证根因。未改此SDK或Desktop。

## 失败原件与上线前补测

原GUI failure E及归档 `BLOCKED-20261007T105139Z.md`已读；新E包含原截图、AX、退出receipt。调查初始VM fixture缺WebCrypto、随后缺Connection.registerGenerationSource，分别TypeError；第一次图探针浅拷贝共享dsh导致错误fixture，失败log保留，修正后有captured child exit0。早期shell的cat掩盖该错误子进程exit，已在调查README明记；不算产品故障。所有新文件SHA/长度索引与SDK SHA随任务分支证据保存。

准入与无变化门未复跑。新App入口/正常重开、真实新提交字段展示和owner验收仍开放；复杂并发、断连、回滚恢复/重放按原上线前补测，不扩大到独立验证、远端、VNC或干净机门。

## 固定供给消费身份补件（2026-10-07；仅元数据，无GUI GO）

以下来自唯一封存tar内的 `package/package.json`、本origin握手定义和已有生产收据；不是读取未知profile后重新签字节。

```json
{
  "packageName": "hanaworlds-canvas",
  "packageVersion": "0.6.0",
  "sourceRevision": null,
  "sourceRevisionStatus": "UNKNOWN",
  "sourceRevisionDefinition": [
    "package/src/local-v5.mjs:22-27 cellProtocolHandshake.provenance.sourceRevision = null",
    "package/src/region-v1.mjs:39-44 canvasProtocolHandshake.provenance.sourceRevision = null"
  ],
  "frozenSourceEvidenceRevision": "b16fe3bfe849cf340b4b5c447446a880d606e251",
  "evidenceHead": "ba6c600b3ff45df4cc46a67f8f3551cacd2c55fb",
  "tarPath": "/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01/_evidence/packed-display-060-b16fe3b/hanaworlds-canvas-0.6.0.tgz",
  "tarSha256": "1d43d34bccf7b83f97b1cf9bee649ef21f2426784438947e048708444fd8e870",
  "tarBytes": 154190
}
```

name/version 的定义来源是tar内 `package/package.json` 的顶层字段，握手运行定义也使用0.6.0；package.json没有sourceRevision字段。两条本origin握手的sourceRevision真实值均为null，artifactDigest也为null，故精确嵌入来源标记UNKNOWN，不能把外部冻结commit冒充该运行字段。tar内README31–33说明exact source/tar identity存于门证据；其30行仍写0.5.3的旧说明，版本身份以实际package.json/握手代码为准，本轮不改该封存文档。

冻结source完整值来自已封存 `packed-display-060-b16fe3b/receipt.json` 的 `frozenSource`；同一收据 `tar`/`tarSha256`/`tarBytes` 定义上列准确唯一产物。本轮只从tar读元数据/字段定义与收据，不重门/准入/构建。ba6c600是后续证据提交，不是冻结源码字段；该commit已有tar逐字节原件，repo相对路径 `evidence/F-CANVAS-OBJECTS-HISTORY-01/0.6.0/packed-display-060-b16fe3b/hanaworlds-canvas-0.6.0.tgz`。

公开消费依赖来自该tar的package.json：Node `>=24.13.1 <25`；生产依赖 `canonicalize@5.1.0`、`icu@2.3.1`、`hanaworlds-contracts` 的固定codeload URL `https://codeload.github.com/yzsnstotz/hanaworlds-contracts/tar.gz/c006a839a6e6c2c63d57a14b72e4e6b26fa717f1`；peer声明 `@deepseek-ai/cordis~4.0.4`、`@deepseek-ai/dsh-typert-protocol@0.2.0-rc.2`、`zod@4.6.5` 均optional。公开客户端 `dsh.client.platform=web`，包注入依赖 layout/sidebar/ui-session/api-gateway四个 `@deepseek-ai/dsh-client-*`/gateway包，客户端外部React由官方Web baseline提供；声明原文可从tar package.json消费，不是手工profile依赖。构建收据Node24.13.1/npm11.8.0与开发SDK链接只作既有研发事实，不能当Desktop当前供给已验。

git现查：分支 `codex/s1-canvas-region-undo-01`；HEAD与 `git ls-remote origin refs/heads/codex/s1-canvas-region-undo-01` 均为完整ba6c600b3ff45df4cc46a67f8f3551cacd2c55fb，已普通push；git status --porcelain为空，工作树干净。源码、tar、调查与GUI E全未修改，本轮仅追加此REPORT消费条目。清理0状态：新增构建0、新候选0、重复门0、GUI操作/取锁0、需删除新残留0；原唯一tar/source/E保全。整体状态仍PARTIAL/首步NOT_RUN，等待合法固定供给恢复与明确新窗口。

## build04 产品窗口排队补件（2026-10-07；PARTIAL）

收到原writer的产品GUI续GO：PM供给身份build04/source `9776f74d2a86d619e3b9002bb899e46d8474e52c`/0.2.0-rc.2，Canvas0.6.0准确seed，要求只核已装身份与本面板，不再Install。该身份是PM供给通知，本worker本轮尚未启动App核验。

按指令只尝试一次fresh gui-lock acquire。实际native exit1：`BUSY held by /Users/yzliu/work/projects/hana-world-mvp F-CONTRACT-INSPECTOR-01 thread 01a11578-7cd5-7002-bb44-41406205d0ee since 2026-10-07T12:38:10Z — wait; do not take it over`。持锁时间为21:38:10 JST。本worker未获得锁，不release他人锁，未轮询/再次acquire，未初始化或操作本轮CUA、未启动App、未发安装请求。

当前自己的Plugins0.6.0/on核验、侧栏/首步、真实空状态、示例与正常重开全未在build04运行。本轮停止于排队，不把PMstartup或历史Installed替代当前首步；仍PARTIAL，待PM安排下一独立窗口。无当前成功截图或可执行USER_CHECKLIST，validate --card产品交件格式检查尚未运行，因为可执行清单未达前提。

冻结source b16fe3bfe849cf340b4b5c447446a880d606e251、证据ba6c600b3ff45df4cc46a67f8f3551cacd2c55fb、唯一0.6.0 tar及原失败E均保留，未改源码/包/调查；原任务分支普通push/clean记录不变，本轮未新作源码提交。构建清理0：构建0、新候选0、门/准入复跑0、GUI操作0、新残留0，未做卡外清理。此条仅排队PARTIAL，不重调查旧缓存原因或重演旧失败窗口。

## build04 新独立窗口返回（2026-10-07；PARTIAL / 新公共启动失败）

本轮fresh gui-lock acquire实际ACQUIRED/exit0。正常启动现 `/Applications/HanaWorlds.app`，欢迎窗口一度可见，随后出现新的critical alert：`web boot: 1 entry did not activate`，`@hanaworlds/contract-inspector: failed`。公开警报给出日志路径 `/Users/yzliu/Library/Logs/HanaWorlds/crash-2026-10-07T12-59-40-772Z-web-boot.log`，未读该日志/peer私有材料，未调查SDK或猜根因。这是21:59:40 JST新启动失败，不是旧DEPLOYMENT_BYTES_CHANGED或旧Canvas无侧栏窗口的重复交件。

当前截图 `/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01/_evidence/gui-build04-startup-125940/startup-alert.png`，相同目录startup-alert.ax.txt/receipt.json、退出及残留收据；截图观察21:59:58 JST。是新警报截图，不是Canvas首步成功截图。供给build04/source9776f74d2a86d619e3b9002bb899e46d8474e52c/App0.2.0-rc.2/Canvas0.6.0仍只来自PM身份通知；本轮未进入main/Plugins，未独立核当前Canvas身份/on，不把历史已装事实代当前读回。安装请求0，世界请求0，未操作其他origin面板。

首遇公共缺口即停止。公开应用菜单Quit先被UI状态变化guard拒绝；fresh AX后菜单Quit已发送，但modal仍在。仅点击警报Exit（未点击Restart/Disable）退出：fresh CUA inventory实际isRunning:false，ps全command选择自身App路径的残留0（不打印参数、不读profile），GUI-lock实际RELEASED/exit0。不持锁等待、不再启动/Retry/Install，不以强退或禁用插件绕过失败。初始REPL无app变量导致首次getApp已启动/显示欢迎但绑定赋值报错；第二次getApp绑定同一现窗口而非重启。前一次较窄ps选择与未退出inventory原文保留，最终退出确认采用全command选择与fresh inventory，不把初始矛盾记录冒充退出已达。

完成门：当前Plugins身份/on、Canvas侧栏/首步、真实空态、明确样例、正常重开与内容持久均NOT_RUN，真实新世界提交展示/owner接受也未签。USER_CHECKLIST无可执行前提，本轮不写无法亲走的清单，validate --card产品交件格式检查NOT_RUN；当前交精确BLOCKED，PM分流新的public boot失败后另排窗口。原组件检查/准入不复。

新交付仅9项小GUI证据共139850B，已commit普通push到任务分支 `codex/s1-canvas-region-undo-01`，最新evidence HEAD `b1d7fe613d61063d7182a4e34d2aad226d5a704b`，本地/remote实查相同；工作树干净。冻结source b16fe3bfe849cf340b4b5c447446a880d606e251和唯一0.6.0 tar/SHA/154190B未改，原ba6c600调查/旧失败E保留未覆盖。构建清理：新构建0/新候选0/门和准入0，没有大App/profile复制或清盘；留原源码/唯一包/E与新小GUI证据。未修改当前App/profile、Desktop/SDK或peer源码，未新协议/第二writer。
