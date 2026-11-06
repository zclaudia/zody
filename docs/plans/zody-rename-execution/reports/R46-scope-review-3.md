# R46 scope review 3

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a46c-fb33-7720-8cee-047c7ae90cb1`, DeepSeek. Conditional scope GO; final two test closures and post-R45 rebind remain.

**Conditional Dispatch: GO, subject to two test-closure additions and the R45 rebind.**

**Scope Closure Confirmed**
- Counts are exact: 48 production, 42 existing tests, 1 new test, 3 new documents.
- `baselineComparison` independently verified: 90 existing candidate blobs are identical between `8d953d3c` and `04860520`; all four new paths are absent in both commits.
- R43 is sealed at `04860520`; R43 intersection is empty.
- R45 overlap is exact: 5 paths, including `create-app.ts`. R20 overlap is exact at 88 paths.
- `v4-native-commands.test.ts` is now included and the old module assertion is explicitly assigned to update.
- Supplements are now under `mapping`: `startupAndModuleLiterals` covers `zcode_app` plus the three module tags; `loggerCategory` covers `createLogger("zcode")` and retention; `serviceLoggerScopes` lists all seven active scopes.
- Startup, logger-category, retention, v4-module, service-scope, and restore cases are named in `specificTestCases`.
- The restore path is now mandatory: `restore-legacy-agent-roundtrip.test.ts` must run the real restore script against temporary file SQLite, close/reopen through real adapters, and verify new defaults plus old values.
- Server-operations occurrences, lifecycle exactly-once counting, stable seed preservation, and old log/identity retention are closed.

**Residual Test-Closure Gaps**
- `packages/services/src/zody-agent/zodyTaskServiceAdapter.ts` has active scope `zcode-task-service`, but its only importing test is `packages/services/test/zodyLegacyTaskCompatTaskIndex.test.ts`, which is not in R46’s test set or R20 overlap. Add that test path and update R20 overlap to 89; add a scope-specific assertion there.
- `packages/services/src/zody-session/importedClaudeSessionRepair.ts` shares `zcode-session-service`, and `zodySessionService.test.ts` exercises the repair path, but there is no explicit assertion that this producer’s scope changed. Add that assertion to the included session test or add a dedicated test.
- The current “seven scopes + tests” claim is therefore not yet exactly closed: five service tests are included, but the two producers above lack explicit candidate assertions.

**Dispatch Condition**
Proceed only after R45 is accepted and R46 rebinds to that commit; then recompute the 90-blob comparison and R20/R45 intersections. If the two service-scope test closures are added, the artifact is freeze-ready. No implementation, tests, builds, or writes were performed.
