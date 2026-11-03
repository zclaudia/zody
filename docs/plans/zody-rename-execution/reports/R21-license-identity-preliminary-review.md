**Preliminary Status**

Read-only review of `specs/third-party-license-identity.md`, `reports/R21-license-collision-fix-proposal.md`, prior `7c71e60c` generator, and the current uncommitted tests. No final PASS; the source diff is moving.

The current tests already cover some good cases: workspace vs npm `debug@4.4.3`, external same-version `debug@0.1.0` at unit/scan level, workspace symlink exclusion, dev `debug@2.6.9` presence, duplicate `4.4.3` conflict, and collector repository/LICENSE hashing.

**Red Evidence**

- `red-confirmed.log` now contains genuine old-interface behavior red: `productionPackages(projects)` returns `[]` instead of `["debug@4.4.3"]`, and `collectNpmNotices` returns `[]` instead of `debug@4.4.3`. That meets the “debug loss” evidence request at a basic level.
- It is still mixed with API-shape failures: `prepareWorkspaceIdentity is not a function` and `copies.length` undefined. `red.log` is mostly API-missing. Keep a separate minimal red command pinned to `7c71e60c` that runs only the legacy two-argument behavior tests, so the receipt is clean behavioral evidence rather than a mix of new API and old behavior.

**Required Coverage Gaps**

1. **Actual vs lockfile-only graphs are not really tested.** `scripts/test/third-party-npm-platform.test.mjs:131` calls `prepareWorkspaceIdentity(projects, projects)` with the same array twice, and `scripts/third-party-notices.test.mjs:148` uses a fake `pnpm` that returns the same graph for both modes. There is no test where the lock representation uses `version: link:../debug` and the actual graph uses a real `path`, no lock importer/alias cross-check, and no `assertProductionGraphs` missing/stale assertion.
2. **Workspace-as-dependency traversal is missing.** No fixture has an app depending on workspace `debug@0.1.0`, whose external child `debug@4.4.3` must still be traversed after the workspace node is excluded. The current workspace root is the top-level project, so an implementation that `continue`s on workspace children can still pass.
3. **Alias/symlink coverage is partial.** The production test’s `canonicalize` is an identity function, so it does not prove symlink resolution. There is no external-package symlink alias, no alias-only third-party entry (`info.name` absent), no external package under the removed `@zody/` namespace shortcut, and no broken/unresolved symlink case.
4. **Same-name same-version assertion is ambiguous.** The test only checks `debug@0.1.0` in the required map. That key could come from the workspace itself or the external same-version package. Assert the required entry’s path/source/origin, and add the same-name same-version case at the inventory/notices generation level, not only in the unit test.
5. **Unresolved/nonworkspace link behavior is under-specified.** The `assert.throws(..., /workspace|link|identity/i)` assertion in `third-party-npm-platform.test.mjs:131` is too broad. It should assert the parent project, alias, and target are reported. Also test a verifiable nonworkspace local `link:` separately from an unresolvable one; the spec says nonworkspace links must not be silently excluded.
6. **Dev-only basic checking is untested.** `third-party-notices.test.mjs:148` checks production notices only. There is no test of the basic `licenses.mjs` checker proving `debug@2.6.9` is included in installed/basic coverage while remaining `isProd: false` and absent from production notices. This likely requires a testable checker/collection seam; otherwise the name-filter bug can survive in `licenses.mjs`.
7. **Duplicate physical copies are only partly covered.** The scan test asserts `copies.length === 2` but not the two directories or their source hashes. The conflict test accepts `/conflict|不一致/i` without asserting both paths or the differing field. Add cases for identical-content duplicate copies (should be accepted/deduplicated deterministically), repository mismatch, duplicate `0.1.0`, and symlink-to-same-realpath deduplication. Define the `copies` shape for every entry, not only the `4.4.3` key.
8. **Generation-level output is not asserted.** The notices test calls `collectNpmNotices`, not `generateThirdPartyNotices`/the inventory and notices writer. Final evidence must independently assert the generated `third-party/inventory.json` and `THIRD-PARTY-NOTICES.md` contain `debug@4.4.3` with actual installed repository/LICENSE bytes, omit workspace `debug@0.1.0`, and do not add dev-only `2.6.9` to production notices.

**Contract Items to Pin**

- The tests introduce `prepareWorkspaceIdentity(...)`, a third `identity` argument to `productionPackages`, and a `copies` field on scan results. These are not in the `7c71` interface or the current spec text. Decide whether identity is mandatory or default-derived, and whether the legacy two-argument call is supported. Do not let one red-behavior test become an undefined green contract by accident.
- Define the `scanInstalledPackages` return contract for multiple copies and update/test all consumers (`missingProductionPackages`, `collectNpmNotices`, `licenses.mjs`).
- Test the `@zody/` namespace shortcut explicitly: if it is retained, the spec must reserve that namespace; otherwise a foreign package with that namespace remains silently excluded.

Minor: the fake `pnpm` uses `#!/bin/sh`, `PATH` with `:`, and `symlink(..., "dir")`; these are POSIX-oriented. If Windows is in scope, add a platform-safe shim or guard.

No files were modified; I did not run install, build, or the test suite.
