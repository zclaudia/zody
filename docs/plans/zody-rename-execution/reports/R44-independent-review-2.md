# R44 independent review 2

Broker reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a46c-fb33-7720-8cee-047c7ae90cb1`; `deepseek-flash` / `magpie` / `group/deepseek`, read-only; baseline `71acf64f`, corrected source hashes in `review-results.json`, 2026-11-04.

**Verdict: Code-Scoped Acceptance (R44)**

No blocking code regressions were reproduced in the corrected R44 diff. This is not a whole-stage PASS: real Desktop Electron smoke remains pending.

**Corrections Verified**
- `packages/shared/src/validation.ts:672-697`: Host init now rejects the retired key in all forms — old-only, old+new, and old+new with `undefined` — via `z.never().optional()` plus `Object.hasOwn` in `superRefine`. Unrelated unknown keys are still stripped, and `zodyBuiltinProviderConfigFilePath` remains required.
- `packages/shared/test/validation.test.ts:297-326`: covers old-only, mixed, mixed-with-`undefined`, and unrelated-unknown stripping.
- `packages/shared/test/accountProviderSnapshotProtocol.test.ts:23-40`: strict account envelope rejects old-only and old+new coexistence.
- Eight authorized E2E cast consumers plus the already-owned agent-step type file now use `window.zody`; a filtered search found no remaining main-bridge `window.zcode` in E2E or main consumers (`packages/client/src/globals.d.ts:80`, `packages/desktop/src/preload/index.ts:252`).
- `packages/desktop/test/preloadDisposer.test.ts:103-139`: loads the real CUA preload and real `createCuaPermissionDragPanel`, routes actual main sends to the actual preload listener, and asserts `zody:cua-permission-panel-state`, payload delivery, absence of `zcode:cua-permission-panel-state`, and disposer removal. Both sides use the same channel constant (`packages/desktop/src/main/cuaPermissionDragPanel.ts:66`, `packages/desktop/src/preload/cuaPermissionPanel.ts:13`).
- Plugin aliasing is preserved: `zcodePluginSandbox`, plugin-page `window.zcode`, GenUI/MCP aliases, and custom-event bridges are untouched and remain typed (`packages/client/src/globals.d.ts:71`).

**Boundaries**
- Builtin field closure is consistent across Main/Host/stdio producer (`packages/desktop/src/main/index.ts:1902`, `packages/desktop/src/host/index.ts:2846`, `packages/server/src/stdioServices.ts:11`, R41-owned `packages/server/src/entry-stdio.ts:61`). R41 hash not required.
- Persistence trace confirms account revision derives only from `[builtin revision, providers.toJSON(), states]`. Historical `zcode-builtin:` revision prefixes, `zcode-builtin-refresh.json`, external provider JSON, and frozen fixtures were not mechanically renamed. This remains bounded to the traced in-repo path, as stated in the report.
- `review-results.json` has 93/93 matching hashes; controller `source-hashes-final.json` reports 117 matching final worker hashes. Original `results.json` (83 entries) is superseded and stale for five corrected files — evidence housekeeping, not a code defect.
- Controller gates post-correction: typecheck-02/lint-02/architecture-02 exit 0 with 303 baseline lint warnings; focused 79/79; CLI typecheck 34/34 tasks, 0 errors.

**Remaining Gate**
- Real Desktop Electron smoke is still pending (candidate building via existing Playwright/Electron). Unit mocks and the preload-listener wiring test do not substitute for actual Electron validation of the CUA panel, plugin sandbox aliases, or runtime bridge behavior. Whole-stage acceptance must wait for that evidence.
