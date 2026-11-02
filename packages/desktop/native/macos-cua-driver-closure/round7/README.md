# macOS CUA Driver 第七轮候选

日期：2026-10-28。状态：候选已冻结，controller 已完成独立来源审计与锁定离线库编译；产品默认禁用，许可、原生、签名/TCC、Fenced、D06 和产品采用结论均未关闭。

## 冻结输入与产物

- 固定 upstream：`2d2f99228d4d2508dc6fcc84c176b296e146714a` (`libs/cua-driver/rust`)。
- 只读历史输入：`/Users/zhvala/SourceCode/scripts/experiments/zody-cua-p0-g2-stop-retire-reservation/full-source`，752 文件。
- 最终候选：`output/cua-driver-round7/candidate-work/final/full-source`，753 文件。
- 增量 patch：`candidate-source.patch`，97,785 bytes，SHA-256 `2798b890e4293147652b9994579404383b3aa70e8d434287ddd11e8524c7e64f`。
- 新 source manifest：`source-manifest.json`，SHA-256 `53fc08d9835f27c07ae756f93a345b9d0a0cf6d9197aa01db03796fc605f5267`。
- 当前 review config：`review-config.json`，SHA-256 `73171d6112f54c2541f2905f96310e04c3d5b15e49c313d5484b354ecf359ac0`。
- base tree SHA-256：`fbd0452904ac4209eacf7f5d1e845c207a2ab1fdd42c320bfc39f7e9ec448654`。
- candidate tree SHA-256：`f110f6466d06036ff9a028c7e35bd4f3b6fe312b67607c2a3f930f1c250f8d48`。
- `Cargo.lock` SHA-256：`5c60d9852c60eb69f4ca74d323e89490ffd2b98954f2f450d0a69a17de8e9940`，与冻结 base 字节一致，569 个 lock 条目。

`review-config.baseSourceManifest` 已从错误的 `../../source-manifest.json` 修为 `../source-manifest.json`。该字段不参与 Rust 源码或编译；因此 patch、source manifest 和 candidate tree 保持冻结，只有 review config 自身的摘要由 `108cfa35...` 变为 `73171d61...`。controller 的 `controller-build-first` 报告记录的是修正前 config 摘要，但其候选、patch 和树摘要与当前冻结值一致。

候选计数为 672 unchanged、38 modified、43 added、0 removed。source manifest 仍沿用无 `removed` 的格式，不允许删除原 file 集合。

## 固定重建

输出必须新建且 basename 必须为 `full-source`。以下命令在全新 candidate-work 子目录运行；若输出已存在会 fail closed，不会覆盖冻结候选。

```sh
node packages/desktop/scripts/prepare-macos-cua-driver-round7.mjs \
  --base-source /Users/zhvala/SourceCode/scripts/experiments/zody-cua-p0-g2-stop-retire-reservation/full-source \
  --output output/cua-driver-round7/candidate-work/review-rebuild/full-source
```

工具只使用只读 base、round7 patch/manifest/config 和 `git apply`；生成期间不做网络访问、包安装、原生程序启动、上游测试、系统输入或 TCC 操作。它逐文件验证 base manifest、patch 摘要/字节数/路径、patch 应用后的全树摘要、candidate source manifest、依赖策略和 UniFFI cfg 门控，发布前再次拒绝已有输出或路径 symlink/逃逸。

## 源码变更

- 根 workspace 移除 `../harness`；候选 workspace 为 9 个内部成员，`workspaceExternalMembers` 为空。
- `cua-driver-core` 默认 feature 只保留 `yaml`；`rego`/`regorus` 与 `script`/`rquickjs` 的源码和 feature 定义保留为未编译模块。
- `platform-macos -> cua-driver-core` 使用 `default-features = false, features = ["yaml"]`；`zody-dev-no-input` 与 `zody-strict-frame-gate` 默认值及原生实现原样保留。
- `cua-driver-sdk -> cua-driver-core` 显式选择 `yaml`。SDK 的 `uniffi` 依赖改为 optional、默认关闭，feature 透传 `cua-driver-contract/uniffi`；SDK dev-dependencies 不再激活 UniFFI。
- `cua-driver-contract` 的 `uniffi` 依赖改为 optional、默认关闭，并定义独立 `uniffi` feature。
- contract/SDK 中 171 个 derive、53 个导出/构造/字段/default 属性以及 2 个 `setup_scaffolding!` 均由 `cfg_attr(feature = "uniffi", ...)` 或 `#[cfg(feature = "uniffi")]` 门控。Rust 类型与手写 C ABI 语义未改。
- 新增 `crates/cua-driver-core/tests/round7_dependency_boundaries.rs`，只覆盖本轮纯函数边界；没有 rustfmt 整棵旧树。

