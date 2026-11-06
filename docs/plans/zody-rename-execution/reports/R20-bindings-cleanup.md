# R20 internal bindings stage cleanup

The 94-binding phase received independent scoped acceptance before cleanup. DeepSeek separately reviewed the exact deletion scope and executor; the controller executed the approved script once, then Terra independently audited the remaining files. This is cleanup of task-owned validation data, not a full release acceptance.

Five isolated roots were moved on the same volume into `output/zody-rename-cleanup-20261104/r20-bindings-preflight/preserved-*`. Only three Node/tsx caches, one duplicate computer-use dependency tree and one duplicate old `server.js` were deleted. The dependency tree exactly matched the retained R46 canonical 284-entry tree; the obsolete JS exactly matched the successfully tested new `server.mjs` SHA-256. All failure logs and metadata remain.

Post-cleanup comparison verified 439 retained files, 213 directories, all 241 scoped source paths, 55 raw logs, four spec/review documents, 48 isolated declaration outputs and the successful new host bundle. The original five temporary roots are absent. R45's 6,710 manifest entries match the runtime bytes and three explicitly recorded later TypeScript incremental-cache values; the R45 runtime remains associated with source `4f5f9951`, not this phase. New package exports, shared dependencies, tools, 6fb archives, 7089 server stage and R02 evidence remain. Three needed worktrees and two attached branches were retained.

Observed volume availability increased by **50,278,400 bytes (47.95 MiB)** during the cleanup, from 38,720,974,848 to 38,771,253,248 bytes. This is a concurrent APFS volume snapshot, not an exclusive physical-reclamation measurement.

Exact manifests, preflight review, stepwise execution journal, source/log hashes, relocation mapping and post-audit are retained in `output/zody-rename-cleanup-20261104/r20-bindings-preflight/`. The executor has already run; do not run it again.
