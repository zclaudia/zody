# R21 容器入口修正：DeepSeek 复审

**结论：PASS（仅 scoped Docker build 入口）**
在“保留 hoisted 布局 + 安装原生构建工具”的既定选项下，此前 `7c4ff911` 的 Docker prerequisite finding 已闭合。完整 R21/R22、compact/browser E2E 仍不能判通过。

**已核查**
- `cc19c32b` 的父提交是 `2d9e7d39`；本批正好 8 文件：2 Dockerfile + 6 元数据/报告，无其他产品源码。
- 最终 Dockerfile 与私有 `cc648373` 逐字节一致：
  - compact `362ea5772994b5bb694d85adb8b5474c81cb05a27b46221722350f2576760f38`
  - browser `f887e406c94b850112ec771879b4bff7b3d34157a3da873a94aa410c163433f4`
- compact `0ed4aa34` 真实 build 退出 0：Node `v24.14.0`、pnpm `10.33.2`、frozen install、23/23 tasks、0 cached；browser `1a705507` 完整 build 退出 0。日志见 `output/zody-rename-r21/docker-correction/build-0ed4-compact.log`、`build-1a705507-browser.log`。
- `apps/zody-cli/e2e/compact-microcompact/Dockerfile:2` 固定 Node 24.14.0，`:23` 安装 python3/make/g++/cmake，`:48` 使用 `--import tsx`；`headless-linux.Dockerfile:4` 增加 python3/make/g++，`:9` 在 `USER node` 前修正 `/workspace` owner。这些修正与真实失败原因一致。
- compact 最终只比 `0ed4` 多 ENTRYPOINT；派生镜像构建 0 且 `derived-entrypoint.json` 为 `["node","--import","tsx",...]`。因此 scoped build/entry 证据成立，但确实不是从 `cc19` 完整源码树重新 build 的镜像。
- hoisted 安装继续执行 Electron 等第三方 lifecycle；按你的明确边界，我不再要求 isolated linker、ignore-scripts 或排除该 lifecycle。browser 的首次失败原因已由 `chown` 修正，不是当前 Dockerfile 的 blocker。

**剩余失败对本范围的影响**
- compact fake 为 5 pass / 2 fail，失败不影响 Docker build/loader 结论，但阻止“完整 compact E2E 通过”：
  - `usage-anchor` 不是产品缺失 `app.submitPrompt`。`case-utils.mjs:116` 的 `createApp` 是 async，`create-app.ts:170` 也是 async；但 `case-usage-anchor.mjs:126/156/203` 写成了 `app = createApp(...)` 而没有 `await`，`app` 实际是 Promise。产品 app 仍在 `create-app.ts:1502` 通过 `...inputFacade` 暴露 `submitPrompt`。这是 E2E harness 的一行级 bug，修复为 `app = await createApp(...)`。
  - `background-bash` 在 `case-background-bash.mjs:245-264` 期望裸 `<task-notification>`，实际消息带 `incoming-message.ts:10` 的安全前缀；应在断言中接受该前缀或抽取通知块。该 case 和前缀源在 836 也是静态相同，但我没有实际运行 836，不能声称已证明旧基线失败。
- browser 首次运行 31.56s 超过 30s timeout；diagnostic 1/1 通过（23.5s），原样重试 1/1 通过（3.26s），根因未定位。它是真实 flake，不能据此声称 browser E2E 稳定；但不是 Docker build/entry 的 blocker。
- `--import tsx` 是 E2E loader 的合理修正，但不证明 built package 在 plain Node 下解析通过；完整 R21/R22 的 packaged/SEA/plain-Node gate 仍需保留。

**证据边界**
- 本次仅固定 SHA 静态审查 + 读取日志，未 install/build/rerun Docker，也未改源码。
- `output/.../files.json` 和 `static-check.json` 记录的是 `0ed4/2d9` 中间快照（compact `4272…`、browser `34d8…`）；最终 `cc19` 的 `362e…`/`f887…` 以 `R21-docker-correction-verification.md` 和私有候选 patch 为准。若把 `files.json` 当最终 manifest，需要更新。
- 完整 R21/R22、完整 compact/browser E2E、browser 稳定性、plain-Node 打包验证均未通过或未证明。
