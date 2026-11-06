# R30 implementation review 1

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1` (DeepSeek, read-only). Current implementation is not accepted: the legacy envelope can be captured again after direct sanitization. This supersedes any proposed completion pending review.

**本轮结论**

安全阻断仍未闭合，因此当前仍不能给 R30 v3“实现通过/最终验收”。

`packages/shared/src/runtimeEnv.ts:121` 的 `NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS` 仍没有排除旧 `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`，而 `shouldCaptureZodyToolEnvPassthroughKey()`（`packages/shared/src/runtimeEnv.ts:327`）继续复用 sanitizer 资格。结果仍是：`buildZodyToolEnvPassthroughEnv()` 会把旧 envelope 重新封入新 envelope；`packages/desktop/src/main/desktopRuntimeEnv.ts:533` 的 spread 顺序让该值进入 Host，随后 `apps/zody-cli/packages/adapters/src/network/subprocess-env.ts:65` 又会展开到子进程。新增的 HTTP/CUA 测试不会覆盖这个 desktop helper 顺序。

**新增证据**

- CLI `typecheck-02`：34/34 tasks、exit 0。
- CLI `lint-01`：14/14 tasks、exit 0，0 errors。
- `arch-01`：`architecture: OK`，0 violations。
- `green-auth-01`：8/8，真实 `createHttpServer` + 随机 `127.0.0.1` 端口，覆盖新旧 token 四组合及旧 token 401。
- `green-cua-consumer-01`：聚焦过滤下 4 passed、18 skipped，覆盖 CUA root 四组合；属于有效行为证据，不是全文件通过。
- `license-check-01` 的 exit 1 是旧 inventory 导致的过期检查。当前静态核对已一致：
  - `apps/zody-cli/packages/bootstrap/package.json` SHA256 为 `943ba58...e5557`，与 `third-party/inventory.json` 一致；
  - `THIRD-PARTY-NOTICES.md` SHA256 为 `4517e27...c9479`，与 `noticesSha256` 一致。
  因此这是待重跑 `license check` 的验证项，不是当前代码阻断。

**待办**

修复旧 envelope 捕获问题并补 helper 级断言后，只需重跑 shared/desktop/adapters focused、`license check` 和最终 root G；不需要重审全部 675 文件。最终 manifest 与新 root 结果出来前，不宣称 root 或实现验收通过。

Controller disposition: fix the real capture/repack path and exercise the helper composition, then rerun affected checks. Preserve all current logs; no repeated license generation or full-source re-review is required.

