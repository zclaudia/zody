# R20 当前文字审查返修

基线 `8dfd3615410d763631b5646056ed83fc02aca2bf`。依据 [DeepSeek 首轮意见](R20-current-text-deepseek-review-1.md)，先在 `specs/zody-brand-residual-cleanup.md` 明确：缺少 provider 时仅内部 `useZodyStore` 诊断更新为当前 hook 名，外部 `Error.name`、协议字段和兼容键不变。`packages/ui/test/mobileStartPageStandalone.test.ts` 的两处旧名称已同步，并增加一个实际在 provider 外调用 hook 的负例；`StoreProvider.tsx` 的运行时文案随后同步。

三个 shared 文件仅修改审查指出的顶部当前符号说明：`ZodyTaskMeta`、`ZodyProvider`、`ZodyStreamEvent`、`ZodyTaskSnapshot` 和 `normalizeAvailableZodyMode`。本轮全部 19 个源码/spec 文件的精确 before/after SHA 见 `output/zody-rename-r20-current-text/review-correction/candidate-hashes.json`。未改外部错误身份、wire/env/渠道值、native 资源或主控维护的清单/ledger。

全部命令从实施工作树根执行，完整 argv、输出和退出码位于上述 output 子目录：

- 修复前 `pnpm exec vitest run packages/ui/test/mobileStartPageStandalone.test.ts` 的 `red-corrected.log`：1 通过、1 失败，exit 1；新负例期望 `useZodyStore`，实际仍为 `useZCodeStore`。修复后 `green.log`：2/2 通过，exit 0。
- 初次 `red.log` 有 2 项失败：除目标诊断外，实施者误把导入项插入 React 参数造成第二项失败；已立即移除该误插入，再记录上述独立有效 red。原日志保留，不将它当成产品基线。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均 exit 0；lint 为 303 warnings、0 errors。`git diff --check` 对六个文件通过。
- 六文件 `oxfmt --check` exit 1，指出 `StoreProvider.tsx` 和测试文件；对 HEAD 原始两文件的同一格式检查亦各失败（`format.log`、`format-baseline.log`），未为本次返修重排无关内容。

## 87 文件注释裁决与闭合

原批扫描的 35 条逐项裁决、owner 和具体声明或路径依据记录于 `output/zody-rename-r20-current-text/review-correction/scan-87-disposition.md` 与同名 JSON：16 条改为核实存在的当前声明或路径，19 条按外部身份、实际二进制、旧数据、协议字段或历史删除记录保留。两个历史协议文档引用指向实际存在的文件。另修正 services/node.ts 中动态工作流 offer 所引用的现行 zodyAgentService；其 B1b 删除历史说明保留。

此轮额外修改 14 个源码文件，全部仅为注释；独立解析前后 AST，逐节点比对非 trivia 和全部字符串字面量均一致，记录于 `comment-ast-verification.json`。全部 19 个候选文件的基线/当前 SHA-256 已更新至 `candidate-hashes.json`。此结论不扩大到此前已单独验证的 hook 诊断行为。

根目录重新执行 `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed`，均 exit 0；lint 303 warnings、0 errors。对应 `comments-typecheck-rerun.log`、`comments-lint.log`、`comments-architecture.log` 和各自 .exit 文件。首轮命令输出被保留，但包装脚本误用 zsh 只读变量 status，未能记录命令退出码；以修正包装后上述实际重跑结果为准。此前 hook 2/2 绿测仍适用，未重跑。

实施者不提交；主控负责冻结、独立复核并交 DeepSeek 重新审查。最终干净安装、R21/R22 和发行 gate 不由此返修替代。
