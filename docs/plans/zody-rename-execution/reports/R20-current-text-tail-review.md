# Independent metadata tail review

DeepSeek B, fixed6c source. Raw receipt is scoped to formatter/text changes, not build/release. Subsequent controller fixes the one adjacent current-scope comment identified below; only that comment token changes, with exact-diff verification and root typecheck/lint0. It is outside this fixed6c receipt and does not alter inventory inputs.

**结论：scoped PASS**

在固定范围 `1262e00c → 6c987a26`（tree `5d6d07d4…`）内，6 个源码/spec 文本文件与报告/账本均符合本批声明，没有发现需要阻断的实际改动。该结论只覆盖这次文字/配置映射收尾，不代表 6c 源码已完成构建或发行。

**已核对**
- 范围与对象：candidate tree 为 `5d6d07d49edc…`；diff 为 11 个文件，6 个实现/配置/spec + 5 个报告/ledger，没有意外产品文件。
- `.prettierignore`：三条旧规则精确映射到 `apps/zody-cli/` 及两份现有 fixture（`.prettierignore:4,8,9`），第二行注释同步（`:2`）；`ignore-parity.json` 证明仅这四条变化、其他行未动。旧 `apps/zcode-cli` 目录在 candidate 不存在，不扩大实际忽略范围。
- 格式化证据：修改前对两份 `for await` fixture 运行 oxfmt 得到真实解析错误（`oxfmt-target.log`）；忽略生效后仅指定两份目标时 oxfmt exit 2、提示无 target（`oxfmt-green.log`），加入根 `package.json` 对照后 exit 0 且实际只检查 1 个文件（`oxfmt-green-with-control.log`）。
- `browser-use-plugin/package.json:6` 仅 description 的 `@zcode/node-repl-host` → `@zody/node-repl-host`；包名、版本、license、scripts 未变，依赖包 manifest name 确为 `@zody/node-repl-host`。许可/inventory 输入需由 R10 从固定候选重新生成，本批未改生成对。
- `plugin-host-command.ts:110` 仅注释；两处测试错误消息分别改为 `@zody/adapters`（`cua-submission-control-binding.test.ts:32`）和 `@zody/core`（`macosCuaHelperRound11Authority.test.ts:209`），均为诊断路径，实际 manifest name 匹配。
- spec 仅新增一句忽略范围说明（`specs/zody-brand-residual-cleanup.md:97`），没有扩大格式检查豁免语义。
- 哈希核对：`changes.json`/`change-hashes.json` 的最终 after 与 candidate 文件一致；core 测试 6/6、desktop 测试 5/5，root typecheck/lint exit 0（303 warnings）；`git diff --check` 通过。
- 报告边界正确：`R22-four-target-build-smoke-71e.md` 明确是 `71e21e4f` 的构建/smoke；`R20-current-text-tail.md` 明确本批文本修正不在该构建中，未把 71e 四目标结果冒充 6c 源码已构建。

**证据限制**
- 未实际运行 6c 的构建、SEA 或归档 smoke；本批只有文本/配置/测试消息变化，未生成对应二进制。
- 未重跑完整 `pnpm fmt:check`，只审阅了真实定向 oxfmt red/control 证据。
- browser-use manifest 的许可生成对未在本批重生；R10 的 inventory/许可验证仍是后续 gate。
- 71e 的归档/宿主 smoke 不能作为 6c 候选构建通过证据。

**非阻断观察**
- `cua-submission-control-binding.test.ts:34` 相邻注释仍写 `@zcode/adapters/mcp`，同文件临时目录名仍用 `zcode-cua-*`；属于既有注释/临时命名，不在本批五个精确文本项内，且报告已声明未做全量活跃注释审计。
- `plugin-host-command.ts` 的 `--zcode-node-repl-control` 等 flag 未被本次文本替换触及，符合协议身份保留边界；本批未改动其行为。
