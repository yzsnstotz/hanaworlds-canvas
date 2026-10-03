# hanaworlds-canvas · 插件级验收

真实运行时：**本地存储 + fake adapter**（Canvas 是唯一事务决策者；fake adapter 实现 world-adapter/v4 的内存世界）。
证据上限：`REAL_RUNTIME`（本地持久化存储是它自己的真实运行时）。

| ID | 验收条目 | 可见结果 | 怎么跑 | 证据上限 |
| --- | --- | --- | --- | --- |
| CV-01 | 对 fake adapter apply 后 readback 一致 | 一次 ApplyRecoverableCommit 后，readback 的方块与请求相同，历史新增恰好一条 | `npm test`（v4 apply/readback 用例） | REAL_RUNTIME |
| CV-02 | undo / redo 跨进程重启保持 | 写入 → undo → 关闭进程 → 重新打开同一存储目录 → redo 可用且 head 正确 | `npm test`（store / history 用例，用临时目录重开） | REAL_RUNTIME |
| CV-03 | apply 中途失败回滚到 before 镜像 | fake adapter 在 Apply 中途返回失败时，readback 等于 before 镜像，收据为 `ROLLED_BACK`；恢复失败时为 `RESTORE_FAILED`/`RECOVERY_PENDING` 并阻止同范围新写 | `npm test`（recovery 用例） | REAL_RUNTIME |
| CV-04 | 旧存储 schema 升级保留旧记录并留下备份 | schema1/2 存储打开后迁移到 schema3，旧记录逐字节保留，备份文件 fsync 后存在；旧代码对 schema3 拒绝而非误读 | `npm test`（store-migration 用例） | REAL_RUNTIME |
| CV-05 | 当前清单查询只读 | `ListObjects(expectedRevision:null)` 返回一致的已提交快照；调用前后存储字节相同 | `npm test`（current-inventory 用例） | REAL_RUNTIME |
