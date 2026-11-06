# R20 transport 取消/自然退出复审（review2）：主控验收

登记日期：2026-11-05。结论：**accepted=true；复审结论 PASS；最后定向测试 exit 0**。本文只覆盖 R20 的 control-only transport 取消/自然退出修复，不构成发布验收。

## 已实现

- `createControlDuplex` 切换为 `net.Socket({fd, allowHalfOpen})` ×2 + `Duplex.from`（`apps/zody-cli/packages/node-repl-host/src/control-only-protocol.ts:326-364`）；构造失败对称 destroy 并抛 `control_fd_unavailable`。
- fixture 移除全部 `process.exit`，仅设 `exitCode`；新增 `READY_WRITE_DIAGNOSTIC` / `CONTROL_FD_REUSE_FILE` / `HALF_CLOSE_REPORT` 三种模式。
- 测试新增 5 用例并强化 missing-fd 断言；spec 新增生命周期合同。
- 共享 `packages/zody-cua`（control-channel / producer-control）git status 为空，确认未改。

## 定向测试通过

- 主控复跑：`output/zody-rename-w5-controller/logs/r20-targeted-r1.log`，3 文件 30 passed（entry 15 + launcher 11 + boundary 4，start 11:26:49）。按嘱本轮未重复运行测试套件。
- 实施/复审日志核对：
  - `output/zody-rename-r20-ready-cancel-fix/logs/green-control-only-entry-review2.log`（10:36:51，晚于全部源文件最后修改 10:36:41）15 passed。
  - `output/zody-rename-r20-ready-cancel-fix/logs/green-adapters-control-only-review2.log`（10:35:10，晚于 protocol 10:33:41 与 fixture 10:34:36 的修改；其后仅 entry 测试文件改动，不影响 adapters）15 passed。
  - `red-fd4-preexisting.log` / `red-new-tests.log` 与 `raw-fs-*`、`raw-socket-*` 相互印证根因。

## 独立验收通过（逐项核对，均有代码/日志证据）

1. **fd4 EBADF 自然退出**：fixture 无 `process.exit`（grep 仅 5 处 `exitCode` 赋值）；父端 stdio[5] 未 end（test:188-221 仅 end stdio[3]）；断言覆盖 `killed===false`（:214）、10s 限时自然退出（:201）、`closedCode="disposed"` / `closedCount=1` / `transportClosed=true`（:207-209）。
2. **EPIPE 归因**：受控诊断有真实屏障——fixture 先 fstat 成功才打印 precheck，父端见行后才关 fd4 读端并放行，`cause:"EPIPE"` 只能来自真实写入（test:260-312 + fixture:25-55，旁证 `diag-ready-write-epipe.json`）；entry 级用例已降级为清理验证（test:240 注释）。
3. **fd 复用**：filler 占 3/4 后字面断言 `reused===[5,6]`（fixture:79-90/test:355-360）；二次 dispose 后写复用 fd `writeError:null`、三次 dispose `closedCount:1`；两个半关闭方向均有可观察断言（A: exit 0 + closedCount 1 + stdio[6] end；B: 300ms 存活 + exitCode null + 后续单次结算），未预设剩余方向可写性。
4. **transport**：握手顺序不变（`control-only.ts:42-64` 不在 diff，transport→channel→writeReady）；单 owner 无按数字关 fd5/6；fd3 仅完整读取后单次关闭（protocol:269-278）；dispose 幂等由 `closeInternal` 锁存保证（`control-channel.js:135-181`）；duplex error 已挂接（:328），故 destroy 期 AbortError 不会击穿产品路径（实验 `child-socket-duplex-diag` 的未处理崩溃系实验脚本缺 listener）；fd3 误关防护由既有用例断言 `reusedFd===3`（test:646-721）。
5. **Windows**：`output/zody-rename-r20-ready-cancel-fix/report.md:79-81` 如实保留阻断、未宣称兼容/回归、无 fallback；`specs/zody-rename-process-markers.md:46` 同步固化；allowlist 声明属实（`control-only-contract.ts:32` SystemRoot、`:36` APPDATA、`:37` LOCALAPPDATA、`:43` USERPROFILE）；contract/launcher 相关源 grep 无 `process.platform`/`win32` 门禁；新 transport 代码无平台分支；Linux 如实标注未执行（report.md:82）。

本轮自行执行的只读检查：

- `git diff`/`git status`：候选 4 文件 + `packages/zody-cua` 为空。
- `grep process.exit`：fixture/src 无调用。
- `oxfmt --check` 4 文件 exit 0（"All matched files use the correct format"；其输出 "on 1 files" 为该工具对多文件的固有显示，与报告 4 文件命令无矛盾）。
- `oxlint` 4 文件 exit 0（0 warnings / 0 errors）。

## 尚未验证

- 包级 tsc：日志为空文件与成功一致，报告称 exit 0，本轮未独立复跑。
- 根 `pnpm typecheck` / `pnpm lint` / `architecture:check`：审查时点报告声明由主控串行执行；收口时已补跑并通过，见下。
- Windows 真实 runner 证据。

## 收口根检查（主控执行）

- `pnpm typecheck` exit 0：`output/zody-rename-w5-controller/logs/root-typecheck.log`。
- `pnpm lint` exit 0，303 warnings / 0 errors：`output/zody-rename-w5-controller/logs/root-lint.log`。
- `pnpm architecture:check --changed` exit 0，violations 0 / baseline 0 / new 0：`output/zody-rename-w5-controller/logs/root-architecture.log`。
- 归因：全部通过，无需分诊。

## 阻止发布

Windows 验收保留阻断：产品合同包含 Windows 而无 runner 证据。维持报告与 spec 的既有阻断登记，不因本轮通过解除。

## 边界

runtime19 仅证明本地子集；Windows 验证保留阻断；Linux 未执行；旧全量测试未全绿；R48 及之后未开始。
