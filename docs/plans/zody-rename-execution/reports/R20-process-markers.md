# R20 process markers：限定范围实施记录

基线为 `69b5a1dae1105012c5c3d9f9ff6e9e30eb914624`。本记录只覆盖本阶段受授权的进程标记；不代表整个 R20、产品或发行通过。生产标记改动的逐文件映射及基线等价审查见 `output/zody-rename-r20-process/controller/production-equivalence.json`。R54 持久化 `__zcode-plugin-host` 和 R41 framing 不在本批。Windows sentinel 有结构性验证，Windows 实际执行 **UNEXECUTED**。

DWF hidden command/environment、Node REPL control flag、login NUL 标记、diff 截断标记、Windows sentinel 和 embedded-search 测试标记按 spec 成对更新；旧 control flag 不作 alias。`docs/dynamic-workflow/launch.md` 的 single-executable 段按追加授权修正当前命令、工作流目录及 engine 路径。`specs/zody-rename-process-markers.md` 记录合同及范围。

原 tsconfig 隔离 emit 逐一比较 48 项，44 项未变，4 项声明及 map 因 control-only 标识符及 re-export 同步改变，依据编译输出按授权写回；详见 `implementation/staged-emit-result.json`。未使用旧自动 promote helper。

固定 Node/pnpm 与隔离 HOME/TMP/XDG 下，`green-root` 3 文件 49 tests、`diff-negative` 23 tests、`dwf-cli` 5、`dwf-runtime` 5、`bootstrap-child` 3、`control-launcher` 11、`cli-authority` 2、`embedded-native` 3 通过；`lint-scoped` 0 warnings。根 typecheck、lint 和 architecture 均 exit 0，lint 有 303 warnings；这些根检查在该文档追加前的冻结源码上运行。前置 red、运行命令、环境、退出码及全部原始日志和 SHA 索引见 `output/zody-rename-r20-process/implementation/final-evidence-index.json`；原始失败不被通过结果覆盖。

真实 darwin-arm64 SEA 候选经正常 CLI parent 使用 CreateWorkflow 派生同 binary child；独立进程身份及祖先链和隔离 SQLite 中实际 script 结果 `{ok:42}` 已记录，见 `output/zody-rename-r20-process/sea-controlled-attempt2/` 和其 probe 的原始结果。首次 capture 因缺少 tui-bundle metafile 失败；原目录已恢复，失败记录在 `sea-controlled/`，第二次的恢复核验在 `sea-controlled-attempt2/post-attempt-restoration.json`。这不是 Windows 或完整发行验收。

`control-entry-retry` 为 **9/10、1 failed**：真实 pipe 的 logical ready fd EBADF 用例未自然退出；bootstrap/read/write 逻辑 lane 及其他成功项不证明 ready lane 通过。旧基线同类配置也复现；`ignore` 不等于 fd 必定关闭。固定 Node 24.14 的独立诊断及原始日志位于 `diagnostics/ready-pipe-node2414/`：dispose 和 composite close 已完成，底层 fs read 仍使进程存活，关闭父端 fd5 peer 后才退出；早先 dispose promise 卡住的假设已被纠正。该资源生命周期修复的范围仍待用户决定，本阶段不修改产品绕过该失败。R48 和完整发行验收仍未通过。
