# R22 失败分诊：ad859 与 7c

候选为 `ad859813ec8ace8e21d418186cfe1d16939abb59`，祖先为 `7c4ff9113680a38e273032b09bee32ee6ba399af`。本分诊未修改产品源码或断言，也没有执行许可修复、发行构建或安装。完整初次全量结果仍为 34 文件失败、104 测试失败，不能将下列定向绿测相加当作全量通过。

`output/zody-rename-r22/ad859-failure-triage/failures.json` 保存初次日志的全部 110 个 FAIL 条目，按 34 文件归组；其中还包括套件加载失败，不能将 110 条等同 104 个失败断言。此前因长 socket 路径和 Python 版本问题定向复跑的 6 文件 62/62 通过。其余 28 文件使用独立短 `/tmp`、隔离 HOME/TMP/XDG、Node 24.14.0、Python 3.14.3 及根 Vitest 配置重跑：23 文件失败、5 通过，342 通过、36 失败、9 跳过，共 387 测试，exit 1。精确 argv、环境、磁盘、目标文件及输出见 `rerun.json` 与 `candidate-rerun.log`。

候选仍失败的 23 文件在 7c 中全部存在，以相同 runner、短独立临时目录、Python 和原超时复跑：20 文件失败、3 通过；159 通过、39 失败、4 跳过，exit 1。`ancestor.json` 保存 argv、环境、前后 Git 状态和 23 个测试文件双边 SHA；两检出前后 Git 状态均为空，21 个测试文件两版本字节相同，另外两个 UI 测试仅国际化 mock 名称变更。测试引用的 66 个可定位源码/测试文件在运行后均与对应固定 HEAD blob 一致，见 `referenced-source-hashes.json`。

`case-comparison.json` 对候选定向复跑的 42 个 FAIL 条目逐项记录祖先的同名条目、完整错误内容、匹配情况和报错涉及的已变更源码路径；它包括套件级失败。严格按同一文件与同一用例名匹配，38 项有祖先对应，其中 3 项未成功提取双方非空错误详情，不能判断相等；其余 35 项可比较：30 项在只归一化检出根和临时根后完整失败详情一致，2 项首条错误相同但详情不全同，3 项首条错误不同。另 4 项祖先没有同名 FAIL，不能自动判为新增回归。该清单保留原始实际详情，供逐项审查。

最小可行动归类：

- **确认改名回归：**目前没有证据足以确认。不要把祖先通过的文件自动归因改名。
- **同断言/同错误基线：**上述 30 项完整归一化失败详情相同，具体条目见 `case-comparison.json` 的 `fullDetailEqual: true`。例如模型元数据对话框缺 `max-h-[min(48rem,calc(100vh-4rem))]`、远控设置期望值缺实际 `allowMobileOpenArbitraryPath`、手机 gateway hello 的 `appProtocol.max` 期望 3 而实际 4，均在两次输出中可逐项比较；这些是两次实测相同的失败，不是已修复的 gate。
- **环境或冻结输入：**首轮 6 文件因超长 TMP Unix socket 路径和系统 Python 3.9 缺 `tomllib` 受影响，环境修正后 62/62。candidate `storagePreparationProtocol.test.ts` 未加载 `@zody/adapters/storage`：候选 `adapters/dist/storage/index.js` 缺失，祖先已有，故先补候选正常构建前置再验；未复制祖先 dist。`macosCuaHelperRound11Authority.test.ts` 在测试内直接执行 core `tsc -p`，实际复核 exit 2，报告缺 `@zody/contracts` 声明及连锁诊断；候选 `contracts/dist/index.d.ts` 缺失而祖先存在（`authority-core-tsc.log`）。先按后续 R22 构建生成正确依赖再重验。该诊断与既有 CLI 两项不同：既有项是 `runtime-command-queue.test.ts` 的函数断言和 `runtime-module-boundary.test.ts` 的 407 行边界断言，不是本次 TS2307，不能视为逐条相同或同因。CUA narrow 四项所需冻结输入的还原核对见 `native-input-plan.md`：归档和 stage pin 有已审计 SHA，但旧 identity-pins 目标路径原文件及其独立字节 SHA 尚未找到；未复制或伪造。
- **尚未归因：**候选 `stateStorage.test.ts` 的 broadcast 在批量运行中 30 秒超时，7c 同用例 23.76 秒通过；两个文件源码本身无差异。按授权在候选独立短 TMP、原超时、无并行测试下只复跑一次，3/3 通过，broadcast 2.38 秒（`state-single.log`）；这是定向结果，不抵消原全量失败。`subagentRuntimeConfigWatcher` 有 1 个候选 FAIL 在祖先未出现、3 个同名 FAIL 的错误详情未能完整提取，另有同名用例双方具体错误不同；不要把 watcher 时序和状态问题归因改名。相同首条错误但全文不等以及其余无法对齐条目亦保留未决；逐条内容、源码差异清单以 `case-comparison.json` 为准。

Knip 只分析已保存的 ad859 原始报告，没有复跑大检查。输出中的 `@zcode/` 行属于 unlisted dependencies；报告宽度截断了许多路径，不能把它作为全量残留清单。例如 `@zcode/contracts` 对应的 `packages/desktop/native/macos-cua-driver-closure/reports/2026-10-30-desktop-session/frozen-candidate/source/apps/zcode-cli/packages/adapters/src/mcp/cua-native-authority-capture.ts:5` 经源码核对是冻结历史快照，不应机械改名。其余截断条目的完整归属未经证明，不宣称已排除活跃残留或解决 knip gate。

结束磁盘可用约 11 GiB；证据目录在主工作树 `output/zody-rename-r22/ad859-failure-triage/`。R22 和待裁决的许可设计仍未完成。
