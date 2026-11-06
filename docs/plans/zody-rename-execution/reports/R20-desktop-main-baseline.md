# Desktop main 类型检查：854ddf60 基线对照

- 以 `git archive 854ddf60` 导出独立检出 `output/zody-rename-main-baseline/checkout`；在该目录使用 Node 24.14.0、pnpm 10.33.2 执行 `pnpm install --offline --frozen-lockfile --ignore-scripts`，退出 0。未使用主工作树的 workspace 构建产物，未修改主工作树源码、锁文件或 node_modules。
- 在该隔离检出执行 `pnpm exec tsc -b packages/desktop/tsconfig.main.json`，退出 1；重复执行退出 1。完整首次和重复日志分别为 `desktop-main-baseline.log`、`desktop-main-rerun.log`。
- 与 R01 提供的当时 R20.4 日志快照 `r20-current-diagnostics.log` 比较：移除两检出绝对根路径后，两边各 85 个 TypeScript 诊断，逐条文本、位置和错误码完全相同，差集均为 0。每项诊断及其分类见 `diagnostic-classification.json`；差集见 `comparison.txt`。因此这 85 项均已在 854ddf60 基线复现，未发现本次捕获快照新增的诊断。不能由此推断未捕获的后续修改或其他配置没有新问题。
- 两项 TS6307 的直接原因可由配置和源码确认：`tsconfig.main.json` 的 include 仅为 `src/main` 和 `src/common`，而 main 分别导入 `src/shared/armsRumShared.ts` 和 `src/scheduler/schedulerProtocol.ts`，这两文件未列入 main 项目。其余 83 条涉及类型收窄、DOM 类型、缺少导出、声明和重复标识符等，逐条以日志为准；本调查未将它们统称为环境问题或提出未经验证的单一根因。
- 854ddf60 根 `package.json` 的 typecheck 命令显式列出 desktop host 和 e2e，而未列出 `tsconfig.main.json`；因此根 typecheck 通过不等于单独 main 项目通过。

Controller independently compared the two raw logs after normalizing checkout roots: 85 diagnostic lines each, exact equality. This evidence covers the recorded candidate snapshot only, not arbitrary later edits.
