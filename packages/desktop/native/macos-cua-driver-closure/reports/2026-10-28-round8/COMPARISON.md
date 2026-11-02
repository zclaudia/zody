# Driver 显式根迁移比较结果

生成时间：2026-10-28T16:00:09.573Z

- 根迁移：`cua-driver-sdk` -> `cua-macos-visual`；revision `2d2f99228d4d2508dc6fcc84c176b296e146714a`，sourceRoot `libs/cua-driver/rust`，target `aarch64-apple-darwin`。functionalEquivalent=false；interface/ABI/tool equivalence not-established；legacyRootUncompiled=true。
- source retention：verified；baseline 753 -> candidate 767，所有 baseline 路径仍存在，除 Cargo.toml/Cargo.lock 外字节不变，新增仅限 `crates/cua-macos-visual/`。旧 SDK/core/platform 源码仍留存，但不在新构建图。
- 实际 graph：259 -> 30（差额 -229）；removedFromCandidateGraph=230，addedToCandidateGraph=1。差额来自 root 功能收窄，不是功能等价替换。
- 许可：旧 R7 许可缺口仍然存在（baseline entries 14）。inventoryDelta 中 removedFromCandidateGraph=14 仅表示这些精确身份不在新图，不是许可补齐或已解决；candidate residual missing 0、partial 0、reviewRequired 0、MPL 0。
- feature 约束：cua-driver-core/platform-macos 仅在 R7 baseline 图适用；新图 required=[]，旧安全 feature 只留在旧源码，未伪造同名 feature 通过检查。
- 排除包：candidate graph 未出现 cua-driver-sdk/cua-driver-core/platform-macos/clipboard-rs/cursor-overlay/pip-preview/cua-cursor-motion/rquickjs/rquickjs-core/rquickjs-sys/quickjs/quickjs-ng/rego/regorus/uniffi 或 uniffi_*。
- lock 计数：569 -> 570（checksum 558 -> 558）；逐项身份/checksum 需直接比较两个 Cargo.lock。
- 补充许可：not-requested。新视觉根自带 LICENSE-MIT，不新增 supplement mapping。

产品采用：blocked。root transition candidate only; interface, ABI and tool equivalence remain not-established, legacy root remains uncompiled, and native, signing, TCC, runtime and legal review remain separate gates

本工具只比较显式报告与 policy，不执行编译、系统输入、证书或 TCC 操作，也不修改候选或旧报告。
