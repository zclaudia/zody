# W4 controller verification

Baseline `71acf64f573303f2415d750128fea23c009463e8`; R41, R42 and R44 source owners stopped before shared checks. Exact argv, isolated HOME/TMP/XDG, tool paths and exit codes are in `output/zody-rename-w4/integration/results.json`. All checks use pinned Node 24.14.0 and pnpm 10.33.2. The final source snapshot has 117 files with no mismatch against the workers' final hashes; the 125 changed/new paths audited at that checkpoint belong to the authorized W4 write sets or controller plans/reports.

- Root `typecheck-02`, `lint-02`, and `architecture-02`: exit 0. Lint reports 303 warnings; changed architecture reports zero violations. These checks follow the R44 coexistence/consumer corrections.
- CLI `cli-typecheck-01`: exit 0, 34/34 tasks successful (11 cached).
- `focused-controller-01`: 12 files, 162 tests passed; includes all nine R42 files, RemoteServer real-child handshake tests, main preload and account envelope.
- After the R44 review corrections, `r44-controller-correction-01`: 3 files, 79 tests passed, including retired-key coexistence rejection and the real Main/preload CUA channel pair. Counts overlap the earlier suite and must not be added as unique tests.
- `git diff --check` passed. R41 and R42 have independent scoped acceptance and stage cleanup. R44 corrected code and real ordinary-Host main-bridge smoke now have independent bounded acceptance; see `R44-independent-acceptance.md`.

The default darwin/arm64 Desktop build fails at the missing frozen CUA manifest. The separately documented x64-target JavaScript configuration uses the ordinary Host path with actual arm64 Electron; it can validate the main bridge but cannot clear the default build, native CUA, or R60 release gate. Preserve all failed and successful attempts under `output/zody-rename-r44/desktop-smoke`.

Real Electron run5 exits 0 and verifies new main bridge, retired bridge absence, locale IPC, visible workspace UI, isolated user/session data, Host channels/database and orderly Host exit. Provider count is zero and Agent is not started; this is not conversation validation. The first probe misread `activated:false`, and two subsequent probes missed asynchronous welcome-page handling; their failures are retained separately from the successful real-UI run. Controller inspected the screenshot and Host logs, then verified all 6,709 entries in the current output manifest and its 117-source association. R44 stage cleanup is complete (`R44-cleanup.md`).

R22's historical complete-unit, Main, architecture/knip and release limitations remain unchanged. These scoped checks do not establish full-suite, real mixed-version SSH/mobile/browser, other-platform, frozen CUA, signing or release success. R48 and R60/R61 retain their respective gates.
