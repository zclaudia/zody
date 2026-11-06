# R20.4 剩余 106 个类型实施

基线 `a8a0fe2b5b168536bfb68d24911ba4368f7d1ff5`。本批仅应用 106 个 interface/type alias 的既有 `types-preview-aliases.patch`，补丁 SHA-256 为 `b28712e630cb208877a47b0ad81ed12b63cc422f79c9c0b85078859e23d7984a`。改动 140 个授权文件、854 个标识符位置；逐声明 old/new/引用见 `output/zody-rename-r20-runtime-next/types-plan-aliases.json`。应用前范围、manual 排除和每个文件前置 SHA 检查均无异常；应用后 140 文件均与补丁预期 SHA 一致，见 `output/zody-rename-r20-runtime-next/types-implementation/{preflight,final-audit}.json`。没有应用 runtime 预览、47 条人工项或 CUA JS/d.ts 组，也没有修改外部运行时值。

本批执行时工作区根 Vitest 解析为 4.1.4，CLI 根 `pnpm exec vitest` 解析为 4.1.7；包目录直接执行可能回落至根 runner，以下按实际 cwd 和日志报告。已知 root teardown 的偶发错误未以等待或忽略错误规避。本批目标测试没有出现该错误。

完整命令、cwd、输出和退出码均保存在 `output/zody-rename-r20-runtime-next/types-implementation/`：

- 根 `pnpm typecheck` exit 0；`pnpm lint` exit 0（303 warnings）；`pnpm architecture:check --changed` exit 0。实施前的架构 baseline 也为 0；本批不触达前批既有 404 行文件。
- `pnpm --dir apps/zody-cli build --force` exit 0（23/23，0 cached）；`pnpm --dir apps/zody-cli typecheck --force` exit 0（34/34，0 cached）。从源码重建的 bootstrap、adapters、UI 代表性声明确认新类型与公开导出；源码及产物 SHA 见 `declaration-evidence.sha256`。运行时旧函数名称属于尚未执行的后续 runtime 范围。
- 根 Vitest 4.1.4：`packages/desktop/test/zodyDataSizeTelemetry.test.ts` 和 `packages/ui/test/zodySessionProjection.test.ts`，2 文件 117 项通过。
- CLI 根 Vitest 4.1.7：19 个受影响 adapters/bootstrap/i18n 文件，374 项通过；精确文件集 `target-files.json`，完整 argv 和输出 `cli-vitest-tests.log`。CLI 包 Node test runner 对 3 个受影响文件执行，50 项通过，完整 argv 和输出 `cli-node-tests.log`。
- Desktop Main 单独 `pnpm exec tsc -b packages/desktop/tsconfig.main.json` exit 1，85 条诊断；与前批 Main 日志相比，将本批类型名及字面量/ArrayBuffer 联合类型顺序归一后完整日志一致（`main-comparison.json`）。不能将此单独项目称为类型检查通过；根 typecheck 不包含它。

本批未改 ledger、scope、锁文件或用户数据。剩余运行时符号、人工字符串和 CUA 配对声明仍由后续批处理。
