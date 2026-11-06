# Independent6fb unified build and host smoke review

DeepSeek B. Scope is exact6fb unified CLI/Web production build and darwin-arm64 smoke; the currently authorized standalone server-cli bridge is separate. Raw receipt follows.

**结论：scoped PASS**

固定候选 `6fb79b35…`（tree `7363415f…`）的 6fb 独立验证树与构建/smoke 证据匹配；未发现需要阻断本批“统一 CLI/Web 构建 + 宿主 smoke”的证据问题。该结论不覆盖完整 R22、Desktop 发行、full suite、strict 19 或独立 server-cli。

**已核实**
- 验证树 `output/zody-rename-r21/license-clean-9d135318` 当前 HEAD 为 `6fb79b35…`、tree 为 `7363415f…`，`git status --porcelain` 为空；主树未提交的 R01 server-cli/spec/test 改动不在 6fb 中，未被当作 6fb 制品。
- prerequisites：根 `pnpm typecheck` exit 0；`pnpm --dir apps/zody-cli build --force` exit 0，日志为 `23 successful / 23 total`、`0 cached`。
- consumer：`storagePreparationProtocol.test.ts` + `macosCuaHelperRound11Authority.test.ts` 实际 2 files / 7 tests 通过。
- collectors：`collector-results.json` 记录 15 项，全部 `ok:true`；包括 official、skills、provider，以及四目标的 TUI/tools/Playwright。TUI 5317 keys、official 321 keys、Playwright 466 keys，符合各 collector 输出形状。
- distribution：argv 无 `skip-build`，实际根构建后四目标全部 exit 0；四个 archive、sidecar 与 `SHA256SUMS.txt` 的 SHA-256 与 `metadata-tail-controller/archive-hashes-6fb.json` 完全一致：
  - `darwin-arm64` `1d24c86c…`
  - `darwin-x64` `446b1415…`
  - `win32-x64` `593768b6…`
  - `linux-x64` `05ae4670…`
- 四目标 official SEA manifest 均含 `browser-use/package.json` SHA `c23ae067…`，与 6fb 源文件一致；内部 manifest 内容 hash 均为 `01a35e9c…`。
- 宿主 smoke：darwin-arm64 归档实际运行 TUI native import/渲染/键盘退出，Web HTML/server-info/workspace/WebSocket/关闭均通过；归档 launcher 与 SEA `--version` 均为 `0.1.0`；provider 源/归档 SHA 均为 `bba4a742…`，`source.read` 成功，provider 2 files / 4 tests 通过。
- 清理与状态：`cleanup-check.json` 的 `remainingMatchingPids` 为空；各阶段 `status-after.log` 为空，before/final snapshot 哈希一致；smoke `gitStatusAfter` 为空。
- 边界标识：宿主 package 为 `verificationOnly=true`、`reviewObligationCount=19`，distribution 日志明确“19 material obligations unresolved”；Darwin 仅 ad-hoc 签名；非宿主目标日志明确 `skipping smoke test for foreign target`。

**证据限制**
- 构建沿用 9d 首次安装及 6c frozen reinstall，不是 6fb 全新空安装；报告已披露。
- 仅实际运行 darwin-arm64 归档；darwin-x64/win32-x64/linux-x64 是构建完成但未执行。
- `official-manifests.json` 的 `manifestHash` 是 manifest 内部内容 hash（`01a35e9c…`），不是 manifest 文件本身的 SHA；浏览器包 hash 与四个文件的实际内容核对无误。
- 无 Desktop 打包、完整测试套件、完整 R22、strict/release 通过结论；内部 `dist/zcode-<target>` 中间名仍归 R45，外部归档与 launcher 已是 zody。
- 本次只读核对既有证据与归档哈希，未重新构建或运行 smoke。
