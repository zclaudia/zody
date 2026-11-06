# R47 local runtime19 subset

Date: 2026-11-05 (Asia/Shanghai). Base HEAD: `e4834fe2709763047d4d439f83212159898f150d`.

## Result

The local Desktop trust/restart/source-move subset passed in runtime19. This is a subset result, not a complete R47, remote-routing, R48 or full-rename result.

- Validation result: `output/zody-rename-r47-desktop-restart/validation-worktree/output/r47-harness/results/result.json`, SHA-256 `76690e04e1f24988fd61f8146e5c78d65effd594214984b83b5e3a427ffb2ed9`; harness exit 0, `remaining=[]`, no first error.
- Functional evidence: `output/zody-rename-r47-desktop-restart/controller/runtime19-functional-evidence.md`, SHA-256 `11645a82e28b64dc23e292c75561ea34dea698907d635f25fba584dbe5ff5efb`.
- Three real Electron launches completed with three Host/Agent readiness records and strong process identities: 4302/4627, 5091/5194 and 5805/5865.
- Four distinct replay IDs completed: `7c561556-b540-483b-9430-28262104f032`, `ae6e58f7-b733-4361-b6ae-d4e80aae3643`, `27c4c713-1f43-4209-8788-79ae48ef5a81` and `090a045f-a186-4451-bb53-d4e83a1b2530`. The synthetic model was `deepseek-v4-flash`; persisted provider configuration stayed stable and contained one provider/model.
- Hook flow behaved as designed: before authorization the pending banner appeared with recorder count 0; after the real UI grant the count was 1; after a full close/restart the count was 2 with trust bytes unchanged. Moving the source from `.zcode/config.json` to `.zody/config.json` produced pending again, kept the count at 2 and again left trust bytes unchanged. The grant copy and current trust file both have SHA-256 `fc4d1db0b1a8d0b2ccf27b24cb0fe742257b9e816d007ee63a869a986eb0553f`.
- Exit and recovery checks passed: dotenv inode `166420347` restored, source files 20941 and dependency files 109096 reverified, original outputs `changed=[]`, allocated 994263040 bytes. The result is a path-move negative control, not a content-tamper test.

The conclusion uses actual UI, process identity and synthetic behavior evidence. The Host model-selection view and Agent environment were not directly observed, so this report does not claim that stronger chain was proven.

## Cleanup and retention

- `runtime13` through `runtime19` each retain a cleanup result and review directory under `output/zody-rename-r47-desktop-restart/controller/` (`runtimeN-cache-cleanup.json` and `runtimeN-cleanup-review/`). `runtime13` through `runtime17` have post-cleanup verification status PASS; `runtime18` and `runtime19` use the later review/retained-evidence format. Every stage was limited to reviewed caches and retained current source, logs, results and short roots.
- Runtime19 cleanup: `output/zody-rename-r47-desktop-restart/controller/runtime19-cache-cleanup.json`, SHA-256 `1dccfbf75a0dd9668ee8d53d12b9fce548764390b856dd4c6cb78bf8a2d360dd`. It removed 8 reviewed cache paths / 284 files / 8,318,976 allocated bytes and retained 286 records across 15 short roots; source fixture SHA-256 `dce0a0d8a6cfb4ae2cb315f2db6d506705e771a7754c7a8c895aeffe8726dc0a` and support files were unchanged. Terra post-cleanup PASS and source-freeze release are recorded in `output/zody-rename-post-r47-local/dispatch.json`.
- The latest valid built candidate retained for this phase is `e4834fe2709763047d4d439f83212159898f150d`. It was built once and frozen; no rebuild was performed. The runtime17 and runtime18 failures and their raw evidence remain recorded as failed and were not rewritten by the runtime19 success.

## Limits

Remote `remoteSessionId`/task routing, complete R47, R20, R40, R48 mixed-version integration and the full rename remain outside this result and are not PASS. This documentation update added no tests, build, install, product code, fixture, historical raw-log or prior-failure changes.
