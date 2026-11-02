# R20.3 二审修复

基线 `c62caae2`。修复 guide 与 computer-use 的实际 monorepo seed 目录，保留旧 staged 目录、marketplace/name 与 `.zcode-plugin` 身份。`candidateBaseDirs()` 包含 `process.cwd()` 和 bootstrap 运行目录：在 `apps/zody-cli` 工作区启动时 `packages/zody-*-plugin` 命中；在 bootstrap `src/app` 或 `dist/app` 运行目录下 `../../../zody-*-plugin` 命中。旧四个 staged 候选保留；未增加未经证实的其它新路径。真实 seed 测试确认两个插件的缓存 manifest 均生成，并断言新源码和旧 staged 候选存在。

四个 bootstrap/node-repl-host 测试引用改用当前源码目录；UI path fallback 同时识别新源码与旧 staged guide 目录，回归覆盖无 pluginName 的两种路径。SEA 的 target blob 生产和消费路径均改为 `zody-${target}.sea.blob`；现有参数测试的虚拟 blob 路径相应更新。未执行真实 SEA 出包，因此此中间产物路径仅经静态核对及相关脚本测试，不声称真实 SEA 产物验证。

- 先添加真实 seed 和 UI fallback 反例，旧实现均失败；修复后五个 CLI 相关测试文件 71/71 通过；UI 测试 12/12 通过。
- `node --test apps/zody-cli/packages/cli/tests/build-sea.test.mjs`：退出 0，43 项通过（无纯源码正则镜像测试）。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、10 个目标文件 `oxfmt --check` 均退出 0；lint 303 warnings。`--changed` 不证明全量架构通过，全量基线两项失败已补充在 R20.md。
- Terra 作者交付时未 install、改锁、发布或提交，未触及冻结资源及任务账本。随后 controller 固化为 `854ddf60` 并更新任务账本；这些控制器操作不属于作者的源码写入。

CLI 71 项复跑命令（cwd：`/Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename/apps/zody-cli`）：

```sh
export PATH="$PWD/../../output/zody-rename-toolchain/node-v24.14.0-darwin-arm64/bin:$PATH"
../../node_modules/.bin/vitest run packages/bootstrap/tests/bundled-plugins-resilience.test.ts packages/bootstrap/tests/dynamic-workflow-skill.test.ts packages/bootstrap/tests/zody-guide-path-contract.test.ts packages/node-repl-host/test/computer-use-onboarding.test.ts packages/node-repl-host/test/mcp-server.test.ts
```
