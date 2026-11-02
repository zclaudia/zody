# R20-deepseek-implementation-review-1

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5`; read-only.

**结论：CHANGES_REQUIRED**

审查对象固定为 `6c7bd1c0`（base `f5dcc6ba`）；三份未提交 docs 未计入。仅做静态/scope 验收，未运行 codemod、install、UI 或完整 typecheck；`#src` 别名与 35 条诊断按你给的已知输入处理，不据此声称通过。

**已核实**

- 13/13 目录映射完成，源目录消失、目标存在、0 碰撞；5,364 个目标文件存在；48 个 workspace 包名和 3 个 fixture 包名匹配；native diff 恰为 5 个授权文件。
- 两把锁都是旧字节的 `zcode→zody` 精确替换，无第三方区域漂移；未发现 Excalidraw/marketplace/MCP 外部身份误改；未发现 env/wire/telemetry 值改名，diff 中只有 workspace import specifier 变化。

**阻断项**

- CUA 封装守卫和 R11 alias 仍只认旧 scope：`packages/desktop/scripts/lib/cua-helper-product-wiring-bundle.mjs:153,159`；`packages/desktop/scripts/lib/cua-helper-round11-final-build.mjs:475,492,498`。但 `packages/desktop/native/macos-cua-helper-round11/authority-entry.mjs:2` 已改为 `@zody/core/cua-submission`。目前只有 `cua-desktop-session-bundle.mjs:301` 同时拒绝两种 scope，11 项通过仅覆盖该文件。最小修复：R11 alias 改为 `@zody/core/cua-submission`；三处 guard 改为 `@(?:zcode|zody)/`；为 product-wiring 和 R11 各补两 scope 的 focused test。
- CUA 安装包路径仍指向旧 scope：`scripts/dev-desktop-cua-env.mjs:11`、`packages/desktop/scripts/computer-use-producer.mjs:18`、`packages/desktop/scripts/sharp-package-assets.mjs:169`、`packages/desktop/scripts/windows-cua-helper-assets.mjs:754`、`apps/zody-cli/packages/core/tests/frame-contract-artifact.test.ts:17`；测试 fixture 同错：`packages/desktop/test/placeholderProducerDetection.test.ts:20`、`packages/desktop/test/sharpComputerUseRequirement.test.ts:17`。实际安装链接已是 `packages/desktop/node_modules/@zody/zody-cua`，旧的 `@zcode/zcode-cua` 是悬空链接，因此 producer 检测会静默返回未安装，测试又自行创建旧目录掩盖问题。最小修复：这些路径统一改为 `@zody`/`zody-cua`；若分配到 R20.3，必须 producer、consumer、tests 同批完成。
- 两个 active E2E 构建入口仍用旧包名：`packages/desktop/scripts/gen-ui-e2e.mjs:21` 生成 `@zcode/shared*` alias，而 fixture 已导入 `@zody/shared*`（如 `packages/desktop/scripts/gen-ui-fixture/file-summary.tsx:2`、`renderer.ts:5`）；`packages/desktop/scripts/mcp-apps-host-e2e.mjs:55` 仍执行 `pnpm --filter @zcode/${name}`。修复：改为 `@zody/shared` alias 和 `@zody/${name}` filter，并确认 filter 能选中已迁移包。
- 冻结 fixture 的 provenance 被改写：`apps/zody-cli/packages/adapters/tests/fixtures/staging-backup-model-readers.mjs:4,18,27` 把 `apps/zcode-cli/...`、`zcode-protocol` 改成了新路径，但文件头仍声明来源 SHA `790884b1...`；这是 98% rename 中的 3 行内容修改，会让冻结基线看起来来自新路径。修复：恢复这三处注释为旧路径，只保留文件移动。另 `docs/plans/zody-rename-execution/reports/R20.md:5,22` 仍声称受保护 lock/graph 字节未变；对组合提交 `6c7bd1c0` 这不成立。锁是干净的 R21.1 机械替换、graph 是选择性 R21.1 更新，但报告应分阶段表述，不能把 R21.1 变更写成 R20.2 未改。

**非阻断/owner 收口**

- R21 独占项未从 R20 preview 内容候选中硬排除：`candidateContentEdits` 仍含 `zcode-feature-graph.yaml` 和 `THIRD-PARTY-NOTICES.md`；inventory 未列出但没有硬保护集。`6c7bd1c0` 里的 graph 变更本身可接受为 R21.1（只改已移动路径，保留未改 basename/graphId），但 R20.2 应把 graph/inventory/notices 加入硬排除。`r20-3-asset-bin-closure.json` 已明确把 `config/provider/*`、private bin 键和构建产物名归 R20.3，这部分 owner 清楚；但 `windows-cua-helper-assets.mjs:966` 的 `@zcode/zcode-cua-helper-runtime` 被 preview 标为 R20，报告/closure 又归 R20.3，需二选一并原子改消费端。`apps/dev-docs/src/App.tsx:1034` 仍显示 `@zcode/protocol`，preview 说 current display 属 R20、报告说 docs 归 R20.3，也应明确 owner。内部符号提案未用于本次判断，R20.5 仍独立。

目录/包移动本身不作为阻断，可作为受约束 scope 继续；但上述 4 个内容/消费端问题修复前，P2 不能签收。
