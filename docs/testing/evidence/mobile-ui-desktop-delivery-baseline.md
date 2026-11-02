# 移动端 UI 随桌面交付：实施前基线

日期：2026-11-03

分支：`feat/mobile-ui-desktop-delivery`

设计基线：`c77a85f2`；M1 兼容裁决补充：`fbf18a28`。

本记录只描述实现开始前主线程实际执行的检查，不代表后续功能已经通过验收。

## 环境与边界

- 主线程默认 Node 为 22.23.2，仓库 `mise.toml` 要求 Node 24.14.0；主线程 `mise` 命令不可用，后续主线程命令会保留 engine warning。
- M1-T1 agent 报告已在隔离 worktree 用 Node 24.14.0 重装依赖；最终以该 agent 的实际命令输出为准。
- 工作区原有 `.gitignore`、上游审查台账、重命名调查与若干上游计划改动，均未纳入本任务提交。
- 基线构建产生的临时文件已自行清理，未留下本任务源码改动。

## 已通过

| 检查 | 真实结果 |
| --- | --- |
| `pnpm architecture:check --changed` | OK；violations 0、baseline 0、new 0 |
| `pnpm typecheck` | exit 0；有 Node engine warning |
| `pnpm lint` | exit 0；有 Node engine warning |
| `pnpm check:mobile-web-isolation` | 普通 Web 命中 0 处 gateway-client；Remote 产物入口存在；OK |
| `pnpm build:mobile-web` | Vite 构建成功，7862 modules transformed；输出较长已归档于工具结果 |
| `pnpm --filter @zcode/desktop build:no-runtime-assets` | exit 0；临时 tsup 配置已清理 |
| `packages/android/gradlew -p packages/android testDebugUnitTest` | exit 0 |
| `pnpm exec vitest run packages/desktop/test/remoteGatewayBackend.test.ts packages/desktop/test/run-production-build.test.ts` | 2 files / 27 tests passed |
| `pnpm exec vitest run packages/desktop/test/webRemoteControl*.test.ts packages/desktop/test/gatewayDeviceTransport*.test.ts --reporter=dot` | exit 0 |

## 既有失败，不作为本次回归

### `pnpm fmt:check`

exit 2。失败位于既有 `docs/electron/docs/fiddles/**` HTML，包含未闭合/多余标签；不是本任务文档或代码造成。后续只在相关改动范围执行格式检查，不能把全量 fmt 写成通过。

### `pnpm knip`

exit 1，输出大量既有未使用导出与配置提示。后续只对本任务新增导出和依赖做增量审查，不宣称全量 knip 通过。

### shared 全量

命令：`pnpm exec vitest run packages/shared/test --reporter=dot`

结果：130 passed files / 2 failed files；1475 passed tests / 9 failed tests。

- `packages/shared/test/appSettings.test.ts`：6 个失败。
- `packages/shared/test/remoteAccess.test.ts`：3 个失败。
- 共同原因是现有实现已返回/要求 `allowMobileOpenArbitraryPath`，旧断言未包含该字段；先于本任务存在。

### Web 全量

命令：`pnpm exec vitest run packages/web/test --reporter=dot`

结果：32 passed files / 2 failed files；164 passed tests / 8 failed tests。

- `externalRelayFrameGapRecovery.test.ts`：6 个既有失败。
- `mobileRemoteGatewayTerminalTransport.test.ts`：1 个既有失败，hello 断言仍期望 appProtocol.max=3，当前实现为 4。
- 另一个失败同属上述 2 个失败文件中的既有恢复断言。
- 输出另有 jsdom 未实现 canvas getContext 的诊断，不作为本任务功能证据。

## 后续验收规则

- 每个阶段单独报告新增/修改测试，不能用上述既有失败掩盖新失败。
- 阶段门禁要求的全局命令再次执行时，需要与这份基线比较。
- 未执行的 Windows/Linux 打包、Release 签名、真实 HTTPS 和特定 Android/OEM 场景必须明确标记未验证。
