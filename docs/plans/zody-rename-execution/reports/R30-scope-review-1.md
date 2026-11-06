# R30 scope review 1

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`; read-only deepseek-flash / magpie / group/deepseek. Fixed7089 scope review before production cutover; findings require completing the existing authorized hard-cut scope, not new product decisions.

**结论**

`NOT IMPLEMENTATION PASS`。本轮仅完成固定 `7089ad3e095ec10727772107100d3e019b78d456` 的 R30 scope 审查，结论为 **scope 阻断 / 可执行缺口**，不是产品实现通过。R22 的 conditional 放行不改变本轮判断；R30.1 的 spec 增补与 planned red test 只是前置，不能替代生产 writeSet 闭包。未运行测试、install 或 build；`check-workspace-freshness` 因沙箱无法写 `FETCH_HEAD` 失败，属环境限制。

**已确认合格的边界**

- writeSet 结构唯一：581 个唯一路径，580 个既有文件 + 新增 `packages/server/test/zodyRenameEnv.test.ts`，2732 行 occurrence；无重复路径；`verification.json` 为 580 paths、2732 rows、`blobMismatches:[]`、`missingOccurrences:[]`。A/B/C/D 是串行审查分组，不是并发授权。
- shared `ZCODE_VERSION/COMMIT/ENV` 闭包完整：VERSION 201 refs + 1 re-export、COMMIT 10 + 1、ENV 31 + 1，均 0 missing；声明 `packages/shared/src/version.ts:8,10`、`packages/shared/src/env.ts:21` 和再导出 `packages/shared/src/index.ts:46,79` 均在 writeSet。
- env object shorthand 抽查通过：`desktopRuntimeEnv.ts:292,553`、`env.ts:43` 等只切新 env key，未误改外部对象字段或 wire 名称。
- Vite bridge：`vite-bridge-closure.json` 的 14 个路径中，13 个活跃生产/消费/测试路径均在 writeSet；仅历史 ledger `docs/working-memory/.../todo103-staging-integration-ledger.md` 保留，符合历史证据规则。
- 动态 SSH family：`ZCODE_E2E_SSH_{A,B}_*`、`ZCODE_E2E_SSH_${suffix}_*` 及 P8 identity 键的活跃生产/测试路径均进入 writeSet；只剩历史文档保留。
- CMake：`scripts/native-search-tools-windows.mjs:112-119` 的 8 个 `-DZCODE_*`、动态 `ZCODE_${source_name}_SOURCE_DIR`、`ZCODE_VIIZ_SOURCE_DIR` 及 `CMakeLists.txt` 消费端均覆盖。
- NSIS 产品宏：`/DZCODE_UNINSTALLER_LOG_PATH` 的生产者 `packages/desktop/scripts/test-installer-preserve-files.mjs:96`、`packages/desktop/build/installer.nsh:21-301` 已覆盖。
- 负例/排除边界：`ZCODE_DEV_REMOTE_ASSET_USE_CDN`、`ZCODE_OFFPEAK_MOCK` 在 writeSet 中 0 行；冻结源、历史文档、通用测试任意键、R55 通用 `ZCODE_PLUGIN_*` 均未被派发。注意 `packages/server/src/remote/remoteAssetCdn.ts:136,143` 的 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 是活跃生产键，已正确列入，不是旧 CDN 负例。

**精确阻断**

1. **`turbo.json:54,119` 未进入 writeSet。** 当前仍为 `"ZCODE_ENV"`。精确扫描非文档、非冻结的活跃 `ZCODE_ENV` 字面量，除该文件外没有其他未覆盖项。R30 计划要求 mise/CI/构建配置同批切换；Turbo `build`/`test` 的 env 白名单若保留旧键，新键不进入 cache key，旧键仍触发缓存失效。应将 `turbo.json` 加入 writeSet 并改为 `ZODY_ENV`，随后重新生成 verification。

2. **`env-config.adapter.ts:9` 仍硬编码 `"ZCODE_"`，但 writeSet 已改测试输入。** `apps/zody-cli/packages/adapters/tests/config.test.ts:340-343` 已改为 `ZODY_STORAGE_DIR` 等，而 `:344-346,416,421` 仍是旧的 `ZCODE_HTTP_TIMEOUT`、`ZCODE_LOCALE`、`ZCODE_LOG_FORMAT`、`ZCODE_SESSION_DB_PATH`。按当前 writeSet 应用后，`parseEnvConfig` 默认前缀不识别新键，`:340-343` 的断言会直接失败；若只改前缀，则 `:344-346,416,421` 又会被忽略。必须补齐 `DEFAULT_PREFIX = "ZODY_"` 及所有活跃 `parseEnvConfig` 输入/断言，或明确把该 provider 排除在 R30 之外；现状不能算原子闭包。

3. **`ZCODE_APP_VERSION` / `ZCODE_BUILD_COMMIT_ID` 跨进程键只切了一半。** `packages/shared/src/env.ts:45-46` 的值仍是旧键；writeSet 却把 `apps/zody-cli/packages/bootstrap/tests/model-config.test.ts:37,75` 的输入改成 `ZODY_APP_VERSION`，而生产读取 `apps/zody-cli/packages/bootstrap/src/model-config.ts:75` 仍通过 `ZCODE_APP_VERSION_ENV` 读旧键，且同文件 `:91` 仍用旧键。应用 writeSet 后，`:37,75` 的期望版本会变成 `Zody/unknown`，测试失败。还需同步 `packages/server/src/remote/connect.ts:382`、`apps/zody-cli/packages/telemetry/src/bootstrap.ts:160,167`、CLI 的 `env.ZCODE_APP_VERSION` 读取点，以及 `packages/desktop/test/desktopRuntimeEnv.test.ts:28-29,456-457` 的 mock/断言。按 7089 spec `specs/zody-rename-runtime-contract.md:29` 的非插件硬切规则，不能保留旧键静默读取。

4. **`ZCODE_BUILD_TIME` 同文件半切，需显式处置。** `packages/shared/src/version.ts:6,13` 的 define 已改为 `__ZODY_BUILD_TIME__`，但导出绑定 `version.ts:12`、再导出 `packages/shared/src/index.ts:46`、`packages/services/src/feedback/feedbackService.ts:2,34`、`packages/desktop/src/main/about.ts:12,159` 仍是 `ZCODE_BUILD_TIME`。若 R30 的“全部编译定义”硬切包含 BUILD_TIME，这是 shared binding/re-export 缺口；若刻意保留，必须在 authorized scope/keepRules 中写明排除，不能以未列出代替结论。

5. **NSIS fixture 宏 `ZCODE_INSTALLER_NSH` 仍未决。** 生产 uninstaller `/D` 闭包已覆盖，但 `packages/desktop/scripts/test-installer-preserve-files.mjs:42,60,93`、`test-installer-nsh-smoke.mjs:98`、`packages/desktop/test/windowsInstallerCompile.test.ts:83` 及 `installer-*.nsi` fixture 仍使用旧宏；dispatch 本身也只写“另按引用单独审定”，`r30-authorized-scope.json` 的 keepRules 未包含它。若它不属于 R30，应记录明确 owner/exclusion；若属于，则需与 fixture 编译/冒烟测试同批改名。当前不能宣称 NSIS `/D` 全闭包完成。

**收敛与执行结论**

- 结构上 writeSet 唯一性和 blob/occurrence 校验通过；语义上跨组原子收敛**未通过**：测试/部分消费端已切新键，而 `turbo.json`、env parser、APP_VERSION/BUILD_COMMIT、BUILD_TIME、NSIS fixture 仍存在新旧分叉。A/B/C/D 串行顺序不能修复缺失路径。
- 在 Terra 进行 R30.1 生产切换前，应先补齐上述 writeSet 路径并重新生成 `R30-merged-writeset.json`/`verification.json`；新增 `zodyRenameEnv.test.ts` 的红测应至少覆盖这些键的“仅新、仅旧、并存、均无”，并对 Turbo 构建输入做配置级断言，否则无法捕获本轮缺口。
- `verification.json` 只能证明固定 blob 上的旧 token 行匹配，不证明 581 文件已逐字符覆盖，也不证明所有活跃消费点已纳入。本轮不重复手工审 580 文件，但上述路径均已用实际声明、导入和上下文复核。

**未判定为通过的项**

`specs/zody-rename-runtime-contract.md` 在 7089 仅有通用硬切规则；R30.1 的 spec 增补和 planned red test 是前置证据，不是实现通过。R22 完整红项仍保留，本报告不重开 R22 结论。

