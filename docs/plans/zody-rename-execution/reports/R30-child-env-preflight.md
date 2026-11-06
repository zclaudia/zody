# R30 child 环境变量闭包预检

固定对象 `ad859813ec8ace8e21d418186cfe1d16939abb59`；只读检索，未运行测试、构建或安装。逐行机器清单见 `output/zody-rename-r30/child-env-closure.json`：82 处精确字面量（42/25/6/9），逐条列文件、行、符号、角色与 owner。该清单是路径发现而非授权写集；具体实施须等 R22 gate 与主控分配。

| 旧键 → 新键 | 生产、消费及合同 | 测试和文档 owner |
|---|---|---|
| `ZCODE_AGENT_SERVER_COMMAND` → `ZODY_AGENT_SERVER_COMMAND` | `packages/zody-server-cli/src/runtime/agentWiring.ts:5,14,16,29,35,45` 判断用户覆盖并产生 bundled command；`packages/zody-server-cli/src/cli.ts:261-267` 注入 fork 环境；`scripts/zody-distribution/runner.mjs:199` 在继承环境之后写入 bundled command。`packages/services/src/zody-agent/zodyAgentProcessManager.ts:633` 消费，trusted native runtime 优先；1338、1799 的诊断文字也引用它。R30 hard cut，调用链同批；1799 的 reason 可能被上层展示，需追踪调用者，不能擅称其只是内部注释或 R40 wire 变更。 | 同目录 `agentWiring.test.ts`、`runtimeUpdateIntegration.test.ts:134` 所执行的 `test/fixtures/coreWiringFixture.mjs:9`；services 测试、server stdio 测试、distribution runner 测试及 `packages/desktop/wdio.conf.ts:952,986,3015`。当前设计说明 `apps/zody-cli/docs/design/v2/zcode-protocol-agent-server.md:106`、`docs/architecture/r2-server-cli-and-daemon.md:336` 先由文档 owner 确认现行状态。 |
| `ZCODE_AGENT_SERVER_ARGS_JSON` → `ZODY_AGENT_SERVER_ARGS_JSON` | `agentWiring.ts:6,17,46` 与 `scripts/zody-distribution/runner.mjs:198` 生产；`zodyAgentProcessManager.ts:398,638` 在显式 command 分支解析 JSON 字符串数组，不合法报错；缺省为现有参数。R30 与 command 同批。 | `coreWiringFixture.mjs:8` 是实际执行的 fixture；同上 agentWiring、services、server stdio、distribution 测试和 WDIO 配置。不能因 fixture 路径自动排除。 |
| `ZCODE_AGENT_SERVER_CWD` → `ZODY_AGENT_SERVER_CWD` | `zodyAgentProcessManager.ts:639` 在显式 command 分支消费，空值回 workspace 路径。精确扫描未找到仓内对应赋值生产者；可能由外部环境提供，不能凭此推定不存在外部调用。R30 与 command 同批。 | `packages/services/test/zodyAgentProcessManager.test.ts:422,451,476,568,627`；需覆盖孤立 CWD 不构成 command 覆盖。 |
| `ZCODE_CUA_PLUGIN_ROOT` → `ZODY_CUA_PLUGIN_ROOT` | `apps/zody-cli/packages/bootstrap/src/app/built-in-node-repl.ts:39` 注入；`apps/zody-cli/packages/node-repl-host/src/node-repl-session-executor.ts:22` 模块初始化时消费，`subprocess-executor.ts:101` 使用得到的 documentation root。`docs/plans/zody-rename-execution/contract-map.md:53` 明确这是 R30 内部 root 的 hard cut 例外。 | `bootstrap/tests/plugin-runtime-features.test.ts:88,132`；`node-repl-host/test/mcp-server.test.ts:323` 仅是注释引用，不能当作四组合行为覆盖。现行插件指令 `packages/zody-cua-plugin/skills/computer-use/SKILL.md:28` 与 `packages/zody-cua-plugin/docs/computer-use.md:31` 同批检查。 |

