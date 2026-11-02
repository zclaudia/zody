# Helper 应用图标轮（2026-10-31）

用户批准为 `Zody CUA Desktop Session.app` 增加应用图标，并把默认装配 pin、材料可搬迁与正式包重打三件遗留一并处理。spec 先行（computer-use-macos-phase1.md「Helper bundle 应用图标资源」及其 v4 小节）。

## 改动

- builder（build-cua-desktop-session.mjs + pins/config/manifest）：`Info.plist` 增加 `CFBundleIconFile=AppIcon.icns`；`packages/desktop/build/icon.icns`（git 追踪）原样复制进 `Contents/Resources/AppIcon.icns`，纳入固定输入 preflight；build manifest 按 resources 账本记录 path/source/sha256。
- 默认 pin（macos-cua-demo-defaults.mjs）：manifestRelativePath/manifestSha256 切到 `output/cua-app-icon/controller-prepared/manifest.json`（SHA `48a657bb…`）。与 inapp-confirm v3 差异：AppIcon 新增、plist 加键、cli/session entry 随当日工作区重新封装；host-entry/Node/签名身份逐字节不变。
- 可搬迁（restore-cua-narrow-frozen.mjs + 归档）：`output/cua-app-icon/archive/narrow-frozen-v4.tar.gz`（SHA `3713cbf3…`，58MB）内含 controller-prepared 全目录与 startup snapshot；还原脚本先验 sha，tar 条目仅允许仓库相对 `output/` 前缀，解包后立即重跑默认选择解析，已存在 pin 目标拒绝覆盖（--force 显式）。

## 验证（本机 darwin/arm64，Node 24.14.0）

| 项 | 结果 |
| --- | --- |
| 重建 | native 11/11 测试 pass；plist 含图标键；AppIcon.icns 与主图标 sha256 一致 |
| 签名 | 上轮同参数 local-self-signed；`codesign --verify --strict` 通过；identifier/DR 与 pin 一致 |
| prepare-narrow | manifest pass；图标计入树（`Contents/Resources/AppIcon.icns` sha `e2283e09…`） |
| 默认选择 | `resolveMacosCuaDemoBuildSelection` source=default，profile 与 pin 全匹配（provider 快照未漂移） |
| 还原演练 | 挪走 controller-prepared 后从归档还原，pin 链复验 pass，字节与原目录 diff 一致 |
| 单测 | cua-desktop-session-bundle 10/10；restore-cua-narrow-frozen 4/4；narrow-resources 37/37 |
| 根检查 | typecheck pass；lint 0 errors；architecture:check 0 violations |
| 正式包 | `pnpm bundle`（mac/arm64）默认装配 v4：afterPack/afterSign `assertPackagedNarrowResource` 均 pass；`bundle:verify-cua-narrow-resources` pass。产物 `dist/mac-arm64/Zody.app`（含 `Resources/cua-narrow/` 槽位 + build audit）与 `Zody-0.1.0-mac-arm64.dmg`/`.zip`（428MiB < 500MiB 限）。包内 Helper plist 含 `CFBundleIconFile`，AppIcon.icns sha `e2283e09…` 与 pin 一致。主 App 签名维持本地构建默认（identity=null 跳过），与既有本地包行为一致 |

## 已知边界

- 归档仍在 `output/`（gitignore）；跨机器搬迁需先人工携带 tar.gz+sha，再跑还原脚本。信任判定不依赖归档本身。
- 运行时默认禁用语义（productDefaultDisabled/placeholder）不变；本轮只是资源装配与展示。
