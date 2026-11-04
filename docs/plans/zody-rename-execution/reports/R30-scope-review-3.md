# R30 frozen v3 review

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1` (DeepSeek, read-only). Reviewed patch SHA-256 `a1f53f2ec3bfb09c8e17768dc0bfedf6425ab1e69d01d749b96826a66a4ebadc`. This is authorization to apply and validate, not implementation acceptance.

**结论**
条件性允许把候选 patch 应用到当前工作树，进入 focused + root 验证；**不能视为实现或安全验收通过**。`review2` 所列的 Turbo、默认 prefix、APP_VERSION/BUILD_COMMIT、BUILD_TIME、NSIS 阻断在本候选已闭合；但发现一处新的真实安全缺口，建议在 root 绿之前补掉。

**已核销**
- patch SHA256 匹配；675 个文件、0 held；writeset 677 个路径，差集仅为 R30.1 当前的 `specs/zody-rename-runtime-contract.md` 与 `packages/desktop/test/windowsInstallerCompile.test.ts`，两者当前内容与候选意图一致；`git apply --check` exit 0。
- NSIS 四个 `/DZODY_INSTALLER_NSH` producer、fixture `!include`、uninstaller log macro 已闭合；CMake 八个 `-DZODY_*` 与动态 source dir 已闭合。
- `VITE_ZCODE_E2E_STORE_BRIDGE`、动态 SSH `A/B_*` 与 `${suffix}` family 已完整切换。
- Turbo 测试已使用实际任务名 `build:desktop-agent`、`@zody/cli#build`；`turbo.json` 两处 env 均已 `ZODY_ENV`。
- `ZODY_BUILD_TIME` 导出链、测试绑定、telemetry 四个活动 env、`ZODY_TELEMETRY_REPORT_ENDPOINT` 及 build-time AUTO_UPDATE/下载/反馈 define 已闭环。
- shared/desktop 旧新敏感键双清理、活动 capture 新-only、node-repl 旧检查保留并新增新键断言，均符合本轮要求。
- `server-red-03` 的 10 红 2 绿可作为有效切换前信号；不据此宣称 green。

**唯一需要关闭的安全项**
`packages/shared/src/runtimeEnv.ts` 的 `SANITIZED_RUNTIME_ENV_KEYS` 没有保留旧 `"ZCODE_TOOL_ENV_PASSTHROUGH_JSON"` 字面量；同时 `readZodyToolEnvPassthroughEnv` 现在只读 `ZODY_TOOL_ENV_PASSTHROUGH_JSON`。旧代码会通过 `buildZodyToolEnvPassthroughEnv` 重建并覆盖旧 key；改名后旧 envelope 不再被解析/覆盖，可能原样进入 `packages/desktop/src/main/desktopRuntimeEnv.ts` 的 host/child env，携带旧 proxy/CA 或人为注入内容。该问题不会被现有“只断言新 key 不存在”的测试捕获，也不是单纯大写名残留。

建议最小修复：在 `SANITIZED_RUNTIME_ENV_KEYS` 加入 `"ZCODE_TOOL_ENV_PASSTHROUGH_JSON"`，并在 `applyNetworkEgressEnv`/host env 边界显式删除旧 key；补一条“旧 envelope 不存在、新 envelope 正常”的行为断言。关闭前可继续 apply 进入验证，但 **root 绿不能作为安全通过**。

纯内部名、错误码、window globals、R55 插件身份等仍按既有 owner 后置；Windows NSIS Unicode probe skip 仍不算 Windows 通过。

Controller disposition: permit the sole Terra writer to apply the frozen patch, preserve the three separately added behavioral test files, close the legacy passthrough-envelope regression under the existing sanitization contract, and execute the focused/root validation plan. Actual implementation review and stage cleanup remain pending.
