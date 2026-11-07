# Dynamic Workflow: Quota Resume and Failure Shutdown (spec)

Status: implemented (F24, tier2 upstream v3.17.1, source SHA a60ba6a7). This document is
the product spec for two rules that keep a workflow run from being stranded when the
provider refuses it in a way the failure classifier does not fully understand:

1. **Quota auto-resume** — a run stopped on a usage cap resumes by itself once the cap
   resets, when the stop record carries a reset time. Implemented by a new host module in
   `packages/bootstrap` (`dynamic-workflow-quota-resume.ts`) plus a provenance upgrade of
   the reset time in `packages/adapters`.
2. **Shutdown on unrecognized business codes** — a provider business code the classifier
   does not know, returned _consecutively_ within one request, stops the run instead of
   being retried forever. Implemented in the policy table in `packages/adapters`
   (`model/workflow-model-failure-policy.ts`); the table itself is documented in
   `concurrency.md` ("The policy table").

Implementation landed in step F24② (adapters: streak semantics + reset-time provenance in
`workflow-model-failure-policy.ts`, streak counting in `runner-generate.ts` /
`runner-stream.ts`; bootstrap: `dynamic-workflow-quota-resume.ts` wired in `create-app.ts`
after the workflow facade, disposed before the run service closes). Acceptance scenarios
S1–S9 are covered by `adapters/tests/workflow-model-failure-policy.test.ts` and
`bootstrap/tests/dynamic-workflow-quota-resume.test.ts`. Nothing here changes
main-conversation behaviour: under a `default` (bounded) retry budget the classifier's
`retryable` flag is consulted exactly as before.

## Why

Two observed failure shapes strand a run:

- A subagent hits `1308` / `1310` (the five-hour or weekly/monthly cap exhausted) and the
  whole run stops as `stopped(provider)`, kind `quota`. Somebody — the user or the main
  agent — then has to remember to call `ResumeWorkflowRun` hours later. Upstream's field
  evidence (one heavy user, 20 days of logs): 22 runs stopped on a cap, 17 were resumed by
  hand, 5 were simply left. The reset time is already known at the moment of the stop; the
  run can wait it out itself.
- The server returns a business code the classifier does not know (`1113`, 2026-10-16
  incident) on every request, deterministically, for a set of accounts. Workflow traffic
  carries an unbounded retry budget, so the run retried it forever and hung; only the stall
  notice said anything. An unknown code may also be transient, so the first occurrence must
  not stop the run — but a _consecutive run_ of them is deterministic until proven
  otherwise.

## Product rules

### R1 — What the quota stop records

| Rule                                     | Value                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quota stop detection                     | provider code in `WORKFLOW_QUOTA_PROVIDER_CODES` (`1005`, `1308`, `1310`, `1313`, `1316`–`1321`, `2056`, `20097`, `insufficient_quota`, `credit_balance_exhausted`, the spend- and usage-limit codes), judged by **code before reason**                                                                        |
| Reset time, first source                 | the provider's `Retry-After`, as `now + retryAfterMs`                                                                                                                                                                                                                                                          |
| Reset time, fallback                     | the provider's message text: `您的限额将在 YYYY-MM-DD HH:MM:SS 重置` — a time without a zone, read as Beijing time (UTC+8); only read when the message really is about a reset (it says 重置 / reset)                                                                                                          |
| Plausibility window for **both** sources | epoch ms no earlier than `now − 24 h` (clock skew) and no later than `now + 35 d` (weekly and monthly caps); a value outside the window is discarded — an abnormal or hostile `Retry-After` (years of seconds) must not be able to write a nonsense time into the stop record more easily than the message can |
| No reset time → no auto-resume           | a quota stop without a usable reset time (e.g. `1005`, an exhausted balance: there is nothing to wait for) records no `resetAt` and is never auto-resumed; it only notifies                                                                                                                                    |
| Stop record owner                        | `failure.providerStop` (`ProviderStopDetails`) on the journal run row, written once by the driver settle path (`providerStopError` in `packages/bootstrap`); `resetAt` is present only when parseable                                                                                                          |

### R2 — Quota auto-resume (the host module)

