入口：http://127.0.0.1:47601/objects

# F-CANVAS-OBJECTS-HISTORY-01 REPORT

状态：独立本机网页已起，可试用；真实新世界提交的展示尚未验证，整体保留 PARTIAL，不记 owner ACCEPTED。按 owner 2026-10-07 入口变更交独立网页；历史 App 安装/侧栏/启动失败不再作为本轮入口门，App 内接入归整合卡。

- 试用入口已起：http://127.0.0.1:47601/objects · 启动命令：在 `/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-REGION-UNDO-01/source` 运行 `/Users/yzliu/.local/state/fnm_multishells/34058_1791361431970/bin/node scripts/objects-web-server.mjs`。构建资源命令：同目录、同 Node 运行 `scripts/build-objects-web.mjs`；也有 `npm run build:objects` / `npm run dev:objects`（Node24）。当前持续运行 exec session65133、PID67737，交件前实查 LISTEN 127.0.0.1:47601；服务留给 owner，不在本轮结束时关闭。初始短 shell nohup 未保持进程，后改为持续 PTY，ready 已读回；没有加超时、重试或静默兜底。
- 改了什么：新增本 origin 独立开发网页/服务/资源构建，复用已交 CanvasV5、CanvasStore、公开 readObjectsHistory、ObjectsHistoryView 与明确标注的 displayFixture；名称、位置、占地大小和历史时间、批量/逐格、影响格数、提交/撤回状态均展示。真实会话来自本 origin 自己耐久存储；无会话时说明原因。示例开关与会话选择保存在浏览器，页面只读。原 App 面板代码和0.6.0封存 tar 原样保留，未重建 lib/client.js，未改 Desktop、peer、协议、事务/回滚/Undo 决定，未开放世界写入。
- 真实运行边界：服务实际打开自己的新 CanvasStore，目录 `/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01/objects-web/data`。当前没有连接世界的会话或提交，所以真实页面是 NO_SESSION/0对象/0历史；并未接入 App profile。示例只在客户端显示，不写入此存储；HTTP 检查的种子记录是本卡临时耐久 FIXTURE，finally删除，未拷进网页真实数据。不能把示例或种子记录当真实新世界提交，后者 NOT_RUN。
- git：任务分支 `codex/s1-canvas-region-undo-01`；源码提交 `0cd4e39358f884af671c6fa5baf48a1be9cee896`；证据 HEAD `c2972d622608ff3359d47e1583b6c0bdd505ef70`。两节点均 commit+普通push，git ls-remote 实查与本地HEAD一致；git status --porcelain 空，工作树干净。未merge/main push/force-push/tag/release/publish/deploy。
- 当前运行资源：objects.js151580B，SHA256 `c800d8d26a9693b2edf29d2349f966441bbe107b518d2d248337219796232050`；objects.css7596B，SHA256 `ffbc56d7e878104bb7ce37d107f8d917c7d61bc77a7ff7721827f2bbd6b32684`。确切原件、索引、命令和运行收据已归档在 origin `evidence/F-CANVAS-OBJECTS-HISTORY-01/objects-web/`。
- 自测：新只读 HTTP 门1/1 PASS（实际 exit0）；读取实际 CanvasStore 的隔离fixture，核对象/历史公开投影、会话、空态、拒写、重复参数/路径隔离与读前后耐久字节相同。受影响纯显示门2/2 PASS（exit0）；资源构建 exit0；git diff --check PASS。预期缺实现的 RED exit1原件保留。既有成功全SOURCE/package/准入门不复跑；无新 tar 或 App 安装/启动/GUI锁。
- REAL_UI：本人在本机浏览器亲走原7个动作（本轮合并为清单1–6）。23:02:33 JST首步打开准确入口，自己的导航/两区域/真实空原因/只读提示可见；打开示例明确显示非当前世界，林边小屋位置(12,4,8)/8×6×8/384格、石头小径已撤回；历史显示17:00批量区域384格已提交与两笔逐格24格已撤回。关闭页并正常 SIGINT 服务 exit0、从源码提交重启、重开页后示例开关与记录保持；再关闭示例并刷新，真实空态保持，未混入示例。最后清单步骤观察23:05:36 JST。服务启动与端口事实不能代 owner 接受。
- 首步截图：`/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01/_evidence/objects-web/01-first-step-real-empty.png`；同目录02-sample.png、03-reopen-preserved-sample.png、04-reopened-real-refresh.png及完整 AX 保存后续步骤。浏览器页留在真实空态，已标为交付页。
- 完成判据：①独立网页导航/打开→REAL_UI PASS；②真实 CanvasStore读取和空原因→REAL_RUNTIME读取 + REAL_UI空态 PASS；真实世界新提交→NOT_RUN；③醒目标注示例→REAL_UI PASS；④页面与服务正常关闭重开、示例显示保持→REAL_UI PASS；⑤只读→SOURCE/HTTP拒写及页面无写按钮 PASS。App 接入由整合卡承担，不宣称 App 门已达。
- 清单/格式：USER_CHECKLIST.md首行准确入口，共6个直线纯UI步骤，覆盖此前亲走的7个动作（合并对象与历史字段观察）。此前原7步版本的 `bluemap.py validate --card` 实际 exit0 / PASS（format only; not evidence）；本轮仅文档收尾，未复跑该检查。不以格式检查替代产品验收或自动签 TO_TEST/ACCEPTED。
- 构建清理：HTTP fixture临时目录已finally删除；没有被替代的大构建或新安装包需删除。保留一份当前网页资源、正在运行的服务/数据、源码与 `_evidence/`；旧 tar 与失败证据原件保全；修正失败启动留下的过期PID内容。未清卡外目录/profile/世界/回滚数据。
- 研发依赖及许可：Node24.13.1/npm11.8.0；复用 React18.3.1 · MIT · 已有 npm包 · 独立UI，ReactDOM18.3.1 · MIT · 已有 npm包 · 浏览器渲染，esbuild0.25.10 · MIT · 已有 npm开发包 · 本地资源构建。新增 React/ReactDOM完整MIT原文到 LICENSES/，NOTICE记录；未新增依赖、CDN或网络字体，版本/lock不变。
- 未解决项/上线前补测：真实世界新提交后完整字段显示尚未验证；整合卡接入与后续复杂并发、断连、恢复/重放沿原门处理。当前无需 owner 工程操作；owner可直接通过入口试用。ACCEPTED仅由 owner 明确授予。
- 需要PM知道的：本轮交的是独立本机入口与可执行清单，源/证据已push且服务保留；请按新入口收件并保留真实新提交 NOT_RUN 的边界。旧 App REPORT 原文归档 `_evidence/objects-web/previous-app-report.md` 并随证据commit保存；原冻结源码b16fe3b及唯一0.6.0 tar/hash不变，嵌入sourceRevision仍UNKNOWN，不能把本轮网页source commit冒充旧tar运行字段。

## 本轮文档收尾（2026-10-07）

按现任PM指令，仅将此前已测的对象与历史字段观察合并为一个步骤，清单7步缩为6步；真实空原因、明示示例、完整字段、重开保持、关示例、刷新与只读观察均保留。本轮没有重走UI、实验、构建、工程门或准入，前文验证均为上轮已有证据；当前仍 PARTIAL / 不TO_TEST / 不ACCEPTED。

后续「真实runtime + 显式隔离fixture耐久Store正向网页显示/重开」路线等待CARD供给与现任PM正式GO，尚未执行。当前source、唯一tar、旧新E、数据与服务均保全，本轮未操作这些资源。构建清理：新增构建0、需删除候选0，未清盘或停服务。

本轮提交范围仅本卡REPORT.md与USER_CHECKLIST.md，沿整合仓现有任务分支codex/bluemap-pm-oct04普通commit/push；实际提交及远端读回在交件通知中给出。共享工作树已有其他会话改动与gitlinks，不stage、不提交；本卡两文档交件后无未提交差异，不能据此称共享整仓工作树干净。
