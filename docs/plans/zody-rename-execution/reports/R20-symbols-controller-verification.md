# R20.4 首组主控验证

基线：`854ddf60ac1be92428e3c32192ee325aab6acd25`。仅验证首组内部符号与两个 basename，不能据此接受完整 R20.4/P2。

主控核对 42 个产品旧/新路径与 Terra 的 `candidate-file-list.json` 完全一致，均在受约束的 scope 内；151 个手工复核路径未被修改。抽查公共 exports、class 引用、模块 mock 导出键、测试 runner 路径、运行时函数调用者及环境变量保留边界。声明源码、成功隔离 emit 的 `.d.ts`/map 与入库字节分别完全一致，map 指向邻接 `armsRumShared.ts`。

固定 Node 24.14.0，主控实际执行：

| cwd | 命令 | 结果 |
| --- | --- | --- |
| 仓库根 | `pnpm typecheck` | exit 0 |
| 仓库根 | `pnpm lint` | exit 0，303 warnings |
| 仓库根 | `pnpm exec vitest run packages/services/test/zodyAgentProcessManager.test.ts packages/shared/test/runtimeEnv.test.ts packages/desktop/test/desktopRuntimeEnv.test.ts packages/desktop/test/armsRumShared.test.ts` | 4 文件，113/113 |
| 仓库根 | `pnpm exec vitest run --config output/zody-rename-r20-symbols/vitest-source.config.mjs` | 显式执行源码旁 Gen UI 测试，1/1 |
| `apps/zody-cli/packages/bootstrap` | `pnpm exec vitest run tests/mcp-project-config.test.ts tests/telemetry-bootstrap.test.ts` | 2 文件，19/19 |
| `apps/zody-cli/packages/cli` | `node --disable-warning=DEP0205 --import tsx --test tests/cli.unit.test.ts tests/zcode-cua-plugin-host-authority.node-test.ts` | 176/176 |
| 仓库根 | `pnpm exec tsc -b packages/desktop/tsconfig.main.json` | exit 1，85 条诊断 |

完整主控日志位于 `output/zody-rename-validation/controller-symbols-01-*.log`。合计 309 项目标测试通过。CLI 和 Bootstrap 的首次补验曾失败，原因是旧 adapters dist 仍引用改名前的函数；Terra 将旧 dist 移到隔离输出目录，真实执行 `pnpm --dir apps/zody-cli/packages/adapters build` 后重新通过，主控随后复跑上表两组通过。构建依赖依据、顺序与旧失败日志保存在 `output/zody-rename-r20-symbols/rebuild-verification-summary.log` 及其引用日志。没有以恢复旧 export 的方式绕过失败。

主控将最终 main 日志与独立 854ddf60 检出的原始日志规范化比较：85 条错误逐条相同，无新增或消失。这不表示 main 通过；根类型检查不覆盖该项目。另有两项已记录的全量架构基线失败。Terra 的 CLI tsc 仅覆盖 CLI 包，不能代表所有 CLI 子包。

剩余 1602 条词法声明候选、196 个 basename 仍需语义核实；内部注入属性、动态引用、现行文档和手工模板/fixture 分类未因此完成。下一步是固定本候选供 DeepSeek 独立审查，再继续剩余组；R21/R22、运行时协议、插件兼容和最终 CUA/跨平台验收继续保留。