| Rule                              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fire time                         | `resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS` (60 s). The margin absorbs per-second server window rounding and client clock skew; arriving early only hits the cap again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Sole source of truth              | the journal run row (`dwf_run`). The timer only _wakes_ the module; at wake it re-reads the row and resumes only if the row is still `stopped` / `provider` / quota / the same `resetAt`. Manual `ResumeWorkflowRun`, an `AmendWorkflow` supersede, or a stop for any other reason have all rewritten the row by then and are respected — no in-memory state is reconciled against the store                                                                                                                                                                                                                                                                                                                                             |
| Two entries                       | (a) the run-settled subscription in this process (`subscribeRunSettled`); (b) the cold-start scan when the session App is constructed — the session's most recent runs (limit 64, the same order of magnitude as the run list) are scanned, an already-due quota stop resumes immediately (timer delay 0), a future one is scheduled. A stopped run does not keep its App resident; the cold-start scan is the catch-up for a timer that died with the process. Nothing resumes a run of a session nobody opens                                                                                                                                                                                                                          |
| Same path as the app's Resume     | the injected resume callback goes through the session's execution boundary → `port.resume` → the runtime re-arms tracking, so the resumed run keeps its terminal notification, its background-task entry and its residency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| No loop                           | per process, per run: the module remembers the `resetAt` it last auto-resumed on. If the run stops on the same reset time again — or an earlier one — the module does **not** resume it again in that process, cancels any pending retry for it, and logs `dynamic_workflow.quota_resume.not_advancing`. A later reset time is a new window and is scheduled as usual. Without this rule the run would hit the cap once per margin                                                                                                                                                                                                                                                                                                       |
| Spacing                           | per process, per run: each auto-resume pushes the earliest next one further out — `WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS` (10 min) after the previous resume start, doubling each time, capped at `WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS` (60 min). The no-loop rule catches a reset time that does not move; spacing catches one that moves but is _wrong_ (a provider answering a quota stop with a `Retry-After` of a few seconds would otherwise resume the run every minute). Real quota windows are hours apart, so the spacing never delays a healthy resume                                                                                                                                                                        |
| Timer ceiling                     | `setTimeout` caps at 2 147 483 647 ms (~24.8 days). A monthly cap can be further out: the module wakes at the ceiling, re-reads the row, and re-arms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Transient refusals, bounded retry | only `already_running` (the run is in flight in this process, e.g. the user pressed Resume at the same moment) and a thrown error (execution boundary, close race) are retried: one margin later, at most `WORKFLOW_QUOTA_RESUME_RETRY_LIMIT` (2) times, and every retry re-reads the row first like any firing — a run that did start in the meantime is left alone. All other refusals (`not_found`, `not_resumable`, `superseded`, `script_missing`, `script_mismatch`, `compile_failed`) mean the run cannot be resumed as it is: logged (`…refused`), never retried. After the last retry the module logs `dynamic_workflow.quota_resume.gave_up`; the row is still a quota stop, so the next cold start of the session tries again |
| Failures never escape the host    | every journal read on the timer, retry and run-settled paths is guarded like the cold-start scan: an exception is logged with a clipped message (≤ 500 chars) as `dynamic_workflow.quota_resume.read_failed` and that run is simply not resumed this time. The injected resume is wrapped so a synchronous throw also lands in the failure branch. No exception escapes a timer callback or a subscription callback                                                                                                                                                                                                                                                                                                                      |
| Shutdown                          | App close disposes the module before the run service closes: unsubscribe from run-settled, cancel every timer. `dispose()` is idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The module holds **no durable state**: its maps (pending timers, last-resumed-on reset time,
resume starts) are process-local and rebuilt by the cold-start scan.

### R3 — Shutdown on unrecognized business codes

| Rule                                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What counts as unrecognized            | a failure with reason `unknown` **and** a provider business code present (a code the classifier does not know, e.g. `1113`)                                                                                                                                                                                                                                                                                                                                           |
| The cap                                | `WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE` = 10, counted **consecutively within one request**, including the first occurrence                                                                                                                                                                                                                                                                                                                                       |
| Consecutive, not cumulative            | the counter is a per-request streak in the runner's attempt loop (`nextUnrecognizedCodeStreak`): +1 when this failure is an unrecognized code, reset to 0 by any other failure (network error, 5xx, rate limit). Nine network errors followed by one unknown code is a streak of 1 and retries; unknown codes alternating with network errors never stop the run. Ten unknown codes in a row stop it — about six minutes of backoff when nothing else interrupts them |
| Both paths that see a failure count it | the catch around the request (`runner-generate.ts`) and the in-stream error chunk (`runner-stream.ts`) — the two retry-gate call sites share the streak                                                                                                                                                                                                                                                                                                               |
| Decision                               | at streak ≥ 10 the policy table returns `stop` with kind `other`; the run stops as `stopped(provider)` and is resumable once the cause is fixed                                                                                                                                                                                                                                                                                                                       |
| Streak propagation                     | the runner passes the streak into the policy table, and the adapter error carries it as `unrecognizedCodeStreak`, so the driver's inspection reads the same number and reaches the same stop (one function, one input, both sides)                                                                                                                                                                                                                                    |
| Everything else retries                | rate limits, overload, 5xx, timeouts, network and TLS errors, an unrecognized code below the streak cap, a response the adapter could not parse — all remain `retry` under an unbounded budget. Bounded (main-conversation) budgets are untouched                                                                                                                                                                                                                     |