以上路径在 `apps/zody-cli/` 下的简写均以相应包根为准；JSON 给出完整路径。`packages/zody-server-cli/src/main.ts:8` 先调用 `resolveBundledAgentWiring`，`cli.ts:261-267` 再注入 child；distribution runner 则有意在继承环境之后覆盖两个值，不能把其生产者优先级误写成一般环境覆盖优先级。`ARGS_JSON` 或 `CWD` 单独存在并不激活显式命令。现有 native runtime 优先级、安全边界和参数内容须保留。

## 边界和待确认

- `ZCODE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` 是现有 CUA host fallback；通用 `ZCODE_PLUGIN_*` 双注入归 R55，第三方其他 `ZCODE_CUA_*` 与 Python 外部变量保留，不在本批泛替换。skill 中 fallback 与 host 的最终 cwd fallback 不完全相同，分别维持各自合同。
- 内置 bootstrap 有确凿生产证据，但该 skill 和文档可被独立阅读或复制。仓内搜索无法证明仓外没有直接设置 `ZCODE_CUA_PLUGIN_ROOT` 的调用者；外部使用是未知，不应据此静默扩大或更改已定合同。部署/兼容 owner 在实施前核实合同依据及发布说明。
- `docs/plugin-creator.md:85` 为历史操作记录，保留；`docs/cua/2026-08-24-cua-node-repl-sdk-migration-spec.md:23,56` 为有日期的设计材料，现行与历史部分交文档 owner 判断，不机械覆盖。JSON 另列 5 个 native 冻结快照，保持原字节。`ZCODE_SERVER_AUTH_TOKEN` 等其他环境键属于独立 R30 闭包，distribution runner 与本批有文件重叠，必须串行协调；产品 wire/握手交 R40，非本批任意改写。
- 对活跃 `apps/ packages/ scripts/` 做了目标键片段及拼接、模板、join/concat 启发式检索，没有找到构造这四个完整 key 的动态路径；只能证明该范围内所用模式未命中，不能证明任意反射、外部进程或外部仓库不存在。测试 fixture 是基于实际调用关系补入，而非全排除 fixtures。

## 待补的验收矩阵

分别以不同值构造仅新、仅旧、并存、均无四种环境，避免环境泄漏：新键生效；仅旧键不驱动 R30 hard-cut 行为；并存时新键决定相应输入；均无时按各自已有 fallback。旧键物理存在于继承环境不等于被消费。覆盖 command 配套 JSON/cwd、孤立 args/cwd、非法 JSON、trusted native 优先、bundled producer 对继承环境的明确覆盖；CUA 模块初始化需隔离模块缓存并验证真实 documentation root，旧 CUA root 单独存在时继续既有通用插件 root/Claude root fallback。保留安全检查并使用临时目录与合成值。现有测试含部分覆盖，但从字面引用不能证明上述四组均已覆盖。

## 后续可执行验证（本次未运行）

固定 Node 24.14.0 的绝对工具链 PATH，根目录 `/Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename`：

```sh
pnpm exec vitest run packages/services/test/zodyAgentProcessManager.test.ts packages/zody-server-cli/test/agentWiring.test.ts packages/zody-server-cli/test/runtimeUpdateIntegration.test.ts packages/server/test/stdioDesktopPresentationSurface.test.ts
node --test scripts/zody-distribution-runner.test.mjs
pnpm exec turbo run build --filter=@zody/bootstrap --filter=@zody/node-repl-host
pnpm --dir apps/zody-cli/packages/bootstrap exec vitest run --config ../../vitest.config.ts tests/plugin-runtime-features.test.ts
pnpm --dir apps/zody-cli/packages/node-repl-host exec vitest run --config ../../vitest.config.ts test/mcp-server.test.ts
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

固定提交中两个测试均导入 Vitest，分别以包目录为 cwd，并显式使用 `apps/zody-cli/vitest.config.ts`；CLI 的测试规则收集包目录 `tests/**` 与 `test/**`。根 Turbo 的 test 依赖 build，故先构建两个目标及其依赖闭包；构建会写生成物，须持有构建锁。四个根测试路径均存在于 ad859，根 Vitest 的 unit 或 fork-isolated 项目覆盖它们（后者包含 services 和 runtimeUpdateIntegration）。使用隔离临时环境和当前源码产物；不要加载 WDIO 配置作静态检查（可能触发安装），不要以 Vitest 代替原生 E2E。以上均为执行计划，非通过声明。
