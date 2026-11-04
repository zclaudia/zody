# R40 error values independent acceptance

**Verdict**
Scoped **PASS** for `R40_ERROR_VALUES` at baseline `19d608d0a910f33247779b7a1f56d4f6a72557bf`. No blocking regression found in the authorized R40 scope. This is not whole-product, R22, mobile, or release acceptance.

**Verified Evidence**
- Grant contains exactly 33 write paths and 18 verify-only paths; all 33 write paths match `implementation/source-hashes.json`, and every current file SHA matches.
- All 29 recorded log SHAs match. All 18 verify-only paths have zero diff from baseline. `outsideScope` is empty.
- `source-hashes.json` SHA matches controller `results.json.sourceManifestSha256`: `5d45d3790b4a0ac28990ba931261ca7529343a0443dee469f050ef7838856609`.
- Controller root typecheck, lint, and architecture checks are exit 0; lint reports the recorded 303 baseline warnings.
- The nine production files contain only the five authorized code literal mappings plus two explanatory comments. Current diff is 13 insertions/11 deletions; no functional path, alias, fallback, or persistence rewrite was introduced.
- Old code values remain opaque to current branches, historical readings remain unchanged, and the historical fixture tests preserve original code/message/input. `provider_not_ready` and the `zcode.error` namespace remain unchanged.
- Real RPC evidence covers actual `ChannelServer`/`ChannelClient` provider/runtime and MCP error-class round trips. The 370, 17, 7, 10, and 53 test groups overlap and are not a unique-case sum.
- `ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED` remains UI historical-display only with no current producer, supported by `output/zody-rename-w5-preflight/R40-bigmodel-code-owner-19d608.md`.

**Residual Limits**
- `docs/desktop/windows-update-install-handoff.md:108` still names `@zcode/shared`; that wording existed at baseline and the actual package is `@zody/shared`. Non-blocking documentation residue, optional follow-up.
- No real user-database byte verification, formal Desktop UI E2E, or exhaustive old-code injection across every consumer was performed. These limitations are correctly retained in `docs/plans/zody-rename-execution/reports/R40-error-values.md`.
- No tests, builds, installs, or writes were rerun during this final review.
