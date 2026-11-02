# R20 preflight review 1

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5`; static scope review only.

**CHANGES_REQUIRED**

**审查基线**

- 预览 input 仍为 `0e403023`；`0e403023..0ddde93f` 仅改 R02/账本资料，产品源码未变。审查时 HEAD 已到 `f5dcc6ba`，只新增授权/文档文件；我核对了其 `r20-authorized-scope.json`。
- R02/R10 按主控说明不重判。以下是静态 scope/路径审查，未执行 codemod、构建或测试。

**阻断/非阻断**

- **阻断｜CUA 直接路径消费端与断言漏项**：`packages/desktop/scripts/lib/cua-helper-product-wiring-config.mjs:32-33` 的 `BOOTSTRAP_ENTRY` 仍指向 `apps/zcode-cli/...`；`scripts/stage-dev-cua-plugin-runtime.mjs:13` 的 `pluginRoot` 仍指向 `apps/zcode-cli/packages/zcode-cua-plugin`；`packages/desktop/scripts/lib/cua-desktop-session-bundle.mjs:300` 的 sealed-entry 断言只匹配 `@zcode/`。三者均不在当前 `contentMap`；前两处是目录移动后的直接路径消费端，第三处是 survey §6.2 核心 5 之一，改名后不再拦截 `@zody/` 泄漏。最小修正：把三文件加入 `contentMap`（manual CUA context），与 `apps/zcode-cli`→`apps/zody-cli` 同批；断言改查 `@zody/` 或同时查两者，并更新 `cua-desktop-session-bundle.test.mjs`。
- **阻断｜R21 生成物仍可写**：`THIRD-PARTY-NOTICES.md` 仍在 `contentMap`（`r20-authorized-scope.json:6082`），而 `third-party/inventory.json` 已保护（`:685`）；`scripts/third-party-notices.mjs:18` 用 `noticesSha256` 校验，`scripts/build-zody.mjs:246` 会调用。R20 若改 notices 任一字节会使 G/build 失败。最小修正：把 `THIRD-PARTY-NOTICES.md` 加入 `contentProtectedPaths`；R21 需要变化时 inventory+notices 原子重生成。
- **阻断｜历史档案仍可写**：`docs/trace/archive/model-api-observability-v1.md:3`、`turn-trace-observability-v2.md:3`、`telemetry-v4-to-v5-upgrade-design.md:3` 明确标注历史/仅追溯，但仍在 `contentMap`（如 `r20-authorized-scope.json:7931`），且不在排除/保护列表；同类 `docs/plugins/2026-09-17-official-plugin-version-sync-spec.md:4`（“已实现并验证”）、`docs/analysis/memory-leak-audit-2026-09-03.md`、`docs/security/security-audit-2026-06-09.md` 也是候选。最小修正：加入 `contentProtectedPaths`/`excludedHistoricalContent`，父目录移动只保留原字节，不把历史路径改写成新包名。
- **非阻断｜3 个 E2E fixture 包名已由授权文件补上**：原 preview 的 48 mappings 缺 manifest 的 `nonWorkspaceFixturePackages`（`manifest.json:6418-6460`；`apps/zcode-cli/e2e/{compact-microcompact,file-tools-atomic-write,memory}/package.json:2`）。当前 `r20-authorized-scope.json:633,646,659` 已补到 51，并新增两个 package.json 到 contentMap。派发必须用 authorized scope，不能再用原 preview 的 48；测试随 fixture 迁移。
- **非阻断｜R20.3 资产/bin owner 只有类别、没有精确路径**：`r20-authorized-scope.json:697` 仅写 “provider assets/bin/output identifiers require … R20.3”。至少需列明 `apps/zcode-cli/packages/cli/package.json:6-13` 的 `bin.zcode`/`dist/zcode.cjs`、`apps/zcode-cli/packages/cli/scripts/sea-provider-config-assets.mjs:3` 与 `src/provider-runtime-env.ts:22` 的 `zcode-provider/zcode-builtin.json`、`config/provider/zcode-builtin.json:1` 及 `scripts/builtin-provider-config.mjs` 消费者，生产/消费同批。另 `@zcode/protocol` 规则（`rename-preview.json:130932`）写 “dev-docs current display”，但文件表含生产 `packages/desktop/src/main/startupWorkspace.ts:42` 和当前 docs；建议改为 “no package; exact dev-docs/docs current display only; retain production comments/history”。

**已核销**

- 13 个目录映射、5364 个移动映射：old/new 均唯一（含大小写不敏感），所有 old 存在，无 target-in-source、无重复搬运、R10 的 `scripts/zcode-distribution` 未再移动。
- 21 个未映射 scope 均有分类；Excalidraw、marketplace、外部 MCP/PyPI、sandbox origin/partition、安全存储均明确保留；未发现 native 冻结、`output/cua-*`、`docs/plans`、`third-party/inventory.json` 进入内容候选。
- CUA 内部 staging 包 `@zcode/zcode-cua-helper-runtime` 在 `windows-cua-helper-assets.mjs:966` 的生成点已被内容候选覆盖；但上述 CUA 三路径仍未覆盖。
- `internal-symbol-proposal.json` 未被当作授权；内部 basename/TS symbol 仍作为父 R20 的独立串行子步骤（主控口径 R20.5，当前 ledger 记为 R20.4）保留。

**边界**

- 4578 个内容候选未逐文件验证行为；后续 diff、类型检查、路径/构建测试仍负责实现验证。以上不构成测试通过结论。
