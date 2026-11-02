# Driver 闭包比较结果

生成时间：2026-10-28T04:51:23.714Z

- 固定来源：`2d2f99228d4d2508dc6fcc84c176b296e146714a` (`libs/cua-driver/rust`)，target `aarch64-apple-darwin`，package `cua-driver-sdk`。
- 实际 graph：298 -> 259（差额 -39）；移除 39，新增 0，版本替换 0，版本集合变更 1，feature 变更 14，来源变更 0。
- lock 计数：569 -> 569（checksum 558 -> 558）；逐项身份/checksum 需直接比较两个 Cargo.lock。
- 排除包：actual graph 中未出现 rquickjs/rquickjs-core/rquickjs-sys/regorus/uniffi/uniffi_*。
- core feature：[{"version":"0.37.0","features":["yaml"]}]；platform feature：[{"version":"0.37.0","features":["default","zody-dev-no-input","zody-strict-frame-gate"]}]。
- 许可残留：missing 13，partial 1，reviewRequired 0，MPL 0。版本替换 0 项不按已解决处理；材料变化不构成法律审查完成。
- 补充许可：pass（保留 15，图外剔除 7）。

产品采用：blocked。dependency trimming candidate only; native, signing, TCC, runtime and legal review remain separate gates

本工具只比较显式报告与 policy，不执行编译、系统输入、证书或 TCC 操作，也不修改候选或旧报告。
