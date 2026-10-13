# 实际已安装 Canvas 的观察入口

工具由普通官方 Loader 读取，独立于 Canvas 的生命周期，提供
`window.hanaworldsCanvasVerification.inspect()/result(caseId, mode)` 和 128 个实际按钮。
产品 `lib/client.js`、发布 files、peer、manager 策略及业务 wire 均不增加验证页或独立验证包。

先在本卡运行目录自备新隔离资源，执行当前 plan.environment 中
HANAWORLDS_DESKTOP 的 **prepare** 原命令。段级变量为 SEGFLOW_ENV_DIR/SEGFLOW_PORT；
客户端候选使用 SEGFLOW_PORT_HANAWORLDS_DESKTOP。变量未注入只表示尚未连接，不能代替执行 prepare。
缺 App/正常 profile/真实世界来源时保留公开入口的实际失败，禁止写替代 product-environment.json。

正常生产制品生成后，在已准备且未启动的隔离产品上执行：

```sh
npm pack --pack-destination "$SEGFLOW_ENV_DIR"
node tools/client-verification/prepare.mjs --tgz "$SEGFLOW_ENV_DIR/hanaworlds-canvas-0.16.0.tgz"
```

prepare.mjs 使用 App 内 Node/pnpm、同安装锚点的正常 runPluginCommand add 安装同 tgz，
保留原包操作结果与日志；在该 profile 添加普通 Loader 本地工具 entry。
本地元数据仅供 ClientModules 发现观察 bundle，不执行 npm pack/add 观察工具、不新增安装包或验证门。
工具 Host bundle 的自有协议校验逐输入核对实际制品 build-source 哈希；样例只是固定输入/绑定定义，实际结果均由本次调用、事件和独立读回产生。
每次正常 Session.create 建立独立实际会话，经 Workshop 身份与 Canvas 当前连接选择核实；
没有真实可用世界、材料、恢复记录或明确拒绝情景时具名失败。

接着执行同一 plan.environment 的 **start** 和 **ready** 原命令，再执行锁定候选：

```sh
node --test test/client-verification/*.test.mjs
```

Host 观察当前注册者/Loader/fiber/root、同 tgz 全文件与正常 manager 收据；
Client 观察当前正式模块记录、图、同源脚本字节以及实际 Canvas DOM/导航/配置/卸载控件。
公开业务调用保留原 receiver；观察不创建 Context、Gateway、模拟对端或业务 DTO。
调用及失败旁观使用 Node diagnostics_channel，原同步异常与异步返回形式保持。
零事件拒绝也须实际调用和前后状态证据，不能用空 DTO 作为拒绝结果。

停机沿既有启动示例向本次 App 发送 SIGTERM 并等待；保留本次安装/调用证据和隔离数据，
不使用个人 profile、凭据、3080 或其他项目运行态。恢复准备需新的工具目录，以免覆盖旧安装收据。
