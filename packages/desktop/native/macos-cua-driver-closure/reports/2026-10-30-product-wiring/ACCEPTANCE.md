# 生产 owner 接线续作验收（2026-10-30）

当前结论：**接口、原生组合构建与真实单窗口截图 → 既有 owner 撤销 → lease 释放通过**。功能默认禁用，`zcodeCuaPlaceholder: true`。没有修改原 R9/R10/R11 冻结材料、registry、全局工具链或安装版 Zody。

## 已完成

- 用户在系统认证后，controller 精确为原 R11 Helper 开启屏幕录制；该签名 app 经 LaunchServices 实拍 Zody 单窗口并完成撤销。PNG 2400×1600，SHA-256 `0eeb531bbd146014010ab4fb92eb49dad09ab320c612390f4e8cccf198ff4692`，机器锁可重新获取；TCC subject 为 `io.github.zclaudia.zody.cua-helper`。见 `PERMISSION.md` 与 `evidence/independent-permission/`。截图只留本地 output，不入仓库归档。
- `AgentRuntime` 从真实 foreground execution/active turn 提供单一 turn scope；复用已有 coordinator、authority、submission/ref 和 producer binding。turn/stop/abort/shutdown 先使旧 scope 失效，晚到 candidate 不复活。
- control launcher 与同次 producer incarnation 绑定；bootstrap 显式 `createCuaControlSession` / `createCuaNativeAuthoritySession` 只消费自己的 runtime scope。原生 NDJSON adapter 支持 empty bootstrap、完整关联 check、既有 owner revoke 与有界关闭，不生成第二套授权状态。
- controller 审查并修复了自身 revoke 同步失效抢先关闭、未知撤销回执、正常 scope close 错撤销、shutdown 事件次序、FD close 事实及协议错误撤销遗漏。具体见 `REVIEW.md`。纯 TS 事实仍保持 nativeFence unknown，不能冒称原生屏障。
- 新候选从 R11 冻结源码派生 3 个固定 patch：empty bootstrap 与 32MiB sealed snapshot；有界 Helper 失败 reason；显式保留 Node stderr。34 个原生输入逐一对照原归档摘要，patch 文件与每步 before/after SHA 均固定，`--fuzz=0`。原 peer/lease/capture owner/视觉静态库复用。

## 原生实测边界

原 R11 的成功截图是 developer authority 基线；**不是**新生产对象接线的成功证明。

新组合候选使用固定签名 Node 内的真实 `create-app → CommandInbox/sendText → runtime scope → native authority adapter`，随后真实 peer/机器 lease/SCK。输入 Host 标识与 held model 是明确的 synthetic fixture，不调用外部模型，也不是安装版 UI 的输入。sealed entry 不直接实例化 authority 或调用 admitLive/bindTurn。

controller 实际编译链接并以既有 `Zody Local Computer Use` 签名；严格 codesign 验证通过，Helper identifier/DR 与 R11 相同，hardened runtime、空 entitlements、无 Team ID。没有证书安装、权限扩展、DYLD 覆盖、系统库复制或关闭 library validation。Node 资源 SHA 未变。

首次实跑被通用 `helper-exit-not-success` 遮蔽；最小诊断派生后确认 `visual-wait-failed`，无 PNG。stderr 已证实真实 app-created / scope-bound，失败 EOF 后 `ownerRevoked=true`、`authorityRevoke=revoked`、`transportClosed=true`；独立重新获取机器锁成功。这是**失败断连撤销**证据，不能写成截图后的正常撤销或 native Fenced。

同一时间原 R11 对照也失败。controller CUA `getApp('/Applications/Zody.app')` 明确返回 `The Mac is locked and automatic unlock could not unlock it`。用户随后完成解锁；不以超时、进程退出或 fixture 替代真实截图。实际复跑的同一签名候选：`output/cua-helper-product-integration/controller-native-diagnostic/helper/Zody CUA Helper Round11.app`。

2026-10-30 13:32（Asia/Shanghai）最终实测通过：解锁后首次读到目标为333×222的缩略尺寸，仍返回 visual-wait-failed；controller 用 CUA 将原 Zody 窗口 Raise 至前台，重新读取实际1200×800窗口边界后，同一产物返回 `captured-and-revoked`，没有重编译、重新签名、改变权限或放松窗口校验。证据说明锁屏/窗口展示状态会影响采集，不能把所有 visual-wait-failed 唯一归因于锁屏。

实际 PNG 为2400×1600、220261 bytes，SHA-256 `1b91270363b00837ec84191c2dafe12edf77860e844ede84fd4f01c40bec09ee`。controller 查看图像确认是正常非空 Zody 窗口。stderr 的同一真实 scope 结束原因为 `owner-revoked`，`ownerRevoked=true`、`authorityRevoke=revoked`、`transportClosed=true`；原生 supervisor 只有收到真实资源归还、撤销及机器lease释放回执并核验PNG后才返回pass，controller另以flock重新获取机器锁成功。TCC subject仍是Helper自身（supervisor23497、Helper23503）。这是**生产对象组合候选的一次真实截图与正常撤销**，不是安装版UI入口、完整系统输入Fenced或产品发布通过。

