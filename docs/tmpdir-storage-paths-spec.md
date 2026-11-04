# TMPDIR 写入收口规范

## 背景

系统临时目录可能被宿主环境、沙箱或企业安全策略限制权限。ZCode 产品主路径如果依赖 `TMPDIR` / `os.tmpdir()` 写入，会导致日志导出、反馈上传、剪贴板图片读取、checkpoint 构建或命令输出持久化在部分环境中失败。

## 目标

- 产品运行时不再把可控的 ZCode 临时/持久化文件写入系统 `TMPDIR`。
- 新路径统一落在 ZCode 数据根目录下，默认是 `~/.zcode`。
- 不迁移、不读取、不兼容旧 `TMPDIR` 残留数据。
- 本次不修改 remote asset fallback，也不修改官方 iOS / Android 模拟器插件路径。

## 路径规范

| 场景                      | 新路径                                       | 生命周期                                               |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| zcode-cli Bash 持久化输出 | `~/.zody/cli/exec/<sessionId>/<toolCallId>/` | 按 toolCall 目录保留，启动时按 30 天龄清理；规则见下节 |
| zcode-cli 剪贴板图片      | `~/.zcode/clipboard`                         | 单次读取后删除                                         |
| 日志导出 staging          | `~/.zcode/export-log-stage`                  | 打包完成后删除，异常退出允许残留                       |
| 日志导出结果              | `~/.zcode/export-log`                        | 用户可见导出结果，默认保留                             |
| feedback 附件和日志包     | `~/.zcode/feedback`                          | 上传完成后删除                                         |
| Git checkpoint 临时 index | `~/.zcode/git-checkpoint-index`              | checkpoint 构建完成后删除                              |
| Desktop 编辑器图标转换    | `~/.zcode/editor-icon`                       | 单次转换后删除                                         |

## 约束

- 写入前必须确保父目录存在，不能依赖 `mkdtemp` 自动创建父目录。
- 短生命周期目录必须使用单次唯一子目录，结束后在 `finally` 中清理。
- 失败清理不能影响主流程结果，但残留必须留在上述可控目录中，便于后续“完全清理”功能删除。
- zcode-cli 主流程仍优先使用配置解析后的 `storageRoot`；只有 adapter 默认兜底才使用默认 `~/.zody/cli/exec`。
- service / desktop 侧使用现有 data base dir 语义，默认落到 `~/.zcode`，配置了 `ZODY_DATA_BASE_DIR` 时落到 `{dataBaseDir}/.zcode`。

## Bash 执行输出隔离目录（2026-10-24 / I16）

