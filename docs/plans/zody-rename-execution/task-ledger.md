# Zody rename execution ledger

Updated: 2026-11-03 (Asia/Shanghai). Goal: implement the full execution plan using Terra; independent DeepSeek review/acceptance; controller integrates and verifies. Latest committed product candidate: `0ed4aa34ffd611c3ec05a90a51759c25bb7a304f`. Type batch04 at677771fe is under independent review; root-only install at7c passed clean host installation/build checks but requires the container corrections now being verified. Manual data paths and directory corrections through3cb have scoped PASS. Full rename and release gates remain incomplete.

- Source base: `033f91783901e6adaf968d3d4b8ca34c41d89442`.
- Frozen plan commit: `06ad2270f121c46a0f5c069ae3da18641c6a9858`.
- Branch: `codex/zody-full-rename`.
- Implementation cwd: `/Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename`.
- Main worktree unrelated changes are preserved; only the two rename plans were copied into this worktree.
- Implementation agents use native `gpt-6.1-terra`; original R00 ownership is historical. Controller now maintains manifest, scopes and this ledger.
- DeepSeek A (`broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cc4-82c8-7cc2-a81c-fee2d8b18b67`) reviews fixed3cb→677 type batch04. B (`broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5`) requested root-owner container fixes at7c. C (`broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cdb-5be9-73f3-9b21-930b5c45f36a`) completed scoped PASS for3cb and closed manual-path tests. All use read-only deepseek-flash / magpie / group/deepseek.
- Broker grant: exact implementation cwd, connection scope, no UI grant.
- Controller owns integration metadata and current product tree. Terra R10 owns only Docker verification and three precise Docker/README files in isolated `output/zody-rename-r21/docker-clean-0ed4aa34`; local detached candidate commits there are authorized for actual fixed-tree rebuilds. Terra R01/R21 have released product/build locks. Prior chronology below is retained as historical evidence; this summary supersedes earlier pending-choice notes.

| Task | Status     | Implementation                    | Review / gate                                                                                                    |
| ---- | ---------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R00  | integrated | /root/terra_r00                   | DeepSeek review-2 PASS for initial dispatch; later scopes gated on contracts                                     |
| R01  | integrated | /root/terra_r01                   | Accepted contracts at 40cae940; later source/doc refinements preserve those contracts |
| R02  | review     | controller / prior Terra evidence | Source preservation and isolated restore gate passed; old runtime smoke recorded. Standalone old server-cli defect and full mixed-mode runtime evidence remain unresolved for R48 |
| R10  | verified   | /root/terra_r10                   | DeepSeek review-2 PASS at 0e403023; P1 scope only, not release validation                                        |
| R20  | running    | /root/terra_r10 + /root/terra_r01 | R20.2/3, symbols through d49, and all198 registered basenames through f28 scoped PASS. Manual data paths at83680ddc under review; full type/binding and residual closure incomplete |
| R21  | running    | /root/terra_r21_links             | User selected root-only installation; Terra implementing root Turbo, CLI task scopes, install docs and container consumers. Earlier root frozen/link evidence does not validate this new candidate   |
| R22  | planned    | unassigned                        | not run                                                                                                          |
| R30  | planned    | unassigned                        | not run                                                                                                          |
| R40  | planned    | unassigned                        | not run                                                                                                          |
| R41  | planned    | unassigned                        | not run                                                                                                          |
| R42  | planned    | unassigned                        | not run                                                                                                          |
| R43  | planned    | unassigned                        | not run                                                                                                          |
| R44  | planned    | unassigned                        | not run                                                                                                          |
| R45  | planned    | unassigned                        | not run                                                                                                          |
| R46  | planned    | unassigned                        | not run                                                                                                          |
| R47  | planned    | unassigned                        | not run                                                                                                          |
| R48  | planned    | unassigned                        | not run                                                                                                          |
| R50  | planned    | unassigned                        | not run                                                                                                          |
| R51  | planned    | unassigned                        | not run                                                                                                          |
| R52  | planned    | unassigned                        | not run                                                                                                          |
| R53  | planned    | unassigned                        | not run                                                                                                          |
| R54  | planned    | unassigned                        | not run                                                                                                          |
| R55  | planned    | unassigned                        | not run                                                                                                          |
| R56  | planned    | unassigned                        | not run                                                                                                          |
| R60  | planned    | unassigned                        | not run                                                                                                          |
| R61  | planned    | unassigned                        | not run                                                                                                          |

