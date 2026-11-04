# R22 状态广播与 watcher：7089 源码有界归因

比较 `7c4ff9113680a38e273032b09bee32ee6ba399af` 与 `7089ad3e095ec10727772107100d3e019b78d456`；逐文件两侧 Git blob 见 `output/zody-rename-r22/resume-source-triage-7089/blob-comparison.json`。本次只读源码、日志和既有诊断，没有执行测试、构建、安装或修改产品代码。该比较覆盖下述具体链路，不代表完整传递依赖或两侧运行时已安装文件完全一致。

## Gen UI 外部写入

`final-static-7089/unit.stdout.log:2386-2389` 报告三项中 broadcast 用例失败、该项耗时 34879ms；根 Vitest 配置的 testTimeout 是 30000ms。记录是中断的全量 run，`unit.stderr.log` 未保留该项最终错误堆栈，不能仅由耗时判断它停在 `b.set`、watch 回调还是 `changed` promise。既有独立运行成功只证明该次可通过，负载引起延迟、漏事件均非已证实原因。

测试先 `a.get` 建立观察与 null 基线，注册 `a.onChanged`，再 `await b.set` 后无界等待 `changed`。`createGenUiStateStorage` 每实例有独立 Emitter、watchers、lastPublished；`b.set` 按 scope 排队、持文件锁、`atomicWriteText` 在同目录写临时文件再 rename，释放锁后只调用 **b 实例**的 publish。a 收到通知的唯一路径是 `node:fs.watch` 回调携带匹配 `^[a-f0-9]{64}\\.json$` 的文件名 → `publish` → `readRecord` → 与基线比较 → `Emitter.fire`；无 filename、临时文件名、不匹配或未收到回调不会触发该路径。测试先注册 watcher/事件再写，仍未等待独立的原生通知可用确认；源码没有外部广播 ACK 或轮询补偿。上述是可确认的同步边界和可能失效点，日志不足以确认哪个点实际发生，也无法由此认定操作系统丢事件。测试标题的“无 echo loops”本身只断言收到的首次状态，不验证通知次数。

两版 `stateStorage.test.ts`、实现、`atomicFileUtils.ts`、RPC `foundation.ts` Emitter、shared Gen UI contract/scope-key 和 `atomicFileLock.ts` 均同 blob；`@zody/rpc` 默认导出 `src/index.ts`，`@zody/shared` Gen UI/node 导出 src，两版对应 package.json、lock、Vitest config/setup 同 blob。文件名/hash 的输入是 scope identity/path、session、target path，并非重命名后的品牌字符串；选定代码链未见路径、监听过滤器、事件语义或编译 define 的改名变化。Vitest 唯一显式 define 为 telemetry endpoint，非该链路输入。不能因此排除未检查的传递模块、环境或安装状态差异。

## Subagent watcher

测试、`subagentConfigScope.ts`、`subagentRuntimeConfig.ts` 两版同 blob；`subagentStorage.ts` 的运行时差异仅 `resolveZCodeStorageRoot` → `resolveZodyStorageRoot` 的声明和调用配对，函数体及结果未变。`subagentsService.ts` 只对应同一导入/调用和 `ZCodeProvider` → `ZodyProvider` 的 TypeScript type 名称；`subagents.ts` 与 `shared/subagents-types.ts` 中 provider 变化同为 type，擦除后无运行时值。`shared/index.ts` 有其他类型导出改名，但 `ZCODE_DATA_ROOT_DIR_NAME`、profile parser 和 runtime profile resolver 的导出仍在；各实现、`dataDir.ts`、`zody-paths.ts` 同 blob。数据根常量两版都是 `.zody`，workspace 优先 `.zody/agents` 并保留 `.zcode/agents` 读取，因此这条读取/写入目录的已检出源码未发生品牌字符串切换。项目 package exports、lock 和测试 config 同 blob；chokidar 使用 native `usePolling:false`，两版该代码一致。此处不能由源文件/lock 相同断言当前已装 chokidar、Node/系统调度完全相同。

实际链路：每个 service 的 `prepareRuntimeState` 创建自己的 cache，reader 的 `resolveUserSubagentRoot` 和 state 文件确定监听根；scope 用 chokidar 监听根/祖先并辅以 native 目录监听，事件过滤为直接子 markdown，300ms debounce，恢复补扫的稳定检测为 1s/500ms；scope settle 后通过 `publish` 合并 user、state 和 project 快照。`createAgent` 在 mutate 队列写完 `.md` 后返回，没有等待监听器处理、两个 cache 发布或两个 Host 观察到新 profile。`pair()` 在两个 prepare 后等 500ms，之后 `both` 用 8s 等待。先前只读诊断在返回后已读取到完整文件、而两个 snapshot 最长超过 8s 未见 profile，已把现象约束到文件写完成与 snapshot 可见之间；但没有内部事件/绑根/revision/解析/发布逐点记录，不能证明 root 是丢事件、绑定延迟、稳定等待、阻塞或其他原因。对应两版同样失败和不同运行波动是有限基线证据，不证明改名整体无回归。

## 最小剩余实验

等正在运行的 R22 全量工作结束，避免并发干扰。若 Gen UI 仍失败，仅对目标用例在同一 runner、原 timeout 和隔离临时根下采集：`observe/watch` 建立时间；b 锁取得、临时写入、rename、release、b publish 返回；a 原始 event/filename、过滤、read 与 fire；测试 b.set 和 changed 分别完成时间。分别记录是否出现 watcher error；比较单例和复现负载，不增加 sleep 或 timeout。若 watcher 仍失败，按既有四单例诊断，仅追踪目标 scope 的 anchor/dev/ino、ready、原始/筛选事件、revision、pending、load 稳定期与 publish 后两 Host snapshot；对照相同运行环境两版。诊断不借额外旁观 fs.watch 推定内部事件，不重跑全套。两条链路需要分别取得证据，不能仅凭都用文件监听合并为同一根因。
