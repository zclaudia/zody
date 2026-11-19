# 手动推送前检查

仓库已移除本地自动 pre-push 和根依赖安装时的 Husky 注册。日常分支推送与检查分开执行：

- `pnpm verify:pre-push` 依次运行 lint、架构检查、受影响的根 Vitest 单测及官方引用扫描，适合手动检查待推送的提交。
- `pnpm test:unit:affected` 单独看受影响的单测。它比较提交范围。有 upstream 时使用 `@{upstream}..HEAD`，也可通过 `ZODY_AFFECTED_TEST_BASE` 指定基线。变更范围含删除的源码或测试文件时，退回根单测全量运行。
- `pnpm test:unit` 运行根单测。桌面 E2E 使用独立入口 `pnpm test:e2e`。
- `v*` 标签发布由 GitHub Actions 的 `validate` job 执行类型、lint、架构、单测及发布专用检查。官方引用扫描保留在手动检查中。普通分支 push 不启动标签发布。

工具版本见 `mise.toml`。自定义 hook 由各开发者管理。若旧 checkout 的本地 `core.hooksPath` 仍指向原先由 Husky 设置的 `.husky/_`，可以移除此本地配置，恢复 Git 的默认 hook 路径。
