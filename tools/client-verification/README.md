# 正常官方 Web 的实际 Canvas 观察

在本工作树使用 Node24.13.1 执行唯一入口，无需填写 profile、安装路径、token 或调试端口：

```sh
node tools/client-verification/run.mjs
```

runner 在本卡 `evidence/d91/web-run-*` 新建独立资源。它在单独进程调用供方公开
`prepareOfficialHostSupply({root,commandTimeoutMs,commandStopTimeoutMs})`，读取当次真实
`official-host-supply.json` 和 `HOST-USAGE.md` 的完整命令及 env-i 环境。
默认供方入口为本工作区
`~/work/projects/hana-world-mvp/plugins/hanaworlds-desktop/packaging/official-host-supply.mjs`。
只经公开入口运行，不导入对端私有实现。

实际来源必须是批准的 `dsh-v0.2.1-alpha.2`，commit
`d743267388641bc76f17c45ce8b4c231aed1d32c`；归档及原 lock bytes 独立保留、核对。
实际 CLI installation、官方依赖、HOME、DSH_HOME、DSH_AGENTS_HOME、profile、缓存、工作区
和浏览器数据必须在同一新 run 内。外部 checkout 包根及跨根链接会具名失败，不能改写定位字段。
同版本 npm release 不自动替代批准 source archive。

正常 `npm pack` 生成 Canvas 生产 tgz；同源公开 `runPluginCommand` 在正常 `web` profile
安装它及实际官方依赖。原 peers、manager 策略和 bundle patch 保持。
`prepare.mjs` 只添加普通 Loader 本地工具 entry，不生成测试包、验证页或 Desktop 收据；
Host 的自有验证输入逐项对照实际生产制品 build-source。
工具保持独立生命周期，实际卸载 Canvas 后仍可观察正常 manager。

启动使用生成的正常 `dsh --profile web --no-open --host 127.0.0.1 --port 0` 命令。
产品使用原 web-app、FrontendStatic、ClientModules、官方 frontend 与 `__DSH_BOOT__`。
无头 Chromium 通过原打印的本地 token URL 完成 cookie 交换，随后保留干净同源根 URL。
实际 browser command line 与 CDP 提供浏览器身份和隔离数据目录证据。
token/cookie 只在内存中处理；浏览器使用独立数据目录及 incognito，输出流脱敏保存。

正常 Loader 的实际 inspection 必须具有 Canvas、region、Workshop、Adapter 与 WorldFacts
等真实 ACTIVE 提供方。当前公开 supplier 若仅供应 Skills，不能据此宣称这些对端或真实世界已具备。
缺同源安装根、对端制品、公开世界/配对/材料/历史/pending 场景时具名失败。
不制造连接、材料、授权或 store 内容，也不把样例数据填成实际返回。

随后 runner 内部提供仅含真实路径/地址/source 文件的 `CANVAS_CLIENT_VERIFY_RESOURCES`，执行：

```sh
node --test test/client-verification/*.test.mjs
```

定位文件不包含 token、cookie、ready 或 ACTIVE 声明。锁定测试独立核来源、完整生产 bytes、
实际官方 frontend、模块图、manager、Host/Client 身份，并点击全部实际按钮。
测试版代码只存在于 `tools/` 和 run 目录，不进入 Canvas 发布 files 或 `lib/client.js`。

所有正常及失败路径均在 finally 关闭 CDP，对本次自有进程组发送 SIGTERM、等退出并验证实际端口释放。
超过公开停止预算时只终止自有组，保留超时主错与清理错；不杀其他 PID、删除历史资源或重试供应。
`runner-result.json`、真实供应文件和脱敏双流留在当次 run。
供应、隔离、安装、鉴权、对端与功能测试分别记录；未到达的产品阶段写 `NOT_RUN`。
进程监督验证只说明 runner 自身行为，不升级为 REAL_HOST/REAL_UI 或 owner 验收。

可选运行设置均有默认值，用户无需设置：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HANAWORLDS_HOST_PREPARE_TIMEOUT_MS` | `120000` | 公共供应和每条准备命令的等待预算 |
| `HANAWORLDS_HOST_PREPARE_STOP_TIMEOUT_MS` | `10000` | SIGTERM 停机预算 |
| `CANVAS_CLIENT_VERIFY_WAIT_MS` | `30000` | 正常 listener、导航、CDP 与测试观察等待预算 |
| `CANVAS_CLIENT_VERIFY_MANAGER_OUTPUT_BYTES` | `4194304` | 公开 manager 返回的输出字节预算，完整日志另留 |
| `CANVAS_CLIENT_VERIFY_PORT` | `0` | 正常 Web CLI 端口，0 由 OS 分配，拒绝 3080 |
| `CANVAS_CLIENT_VERIFY_CHROMIUM` | 自动发现实际 Chrome/Chromium | 可选浏览器可执行文件 |
| `HANAWORLDS_HOST_SUPPLIER_ENTRY` | 上述本工作区公开入口 | 可选同一公开 API 的安装位置 |

预算和端口在准备前校验；预算必须为正整数。归档、脚本和实际 package 证据没有额外隐藏输出字节上限。
Web 观察不替代原 Desktop 九插件、完整 App、订阅、段级产品门或 owner 验收。