## 实际依赖图

使用第六轮项目内 1.97.1 工具链、隔离 `HOME`/`CARGO_HOME`/`target`，对最终候选执行：

```sh
cargo tree --locked --offline --target aarch64-apple-darwin \
  --package cua-driver-sdk --edges normal,build --prefix none --format '{p}|{f}'
```

结果：259 包 = 8 path + 251 registry，root 为 `cua-driver-sdk@0.37.0`，core feature 为 `yaml`。实际树不含以下名称或前缀：

```text
rquickjs, rquickjs-core, rquickjs-sys, regorus, quickjs, quickjs-ng
uniffi@*, uniffi_core@*, uniffi_internal_macros@*, uniffi_macros@*,
uniffi_meta@*, uniffi_pipeline@*, uniffi_bindgen@*, uniffi_udl@*
```

相对第六轮 298 包净减 39、无新增。图中移除项：

```text
async-compat@0.2.5, bstr@1.13.0, camino@1.2.4, cargo-platform@0.1.9,
cargo_metadata@0.19.2, chrono-tz@0.10.4, chrono@0.4.45, fs-err@2.11.0,
futures-io@0.3.32, globset@0.4.19, heck@0.5.0, iana-time-zone@0.1.65,
ipnet@2.12.0, lru@0.18.1, msvc_spectre_libs@0.1.3, phf@0.12.1,
phf_shared@0.12.1, rand@0.10.2, regorus@0.10.1, rquickjs-core@0.14.0,
rquickjs-sys@0.14.0, rquickjs@0.14.0, serde_spanned@1.1.1,
serde_yaml@0.9.34+deprecated, siphasher@1.0.2, spin@0.10.1,
static_assertions@1.1.0, toml@0.9.12+spec-1.1.0,
toml_datetime@0.7.5+spec-1.1.0, toml_parser@1.1.2+spec-1.1.0,
toml_writer@1.1.2+spec-1.1.0, uniffi@0.31.0, uniffi_core@0.31.0,
uniffi_internal_macros@0.31.0, uniffi_macros@0.31.0, uniffi_meta@0.31.0,
uniffi_pipeline@0.31.0, winnow@0.7.15, winnow@1.0.3
```

`Cargo.lock` 中仍可能存在未被默认图选中的 package 条目。`--locked --offline` tree/build 已证明锁文件无需重写；本轮没有为删除条目而生成临时 lock，也没有升级任何 registry 版本或 checksum。

本地实际图证据：`output/cua-driver-round7/candidate-work/graph/final-tree.txt` 与 `summary.json`。

## 编译与测试

