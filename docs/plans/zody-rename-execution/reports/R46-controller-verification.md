# R46 controller verification

Controller independently verified all 98 assigned source/spec/test/report hashes against the sealed implementation snapshot. Across 48 production paths, 232 changed blocks contain only the approved name replacements; this text comparison does not substitute for producer/consumer behavior tests. The later review corrections changed tests and reporting only. R45 media resolver behavior was not changed.

The controller used pinned Node 24.14.0 and pnpm 10.33.2 with a complete environment allowlist and isolated HOME/USERPROFILE/TMP/XDG. Existing dependencies were reused. Seventeen runner records and their raw logs are hash-registered in `output/zody-rename-r46/controller/results.json`. By-file results after exact failure reruns cover 43 runnable files and 1,240 unique cases: 473 initially passing root cases plus the corrected 40-case Agent service file, adapters 60, bootstrap 288, CLI 174, core 168, and telemetry 37. Targeted review-fix reruns overlap these counts and are not added again.

- Root typecheck and lint passed before and after the test corrections; lint retained 303 warnings. Changed architecture passed with zero violations. CLI typecheck completed 34/34 tasks, 11 cached.
- The root focused run initially failed 12 cases because six positive R40 protocol fixture/assertion values remained old. Only those values were corrected, preserving legacy optional-field retry behavior; the complete affected file then passed 40/40.
- The controller initially invoked a Node test file with Vitest. That runner mismatch remains recorded; the package-declared Node test entry passed 174/174 without a product change.
- Independent review found the pending TTFT E2E's stale filter and strengthened actual histogram point/count, trace/metric resource and scope, and real logger producer assertions. The corrected collector, TTFT, and bootstrap/restore reruns passed 2/2, 2/2, and 9/9 respectively.
- A failed root test left a synthetic Node child. Its exact PID, start time, fixed executable, command and task-owned cwd were checked before termination; absence was verified in `orphan-cleanup-01.json`.

The implementation worker's earlier runs isolated directories but inherited other environment variables; they are not described as a complete allowlist. Original failures, snapshots, and logs remain preserved. Three formal E2E files were synchronized but not executed or promoted. Prior R22 full-suite failures, strict 19 license obligations, default arm64 CUA, mobile/cross-platform execution and signing/release remain separate. R46 did not rebuild Desktop; retained Desktop/Agent artifacts remain associated with accepted R45 source `4f5f9951`, with only three recorded TypeScript incremental-cache changes after checks.

The controller adopts the independent scoped R46 acceptance. Stage cleanup and post-cleanup evidence are recorded separately in `R46-cleanup.md`; no full-suite or release pass is implied.
