# R46 scope review 2

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a46c-fb33-7720-8cee-047c7ae90cb1`, DeepSeek. Scope review; no implementation acceptance.

**Verdict: Previous scope blockers are closed; one concrete test-closure blocker remains before freeze.**

**Residual Blocking**
- `apps/zody-cli/packages/bootstrap/tests/v4-native-commands.test.ts` is missing from R46’s test set and from `serialHandoffs.R20_writeSet_overlap`. Its line 1519 asserts `module: "bootstrap.zcode_protocol_v4.commands"` from the `session-flow.ts` stop path. After `session-flow.ts:209` changes to `bootstrap.zody_protocol_v4.commands`, this existing test will fail. Add it to R46 tests and the R20 handoff. Then counts become 41 production / 37 tests / 3 docs, with R20 overlap 76.

**Closed**
- Counts are now 41 production / 36 tests / 3 documents; no test files remain in production.
- `baselineComparison` is independently confirmed: 77 existing candidate blobs are identical between `8d953d3c` and `04860520`; the three documents are absent in both.
- R43 is sealed at `04860520`; R46 records that R45 acceptance and a post-R45 rebind are required. R43 intersection remains empty.
- R45 overlap is exact: `create-app.ts` plus the four test files. R20 overlap is exact at 75 paths.
- The missing literals are present in `reviewSupplement.missedLiterals`: `create-app.ts:204` startupKind, and the three module paths in `ai-sdk-warning-logger.ts:25`, `session-flow.ts:209`, and `fork-edit-retry.ts:27`.
- `restore-conversation.mjs:494` is now in production and `agentPersistence.producers`; `server-operations.ts:1080/1180/1194` has per-occurrence classification.
- SQLite validation now explicitly requires file-backed write, close, real-adapter reopen, old-value verbatim read, and separate new-default/custom-agent roundtrip.
- Lifecycle plan now names the actual marker producer, `zodyAgentProcessManager`, and Desktop ARMS chain, with exactly-once/duplicate-drop assertions.
- `createLogger("zcode")` producers and the retention `create("zcode")` path are enumerated; `adapters/tests/logging.test.ts` is included.
- OTLP/desktop/renderer mappings, stable `zcode:session_create:v1` seed preservation, no-dual-emit rules, agent schema compatibility, and the real local collector counting plan remain covered.

**Validation Gaps**
- `startupKind: "zcode_app"` has no existing dedicated assertion; add one to an included startup/logging test.
- The restore script has no test path yet; `diskRoundtrip` says “where feasible.” Add a temp-file SQLite script test or explicitly record static-only verification as a residual.
- The four new literals and logger category are in `reviewSupplement`, while `mapping.structuredLogValues` still has only the original 65 values. Fold them into the primary mapping or declare `reviewSupplement` authoritative to avoid implementation drift.
- `logging.test.ts` currently exercises `createLogger("test")` and retention filenames, not the exact `create("zcode")` output/retention case; add that assertion.
- Confirm whether service logger scopes such as `createServiceLogger("zcode-agent")` are intentionally preserved identities or also in scope; the current logger closure covers `createLogger("zcode")` only.

No tests, builds, services, or writes were performed.
