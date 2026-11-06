# R02-deepseek-review-2

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cc4-82c8-7cc2-a81c-fee2d8b18b67`; route deepseek-flash, provider magpie, model group/deepseek, read-only.

**结论**

- **R02 补证：限定 PASS。** 独立复核源码归档、native 证据和恢复证据均能支持报告中的声明；1979/1979 输入、34/34 native 源码、6/6 patch、目标与最终哈希均对上。
- **R20 源码保全 gate：解除（限定 PASS）。** 在“四入口非 `node_modules` 源码 + native baseline/patch 链已保全”的声明范围内通过；不等于完整可重建 checkout。
- **R48：CHANGES_REQUIRED。** 旧 runtime 组合、跨代 stdio/continuous/replayable、两套 HTTP 和 server-cli 仍未运行。
- **R60：CHANGES_REQUIRED。** 最终源码重建、重签、新 pin/归档、bundle/afterPack 和截图仍未完成；宿主可列出身份不等于未来签名成功。

**独立复核结果**

- `v4-source-manifest.json` 实际 SHA 为 `4d6fe9cc7bea7479aff7976fc1895ba394884bd022f5c68a0e467bbea7f63dc3`；`R02.md:26` 已改为正确的 `c68a0`。`v4-source.tar.gz` 实际 SHA `5968df6d...`，`native-evidence.tar.gz` 实际 SHA `ee44c7d0...`，均与报告一致。
- 源码输入去重后 1979 条：Git `033f9178` 命中 1953，原始 source tar 命中 1969，并集 1979，无缺失。manifest 选择 Git 1953、归档 26；其中 `apps/zcode-cli/packages/dynamic-workflow/src/compiler/libs.generated.ts` 不在 Git 033f，正确由 source tar 补齐。先前 1954 是工作树口径，commit tree 复核为 1953，报告数值正确。
- `v4-source.tar.gz` 共 1979 个文件，无重复、无绝对/上级/反斜杠路径；逐文件 SHA 与 manifest 及四份 `.inputs.json` 全部一致，manifest 无缺项/多项。原始 source tar 的 4275 个条目也无重复/不安全路径。
- native 证据：34 个 baseline 源文件在 Git 033f 中逐项命中；6 个 patch 的 SHA 与 `--fuzz=0` 记录均匹配，patch before/after 链连续；product stage 34/34 目标哈希通过；`native-evidence.tar.gz` 含 34 个最终源码、6 个 patch、8 个 build-context 文件及 JSON，50 个条目无重复/越界；最终 34 个源码哈希与 target + extra patch after 链全部一致。
- 恢复证据：`restore-result.json` 已包含四 pin、tree `5f71e45...`、identity、codesign exit 0 和 native archive SHA；恢复重新演练成功。宿主 `codesign-verify.log` 记录 `valid on disk`/`satisfies its Designated Requirement`，`identity-check.log` 列出 `D2AD8F4...` 有效身份。此前只读沙箱的 `CSSMERR_TP_NOT_TRUSTED` 是 keychain 不可用导致的环境差异；未重试、未改信任、未签名。
- `restore-root` 与 `restore-recheck` 的 manifest、snapshot、signed binary 哈希一致（分别为 `48a657...`、`754d672...`、`8e4e93...`），说明两份恢复结果同字节。

**仍存遗漏（不阻断 R20 源码 gate）**

1. **unsigned binary 未字节保存。** `native-evidence.tar.gz` 只有源码、patch 和 build-context；哈希 `724a67c5...` 对应的是活动文件 `/Users/zhvala/SourceCode/zody/output/cua-app-icon/controller-build/helper/Zody CUA Desktop Session.app/Contents/MacOS/macos-cua-desktop-session`，该文件不在 R02 隔离目录。若“保存”指字节副本，应复制到 `output/zody-rename-r02/native-unsigned/` 并写入 native 证据；若只要求 hash 保全，应把报告措辞改为“只读 hash 记录，未复制”。
2. **manifest 未自绑定关键证据哈希。** `v4-source-manifest.json` 的 `sourceArchiveSha256` 是原始 tar `fae6b3a2...`，没有 `assembledArchiveSha256=5968df...`，也没有四份 `.inputs.json`（`f52e.../2d1e.../66a2.../b18f...`）、`native-evidence.json=151a...`、`native-evidence.tar.gz=ee44...`、`restore-result.json=d5a4...` 的字段。内容已独立复核通过，但补这些字段可让 manifest 自证。
3. **native 最终 per-file hash 和完整构建上下文未固化。** `native-evidence.json` 记录 baseline/target 与 patch before/after，未单独列 extra patch 后 34 个最终文件的 hash；`build-context.json` 明确是 033f baseline-only，且未备份 `node_modules`。这不影响四入口源码 gate，但意味着“完整重建能力”仍未证明。
4. **codesign 日志路径与 restore-result 路径不完全对应。** `codesign-verify.log` 指向 `restore-root`，`restore-result.json` 的 `stageAppPath` 指向 `restore-recheck`；两处关键哈希相同，结论不受影响，但建议记录两个路径或对 `restore-recheck` 重跑日志。

**R20 / R48 / R60 分别结论**

- **R20：源码保全 gate 通过（限定）**，1979/1979 源码和 native 34/34 + 6 patch 已保全；可解除“源码被机械改名后不可追溯”的阻断。R20 是否立即派发仍受 R10 和其他主控依赖影响，且不能据此宣称完整重建环境已就绪。
- **R48：CHANGES_REQUIRED**。旧 runtime 仍未实际运行；需用旧源码/制品完成 stdio、trusted host continuous、Web/手机 replayable 的双向组合，分别核销 `packages/server` 与独立 server-cli HTTP、业务前拒绝、零副作用和清理。
- **R60：CHANGES_REQUIRED**。需在最终源码上重建 sealed inputs/pins、Helper/native tests、重签、新归档、隔离恢复、真实 bundle/afterPack 和截图；当前只证明历史材料可恢复和宿主能列出身份，不证明未来重签成功。