## Historical baseline verification

- Main-worktree freshness: passed, main ahead 37 / behind 0 against origin/main; recorded before worktree creation.
- Implementation baseline has only the frozen plan changes. Product checks and environment preparation tracked below when actually executed.
- No production deploy, public release, signing or UI action has been performed.

## Environment and R00 review progress

- Isolated dependency setup: pnpm 10.33.2 frozen-lockfile install with ignore-scripts; lock unchanged. Initial ambient Node 24.16.0 was replaced for validation by verified official Node 24.14.0 in output/zody-rename-toolchain. Install reported esbuild bin ENOENT warnings; native/build setup is not yet validated.
- Node archive SHA256: a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3, checked against official SHASUMS256.txt.
- Pinned-toolchain baseline typecheck: exit 0. Architecture changed baseline: 0 violations. Lint initial R00 scan produced 304 warnings, 0 errors; its added unused-variable warning was fixed by Terra and target lint now has 0 warnings/errors. Full lint will be rechecked at the next gate.
- R00 raw 53MB scan was rejected by controller. Revision separates 50 actual workspace projects (48 names with legacy marker), 3 non-workspace fixtures and 45 frozen copies; tracked summary references raw evidence under ignored output. Later writeSets remain gated on R01 contracts.
- R10 rename collision identified: scripts/zody-distribution.test.mjs already exists. Must preserve both tests' coverage; never overwrite.
- R01 exact grant expanded by controller to protocol-layer docs, mobile master spec, new specs/zody-rename-runtime-contract.md and correction of survey frozen-input facts. This is within the accepted implementation plan.
- R02 preliminary read-only evidence: reports/R02-preflight.md; archive and two pins match, full restore/old-product validation outstanding. Native frozen source is partly tracked, contrary to the old survey statement.
- DeepSeek known agent remains running as confirmed by wait_agent; not restarted or replaced. Global list_agents failed on an unrelated active writer, so polling uses the known ID.

## R00 review and W1 dispatch

- DeepSeek R00 review-1: CHANGES_REQUIRED, saved in reports/R00-deepseek-review-1.md. Terra fixed explicit external identities, two bootstrap protocol mappings (13 total), runner-test collision and nested lock ownership. Independent re-review is running on the same Broker agent.
- Collision decision: old scripts/zcode-distribution.test.mjs becomes scripts/zody-distribution-runner.test.mjs; existing scripts/zody-distribution.test.mjs keeps its coverage and updates imports. Both remain in CI.
- R01 DeepSeek agent: broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5, same DeepSeek route/model and read-only grant. R01 target specs are not yet marked accepted.
- R02 exact write root: implementation cwd/output/zody-rename-r02, plus its report. Explicit source whitelist is the five named archive/sidecar/manifest/snapshot inputs and recorded acceptance metadata in R02-preflight. No active native/output materials were overwritten. Restore result is pass; old runtime provenance and runtime smoke remain incomplete.
- R10 grant: its file-assignments writeSet plus docs/desktop/configurable-data-directory.md, docs/desktop/dev-deep-link.md and docs/desktop/finder-open-folder-deep-link.md for current-fact corrections. No scope/env/wire/lock/frozen-resource modifications. This is staged implementation, not a completed phase or release.

## Preparation review disposition

- R00 DeepSeek review-2: PASS for initial dispatch scope; saved in reports/R00-deepseek-review-2.md. Count now includes two nested bootstrap protocol moves (13 mappings). It does not assert subsequent interface tasks are already verified.
- R01 DeepSeek review-1: CHANGES_REQUIRED (reports/R01-deepseek-review-1.md), permitting R10 but blocking wire/plugin interface dispatch. Terra has addressed field-level ownership, separate RemoteServer/Agent stdio, Web and mobile consumers, manifest readers and exact env keys; re-review pending.
- R10 completed by Terra, staged for independent review: distribution 17 tests, services process manager 66 tests and official-refs 17 tests reported passing. Controller diff review found only granted P1 changes; independent re-run/review pending. Extra grant includes services process-manager test and third-party/SPEC current script path.