来源：[上游 v3.16.2 实施计划 I16](plans/upstream-v3.16.2-implementation-plan.md)。已决方案 a：保持持久输出根，不迁回系统 `TMPDIR`；per-toolCall 隔离目录 + 30 天按龄清理；重启后的查询/历史取回语义不变（原文见 [后台 Bash 输出详情](background-bash-output-details.md#输出文件路径与保留i162026-10-24)）。

### 目录合同

```text
{outputRoot}/<sanitized sessionId>/<sanitized toolCallId>/stdout.log
{outputRoot}/<sanitized sessionId>/<sanitized toolCallId>/stderr.log   （仅通用 pipe 执行）
```

- `outputRoot` 按下节顺序尝试三处：调用方传入的 `outputRootDir`（生产为 `join(storageRoot, "cli", "exec")`）、adapter 默认 `resolveDefaultOutputRootDir(processEnv)`（`ZODY_STORAGE_DIR` → `~/.zody`，再拼 `cli/exec`）、三层都不可用时的进程临时根。
- Bash merged output（`command.mode === "shell" && shellProfile === "posix-bash"`）只创建 `stdout.log`，stderr 写入同一文件；通用 pipe 执行才创建 `stderr.log`。
- 目录名与文件名由 execution adapter 的 `prepareOutputPaths()`（内部 `deriveOutputPaths()`）唯一生成并缓存；runtime、tool、UI 只消费返回的 `artifactPath` / `outputPath`，不得自行拼接。
- 展示用标题可以由 `outputPath` 派生，但只用于 UI 标签，不回写为路径事实：Side Pane 代码查看器使用 `backgroundBashOutputTitle()` 保留最后两段（`<toolCallId>/stdout.log`），避免并发任务的标签都退化成 `stdout.log`；完整路径仍通过 `CodeViewerSource.path` 传递。
- 写输出前先确定并创建本次 toolCall 目录（与 `BashFileOutput.prepare()` 的 `mkdir(dirname(path))` 同一时点），同一 session 的并发执行互不共用目录或文件。
- `sanitizePathSegment` 继续替换路径分隔符与非法字符，并把空值、`.`、`..` 归一为 `unknown`；目录和文件名不得包含路径分隔符或 `..` 段。

### 临时根不可写回落

按以下顺序选择根；只有前一层目录创建或输出文件打开返回文件系统错误时才进入下一层：

1. 配置根：`outputRootDir`（生产为 `storageRoot/cli/exec`）；
2. 默认数据根：`resolveDefaultOutputRootDir(processEnv)`（仅在它与配置根不同时尝试）；
3. 进程级系统临时根：`mkdtemp(join(os.tmpdir(), "zody-cli-exec-"))`，目录权限 `0700`，每个 adapter 实例只创建一次，`close()` 删除。

- 触发条件只包括下列文件系统错误：`EACCES`、`EPERM`、`EROFS`、`ENOSPC`、`ENOTDIR`、`EEXIST`；其它异常照常上抛（按 `spawn_error` 结算），取消、adapter 关闭和命令业务错误不触发回落。
- 回落仍使用 `<sessionId>/<toolCallId>/` 结构；`artifactPath` / `outputPath` 必须指向实际写入的文件，后台查询继续按记录路径尾读。
- `bash-startup` 内部 source 脚本与输出文件使用同一个实际选中的根，但该脚本只为 `posix` / `git-bash` 方言 materialize（`embedded-search-prelude.ts` 对 `cmd` / `legacy-shell` 返回空，`bash-startup-script.ts` 的 `supportsBashSourceScripts` 同口径）。`cmd` 方言不创建 `bash-startup` 目录，其回落验收只覆盖输出文件的 `<sessionId>/<toolCallId>/` 结构。
- 第二层默认数据根是持久根：一旦被选中，adapter 同样按 30 天扫描输出文件与 `shell-snapshots`（见下节），不因“回落”名义跳过。只有第三层进程临时根属于临时降级：不参与 30 天扫描，`close()` 完成前删除；进程退出后不承诺仍可查询或打开，但文件存在期间查询语义与主根一致（文件真读不到返回 `read_failed`）。
- 三层都不可用时保留现有失败语义：命令按 `spawn_error` 结算，不挂起、不无限重试。

### 清理 owner 与时点

Owner 是 execution adapter（`NodeExecutionAdapterBase`）；runtime 不删除输出文件。唯一删除路径：

| 时点                                                                                | 行为                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| adapter 构造                                                                        | 异步扫描配置根，删除最后修改时间早于 `now - 30 天` 的 adapter 输出文件，再删除因此变空的 toolCall / session 目录；不阻塞构造或首个命令，会话间并行扫描，`close()` 等待扫描结束 |
| 首次选中第二层默认数据根                                                            | 该根是持久根，同样异步扫描一次输出文件与 `shell-snapshots` 并纳入 `close()` 等待；第三层临时根不扫描                                                                           |
| spawn 前取消、spawn 失败                                                            | `discard()` 删除本次新建的输出文件（Bash merged）；通用 pipe 删除后台预创建且从未写入的空 `stdout.log` / `stderr.log`；目录因此变空时删除该 toolCall 目录                      |
| 前台结算但未保留 artifact（`persistOutput` 为 `none` / `on_truncate` 且未触发保留） | 删除输出文件；目录因此变空时删除该 toolCall 目录                                                                                                                               |
| `close()`（shutdown）                                                               | 等待在途输出准备与执行结束后删除第三层临时根；持久根（配置根/默认数据根）中已产生的输出不删除                                                                                  |

- 30 天按文件 `mtime` 计算；持续写入的后台任务会刷新 mtime，不会被误删。配置根在构造时扫描一次，默认数据根在首次选中时扫描一次，不对运行中的执行逐个扫描。
- 清理不维护“活动/仍可查询 toolCall 路径”排除表，只按 mtime 判定：`toolCallId` 由 adapter 生成唯一值，正常调用不会与旧目录重名；若调用方显式复用同一 `sessionId`/`toolCallId` 且旧文件恰好超龄，构造时扫描与首个执行并行，可能在新写入刷新 mtime 前删除该文件，此后查询按记录路径返回 `read_failed`。这是已知边界，不额外引入跨执行状态表。
- 扫描只处理参与清理的持久根（配置根、使用中的第二层默认数据根）下、符合 adapter 命名的普通文件：`stdout.log`、`stderr.log`，以及升级前的 `<toolCallId>-stdout.log`、`<toolCallId>-stderr.log`。符号链接、非普通文件和其它文件跳过；不删除根目录本身，不跨根删除。
- `shell-snapshots/*.sh` 沿用既有 `cleanupStaleShellInitSnapshots`：配置根在构造时、默认数据根在首次选中时各扫描一次，按同一 30 天保留期删除超龄快照；临时根随 `close()` 整体删除。
- 扫描或删除失败静默跳过（不阻塞构造/关闭，不改变命令结果或查询错误分类）；adapter 当前不单独记录清理错误计数。
- 持久根中已产生的输出在取消、Stop、自然结束和 `close()` 后保留，供同进程终态查询与 BGV03/BGV06 使用；第三层临时根随 `close()` 删除，文件仍然存在期间查询语义不变。
- [设置存储管理](settings-storage-management.md)中的 catalog 与手工清理裁决不变；30 天是 adapter 的自动保留策略，不是设置页的清理动作。

## 非目标

- 不清理已有 `$TMPDIR/zcode-*` 残留。
- 不修改 remote asset cache fallback。
- 不修改 `apps/zcode-cli/packages/ios-simulator-plugin` 与 `apps/zcode-cli/packages/android-emulator-plugin` 的数据目录。
