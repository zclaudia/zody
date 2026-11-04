# R46 scope review 1

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a46c-fb33-7720-8cee-047c7ae90cb1`, DeepSeek. Scope only, before implementation. Subsequent revised proposal addresses these findings; this record remains the original verdict.

**Scope Verdict: CHANGES REQUIRED**

The R46 proposal is close, but it is not scope-complete for the stated telemetry/log cutover and persistent-agent boundary. Read-only review only; no implementation, tests, build, services, or real-user-data inspection.

**Blocking Scope Gaps**
- Structured logger tags are incomplete. The proposal says `startupKind` and related `module`/`entrypoint` fields switch atomically, but the candidate omits:
  - `apps/zody-cli/packages/bootstrap/src/app/create-app.ts:204` — `startupKind: "zcode_app"`; only `zcode_protocol_agent` is mapped.
  - `apps/zody-cli/packages/bootstrap/src/zody-protocol/ai-sdk-warning-logger.ts:25` — `module: "bootstrap.zcode_protocol"`.
  - `apps/zody-cli/packages/bootstrap/src/zody-protocol-v4/commands/handlers/session-flow.ts:209` — `module: "bootstrap.zcode_protocol_v4.commands"`.
  - `apps/zody-cli/packages/bootstrap/src/zody-protocol-v4/commands/handlers/fork-edit-retry.ts:27` — same module constant.
  These are exactly the structured tags the proposal says must not remain old. Without them, the “zero old tags” assertion and single-generation logger cut cannot pass.
- A new-write persistent-agent producer is omitted: `apps/zody-cli/packages/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts/restore-conversation.mjs:494` writes `agent: "zcode-agent"` directly into restored message rows. It is not in `agentPersistence.producers`, so restored sessions would continue writing the old default despite the new `zody-agent` decision. Include it or explicitly document why this historical-restore path must remain old, with a roundtrip test.
- `apps/zody-cli/packages/bootstrap/src/zody-protocol/server-operations.ts:1080,1180,1194` is listed only at path level, but contains three hardcoded `agent: "zcode-agent"` occurrences. The proposal needs occurrence-level expected values/tests; otherwise “explicit `agentName` unchanged” versus “new import writes” is ambiguous.
- Candidate counts are misclassified: `proposedWriteSet.production` includes `apps/zody-cli/packages/telemetry/tests/bootstrap.test.ts` and `.../compatibility-adapters.test.ts`. Actual counts are 33 production paths, 33 test paths, 3 documents, not 35 production + 31 tests.

**Ownership / Ordering**
- R43 intersection `[]` is verified; R43’s active write set does not overlap R46.
- R45 is a real handoff risk: R46 shares four tests with R45’s `proposedWriteSet.existing`: `apps/zody-cli/packages/bootstrap/tests/session-persistence.test.ts`, `.../zody-protocol.test.ts`, `apps/zody-cli/packages/core/tests/runtime-persistence.test.ts`, and `packages/ui/test/zodySessionProjection.test.ts`. Add an explicit R45 intersection/rebind record; the current JSON only records R43.
- Several omitted or proposed paths are in R20’s write set (`create-app.ts`, `ai-sdk-warning-logger.ts`, `session-flow.ts`, `fork-edit-retry.ts`, the restore script, and `interaction-background.ts`). R20 remains `controller-authorized-through-R20.4-constrained-symbols`; confirm R20 closure or obtain a path-level handoff before locking R46.

**Covered Correctly**
- OTLP literal coverage is complete for the ten named-literal files: CLI metrics, trace runtime/support, bootstrap, exporter, renderer action trace, local TTFT exporter/spans, and data-size telemetry.
- Desktop TTFT service/resource/schema/views, renderer instrumentation scope/service literal, and data-size event name, `event_name`, `metric_kind`, and byte property are mapped.
- Stable dedup seed is preserved: `packages/services/src/telemetry/telemetryCore.ts:36` keeps `["zcode:session_create:v1", userId, sessionId]`; `telemetryDeliveryReliability` covers cross-restart/retry identity.
- No-double-emit design is sound: shared lifecycle marker producer, process-manager injection, and `appARMSBootstrap` suppression remain one path; R41 `[zcode-process-exception]` is explicitly excluded.
- Collector plan is meaningful: it uses the existing local gzip/protobuf `otlp-integration.test.ts` server and counts decoded spans/points rather than HTTP batches.
- Persistent-agent schema/read path is sound: `nonEmptyString` accepts old and new values, six core producers plus bootstrap import are identified, no DB migration, and adapter/usage/mapper/UI tests are listed. Historical fixture replacement is explicitly prohibited.

**Validation Gaps to Close**
- Name a concrete temp-file SQLite roundtrip that seeds an old `zcode-agent` message and usage row, reopens the database, and verifies verbatim reads; avoid `:memory:`-only evidence.
- Add tests for `zcode_app` and the three omitted module tags.
- Add a restore-script test if that producer is included.
- Consider an end-to-end assertion that the lifecycle report is emitted exactly once, not only one-sided producer/consumer tests.
- Clarify whether static logger names such as `createLogger("zcode")` (`create-app.ts:195,217`, `zody-protocol-entrypoint.ts:96`, `cli/src/run.ts:510`) are intentionally preserved; they are currently unmapped and should not be swept silently.
