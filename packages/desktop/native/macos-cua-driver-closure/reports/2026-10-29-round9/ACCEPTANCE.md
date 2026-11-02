# 第九轮 controller 验收记录

2026-10-29。DeepSeek 实现，controller 负责调查、先行规格、最终 diff 审查、独立重建及验收。实际路由为 `deepseek-flash` / `magpie` / `commandcode-plan/deepseek/deepseek-v4.1-flash`，三个 worker 与文件边界见[第九轮计划](../../../../../../docs/plans/computer-use-macos-phase1-round9.md)。worker 均已结束写入。

## 完成结果

最终冻结树为 `421530ae2c2cab7b537226e459905916c849c1cf76095db0a45f574f9c49e02e`，776 文件。controller 从冻结 R8 与补丁重建至 `output/cua-driver-round9/candidate-work/controller-final/full-source`，编译和测试后树摘要一致。R8 的 767 条路径全部保留；相对 R8 修改 10 个文件、新增 9 个，无删除。完整上游来源仍固定 `2d2f99228d4d2508dc6fcc84c176b296e146714a`；上游→R9 与 R8→R9 的补丁、delta 不混用。

视觉根改为真实单窗口 Swift completion 桥，不再编译 SCK wrapper 的 Stream、RecordingOutput、音频、picker、CoreMedia/Metal 纹理桥。目标 Cargo 图从 30 减至 20 包（19 registry + 1 path），移出 10 包，没有新增 registry 或 feature 变化。独立消费者图为 21 包，额外一项为消费者自身。旧 SDK 259 包基线不因此成为等价替换；旧源码、安全限制和锁记录保留。

内部采集增加有界的 4 项在途资源登记、单次消费、可跨线程唤醒的取消句柄、Drop 关闭、晚到结果丢弃、重复回调防护和最终交付前取消检查。操作 ID 是资源关联，不是许可。Swift 在像素分配前拦截重复截图回调，显式通过 C ABI 回调交付资源释放事实，避免旧的跨调用约定假设。公开入口仍为 `HostNotApproved`，未接生产或发布 `finalFrame`。

## 分层验收

| 层次                         | 独立结果       | 证据与限制                                                                                                |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| 冻结重建                     | 通过           | 776 文件、树/patch/清单逐项校验；`checks/prepare-accepted.json`                                           |
| 实际目标图                   | 通过           | 20 包；`checks/comparison.json`、`report.json.gz`；lock 共 571 条不能代替目标图                           |
| 真实库编译                   | 通过           | 固定 Rust 1.97.1，arm64 locked/offline；4 个 build-script 包、0 proc-macro、20 项产物记录；`build.log.gz` |
| Swift 对象及最终消费者       | 通过，本机范围 | 真实对象被保留并最终链接/加载；消费者只执行纯逻辑；`native/`                                              |
| Rust 纯逻辑                  | 50 项通过      | 34 lib + 16 integration；包含取消、容量、晚到、退出接收、身份漂移与 fail-closed，不执行 OS 采集           |
| Driver 工具                  | 106 项通过     | 11 个测试文件；新增 19 项重建/漂移/依赖/锁记录负例；`checks/driver-tests.log`                             |
| 根检查                       | 通过           | Node 24.14.0；typecheck、lint 0 errors / 301 warnings、架构 0 violations；警告数与开工基线一致            |
| 格式                         | 通过           | 新工具定向 oxfmt 与最终候选固定 rustfmt；中间格式失败日志保留，不冒充最终结果                             |
| 真实原生调用                 | 未执行         | 无窗口枚举、截图或输入；Swift 回调运行时行为未实测                                                        |
| 产品 / Helper / TCC / Fenced | blocked        | 编译、纯测试、取消接收和进程启动不替代这些门槛                                                            |

架构检查的 desktop 上下文为 managed=false、无受控合同；架构通过不证明原生安全。此次无产品 UI 或模型工具/schema 变化，不新增交互 E2E 通过结论。

