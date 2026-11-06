# R20.4 第二组主控验证

基线 `6720cfe22b8e16e6abcc4abbeee0d084f17594cb`。主控审查 19 个 runtime/env 声明与 4 个仓内 DI 属性的变更，并核对 Host 仍读取原有 `msg.agentSpawnFallbackCwd`。本组没有切换 env/define、wire、遥测或持久化值。46 个产品路径均在授权范围，151 个人工路径没有变动。

主控验证实际源码与隔离 emit 的 `armsRumShared.ts`、`.js`、`.js.map` 字节及 SHA 一致；生成 JS 仅有 mapper 函数引用改名，map 仍指向邻接源文件。Terra 的 shared 重建、隔离 emit 重试及 core→adapters→bootstrap→CLI 实际构建记录见 R20-symbols-next.md，未将第一次失败或旧 dist 当作通过。

使用固定 Node 24.14.0，主控实际重跑以下命令：

| cwd | 命令 | 结果 |
| --- | --- | --- |
| 仓库根 | `pnpm typecheck` | exit 0 |
| 仓库根 | `pnpm lint` | exit 0，303 warnings |
| 仓库根 | `pnpm exec vitest run packages/shared/test/env.test.ts packages/shared/test/runtimeEnv.test.ts packages/desktop/test/desktopRuntimeEnv.test.ts packages/desktop/test/appARMSBootstrap.test.ts packages/desktop/test/desktopStabilityTelemetry.test.ts packages/desktop/test/armsRumShared.test.ts packages/services/test/localServicesRemoteAuthority.test.ts packages/server/test/stdioDesktopPresentationSurface.test.ts packages/desktop/test/cuaNarrowAgentRuntime.test.ts` | 9 文件，143/143 |
| `apps/zody-cli/packages/bootstrap` | `pnpm exec vitest run tests/mcp-project-config.test.ts tests/telemetry-bootstrap.test.ts` | 19/19 |
| `apps/zody-cli/packages/cli` | `node --disable-warning=DEP0205 --import tsx --test tests/cli.unit.test.ts tests/zcode-cua-plugin-host-authority.node-test.ts` | 176/176 |
| `apps/zody-cli/packages/core` | `pnpm exec vitest run tests/mcp-tool-bridge.test.ts` | 38/38 |

合计 376 项目标测试通过。完整主控输出为 `output/zody-rename-validation/controller-symbols-02-*.log`。

主控读取本组 Desktop main 的完整诊断，与独立旧基线对比：同为 85 条；仅将带引号的 literal union 成员排序后逐条相同，原始差异确为三条 union 顺序变化。该配置实际仍退出 1，不能记为通过；两项全量架构基线问题也仍存在。CLI 单包 tsc 不代表所有 CLI 子包。

本报告仅接受已检查的候选内容与上述验证范围。独立 DeepSeek 审查、剩余内部符号/文件名、R20.5 人工项以及 R21/R22 和后续阶段仍未完成。