## State owners

| State                                                                 | Owner                                                                    | Lifetime                                      | Write path                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| run status / stopReason / `failure.providerStop` (incl. `resetAt`)    | the journal run row `dwf_run`                                            | durable, per run                              | the engine settle path only (single writer; the stop record is shaped by `providerStopError`, `packages/bootstrap`) |
| unrecognized-code streak                                              | the runner's attempt loop, per request                                   | one request (the loop ends on success)        | `nextUnrecognizedCodeStreak`, carried onto the adapter error as `unrecognizedCodeStreak`                            |
| pending quota-resume timers, last-resumed-on `resetAt`, resume starts | the host module `dynamic-workflow-quota-resume.ts`, per process, per run | process-local; rebuilt by the cold-start scan | `startWorkflowQuotaAutoResume` only                                                                                 |
| the resume itself                                                     | the session's execution boundary → `DynamicWorkflowRunPort.resume`       | per invocation                                | injected callback; no second write path to the journal                                                              |

No state lives in two places: the module never caches the stop record beyond the `resetAt`
keys described above, and never writes the journal.

## Interfaces and dependency direction

```
packages/contracts          DynamicWorkflowRunResumeResult / …ErrorReason, Logger
      ▲
packages/dynamic-workflow   JournalStorePort (getRun; listRunsByParentSession via
      ▲                     adapters storage), RunRecord, ProviderStopDetails
packages/adapters           resolveWorkflowModelFailurePolicy(failure, providerCode,
      ▲                       unrecognizedCodeStreak?), retryAllowedByFailurePolicy,
      |                     nextUnrecognizedCodeStreak, parseQuotaResetAt(message, now),
      |                     isPlausibleQuotaResetAt(at, now), inspectWorkflowModelFailure
packages/bootstrap          dynamic-workflow-quota-resume.ts (new):
                            startWorkflowQuotaAutoResume(deps) → { dispose() },
                            quotaResumeAt(row) (pure predicate, the single judge);
                            create-app wires deps: journal, parentSessionId,
                            subscribeRunSettled, resume, clock, logger
```

Dependencies point downward only (bootstrap → adapters/dynamic-workflow/contracts). The
resume callback and the clock are injected, so tests drive the module with a fake clock
without a real timer; `quotaResumeAt` is a pure function shared by the schedule and the
wake-up re-check, so the criterion exists in exactly one place.

## Event order

```text
 run stops on 1308 ──► engine settles ──► journal row: stopped / provider
                       │                    { kind: "quota", resetAt: T }
                       ▼
        ┌────────────────────────────┐   ┌────────────────────────────────┐
        │ this process               │   │ session App constructed        │
        │ run-settled notice ────────┼──►│ cold-start scan (≤ 64 rows)    │
        └────────────────────────────┘   └───────────────┬────────────────┘
                       ▼                                ▼
                 read row ──► quotaResumeAt = T + 60 s ──► arm timer
                 (timer delay = max(0, fire time − now), floored by spacing)
                       ▼
                 timer fires ──► read row again
                       ├── still stopped / provider / quota, same T, T + 60 s ≤ now
                       │        ──► resume (same path as the app's Resume)
                       │             ├── ok ──────────────────────► done
                       │             ├── refused already_running / threw
                       │             │        ──► retry ≤ 2 × one margin (re-read first)
                       │             └── refused otherwise ──► log, never retry
                       ├── a different T ──► arm again at T' + 60 s
                       │        (the no-loop rule drops it if it did not advance)
                       └── anything else (resumed by hand, superseded, …) ──► nothing
```

