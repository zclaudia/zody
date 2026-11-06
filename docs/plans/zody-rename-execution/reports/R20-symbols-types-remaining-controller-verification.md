# R20.4 剩余 106 个类型：主控复核

固定基线 `a8a0fe2b5b168536bfb68d24911ba4368f7d1ff5`，候选包含 106 个声明、140 个产品文件和 854 处标识符编辑；声明和文件精确清单见 `../r20-symbol-migrations.json` 的 `R20.4-types-remaining-01`。主控核对应用前范围与前置哈希，以及应用后 140 文件的预期哈希。候选状态为主控已复核、待 DeepSeek 独立审查，尚未冻结提交。

主控独立运行的日志在 `output/zody-rename-validation/`：

- `controller-types106-root.log`：根 Vitest 4.1.4，2 文件、117 项断言通过；日志没有保留单独进程退出码。
- `controller-types106-cli.log` 与 `controller-types106-cli-command.json`：CLI 根 Vitest 4.1.7，19 文件、374 项通过；命令 JSON 记录退出码 0 和完整 argv。
- `controller-types106-node.log`：Node runner 50 项通过；日志没有保留单独进程退出码。
- `controller-types106-types.log`：根类型检查输出已完成；`controller-types106-lint.log`：303 warnings、0 errors。两份日志未保留单独进程退出码。
- `controller-types106-runtime-emit.json`：使用 TypeScript 6.0.2 在隔离转译比较中，140 文件的修改前后运行时 JS 均一致；该证据不替代实际项目构建。`controller-types106-js-residuals.log` 是零字节，主控对 JS/MJS/CJS/d.ts 范围检查旧 106 类型名未命中。

`controller-types106-main.log` 包含 85 条 Desktop Main TypeScript 诊断，未保留单独进程退出码。独立比较该完整日志与前批 `output/zody-rename-r20-symbols/batch-04/final-3cb/main-tsc.log`：先将前批本次 106 个类型名称映射到新名称，统一双引号字面量联合类型顺序和 `ArrayBuffer | ArrayLike<number>` 顺序，并去除前批命令/退出码包装；两份规范化文本完全相同，均为 85 条诊断。该项目仍有已知诊断，不能称为 Main 类型检查通过。

上述为主控已有独立证据的整理和日志比较，没有重跑测试或构建。实施者自己的强制构建、类型检查、测试和架构结果见 [实施报告](R20-symbols-types-remaining-implementation.md)；它们与本报告中未保存退出码的主控日志分开记录。