## Swift 与消费者闭包

真实编译器为 Apple Swift 6.4（swiftlang-6.4.0.34.1），使用固定选择器 `macosx27.0`，Swift language mode 5。Swift 对象和独立消费者均记录 `minos 14.2`、`sdk 27.0`，消费者自身声明 `LC_RPATH=/usr/lib/swift` 和同一 SDK 的 syslibroot。没有 DYLD 覆盖、系统库复制、忽略未解析符号或 native 编译跳过。

对象实际 autolink 仍含系统 Metal、Swift Metal/AVFoundation 等 overlay，也有 Swift concurrency 链接选项；这不是通用 Rust AppleMetal wrapper 或录屏实现重新进入图。最终动态依赖以 `native/consumer-libraries.stdout.log` 为准，不能把对象 autolink 与最终 dylib 列表混为一谈。对象未要求 `libswiftCompatibility56` / `libswiftCompatibilityPacks` 的 FORCE_LOAD，因此本配置不以这两份 archive 为前提；不能推广到其他编译器或部署目标。普通系统动态导入不是通过忽略链接错误留下的未解析符号。

controller 独立编译完整桥推翻了早期“SDK 27 与编译器不兼容”的判断，故没有沿用 SDK 15.2 回退。`sdk-investigation/`保留独立编译源快照、日志和对象信息；该快照是中间调查材料，最终树证据在 `native/`。早期 worker 的原始诊断未形成可复核失败日志，不把其解释当作已确认原因。

消费者是普通 link/start 探针，codesign 显示 `adhoc,linker-signed`、无 Team ID；这是工具链产物事实，**不是 local-self-signed Helper 验收**。没有执行签名修改、证书安装、TCC 变更或关闭 library validation。持续采用 local-self-signed，无 Developer ID/公证迁移期限。现有 diagnostic Helper 的构建下限仍是 12.0，且不链接 Driver；它不能自动继承本候选的 14.2 部署、rpath 或许可生命周期。真正 Helper 消费者必须另行闭合配置并实测。

## 来源、许可与保留核验

SCK 派生输入固定为 `screencapturekit 8.0.1`，crate archive SHA-256 `9ddaa8d6b16a2762c9a97c9a6297f04cb8ded0487e5ef02dc98b4e2bee3a26c7`，VCS `2a9f13bcbeadb0aabc5596f0ff3d2ba71da8c1d0`。`derived-source/`保存实际读取的五份 Swift 原文件、Package.swift、manifest/VCS 与原文许可，`provenance.json`记录逐文件摘要。派生说明及新桥在冻结补丁内，MIT 与 Apache-2.0 原文随派生代码保留；CUA 根 MIT 不被用来覆盖这些材料。

新图许可正文 0 missing / 0 partial / 0 reviewRequired / 0 MPL，归档 44 份包内材料（包含派生桥的两份原文许可），另有 upstream 根许可。材料门通过不是法律结论或产品采用授权。旧 SDK 的 13 missing / 1 partial 仍未补齐；本轮只是进一步缩小目标图。

原有 570 条锁记录保留，569 条语义不变，仅视觉包去掉 SCK 依赖；新增一个 path probe，所有 558 项 registry checksum 保留。重建了 316 份已有 archive 的缓存并核验 19 项实际目标 registry；原缓存自身仍有前轮漂移，审计只读记录并使用独立重建缓存，没有修补原缓存。

开工快照 3208 个文件中，仅本轮预先声明的 spec/design/implementation 三份文档变化，无缺失或意外改动；其中前轮冻结与验收材料全部保持。另核验 201 个 SCK/AppleMetal/Apple-CF registry 源文件无变化。R8 冻结树仍为 `4cbad8776947504f9883bf5370d6802177090d7a01075c5640b64a730950d9de`。范围见 `checks/preservation.json` 与开工摘要，未声称检查工作区所有无关文件。

## 已审查的生命周期边界与剩余阻断

