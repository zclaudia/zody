# R20 shell/doc tail controller verification and cleanup

Baseline: `e55cda50c6c4ef2be3af38148fc780e159db6960`. DeepSeek independently accepted the six-path candidate. The controller checked all six source hashes, seven raw logs, exact shell executable-content equivalence after the two identifier mappings, and historical document body preservation except the one authorized current comparison cell. Two explanatory comments were corrected after the tests; executable shell content did not change.

The existing fake-tool doctor suite passed 9/9, `bash -n` passed, and root `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` passed. Lint retains 303 warnings. Tests used synthetic tools and isolated environment; no real app/signing/notarization, dependency installation or new worktree occurred.

After scoped acceptance, the controller reviewed the exact four task roots and journaled executor, then moved them on the same volume and deleted only one Node compile cache. Source, all seven logs, latest R20 isolated host bundle and R45 runtime were checked before and after. Native post-audit found zero errors: four old roots absent, 24 retained directories matching, three obsolete cache entries absent, six source/spec/report hashes and seven log hashes intact. R45's 6,710 entries match original runtime bytes plus the three already-recorded incremental-cache values; no new cache delta. Three needed worktrees and two branches remain.

Observed volume availability increased by 1,310,720 bytes (1.25 MiB), from 38,748,303,360 to 38,749,614,080 bytes during execution. This is a concurrent APFS snapshot, not exclusive physical reclamation. Full manifest, move mapping, fsynced journal and post-audit are under `output/zody-rename-cleanup-20261104/r20-shell-doc-preflight/`; cleanup already ran and must not be rerun.

R20 process markers, R40 errors/mobile/Agent wire and R50–R55 plugin contracts remain separate scopes. Existing full-suite and release limitations are unchanged.
