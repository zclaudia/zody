# R44-independent-review-1

Broker reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a46c-fb33-7720-8cee-047c7ae90cb1`; route `deepseek-flash`, provider `magpie`, model `group/deepseek`, read-only. Baseline `71acf64f`; review receipt 2026-11-04.

**Verdict: Changes Requested / Not Accept-Complete**

The core R44 rename is coherent: main bridge is `window.zody`, CUA channel strings match on both ends, plugin sandbox aliases remain intact, and builtin producer/consumer fields are aligned. Root typecheck/lint/architecture and controller-focused tests are green. However, two acceptance gaps remain blocking.

**Blocking Findings**
- Host init schema does not reject the retired field. `hostInitLocalMessageSchema` is a plain `z.object` at `packages/shared/src/validation.ts:672`, so unknown keys are stripped rather than rejected. Sending both `zodyBuiltinProviderConfigFilePath` and `zcodeBuiltinProviderConfigFilePath` succeeds. The test at `packages/shared/test/validation.test.ts:297` only omits the new required field, so it fails for the wrong reason. This violates the spec’s “旧字段拒绝” acceptance criterion and the R44 report claim.
- Main-bridge consumer closure is incomplete. Preload exposes only `zody` at `packages/desktop/src/preload/index.ts:252`, and `preloadDisposer` confirms no main `zcode` bridge at `packages/desktop/test/preloadDisposer.test.ts:89`, but active E2E consumers still dereference `window.zcode`:
  - `packages/desktop/test/e2e/help-client-config.test.ts:19`
  - `packages/desktop/test/e2e/help-menu-about.test.ts:257`
  - `packages/desktop/test/e2e/browser-tab-residency.test.ts:261`
  - `packages/desktop/test/e2e/browser-tab-close-idempotent.test.ts:48`
  - `packages/desktop/test/e2e/settings/browser-extension-settings.test.ts:203`
  - Pending cases such as `packages/desktop/test/e2e/manual-review/pending/windows-file-reveal.test.ts:25`

  These files are R20/R30-owned in `file-assignments.json`, not R44 write-set files, so this is a cross-owner handoff gap rather than an R44-authored regression. But with no `window.zcode` fallback, these paths fail in real Electron. Root typecheck misses them because they use casts, and the 12-file controller suite does not cover them.

**Validated Areas**
- CUA paired channel is consistent: `packages/desktop/src/main/cuaPermissionDragPanel.ts:66` and `packages/desktop/src/preload/cuaPermissionPanel.ts:13`.
- Account schema is strict and producer/consumer use `basedOnZodyBuiltinRevision`: `packages/shared/src/zody-protocol/index.ts:2458`, `packages/services/src/zody-agent/zodyAgentService.ts:1327`, `apps/zody-cli/packages/bootstrap/src/zody-protocol/account-provider-config.ts:21`.
- Snapshot revision still hashes only `[basedOnBuiltinRevision, providers.toJSON(), states]` at `packages/provider/src/sources.ts:50`; no full-snapshot disk serialization path found. Personal/builtin persistence remains separate.
- `zcode-builtin:` revision strings, `zcode-builtin-refresh.json`, external provider JSON, and historical fixtures were not mechanically altered.
- All 83 SHA-256 entries in `output/zody-rename-r44/implementation/results.json` match current files.

**Remaining Validation Gates**
- Real Desktop smoke is still pending, so actual preload/renderer/CUA behavior is not proven.
- No focused test directly exercises the CUA panel channel pair; current confidence is static inspection only.
- The account old-field test also only checks the old key without the new key, though its schema is `.strict()`, so this is a test-strength gap rather than a confirmed code defect.
- R44 cannot be called whole-stage PASS on unit mocks; the Desktop gate remains open.