资源 owner 不复制既有 `CuaSubmissionAuthority`、`submissionLineageId` / `authorizationRevision`、lease 或 frame owner。现有控制协议的 stop 事实仍需分别提供 nativeFenced、pending、ownedInputsReleased、leaseReleased；本轮资源回调不产生这些事实。诊断 Helper 没有 peer、TCC、采集能力，故没有可接入的真实许可来源，本轮只完成内部资源/取消基础。

取消前准入会拒绝截图；准入已通过的 OS 工作可能继续，晚到结果只被丢弃。`payload_released` 表示 C 回调已返回且桥自有像素存储/借用交还，**不证明 Apple 回调线程或 ScreenCaptureKit 已静止**。缺少回调时容量继续占用；未取消的等待仍可能无限等待，OS 调用本身也无已验证的阻塞上限。纯线程取消测试不是原生取消或 native Fenced/Drained。原生颜色/透明度（延续 R8 premultiplied RGBA 编码）、Retina、多显示器与实际窗口一致性尚未截图验收。

后续顺序：先把真正 Helper 的签名身份/加载/peer 与已有 submission、lease 的借用/撤销生命周期接通；涉及证书安装或系统权限变更时说明具体操作和影响后取得确认；随后真实 TCC 归属、单窗口采集及取消/退出证据；再闭合完整 D06、native Fenced/手机屏障、升级稳定性、Intel 和最低 macOS。缺少任一激活前置证据继续 fail-closed。

功能保持默认禁用，`packages/zcode-cua/package.json` 的 `zcodeCuaPlaceholder` 仍为 true。

## 归档与复跑

`report.json.gz` 是最终树完整审计 JSON；`upstream-candidate.patch` 为固定上游→R9 全量补丁，`frozen-inputs/candidate-source.patch` 为 R8→R9 增量。`acceptance-summary.json`绑定最终来源/构建产物摘要。可执行文件、rlib、对象和缓存保留在本地 output，不纳入文本证据归档。`evidence-sha256.json`绑定本目录材料。

`failed-attempts/`保存最初缺少审计配置字段的失败。`intermediate-semantic-tree/`只对应格式化前 `73c392…` 树；它不是最终验收。`checks/rustfmt.log`为中间失败，最终为`rustfmt-accepted.log`。准备收据的最终版本为`prepare-accepted.json`，早期收据仅保留过程证据。

复跑时从仓库根使用 mise.toml 要求的 Node 24.14.0，prepare 选择全新的 round9 输出路径，不能覆盖前轮或已有输出：

```sh
node packages/desktop/scripts/prepare-macos-cua-driver-round9.mjs \
  --output /Users/zhvala/SourceCode/zody/output/cua-driver-round9/candidate-work/replay-new/full-source
node packages/desktop/scripts/audit-macos-cua-driver-closure.mjs \
  --source-repo /Users/zhvala/SourceCode/3rd-party-repositories/cua \
  --candidate-root /Users/zhvala/SourceCode/zody/output/cua-driver-round9/candidate-work/replay-new/full-source \
  --cargo-home /Users/zhvala/SourceCode/scripts/experiments/zody-cua-p0-g2-stop-retire-reservation/build/cargo-home \
  --output-dir /Users/zhvala/SourceCode/zody/output/cua-driver-round9/replay-new-audit \
  --review-config packages/desktop/native/macos-cua-driver-closure/round9/review-config.json \
  --source-manifest packages/desktop/native/macos-cua-driver-closure/round9/source-manifest.json \
  --rebuild-cache \
  --toolchain-root /Users/zhvala/SourceCode/zody/output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin \
  --build-library
```

`runners/controller-verify.mjs.txt`记录纯测试与最终消费者检查脚本，复制回`output/cua-driver-round9/controller-verify.mjs`后传入新源码目录和全新结果目录；`native/commands.json`保存实际命令/隔离环境。隔离环境不是 OS sandbox。只运行这组已审查的纯测试，不运行旧上游全部原生测试。
