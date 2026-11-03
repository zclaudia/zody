# Watcher 单例和临时诊断

## 对象和约束

固定目标源码为 `5bdc63fe2f5298c1f9a6b68ba93eb8dd3f63251e`。八个正式单例执行时主树 HEAD 为 `71e21e4f7f941c6a3abf6e15ce0310d5610d1b52`；两个只读诊断执行时 HEAD 为 `1262e00c42bd8b4cc8f2e87aeeeb71438fa77b8b`。`git diff --name-status 5bdc63fe 1262e00c` 只有 docs/ledger、许可 inventory 与报告，无代码变动。祖先始终为独立干净工作树 `7c4ff9113680a38e273032b09bee32ee6ba399af`，使用其既有依赖和 dist，没有复制或安装。两侧 Vitest 4.1.4、chokidar 4.0.3，根锁 SHA-256 同为 `12e11b834269bada1625ea6b086eabab1234881e2038adb2a3cac21eb345a63f`；这不证明所有已装依赖完全相同。

`results-selected.json` 记录每次实际 cwd、HEAD、绝对 pnpm argv、起止时间、各自短 `/tmp/zr22solo.*` HOME/USERPROFILE/TMPDIR/XDG、退出码及执行前后工作树状态。PATH 前置固定 Node 24.14.0 和 Homebrew；两侧 pnpm 10.33.2。脚本串行执行每个唯一 case（原 test 的 15s 或原有默认超时不变）：

`pnpm exec vitest run --config vitest.config.ts packages/services/test/subagentRuntimeConfigWatcher.test.ts -t '<唯一完整 case 文本>' --no-color`

首轮 `run.mjs` 用错误的套件分隔正则，所有8次显示 28 skipped、0 tests；exit 0 **不计通过**，原文件和 `results.json` 保留。有效 `run-selected.mjs` 的每次日志均明确 1 failed、27 skipped。没有运行其他测试或修改 tracked 源码。

## 结果

| 单例 | 当前源码 | 7c | 实际断言 |
| --- | --- | --- | --- |
| rename | fail | fail | 初次 `both` 要求 researcher，实际 ready/profiles=[] |
| disable | fail | fail | 初次 `both` 要求 researcher，实际 ready/profiles=[] |
| enable | fail | fail | 初次 `both` 要求 researcher，实际 ready/profiles=[] |
| empty-root recovery | fail | fail | 预期 built-in-fallback，实际 ready/profiles=[] |

每对同名单例 `AssertionError`、diff 和测试栈原始正文逐字一致；逐个文件保留于 `*-selected.log`，`summary.json` 列状态。rename/disable/enable 在创建 researcher 之后、进入对应修改操作前已失败，因此本轮无法推断 rename/disable/enable 自身的后续广播行为。empty-root 此次两侧在 fallback 阶段相同失败；先前 ancestor 通过、ad859 失败及 5bd 四场景合跑通过的不同阶段仍是实际波动，不能把单轮结果当完整 race 根因。相关 scope/runtime/test 两版字节完全相同；storage、service 和 interface 只做两组确定的内部符号映射后也逐字相同，详见 `key-source-comparison.json`。这是六文件有限比较，不能外推全部依赖链或证明因果。

## 临时旁观诊断（不是 gate）

`diagnostic.mjs` 是独立输出目录脚本，不更改产品；它在临时 HOME 创建两个 Host、顺序等待 prepare，照原测试停 500ms，调用真实 createAgent，直接读取所写文件，然后每秒读两个 Host snapshot，共10次。`run-diagnostic.mjs` 使用各树当前 source / 各自 tsx loader 和独立临时 HOME；真实 argv、时间、HEAD 和 exit 在 `diagnostic-results.json`。两侧均 exit 0 仅表示诊断采样完成，不表示业务测试通过。

- 当前：9ms prepare 返回两个 ready 空 snapshot；514ms createAgent 返回，目标 56 字节文件已存在、完整可读；8525ms 两侧仍为空；日志约 8810ms 时记录 agents 根重扫，9527ms 样本两侧都有 researcher。
- 7c：8ms prepare 返回 ready 空 snapshot；513ms createAgent 返回，56 字节文件完整可读；到最后 10530ms 两侧均为空。两侧只采样到该时刻，不推断其后永远不会收敛。

源码可明确的顺序：createAgent 经 mutate 串行队列，等待 `writeFile(..., flag: "wx")` 后 resolve，因此其返回保证该写入调用结束，并不等待 watcher/snapshot 发布；prepare 等待各 scope 初始化，但内部有 5 秒 race，超时后允许后台继续，因此 Promise resolve 不能无条件证明 watcher 都 ready。scope 的 ready 经 `checkWatch` 等 chokidar ready 与首次 drain 后完成；发布由 onSettled/`publish` 组装多 scope snapshot，公开 snapshot 没有可据此读取的 revision。当前诊断两侧 prepare 都在约 10ms 返回且输出 ready，但诊断未插桩内部 ready/revision，不能由此声称每个 scope 均就绪。现象定位为文件成功写入与 profile 可见性之间出现超过 8 秒的延迟；测试 waitFor 是原有8秒，不建议据此加大 timeout。

`diagnostic-native.mjs` 另加独立 `fs.watch(homeDir)` 旁观者，只作为观察，可能影响调度，详细结果在 `diagnostic-native-results.json` 和 `*-diagnostic-native.log`：当前一次约517ms 文件写入，10.5s内旁观者无回调且 profile 仍空；祖先一次约514ms 写入，约2135ms 旁观者报告 change，4519ms 样本两 Host 可见。旁观者不等于服务内部监听，且回调和路径不足以断言 OS 未发事件、特定重绑缺陷或共同根因；不能把诊断改写成正式 gate。

## 后续边界

八个单例的同条件、同断言失败加上关键源码有限等价，为这些具体现象提供未因本次改名引入的合理基线证据；不证明 watcher 其他路径无回归，也不关闭 empty-root 在不同运行阶段的波动。原 R22 全量失败依旧有效。Gen UI 原并发 30s timeout、候选独立 3/3 pass 的差异仍未归因；若要进一步处理，只在最终固定源码相同环境记录原并发负载的单 case 调度、广播发送/订阅及收到时序，再与独立运行对比；不扩大 timeout、不反复跑全套。两个旧缺 dist 问题仅 edb 依赖构建后 7/7 通过，最终候选仍须复验；native 缺冻结输入和 UI 正则触发条件沿用上级 `../report.md` 的范围和限制。

Controller integration note: after this diagnostic snapshot, fixed71e validation tree rebuilt current CLI23 tasks and reran the two missing-dist files7/7; final R22 build report records that later evidence. It does not change any watcher/GenUI conclusions above.