证据见 `evidence/independent-native-visible/`；解锁后缩略状态失败保留于 `evidence/independent-native-unlocked/`。最终复跑代码、签名资源和之前131项测试对应实现均未变化，因此没有重复无关测试。

## 必要检查与实际图

| 类别 | 本次独立结果 |
| --- | --- |
| Node / pnpm | 24.14.0 / 10.33.2；开工 freshness ahead 31 / behind 0；解锁续跑 ahead 32 / behind 0 |
| 根 typecheck / lint | 通过；lint 301 warnings / 0 errors |
| CLI typecheck / lint | 通过 |
| 相关测试 | 16 files / 131 tests passed，含真实 runtime、CommandInbox、子进程/socket；不等价原生截图 |
| architecture --changed | 0 violations；CLI/desktop 当前 unmanaged，不扩大覆盖声明 |
| 原生编译/链接 | arm64、SDK macosx27.0、部署14.2，真实 clang 链接；rpath `/usr/lib/swift` |
| 新 JS 实际打包输入 | 3031 files，169 node_modules package roots；输出 external 仅 Node builtins |
| JS 打包字节 | 27,760,098 bytes；SHA `b8a4d730c7a174340bf6b9712633f507f31b6f1058f61d9656b207fb2080d721` |
| JS 许可材料 | 164 package roots 含包内 LICENSE/NOTICE 类材料，5 missing；不是法律审查通过 |
| Rust 视觉图 | 复用 R11 静态库，原20包图未改；未重复运行未变化的纯 Rust 检查 |
| 原生调用 | 原 R11 与新生产对象组合候选均实拍通过；新候选正常 owner revoke 与机器lease释放通过 |
| 产品入口 | 未接安装版 UI / 完整可信产品启动；默认禁用 |

JS 缺失包内许可材料：`@ai-sdk/provider-utils` 4.0.39 与4.0.27、`omggif`1.0.10、`parse-bmfont-ascii`1.0.6、`quickjs-wasi`2.2.0。与之前 Rust 图许可结论分别记账。Windows-only koffi 使用 throw-only 平台排除文件（darwin arm64 guard）；fs worker 字符串中的 lazy ripgrep 未由 held-model fixture 执行。不能声称完整 CLI 依赖等价或可发布闭包。

## 复核入口

- `SOURCE-MANIFEST.json` / `owned-source.tar.gz`：本次58个受控改动文件的增量快照；保留 opening SHA。不是整仓干净基线。
- `owned-changes.patch`：仅可验证 opening preimage 或新增文件的 patch。6个 opening preimage 缺口列在 manifest；不拿 Git HEAD 冒充脏工作区开工版本。完整最终文件均已保存。
- `sealed-inputs-source.tar.gz`：实际3031个 esbuild 输入，归档时逐个校验构建输入 SHA 无漂移；graph/摘要位于 `evidence/native-composition/`。
- `license-materials.tar.gz`：本次复制的 Node 与 bundle 包内材料，missing 如上，不补写伪许可。
- `evidence/native-composition/`：真实构建命令、输入图、编译/链接、资源 pins、签名命令、严格验证和签名产物摘要。
- `evidence/independent-native*/`：保留失败与最终成功实测、真实 runtime 撤销日志；`original-control-after-failure/` 为旧 app 对照。原生 PNG 不入仓。
- `ARTIFACTS.json`：以上归档与证据文件 SHA-256。

实现 worker A `broker:deepseek-flash-rw-c2d541bc0c4e8861:01a18abe-cff3-7d40-9959-1307981b2592`；B `broker:deepseek-flash-rw-c2d541bc0c4e8861:01a18abf-ebf8-7220-b3f3-b79dea5b4587`。均 deepseek-flash / magpie / commandcode-plan/deepseek/deepseek-v4.1-flash；controller 未更换自身 provider，独立审查与运行上述检查。没有提交 Git commit。

## 剩余阻断与顺序

1. 单窗口原生组合链已完成；当前下一阻断是把显式 bootstrap 装配接到完整可信产品启动与真实 Host 输入。当前 `/Applications/Zody.app` 实测为 ad-hoc、无资源封口，不能把 fixture Host 当成已完成这一步；不得放宽 peer 信任。继续使用 local-self-signed，无 Developer ID / 公证迁移期限。
2. 发布前处理新 JS 许可缺口及实际产品依赖闭包。Intel、最低macOS、完整D06及系统输入 Fenced仍未验收，不为本次单窗口接线另扩清单。
