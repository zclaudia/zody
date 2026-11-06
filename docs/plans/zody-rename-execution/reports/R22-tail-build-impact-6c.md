# 71e 到 6c 的四目标构建影响

固定比较 `71e21e4f7f941c6a3abf6e15ce0310d5610d1b52` → `6c987a26`。`git diff --name-status` 实际共有 15 文件：`.prettierignore`；browser-use-plugin `package.json`；CLI `plugin-host-command.ts`；core/desktop 两个测试文件的错误文字；`docs/dynamic-workflow/authoring.md`（将当前 skill 提取目录说明从 `.zcode` 改为 `.zody`）；7 个新增审查/验证报告；ledger；spec。除 browser-use package 描述、CLI 源注释与两个测试错误字符串外，变更是格式规则或文档/元数据。`third-party/inventory.json` 在 71e→6c 没有 diff；其输入被后续 package 描述更改影响，见下。

## browser-use package 是实际 SEA 输入

- `apps/zody-cli/packages/cli/scripts/sea-official-plugin-assets.mjs:120–125` 将 browser-use 的根目录列为官方插件；同文件的 `includedTopLevelPaths` 包含 `package.json`，遍历时将文件内容加入 SEA assets、将 SHA 和 mode 放入插件 manifest，并对所有插件的路径、SHA、mode 算 manifest hash。
- 71e 实际 collector 产物 `output/zody-rename-r22/sea-collect-71e21e4f/collector-stage/official/official-plugins-manifest.json` 的 browser-use 记录有 23 个文件，其中 `package.json` SHA-256 为 `50dfedac5b3cd18e110f168a38719047f47c883a94345c9efefa48e64ddfa398`，与 `git show 71e:.../package.json` 一致。6c 同一路径 SHA 为 `c23ae067cc194f18af8953ef4e5d671d4b127092e15d4c10c3721a998bbedd91`。
- `build-sea.mjs` 的 `prepareSeaBlob` 对每个 target 调用该 collector，并把 `pluginAssets` 合入 SEA 配置；`scripts/zody-distribution/sea-build-steps.mjs` 调用 browser-use 构建和相应 target 的 `build-sea`，`scripts/build-zody.mjs` 把生成的 SEA CLI 放进归档。因此该 package.json 的变更影响四目标预期 SEA 资产输入和包内 manifest，不能将 71e 归档当作 6c 字节产物。尚未实际构建 6c，也不声称具体新归档 SHA 或发布通过。
- 对已保存 71e manifest，仅在内存中把该文件 SHA 换成 6c SHA，并按现有算法计算，manifest hash 从 `4a1c67955df35bf26f08685643bcb909f12629e413207904c1bd3518f68805f9` 变为 `01a35e9c1aa233bd23fa2f94379bc7817d97d0e138137f6712b2a93cb450531b`。这是**只改变该输入**的可复核预测，不是假称 6c collector 已运行；其他输入变动会改变结果。
- 根发行的 `stageTuiRuntime` 通过 `sea-tui-assets.mjs` 收集 TUI 依赖闭包；当前证据中该文件的确定产物路径来自 official-plugin collector，不把它误称 TUI 资产或发行根的独立 package.json。根发行脚本生成的 `zody/package.json` 是自己的 `zody-runtime` 元数据。

## 注释与许可输入

`plugin-host-command.ts` 是 CLI `src/main.ts` 和 `src/run.ts` 的消费者。按 CLI esbuild 的 loader/target/format/legalComments、普通和 Desktop minify 取值对 71e/6c 单个源文件做**内存 transform**，两种代码输出 SHA 分别在前后相同；普通模式 source map 不同，因为包含变更的源文本；Desktop 单文件无 source map。TypeScript 默认保留注释时单文件 emit 不同。这些结果仅证明单文件相应配置的行为，不证明完整 bundle、sourcemap 或 SEA 二进制字节一致；完整 `analysis.json` 记录版本、配置和哈希。

71e/6c 的 `third-party/inventory.json` 输入表仍记录 browser-use package 的旧 SHA `50df…`，与 6c 文件 `c23a…` 不同。已比对 71e→6c 的全部变更文件：该 package 是当前 inventory.inputs 中唯一命中的文件。生成 pair 的一致性已受影响，必须由主控按既定来源、生成和独立复核流程处理；不能把 71e 的许可配对当作 6c 新输入配对。

## 已有证据与最小追加验证

71e 的真实四目标构建、15 项 collector、四归档 SHA 与本机 darwin-arm64 CLI/Web smoke 仍证明**71e 当时**的构建链和宿主行为；其他三个目标仅构建与哈希，未实际运行。它们不能证明 6c 归档或新的许可输入通过，也不能外推 Desktop 正式签名和发布。两个测试文件只改失败错误文本，不改变生产模块逻辑；`.prettierignore` 改变格式检查选择范围，原样保留红/绿证据，不可据此推断运行行为。

建议在新的固定候选和新许可 pair 成对生成并审查后：

1. 实际重跑 official collector，核其 browser-use package 资产与 manifest SHA 对应新源码，并核所有 target 的实际 SEA 配置，不使用上述预测值替代执行结果。
2. 对固定最终候选重新完成四目标构建、归档和 sidecar/SHA256SUMS 核验；本机目标重新运行 CLI/TUI/Web 和 provider 的现有 smoke，非宿主目标仅声明实际执行的检查。
3. 对最终提交实际核对 inventory 中 package 输入 SHA 与素材、notices 配对，以及 basic、Node 验证和 strict 真实结果；保留现有 19 项许可审查义务的实际状态，不推断放行。

本任务只读取历史证据并做内存转译/哈希，未安装、运行构建或改动任何源文件、验证树和产物。
