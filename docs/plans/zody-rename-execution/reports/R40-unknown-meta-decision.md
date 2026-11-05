# R40 unknown agent metadata decision

Date: 2026-11-05 (Asia/Shanghai).

## Decision

Keep the currently registered unknown legacy `_meta.zcode` readers in place, register this as an unfinished rename tail, and continue provenance investigation. This is not a claim of a permanent third-party contract, a completed metadata migration, or a reason to stop tracing ownership. The separately approved `apiRetry` and `taskNotification` writer change is outside this hold and remains unchanged.

## Retained fields and reader risk

| Field | Current reader / use | Risk if removed before producer provenance is known |
| --- | --- | --- |
| `parentToolUseId`, `parentToolCallId` | bootstrap `server-operations.ts` live `ModelStreaming` batch keys; `conversation-telemetry-facts.ts` stream identity/telemetry | A nested-only value could lose parent/child grouping and change stream batching or telemetry, not merely display. |
| `nickname` | `packages/ui/src/ToolCallBlocks/renderers/agentHelpers.ts` Agent name/primary text | A nested-only value could fall back to another name or the default display. |
| `agentType`, `agent_type`, `subagent_type` | same Agent renderer, legacy nested Agent-type candidates | A nested-only value could lose the specific Agent category; authoritative/output/input candidates have their own existing precedence. |
| `color` | same renderer, subagent color | A nested-only value could lose the subagent color; direct/input/output aliases remain available. |
| `backgroundAgent` | same renderer reads nested `outputFile`; `agent.tsx` controls background block/file display | A nested-only path could drop the file line and, without another background flag/output file, the background process block. The approved task-notification/output fallbacks stay intact. |
| `toolName` | `packages/ui/src/lib/toolIdentity.ts` known-tool and legacy Agent-family classification | A nested-only value could change tool/Agent classification; direct, `claudeCode` and title/input sources are not aliases of this key. |

## Why retain now

- The investigated readers, synthetic fixtures and pass-through paths are proven consumers, but no actual producer has been proven for these nested fields. The evidence cannot distinguish a live producer, an old compatibility path or a missing producer.
- Hard-cutting the readers could change live batching/telemetry and visible Agent identity or background display for inputs whose real source is still unknown. A green synthetic fixture would not cover that production risk.
- The two confirmed fields `apiRetry` and `taskNotification` already have their own bounded writer scope. This decision must not be used to widen, revert or silently duplicate that work.

## Provenance follow-up

1. Check archived synthetic or official fixtures, SDK/source material with recorded provenance, and event traces for the specific object creation site, not just same-named direct fields.
2. Trace any candidate producer through event/raw -> persisted part metadata -> UI, or through `ModelStreaming` -> batching/telemetry, including exact-once and restore behavior.
3. If a real producer is confirmed, prepare a new exact scope with spec, tests, history policy and independent review; do not add an old/new alias or rewrite stored raw bytes without that grant.
4. Until then, keep the readers and existing precedence/fallbacks. Track the gap as an incomplete rename tail rather than treating it as resolved.

## Boundaries

No production reader, spec, stored raw metadata or historical evidence was changed. No tests, build, install or real-user-data access was performed. The source proposal and investigations remain at `output/zody-rename-w5-preflight/R40-unresolved-meta-decision-proposal.md`, `R40-agent-meta-unresolved-owner-69b5a1.md` and `R40-agent-meta-historical-provenance-fe99.md`; the task-ledger R40 row records the retained status.
