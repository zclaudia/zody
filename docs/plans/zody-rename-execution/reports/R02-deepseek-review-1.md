# R02-deepseek-review-1

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cc4-82c8-7cc2-a81c-fee2d8b18b67`; route deepseek-flash, provider magpie, model group/deepseek, read-only.

**结论**
`CHANGES_REQUIRED`。R02 的“v4 窄冻结材料隔离备份/恢复”可以给出**限定 PASS**；但 R02 完整验收未过，**R20 暂不可派发**。R20 的唯一阻断是 v4 匹配源码尚未固化成可校验树；旧 runtime 组合只阻断 R48；最终重签/打包/截图只阻断 R60。签名信任受当前只读沙箱限制，不能据此判 artifact 失败，但也不能记“签名校验通过”。

**PASS 范围（已独立核实）**

- `narrow-frozen-v4.tar.gz` SHA `3713cbf...` 与 sidecar 一致；`gzip -t` 通过；22 个条目全部在 `output/` 下，无绝对路径/`..`；隔离 `restore-root` 内容与归档一致。
- 恢复后 manifest `48a657...`、snapshot `754d672...`、identity-pins `273fae...`、native manifest `716044...`、launcher `8e4e93...`、node `14931e...` 均对上；独立重算 stage tree 为 `5f71e45...`，与 manifest 的 `stage/source/tree` 一致，共 15 个条目。
- 四 pin 独立对上：manifest、snapshot、provider revision `545008...`、network digest `b00aea...`、`deepseek/deepseek-flash/max`；解析器代码确实检查这些值（`macos-cua-demo-defaults.mjs:168-206`），恢复脚本先校验 SHA、tar 路径，再解包并跑解析（`restore-cua-narrow-frozen.mjs:122-163`）。
- 主工作区活动冻结未被观察到写动：`output/cua-app-icon/archive/narrow-frozen-v4.tar.gz`、`controller-prepared/manifest.json`、`output/cua-inapp-confirm/startup-snapshot-current.json` 的 SHA 与 evidence 一致，mtime 仍为 10 月 31 日；restore 使用独立 `output/zody-rename-r02/restore-root`。
- 主工作区 HEAD 仍为 `033f917...`，`git cat-file` 确认为 commit；`033f..97fb` 共 9 个文件，全部在 `docs/`，未改产品源码。source tar 内 `.npmrc` 仅 `node-linker/registry`，未发现 auth/token。
- 签名身份元数据：helper CDHash `583337...`、node CDHash `3c57a9...`、identifier `io.github.zclaudia.zody.cua-helper`、DR 内 leaf `d2ad8f...` 均与 manifest/pins 一致；但当前沙箱无法复现信任链验证。

**未通过 / 阻断（5 项）**

1. **R20 阻断，可修复 — v4 匹配源码未固化。** `R02.md:12` 自述两份源码 tar“未证明与 v4 完整源码相同”，`:22` 也承认匹配源码未证明；计划 `:130-131` 要求保存匹配源码，并规定“冻结材料不足则不进入会使无法重建的 R20”。实测：4 个 entry 的 `.inputs.json` 去重后 1979 个非 `node_modules` 源码输入；当前 `033f` 匹配 1954 个，`source-and-patch-product-final.tar.gz` 匹配 1969 个；两者并集 **1979/1979**，即 033f 补 10 个 CUA 文件、source tar 补 25 个其它输入（含 browser-control），交集 1944。另：source tar 不含 `macos-cua-demo-defaults.mjs`，`inapp-source-and-patch.tar.gz` 只有 70 个条目且 pin 指向 v3 `656fd...`，不是 v4 `48a657...`。所以“数据可重建”，但 R02 没有保存重建树/清单，不能作为 R20 的可溯源匹配源码。
2. **R48 阻断 — 旧组合与双向混布未运行。** `R02.md:3` 明确“旧组合运行验收尚未完成”，`:20` 说明候选 Desktop/Host、Agent、Server、Web 未证明同源/版本匹配/可运行，独立 server-cli 未覆盖，相关命令均未执行。计划 `:236-237` 要求 R02 真实旧/新产物在 stdio、trusted host continuous、Web/手机 replayable 双向测试，并分别核销 `packages/server` 与独立 server-cli 两套 HTTP 入口、零副作用和清理；真实制品缺失/E2E 未执行均为发布阻塞。此项**不阻断 R20**。
3. **R60 阻断 — 最终冻结链和签名身份未证明。** 计划 `:300-304` 要求最终源码重建 sealed entries/pins、Helper/native tests、重签、stage/manifest、新归档、隔离复原、真实 bundle/afterPack 和截图；`R02.md:16` 明确“未证明未来重签身份可用”，`:22` 要求 R60 重走完整链。当前 `security find-identity` 为 0 valid、keychain 不可用；`codesign --verify --deep --strict` 实际 exit 1 `CSSMERR_TP_NOT_TRUSTED`，系统 `Terminal.app` 同样失败，说明是沙箱/钥匙串环境限制而非 CDHash 不符。此项只阻断 R60 及签名信任声明。
4. **非阻断证据缺口 — `restore-result.json` 太薄，且 `codesign exit 0` 不可复现。** `restore-result.json:1-9` 只有 status、路径和三个 SHA，没有四 pin 值、tree hash、identity leaf/DR/CDHash、codesign 命令/退出码；报告 `:14-16` 的“四 pin/签名校验通过”主要依赖脚本语义，官方结果文件本身不足以自证。独立阅读源码/快照/monifest 补上了四 pin 和 tree，但签名信任仍未复现。此项不阻断 R20，R02 正式证据应补齐。
5. **非阻断安全硬化 — restore 非原子且只守卫 manifest。** `restore-cua-narrow-frozen.mjs:131-149` 只检查 manifest 目标是否存在；解包发生在解析器验证之前，若 resolver 失败会留下已解包文件，`:151-152` 注释所称“不留下看似还原的状态”与实现不完全一致。R02 使用全新隔离根，所以本次未受影响；R60 应使用临时 staging + 原子 rename/失败清理，或对所有目标做 `--force` 守卫。

**R20 门禁判定**

- **现在不能开始 R20**，唯一阻断项是第 1 项；完成“匹配源码清单/归档 + 哈希复核”后即可解除。
- **R48 保持阻塞**：旧/旧、旧/新、两套 HTTP、server-cli、零副作用/清理未执行，不阻断 R20。
- **R60 保持阻塞**：最终重建/重签/新归档/bundle/afterPack/截图未做；签名身份和信任链未证明，不阻断 R20。
- 本次未运行任何旧/新 runtime，不把上述静态摘要、manifest 或 codesign 元数据当作 R48/R60 运行通过。

**可执行补证步骤**

1. 从四个 `output/cua-app-icon/controller-build/build/audit/*.inputs.json` 生成 `v4-source-manifest.json`；按文件从 `033f` 或 source tar 选取匹配 blob，组装 `v4-source.tar.gz`，验证 1979 个非 `node_modules` 输入全部命中，并记录每文件来源、SHA 和总 SHA。另把 native `sourceHashes` 34 项、6 个 patch 及 `nativeUnsignedBinarySha256=724a67...` 纳入清单；`node_modules` 由 lockfile 固定，不要求进源码 tar。
2. 在正常登录会话、固定本地证书已受信任的环境重跑 `codesign --verify --deep --strict --verbose=4`、`codesign -dvvv`、`security find-identity -v -p codesigning`，记录退出码、CDHash、DR、leaf；把结果写回 R02 证据，不在本次审查中安装/信任证书。
3. 扩展 `restore-result.json`：加入四 pin、treeSha256、pinsSha256、leafSha1/256、CDHash、codesign 退出码、归档条目数、Node 版本和实际命令；同时保留 stderr 摘要。
4. R48 用 033f/旧源码构建或取得 Desktop/Host、Agent、Server、Web、独立 server-cli，记录源码 SHA、构建命令、产物 SHA/版本；实际跑旧/旧、旧/新、新/旧 stdio/continuous/replayable，核销两套 HTTP、业务前拒绝、零副作用和进程/连接清理。
5. R60 在最终源码上重走冻结链并完成新签名、新 pin、新归档、隔离恢复、真实 bundle/afterPack 和截图；不得以 R02 的静态元数据替代。
