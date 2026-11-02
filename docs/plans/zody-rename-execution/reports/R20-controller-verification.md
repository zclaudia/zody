# R20 controller verification (partial P2)

Base checkpoint: `6c7bd1c0`; subsequent R20.3 working tree. Node 24.14.0, pnpm 10.33.2.

- Parent reran `pnpm typecheck`: exit 0; `pnpm lint`: exit 0, 303 warnings/0 errors.
- Parent ran CUA scope/desktop bundle plus three distribution node:test files: 31/31 pass. After the shared AST helper extraction/literal-argument regression fix, parent reran the two CUA files: 13/13 pass. Logs: `output/zody-rename-validation/R20-3-controller-*.log`.
- First targeted format check failed four new/changed guard files. Terra formatted the six affected helper/caller/test files and reported a clean targeted check.
- Parent reviewed the three guard consumers and the pure TypeScript AST helper; actual module references are parsed while comments/ordinary strings are not treated as imports.
- Parent verified the historical staging-backup fixture equals the original f5dcc6ba old-path bytes after directory migration.
- Earlier native diff was exactly the four authorized active entry sources and one current BUILD guide; snapshots/pins were not updated.
- Actual compiled outputs exist (hashes below); Terra ran their version entrypoints. These are intermediate build evidence, not a final release/source-tree certification.
- Provider build test remains 13/14 due absent active CUA frozen manifest. Full architecture still has the two recorded baseline failures; a changed-only pass does not clear them.
- R20.4 internal symbols/basenames, remaining active docs, private bin link refresh, R21 generated inventory/graph and final clean installation/build gates remain incomplete. The nested-workspace ownership choice awaits the user's answer.

{
"apps/zody-cli/packages/cli/dist/zody.cjs": "bef85204946b7cbf80a90c34b6ebcd181a31141044f3f56dc819f7880ab2727e",
"packages/server/dist/remote/zody-server.cjs": "755b32a3b3d63ef90724b57611a1354ded148f3c6e2b88e2b3d36ad922cffa6c"
}

## Review-2 corrective candidate (2026-11-03)

Controller reviewed the cold-cache plugin seed test and actual monorepo-vs-staged candidates, both guide path fallback cases, four source-tree test imports and both SEA blob producer/consumer strings. A source-regex mirror test was removed; SEA runtime generation remains unverified.

Pinned Node 24.14.0: root `pnpm typecheck` exit 0, `pnpm lint` exit 0 (303 warnings), root `pnpm exec vitest run packages/ui/test/skillsSection.test.ts` 12/12, and `node --test apps/zody-cli/packages/cli/tests/build-sea.test.mjs` 43/43. Logs: `output/zody-rename-validation/controller-review2-{types,lint,ui,sea}.log`. CLI targeted re-run is recorded separately once complete.

R20.4 preparation found further stale module mock paths and export keys around ProcessManager. These remain assigned to the semantic class-and-consumer migration; this corrective checkpoint is not R20/P2 completion.

Controller CLI re-run: cwd `apps/zody-cli`, `pnpm exec vitest run packages/bootstrap/tests/bundled-plugins-resilience.test.ts packages/bootstrap/tests/dynamic-workflow-skill.test.ts packages/bootstrap/tests/zody-guide-path-contract.test.ts packages/node-repl-host/test/computer-use-onboarding.test.ts packages/node-repl-host/test/mcp-server.test.ts` exited 0, 5 files / 71 tests passed. Log: `output/zody-rename-validation/controller-review2-cli.log`.