Owner annotations: the engine owns settling and the row; the host module owns timers and
wakes; the execution boundary owns the resume; the journal is read-only to the module.

## Idempotency boundaries

- Re-arming replaces: a second `consider` for the same run cancels the pending timer before
  setting the new one; there is never more than one timer per run.
- The wake-up re-check is the idempotency boundary of the resume itself: firing twice on
  the same row resumes once, because the first successful resume rewrites the row (status
  leaves `stopped`), and `already_running` covers the in-flight window.
- The no-loop map makes auto-resume at most once per (run, resetAt) per process.
- `dispose()` twice is a no-op; timers cancelled once.
- The streak is per request: a resumed run starts its attempt loops from zero.

## Acceptance scenarios

Unit level, per package (naming follows each suite, e.g. `dynamic-workflow-quota-resume.test.ts`
in `bootstrap/tests/`, additions to `workflow-model-failure-policy.test.ts` in
`adapters/tests/`). Each numbered scenario is a behaviour change with a counter-example:
S1, S2 and S4–S9 did not hold before the implementation landed (no module, no streak, no
message-parsed reset time — verified by running the new tests against the pre-F24② code,
five adapter assertions failing and the bootstrap suite failing on the missing module);
S3 is the unchanged-behaviour guard and passes before and after.

Adapters — policy and provenance:

- **S1 streak stop**: reason `unknown` with provider code `1113`, `unrecognizedCodeStreak = 10`
  → `stop`, kind `other`. Counter-example at streak 9 → `retry`.
- **S2 streak reset**: streak 9, then one network failure → `nextUnrecognizedCodeStreak`
  returns 0; nine network errors then one unknown code = streak 1 → `retry`.
- **S3 recognized transient untouched**: 429 rate limit (`3008`), 5xx, TLS — `retry`, with
  and without a streak in flight; bounded budgets still read the classifier flag.
- **S4 reset time provenance**: quota code with `retryAfterMs` inside the window →
  `resetAt = now + retryAfterMs`; implausible header (outside ± window) discarded and the
  message time used instead; message `…重置` time parsed as UTC+8; no plausible source →
  no `resetAt`.

Bootstrap — auto-resume:

- **S5 fires at the point**: row `stopped`/`provider`, quota, `resetAt = T`; module armed at
  settle; fake clock advanced to `T + 60 s` → resume called exactly once, on the injected
  callback. Counter-example: before `T + 60 s` no call (advancing to `T + 59 s` fires
  nothing).
- **S6 no loop**: after an auto-resume the run stops again with the **same** (or an earlier)
  `resetAt` → no further resume in this process, pending retry cancelled, warning logged.
  A later `resetAt` is armed again.
- **S7 spacing**: second auto-resume of the same run is not started before 10 min after the
  first start, the third before 20 min (doubling), and never later than 60 min after the
  previous start.
- **S8 row is the truth**: timer fires but the row no longer reads quota-stop-on-the-same
  `resetAt` — resumed by hand (status left `running`), superseded
  (`stopReason: "superseded"`), or stopped for another reason (e.g. `user`) → no resume
  call. Cold start with an already-due quota stop resumes immediately (delay 0).
- **S9 transient refusal bounded**: resume returns `already_running` → one retry after a
  margin, then another at the limit, then `gave_up`; `superseded` → no retry; a journal read
  that throws → logged, no resume, nothing escapes the callback.

E2E posture: this feature has no interactive surface (no UI, no protocol change); it is a
host-side policy, so it is not in the e2e-case-lifecycle registry. The existing
fault-matrix bed (`bootstrap/tests/workflow-fault-matrix.stop.test.ts`, `FakeProviderServer`
on loopback, cell B11 "五小时用量上限 429/1308") already exercises the quota stop
end-to-end against a fake provider and remains the natural place to extend with an
unknown-code cell and a resume-after-reset cell if field evidence asks for one; the
F24② port is validated by the two unit suites above.

## Non-goals

- No retry of quota stops inside the attempt loop (quota stays a `stop`).
- No cross-process coordination: two processes on one session each may scan; the row
  re-check and `already_running` keep it safe.
- No change to main-conversation (bounded-budget) retry behaviour.
- No scheduler persistence: a timer that dies with the process is replaced by the next
  cold-start scan, not by a queue.
- The stop notification wording (telling the main agent the run resumes by itself and not
  to call `ResumeWorkflowRun` before the reset) is a follow-up on
  `transcript-and-notifications.md` and is not part of F24.
