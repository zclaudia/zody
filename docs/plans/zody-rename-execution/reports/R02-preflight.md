# R02 前置资源核实（只读，非正式备份）

2026-11-02；主工作区 `/Users/zhvala/SourceCode/zody`，HEAD `033f91783901e6adaf968d3d4b8ca34c41d89442`。此记录不构成 R02 恢复或可运行验收。

- 主工作区 `packages/desktop/native/macos-cua-*` 六个目录均存在；Git 分别跟踪 65、3638、6、6、26、29 个文件（desktop-session、driver-closure、helper-diagnostic、helper-product-wiring、helper-round11、peer-diagnostic）。因此 survey §6 中六目录全部 Git 外的说法不成立；不能据此推断每个目录所有内容均已跟踪。`output/` 被 Git 忽略；10 个 `output/cua-*` 目录存在。
- `output/cua-app-icon/archive/narrow-frozen-v4.tar.gz` 可读取、可列目录，SHA256 `3713cbf39c85de42df34533d3d555026d4e909d821832fca307a51b6ee1afa59`，与相邻 sidecar 相符；归档包含 controller-prepared 和 startup snapshot，来源参见 `packages/desktop/native/macos-cua-driver-closure/reports/2026-10-31-app-icon/ACCEPTANCE.md`。未展开归档或执行恢复。
- 活动 `output/cua-app-icon/controller-prepared/manifest.json` 的 SHA256 为 `48a657bb2883ed18801dd52e13425c360e03c90ae2f66f1f6f77231108af1a10`；`output/cua-inapp-confirm/startup-snapshot-current.json` 为 `754d672286692bea5933d8a3ae33935fbb94b05f0ca56ff78995fe31e8ded2e9`。两者与 `packages/desktop/scripts/macos-cua-demo-defaults.mjs` 对应 pin 及归档内同名成员摘要一致。另两项 provider revision、network digest 的派生匹配未验证，不应宣称四 pin 全通过。
- `output/cua-arm64-screenshot-product/source-and-patch-product-final.tar.gz` 的 SHA256 `fae6b3a2ddebf93a8a59ab71dc85c7211ac45845866079c86ac2c3e0c4a67a01` 与对应 `2026-10-31-arm64-screenshot-product/ACCEPTANCE.md` 记录一致；该轮源码归档不自动证明与 v4 当前冻结资源或本次 HEAD 完全匹配。`output/cua-inapp-confirm/archive/source-and-patch.tar.gz` 亦存在，其与 v4 的完整关联尚待核对。
- 候选旧制品存在：`output/cua-inapp-confirm/ordinary-app-v4/mac-arm64/Zody Preview.app`、`output/cua-arm64-screenshot-product/controller-normal-host-production/Zody CUA Normal Host Candidate.app`，以及 `packages/desktop/dist`、`apps/zcode-cli/packages/cli/dist/zcode.cjs`、`packages/server/dist`、`packages/web/dist`。独立 server-cli 发行制品尚未定位；以上产物的来源、彼此版本一致性与运行能力均未验证，不足以作为 R48 旧组合。

正式 R02 仍需确定完整匹配源码和签名身份元数据，验证全部四 pin、构建或获取来源及旧组合运行；在独立隔离目录做备份和 restore 演练、核对摘要并避免覆盖活动资源。先按明确白名单筛选待备份资源，排除凭据、私钥和真实会话；不要直接复制整个 output。缺少可追溯旧组合时 R48 保持阻塞；冻结材料不能证明可恢复前不得进入会使其无法重建的 R20。R60 的签名身份、SDK、权限及截图链也尚未验证。