- controller 最终审计：`output/cua-driver-round7/controller-final-audit/report.json`，使用当前 config SHA `73171d61...`；source/dependencies/toolchain 为 pass，259 包、251 registry、13 missing/1 partial(`shlex@1.3.0`)/0 reviewRequired/0 MPL，15 条 supplements mapping pass。comparison 为 `output/cua-driver-round7/controller-comparison/comparison.json`，298 -> 259（-39）、无新增，手写 ABI 15 项保留、UniFFI 符号 0。
- controller 独立 build：`output/cua-driver-round7/controller-build-first/report.json`，source/dependencies/toolchain/build 均为 pass；编译 37 个 build-script 包、16 个 proc-macro 包，这是编译包事实，不代表执行原生 API、启动程序或运行测试。该报告早于 supplements 接入，其旧许可计数已被最终 audit/comparison 取代；未启动上游程序或测试。
- SDK build-library 产物：`libcua_driver_sdk.dylib` 34,986,104 bytes / `128742959b2ce979c9ff2ec4ba6ccd35ea7c4877593a904b95c67bfb3b3f1185`；`libcua_driver_sdk.rlib` 36,046,752 bytes / `24ca20ca609bfbd46cb1204ccbf7521e7b3f887cd37b4590cdc0a32add09641c`。
- 本轮 TS：`node_modules/.bin/vitest run packages/desktop/test/macosCuaDriverRound7Prepare.test.ts`，15 passed，0 failed；覆盖重建正反例、已有输出/名字/symlink/逃逸、patch 应用、manifest 重复/漂移、UniFFI 合法 cfg_attr 与反例、许可子集与 symlink、成功 staging 清理和 config 摘要失配。
- 本轮 Rust 纯函数：`cargo test --locked --offline --package cua-driver-core --test round7_dependency_boundaries --target aarch64-apple-darwin`，3 passed；证明 `.rego` 在无 rego feature 时拒绝、YAML 显式 deny 仍 Deny、无 script feature 时 registry 不注册 `run_script`。未运行原生 API、系统输入或上游整个 test suite。
- controller 汇总：125 个 Vitest 通过，3 个 Rust 纯测试通过；`pnpm typecheck`、`pnpm lint`、architecture 检查通过；16 个 code/test 定向 lint/format 通过。
- `oxlint`（本轮 6 个 JS/TS 文件）：0 warning、0 error；`oxfmt --check`：pass。
- 作者侧在 sandbox 内直接编译 SDK 会在 SwiftPM 的 `sandbox-exec` 处被宿主拒绝（`sandbox_apply: Operation not permitted`）；controller 的独立 build 已成功，因此该限制不是候选源码失败。
- 未验证 opt-in UniFFI 编译/符号导出，也未运行完整 upstream 测试套件；默认图只证明 UniFFI 关闭时无相关包与符号。

## 严格许可 supplements 子集

路径：`packages/desktop/native/macos-cua-driver-closure/round7/license-supplements`，manifest SHA-256 `9683d541d692cdeddf3c7b2f5d80a96bf5f965e03bc91d7ba553575f13c7b487`。

- 从旧 22 条只读条目中只保留实际 cargo tree 内 15 包；删除 6 个 UniFFI package 与 `rquickjs-core`。
- 只复制 5 个被引用的许可正文，逐字节保持原 SHA/bytes。
- 6 个 workspace 条目的包 `Cargo.toml` SHA 和 workspace `Cargo.toml` SHA 更新为最终候选实际值；registry 条目的 lock checksum、VCS 和源证据原样保留。
- 用既有 `loadLicenseSupplements` 对真实 259 包图、锁文件和 registry 解包源复核，15/15 接受；没有放宽旧验证或伪造正文。
- 最终 audit 另列出 431 个已索引许可正文/通知材料，并把 upstream 根许可作为独立证据；这些索引计数与 15 条 strict supplements mapping 分开记录，不能互相替代。

该子集只裁剪旧材料的图外条目，不等于许可 gate 通过。最终候选的剩余缺口为 13 包缺包级正文、1 包 partial（`shlex@1.3.0`），0 reviewRequired、0 MPL。旧 6 个 MPL 包是因为不在新 graph 中而退出该候选，不是其法律义务已审查通过；`licenses` 与 `productAdoption` 仍 blocked。

## 冻结与未关闭项

- 本候选冻结后不再修改 patch、source manifest、review config 或最终候选；后续审查应新建输出目录重建。
- 未安装证书、未请求 TCC、未启用真实系统输入、未启动上游应用/测试、未做签名或正式 Helper/D06 验收。
- 未验证 opt-in UniFFI 或完整 upstream 测试；这些能力不得由默认 feature/库编译通过推导为已验收。
- Intel、最低 macOS 环境、SwiftPM/外置宿主构建差异、AX/overlay/PiP/录屏共享耦合仍需真实环境审查。
- 13 个 missing、`shlex` partial、Apple SDK 派生关系与产品采用仍需独立人工/法律流程；旧 graph 的 6 个 MPL 包不进入本轮候选且未被审查，本轮不作法律结论。