## Current review disposition and dispatch (2026-11-02 continuation)

- Previous goal turn made planning progress, not product completion. Current worktree/known agent handles were revalidated before resuming.
- DeepSeek R01 review-2 PASS is saved; its five nonblocking cleanups are in the working tree. Terra is preserving accepted contracts while merging the latest plan dispatch/checkpoint additions.
- DeepSeek R02 review-1 independently verified the isolated v4 archive/restore hashes. Matching source preservation is the remaining R20 gate; old runtime and final signing/bundle tests remain R48/R60 gates. Terra is reconstructing and hashing source inputs from the recorded baseline and source archive into the isolated R02 evidence root.
- DeepSeek R10 review-1 found an active spec stale path and smoke-entry mismatch. Terra is correcting those and current dev/historical-doc inconsistencies, with a dedicated fixture regression test.
- R10 reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cdb-5be9-73f3-9b21-930b5c45f36a`. R02 uses the original R00 reviewer handle. All three known reviewers are completed, not running, at this snapshot.
- Controller independently ran the R10 candidate's 100 related tests, typecheck and lint successfully. Lint: 303 warnings. Full architecture check failed with two baseline violations (missing Gen UI contract test, plugin UI service 404 lines); unchanged versus source baseline. See reports/R10-controller-verification.md.
- R20 is not dispatched for product writes. No main merge, release, production deployment or trust-root change has occurred.
- Historical sections above preserve earlier evidence chronology; this table and this disposition supersede stale running/pending descriptions.

## R02/R10 corrective candidates

- R01 handoff commit: `5b09af46`; latest plan checkpoints merged without replacing accepted protocol contracts.
- R10 correction commit: `0e403023`; active spec and smoke layout corrected, fixture regression and CI entry added. Controller distribution 18/18, typecheck/lint exit 0 (303 warnings); DeepSeek second review running on its existing handle.
- R02 sealed source preservation: four-entry non-node_modules inputs 1979/1979 verified in source archive; native baseline/stage 34/34 and six patches captured. Controller independently compared all 1979 archive hashes to manifest. Source archive SHA256 `5968df6d10dbeeeec82470c81be3abba51544291e998dba0d65214db6260758e`. Report and evidence are under second review. This is not a successful full rebuild or final signature/runtime gate.
- R20 preflight: Terra R01 may only write `output/zody-rename-r20-preflight/` and expand constrained replacement/file assignments; no product writes until R02/R10 gates and controller scope review.
- R02 old runtime preparation: Terra source-provenance agent may create a detached 033f checkout under `output/zody-rename-r02/legacy-runtime-source`, install/build only there with isolated outputs, and write reports/R02-legacy-runtime.md. No production credentials, UI or trust changes.

## 2026-11-03 R20 scoped implementation dispatch

R02 DeepSeek review-2 accepts source preservation for R20; R48/R60 remain incomplete. R10 review-2 PASS is saved. The controller reviewed exact package/path previews and authorizes only R20.2 through r20-authorized-scope.json; R21-owned graph/inventory/lock content is explicitly excluded, and 3 fixture package names are included. Moves may carry protected files byte-for-byte. DeepSeek preflight review continues on the original immutable preview and can trigger corrections; independent implementation acceptance remains mandatory.

The original preview missed complete internal basename/TS symbol ownership. R20.4 now explicitly owns pure internal declarations/references; its AST candidate is not execution permission until references are resolved. R30/R40–R55 retain serialized values/bridge/env/plugin ownership. Builtin assets/private bin/output mapping is a separate R20.3 closure before phase acceptance. No P2 completion is claimed.

## P2 intermediate checkpoint (not an accepted phase)

- R20.2: all 5364 move targets exist; source writes stopped. CUA bundle 11, distribution 18 and gen-ui 3 tests pass; lint exit 0 (303 warnings). DeepSeek implementation review is running.
- Preflight review corrections expanded three CUA path/guard consumers, protected notices with inventory, and protected six historical documents. Native inspection identified exactly four active entry sources plus one current BUILD guide; only those five native files differ, not frozen snapshots/pins. Controller independently checked the native diff and eight protected files outside active R21 ownership.
- R21 initially missed relative link targets; controller identified dangling zody-cua links. Terra repaired both locks using importer/target resolution, reran root frozen install, verified 92 actual local symlink targets/package names and 19 CLI lock targets statically. Both locks retain original third-party package/snapshot bytes.
- Typecheck after relink still fails: 35 diagnostics, 31 old #src aliases. These are actual pending source repairs, not all environment failures. Full architecture still has two recorded baseline failures.
- CLI standalone workspace has an older 15-importer lock versus 31 current projects and missing outer-workspace packages. A user clarification is pending on one root install owner versus maintaining two workspaces. Do not remove the nested workspace/lock or change dependency ownership without that answer; other source work continues.
- Old runtime: isolated mac builds and Linux container server-info/Agent harness smoke ran; real standalone server-cli fails in both Linux/macOS with bundled CommonJS yazl inside ESM. R02-server-cli-baseline-defect.md records root cause and future candidate repair; this is not a version-gate rejection and cannot satisfy mixed-deployment tests. Containers/processes created by this task were cleaned up.

## R20.3 candidate ready for second review

- Terra repaired all 35 relink-era typecheck diagnostics, completed 9 provider asset/source moves and coordinated CLI/server/SEA binary names, repaired the four DeepSeek implementation findings, and restored the provenance fixture's original bytes.
- Parent independently reran typecheck/lint and 31 related node tests; after final helper extraction reran 13 guard tests. Results passed; lint has 303 warnings. See R20-controller-verification.md.
- R20 source writes are stopped for candidate review. Root private bin links will be refreshed by R21; no nested workspace ownership edits before user response. R20.4 is not yet implemented.
- DeepSeek R02 runtime review limited PASS is saved; its two evidence wording/cleanup gaps were corrected by controller. R48 still lacks the true Host/mixed-mode matrix and an independently runnable old server-cli.

## 2026-11-03 implementation resumed after plan refinement

- Previous goal turn updated the dispatch plan (progress), but did not advance product implementation. The controller revalidated current HEAD `c62caae2a32fb369a1d5b3b8679d7310b320a5a5`, the exact Broker handle and workspace grant before resuming.
- R20.2/3 DeepSeek review-2 is CHANGES_REQUIRED, saved in reports/R20-deepseek-implementation-review-2.md. Missing monorepo plugin source candidates and source-tree test paths are real remaining defects; staged external identities must stay unchanged.
- Terra R10 is the sole product writer for those fixes, the builtin guide path fallback and SEA intermediate name closure. Terra R01 may only prepare semantic rename tooling under its output root and own report until the controller hands over the source lock.
- The root/CLI workspace ownership question remains pending; no nested workspace/lock removal or dependency ownership change is authorized by elapsed time.
- The plan's expanded subtask table was incorporated without replacing the accepted R01 protocol/test contracts. R20.4 authorization is a constrained candidate path set, not permission to rewrite external, serialized or historical identities.

## R20.3 fixed candidate and R20.4 source handoff

- Corrective candidate `854ddf60ac1be92428e3c32192ee325aab6acd25` contains the plugin source/staged boundary fixes and SEA blob closure. Controller independently reproduced 71 CLI + 12 UI + 43 SEA script tests, typecheck and lint (303 warnings); real SEA packaging not run.
- DeepSeek review-3 resumed on the same exact read-only Broker handle against that immutable candidate. Mutable R20.4 source is excluded from its review evidence.
- Terra R10 has stopped writing. Terra R01 now holds the sole source write lock for constrained R20.4. Initial closure covers public types, ProcessManager class/mock export keys and source/test basenames; dynamic and generated declaration provenance require validation.
- 151 template/skill/fixture paths are excluded from automatic binding edits and assigned to R20.5 manual review, not permanent exemptions. Additional current-doc references will be reconciled under the same final residual task.

- DeepSeek review-3 returned scoped PASS for `854ddf60` R20.3 corrections; report saved. This was a fixed-diff review, not an independent runtime test rerun. Remaining staged-layout runtime seed coverage, real SEA build, full architecture disposition, R20.4 and R21/R22 remain explicit gates.

- R20.4 exposed Desktop main tsc errors omitted by root typecheck. Terra R10 independently exported `854ddf60`, performed its own offline frozen install, and reproduced all 85 main diagnostics; controller verified exact normalized raw-log equality against the captured R20.4 snapshot. See R20-desktop-main-baseline.md. No claim that main tsc passes or that subsequent changes are automatically covered.

## R20.4 first-group validation, not yet accepted

- First source candidate covers 7 public types, ProcessManager class and 2 basenames, 5 runtime-env functions, consumers/mocks and real regenerated declaration/map. Controller source/emit byte comparisons passed. No automated changes to the 151 manual-review paths.
- Controller reproduced 113 ProcessManager/runtime/ARMS tests and 1 explicit source-adjacent Gen UI test; root typecheck/lint passed (303 warnings).
- Additional CLI boundary verification exposed stale `adapters/dist` imports: bootstrap tests 14 pass / 5 fail; CLI authority 2 pass but cli.unit startup fails. The source was already renamed. Terra R01 now owns the exclusive build-output lock to rebuild the required actual dependency closure and re-run these tests. Do not restore old exports or mark this candidate accepted based only on the green root tests.

- Terra rebuilt only the affected adapters dist from actual source after isolating the old output. Bootstrap now 19/19 and CLI node tests 176/176; controller independently repeated both. Combined first-group controller tests: 309 passed; root typecheck/lint passed. Final main tsc still exits 1 with the exact 85 baseline diagnostics, independently compared after all group changes. See R20-symbols-controller-verification.md. Source/build writes are stopped for snapshot and independent review; R20.4 remains incomplete.

## R20.4 second group and preparatory parallel reads

- Previous goal turn made implementation progress: `854ddf60` and `6720cfe2`, with independently executed verification. Revalidated current HEAD and exact Broker handle before this continuation.
- DeepSeek first-group review returned scoped PASS for `6720cfe2`; raw report saved. Root report authorship/status wording corrected without changing the reviewed source.
- Terra R01 is the sole product/build-output writer for the next 19 runtime/env declarations and four internal LocalServices DI properties. External env/define/wire/telemetry values and Host message fields remain assigned to their existing later owners.
- Terra R10 prepared a 99-file basename subset on isolated 6720, not yet applied or product-tested. Refresh against the next source candidate before applying; do not overwrite subsequent symbol edits with old file content. Another 97 basename candidates have exact remaining owners/evidence.
- Terra R21 completed manual151/current-doc auditing after a terminal Terra capacity error and one same-model retry. No model substitution or product write. Apache source attributions remain protected; active fixture/data-path corrections require separate spec/test scope and no execution against user data.

- Second-group source/build writes stopped. Controller independently reran 376 target tests, root typecheck and lint successfully; verified all 46 product paths are scoped, manual151 untouched, and companion source/emit bytes match. Main still has 85 baseline diagnostics; only three literal-union member order differences, independently checked. See R20-symbols-next-controller-verification.md. Supplemental r20-symbol-migrations.json records actual old/new declarations and DI names, without claiming remaining inventory complete.

## R20.4 basename second batch: candidate preparation

- Previous goal turn refined dispatch contracts and verified documentation (progress); product implementation resumes from the actual worktree, without repeating completed task definitions.
- Second symbol batch `e79eab7d35ba576140ff57698ca0fff122629366` received DeepSeek scoped PASS; raw report saved as R20-symbols-deepseek-review-2.md. Review did not independently rerun runtime tests.
- Terra refreshed and applied 98 basename moves against that baseline. Controller verified 134 current product files contain only the approved module-path changes, preserving previous symbol migrations. Root 575 and CLI 211 tests passed; after a test collection output-argument incident, both affected test files were restored and the controller reran 12 files/103 tests successfully.
- Four package dist/buildinfo outputs were preserved and rebuilt from empty directories. New server remote bundle starts with --version; all 92 affected output pairs have new files and no old counterpart. Clean-build consumer 101 and CLI 211 tests passed. Desktop output cleanliness remains unproven; CUA manifest/Main baseline failures remain R22/R60 gates.
- Source/build writer has stopped. Freeze this batch for read-only DeepSeek review, then continue remaining binding groups from the new path map. Deferred E2E basename/caseName closure is not a permanent exemption. No nested workspace ownership change has been made; pending user choice still applies.

- Basename candidate frozen as `1b042046c373fa91c5ed80b1501bcf0677f2eb39`; DeepSeek reviewer B is reviewing only this immutable diff from e79. Current mutable worktree is excluded from its product evidence.
- Terra R01 has the sole product/build lock for the next bound symbol batch (ProcessManager closure plus public type/interface groups); Terra R10 prepares remaining basename associations read-only against 1b042046. Terra R21 may update only the six explicitly assigned current documentation files and its own R20-current-docs report. All controller ledgers remain controller-owned.

- DeepSeek basename review returned CHANGES_REQUIRED: the active remnants audit classifies by basename and still matched zcode-agent-policy; zody-agent-policy was incorrectly unclassified. Explicit single-file scope added to Terra R01 for scripts/audit-zody-agent-remnants.mjs, preserving the unmoved model-state entry and all external identities. Require actual JSON classification check and fixed-candidate re-review.
- Controller independently compared the entire Main logs (85/85) with only exact path mappings and contiguous quoted-literal union ordering normalized: equal; evidence controller-basenames-main-comparison.json. This does not turn Main into a passing build.

## R20.4 third symbol batch and exact audit correction

- Terra completed 25 declarations across 27 source/test files and the one-line basename classification fix; current-source writes and build commands stopped. Controller verified all 28 hashes, proved remaining TS source bytes unchanged after parser-derived Identifier normalization, and independently reran 191 tests, root/CLI typechecks, lint and actual remnants JSON classification. All passed; lint 303 warnings.
- Entire Main diagnostic text still matches the independently built old baseline (85 errors), allowing only exact path/quoted-literal union order and tool banner/exit trailer normalization. No Main success claim.
- Five of six current-doc files were corrected; historical Windows evidence remains unchanged. The current/future/historical data-path distinction and nonexistent Lite build entry were corrected; two resolver references were reconciled after symbol freeze.
- Freeze this combined candidate for DeepSeek basename fix re-review and batch-03 source/doc review. Remaining 98 basename preview is still owned by Terra R10 and is not included until refreshed on this candidate and assigned the product write lock.

- Combined batch-03/audit/current-doc candidate frozen as `d49aecefa7d1c3571bfae69fe4817950654b9298`. DeepSeek B is independently reviewing fixed 1b→d49 and closing its prior basename finding; no review result yet.
- Terra R10 is refreshing the remaining98 basename preview against d49; product lock not yet handed over pending the exact refreshed list. Terra R01 prepares one coherent shared/bootstrap erased-type group from fixed d49 in isolated output only. No current product/build writer active during this refresh.

- DeepSeek returned scoped PASS for d49 batch-03 and separately closed the prior basename audit finding. Raw read-only review saved as R20-symbols-batch-03-deepseek-review.md. Ledger fields now reference real candidate SHAs; no claim of R20.4/P2/full release completion.
- Controller additionally verified the CLI child process itself uses Node v24.14.0 via absolute toolchain PATH and reran CLI tsc --noEmit successfully; this avoids relative PATH ambiguity after pnpm --dir changes cwd.

## Remaining98 basename implementation handoff

- Controller independently checked all 342 candidate source hashes against current d49, confirmed no manual151 overlap and exact basename grants for four move-only paths outside the source/consumer arrays. Patch SHA `b25066c2fe4662ecf301bb18604a7e47a303f44837b535872488f6148fd80786` matched the candidate manifest; git apply --check succeeded. Evidence: output/zody-rename-validation/controller-remaining-basename-preflight.json and remaining-plan/final-d49/candidate-files.json.
- Terra R10 now holds the sole product/build-output write lock for remaining98 moves +244 consumers, including exact audit regex consumers, the basename-derived E2E case/fixture-resolution regression and current source references in the two explicitly granted documents. Full native E2E and Desktop clean-build limits remain distinct.
- Terra R01 is preparing all B/C erased type/interface candidates in an isolated d49 snapshot. The initial13 NDJSON declarations are only sub-group04-A; preparation must account for the rest rather than treating this small group as completion. No shared source/build access granted to this preparatory task.

- This continuation classifies the previous goal turn as implementation progress: two frozen product candidates and scoped DeepSeek acceptance. Freshness rerun returned exit0, ahead53/behind0 versus origin/main. Current source/build lock was verified against the live Terra R10 handle before any further dispatch.

## Remaining98 basename verification and R21 graph checkpoint

- Previous goal turn was implementation progress. Live Terra handles and actual d49 worktree were revalidated. All198 registered source/test basename candidates are now applied; the remaining98 batch has 342 current files with exact independent expected-byte agreement.
- Controller independently reran root119 files:1815 pass/1 fail/1 skipped; CLI126 and Node2 pass; dev-docs4 pass after graph repair; typecheck/lint/changed architecture pass (303 lint warnings). Root's providerRevision scanner failure was independently reproduced in an untouched d49 scanned source tree with the same four matches; it remains a recorded failure.
- Controller checked59 modules/235 actual generated output pairs (new present/old absent). Entire Main diagnostic text still matches the known85-error baseline after exact path and union-order normalization; Main/clean Desktop/CUA/real E2E gates remain incomplete.
- R21 intermediate graph writer applied only23 exact basename path substitutions across13 paths, preserving372 nodes/726 edges. Graph tests now4/4; existing invalid seeds and later symbol mappings remain final R21 work.
- WDIO config loading triggered an unplanned Electron installer invocation. No install process remained at inspection;342 candidate files and649 manifests/locks match expected. No node_modules pre/post inventory exists, so full dependency changes are unknown. Incident is recorded; no claim of clean install or native E2E success.
- Product/build/graph writers stopped. Prepare frozen candidate and fixed-SHA DeepSeek review before handing the source lock to the complete B/C type batch or minimal manual-path correction. Isolated manual-path candidate now has2 meaningful async behavior tests, both red on old snapshot/green on candidate; current product not yet patched.

- Remaining98 + graph checkpoint frozen as `f28dfddcbd4e646d7fa93d2e593b91a62063b2b6`; DeepSeek B reviewing fixed d49→f28. Original198 basename moves are applied, not a claim all rename phases are complete.
- Exact manual-data-path exception granted for the seven prepared files plus spec and async Node regression test. Terra R21 alone receives current source/build lock for this minimal correction; all tests must use temporary HOME and retain legacy input/explicit override semantics. Terra R01 may only refresh the complete type batch against fixed f28 and prepare in isolated output.

## Minimal manual tool data-path correction

- Terra R21 applied spec and async behavior tests first, reproduced2 failures, then fixed the seven exactly granted files;2 tests passed. Controller independently reran those2 tests, root typecheck and lint (303 warnings), and verified all9 content hashes and semantic boundaries. Historical snapshot source and existing explicit overrides remain intact; no new config detection/options or user-data operations.
- Terra R10 separately closed the remaining audit store-prefix spelling. One exact prefix changed; actual matching category for six current stores is unchanged due the existing broader UI rule. A zero-hit CLI audit run is explicitly not treated as positive classification evidence.
- Source/build writers stopped for a new fixed candidate. DeepSeek B remains on immutable f28 basename review; reviewer C was revalidated completed and can accept the independent small manual-path candidate after it is frozen.

## Root workspace installation decision and final basename review

- User explicitly selected root workspace as sole dependency installation owner; remove the stale nested CLI workspace/lock, retaining `pnpm --dir apps/zody-cli …` script usage. This supersedes the earlier pending-choice notes; do not resolve unrelated third-party version conflicts. Terra R21 prepares an exact scoped change before receiving the source/build lock.
- DeepSeek B returned scoped PASS for fixed d49→f28; raw review saved in R20-basenames-final-deepseek-review.md. Its nonblocking store-prefix finding is addressed in the next manual-path candidate. Previously existing protocol-v4/shadow-replay directory consumers are assigned to Terra R10 for read-only preparation; not declared closed.

- Manual data-path candidate frozen as `83680ddc523fb95a06512ea43fc62c5a5b1ccb75`; DeepSeek C reviews only fixed f28→83680ddc, while Terra R21 implements the approved root-only installation contract. Full type batch remains unapplied pending a new configuration baseline.

## Root workspace candidate verification

- User-approved root-only installation implemented across26 exact paths, preserving root lock bytes and Turbo task semantics after root-relative input mapping. Controller independently verified all hashes and reran47 Node tests, root typecheck and lint successfully (303 warnings). Terra current-tree frozen install and50 member/92 link checks pass; clean candidate install and container checks remain pending.
- DeepSeek C requested a manual-path test correction: assert manifest destination, not merely existence. Product behavior was not rejected; exact test correction is queued before re-review. Raw report saved as R20-manual-data-paths-deepseek-review.md.

- Root-only installation frozen as `7c4ff9113680a38e273032b09bee32ee6ba399af`, tree `de2caf21b05edeb5178de715344830ae8ae5bc40`. Controller created a new detached worktree at `output/zody-rename-r21/root-owner-clean-7c4ff911` from that exact commit; Terra R21 receives its isolated install/build validation lock. DeepSeek B reviews only836→7c. No main merge or release.

## Directory consumers and manual manifest regression

- Terra corrected six active directory consumers and the manual tool manifest destination assertion; exact8-file source scope independently verified. Controller reran26 CLI +7 services +2 Node tests, typecheck and lint successfully (303 warnings). Mutation that restores only the old manifest directory fails at the new assertion. Shadow replay empty synthetic SQLite initialization works via tsx; plain Node export-resolution limitation and lack of actual session replay remain explicit.
- Root installation clean-worktree validation uses frozen7c independently; initial Turbo build had shared-worktree cache hits and is not claimed as a cache-free rebuild. Terra will perform serial forced build after CLI tests.

- DeepSeek C returned scoped PASS for fixed7c→3cb directory consumers and closed the manifest destination test finding. Manual-data-path candidate836 is accepted with correction3cb; raw review stored in R20-directory-residual-deepseek-review.md. Full symbols still in progress, root-only install independently under B review.

## Complete B/C type batch04

- Applied592 records from600-record inventory (8 already migrated),695 product files;3 merged DI pairs and their dynamic consumers preserve channel values. Controller verified695 base/final hashes; two devdocs source fragments explicitly corrected after Terra peer review. Controller CLI45/Node176/docs18 and root types/lint pass. Root168/1914 first passed assertions but exited1 on teardown RPC; isolated9/9 and full168/1914 rerun exit0 without code changes, original failure retained. Main85 full normalized diagnostic text and architecture404-line violation match preexisting content; neither gate is marked passing.
- Independent root-only install clean verification at7c succeeded, but compact/browser Docker builds exposed concrete toolchain/permission problems; exact3-file correction is prepared separately and is excluded from the type candidate. Root-owner review B remains fixed7c; type candidate goes to reviewer A after freeze.

- Type batch04 frozen as `677771fef8ea7b14498668d7b52057bdf7c1bef4`; reviewer A independently audits fixed3cb→677. Container correction is a separate three-file candidate: pin compact Node24.14.0 and supply native build tools; assign browser workdir ownership to node. Root lock and filtered CLI task scope unchanged. Actual container verification will use a new complete frozen tree, not mutable source or the earlier failed7c candidate.

- Root-owner DeepSeek review1 requested Docker corrections, while confirming installation ownership/lock/task scope. Raw report stored in R21-root-workspace-deepseek-review-1.md. Three-file correction at0ed4 retains hoisted layout and supplies supported native build prerequisites; no claim that filtered workspace selection excludes all unrelated third-party lifecycle scripts. Historical path maps are now explicitly distinguished from removed current paths; active R21 write sets cannot recreate the nested workspace/lock.
