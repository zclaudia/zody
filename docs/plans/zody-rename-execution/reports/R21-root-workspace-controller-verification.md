# 根工作区唯一安装：主控复核

用户已明确选择根 workspace 与根 lock 为唯一依赖安装入口，保留 `pnpm --dir apps/zody-cli …`。本候选基于 `83680ddc523fb95a06512ea43fc62c5a5b1ccb75`，26 个实现/配置/测试/文档路径；主控另维护账本与审查报告。

主控逐项复核实施清单的 before/after SHA，26 项一致；根 lock 与基线字节相同，SHA-256 `12e11b834269bada1625ea6b086eabab1234881e2038adb2a3cac21eb345a63f`。把旧 Turbo 的输入按原 CLI/仓库根分别归一后，与新的根 Turbo JSON 深度全等：任务依赖、outputs、env、cache 等其他字段未改变。

独立实际执行（Node 24.14.0 / pnpm 10.33.2）：

- `node --test scripts/test/root-workspace-owner.test.mjs apps/zody-cli/packages/cli/tests/build-sea.test.mjs`：47/47 通过。
- `pnpm typecheck`：退出 0。
- `pnpm lint`：退出 0，303 warnings、0 errors。
- `git diff --check`：退出 0。

日志在 `output/zody-rename-validation/controller-root-owner-{tests,types,lint}.log`。行为测试实际调用 Turbo dry-run 核对 CLI 包集合与 SEA 排除，捕获 Docker package script 的真实 cwd/argv，实际 pnpm 过滤集合为 38 包且无 Desktop；这些分别证明入口选择与命令解析，不替代真实构建/容器运行。主控发现并推动修复 Docker `-f` 的相对 cwd 问题，收窄容器安装面以匹配 CLI 构建入口，排除 output 与嵌套工作树上下文。历史 pnpm 防护保留，只纠正已失效的嵌套工作区现状说明。

Terra 实际执行的当前工作树 frozen install（含 scripts）、50 成员/92 links、CLI lint、增量架构检查结果见实施报告。它们不是干净检出证明。完整 builtin 配置测试仍有缺少 CUA manifest 的已记录失败；本批没有生成原生资源或签名发布。冻结候选后继续以该提交的新干净工作树安装，并交独立 DeepSeek 审查。R21 的最终 graph/inventory、R22 和全量改名仍未完成。
