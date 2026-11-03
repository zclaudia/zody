# R22 剩余失败：5bdc 有界分诊

固定源码 `5bdc63fe2f5298c1f9a6b68ba93eb8dd3f63251e`，工作树测试前后干净。原 34 文件、104 测试失败和其证据仍有效，不能因以下定向通过称全量通过。本次未改源码/测试/spec/ledger，未构建、安装或操作 R10 验证树。

## 原四项没有祖先同名 FAIL

1. `storagePreparationProtocol.test.ts` suite 的缺失 `@zody/adapters/storage` 与 `macosCuaHelperRound11Authority.test.ts` 的缺失 contracts 声明：后续固定 edb 的当前源码构建产生实际 dist 后，两文件 7/7 通过，证据见 `docs/plans/zody-rename-execution/reports/R22-cli-prerequisites-edb.md`。edb→5bd 相关 test、adapters storage 和 contracts src 无 diff；这是 edb 的前置验证，最终固定候选仍需自己构建并复测，不能称 5bd clean gate 已完成。
2. Gen UI `broadcasts external writes without echo loops`：原候选批量 30s timeout，7c 同用例 23.76s pass，候选单文件短 tmp 3/3、目标 2.38s pass（旧 `state-single.log`）。只能说明那次单独运行可通过；原并发失败未归因，也不能由它推论任一版本无 race。
3. watcher `observes an empty root moved away, an invalid file replacement, and directory recovery`：7c 旧日志明确该用例 pass 8509ms，ad859 批量失败 `built-in-fallback` vs `ready/restored`；本次 5bd 定向 pass。一次祖先成功/候选失败/新候选成功不能证明改名引起或消除了回归。

## watcher 分组误解析与实际差异

原 `case-comparison.json` 把 Vitest 连续多个 FAIL header 后共享的一个断言块误认成部分详情未提取。本次直接按分组读取 `candidate-rerun-plain.log` 与 `ancestor-rerun-plain.log`，`grouped-comparison.json` 保存精确结果：delete、disable、plugin 三条共享块的错误正文逐字相同（ready 但 researcher 缺失，test line 48）；shared recovery 单条同断言也相同。该输出证明同一断言表现，并不能证明三个 case 各自独立输出了整块、同一根因或现已修复。

其余不等不能静默归类：recreation 的候选预期 prompt old、祖先预期 new；rename 候选 timeout、祖先共享块为初始 researcher 缺失；enable 候选是预期空而实际仍有 researcher、祖先是初始 researcher 缺失；user-scan 候选 20s timeout、祖先是 recreated profile 缺失。目标测试本身 7c→ad 字节相同；`subagentConfigScope.ts` 和 `subagentRuntimeConfig.ts` 在 7c→5bd 无 diff，`subagentStorage.ts` / `subagentsService.ts` 等有内部符号迁移，不能仅凭文件相同证明完整依赖链和时序相同。现行 scope 以 chokidar 和原生目录 watch 接收事件，按 300ms debounce 和 1s 文件稳定期加载，runtime cache 汇总 scopes；日志出现目录更新但不足以证明某个文件事件、解析、scope 发布还是双 Host 可见性是失败源。

本次实际命令从 main 根目录执行，Node 24.14.0、pnpm 10.33.2、短隔离 `/tmp/zr22c.*` 的 HOME/USERPROFILE/TMPDIR/XDG，原测试超时不变：

`pnpm exec vitest run --config vitest.config.ts packages/services/test/subagentRuntimeConfigWatcher.test.ts -t 'both independent Hosts consume (rename|disable|enable) without broadcasts|observes an empty root moved away' --no-color`

exit 1：4 目标中 empty-root pass，rename/enable 共享块预期 researcher 实际空，disable 15s timeout；其余 24 skipped。`watcher-target.log` 保存原始完整输出，不能把一个分组断言强行当作三个不同的失效步骤。下一步仅对该文件的 rename、disable、enable、empty-root 单例分别记录事件到 snapshot 的时间与 profile/state 可见性，对照 7c 和最终候选、同样 runner/隔离 HOME/版本；按原超时运行，诊断时记录 watcher ready、文件实际存在/hash、收/漏事件、scope revision/publish，不能以加 sleep/改 timeout 代替诊断。此前的 `user scans` timeout 如仍复现，再仅跑其 user 参数单例和祖先同项。

## 其余不同详情

`stopDesktopStopVisualBuild.test.ts` 两侧均在相同源相对路径 `output/cua-driver-round9/candidate-work/controller-final/full-source/crates/cua-macos-visual/native/CuaVisualCapture.swift` 的 copyFile 因 ENOENT 失败；临时目录和 checkout 路径不同使原始错误不等。两侧同缺冻结输入这一已观测条件，未验证 native 行为或补齐来源；按 R60 处理，不能创造/复制未经核实的 pin。

`hookCreateButtonSize.test.ts` 的错误包含整个被读取的组件源码，所以 Intl 内部符号迁移导致全文不等；测试和被断言的 `onNew` JSX 片段在 7c、ad859、5bd 的片段 SHA-256 都是 `f7af714675737945d62b544261d0f939534531f2bd2eda96c1735f7148fb0ee8`。测试正则要求 `className="rounded-lg"`，现有片段为 `className={cn("rounded-lg", SETTINGS_TOUCH_MIN_H_11_CLASS)}`，两次实测同一断言不符；这只确认该测试断言的具体基线，不对按钮交互/视觉语义作结论。

后续最小验证：保持已通过 edb 前置作为历史证据，最终新候选在自己干净树重建对应 CLI 依赖后重跑两个缺 dist 测试；watcher 的 4 个单例及必要同版本祖先对照采用上面的独立诊断；Gen UI 的并发 failure 需在固定最终候选原压力/原超时重现并记录具体调度证据；native 缺输入按现有来源审计后再测；UI 正则按产品合同单独裁决，不扩大至其他 30 项既有失败。无一项构成完整 R22 通过。
