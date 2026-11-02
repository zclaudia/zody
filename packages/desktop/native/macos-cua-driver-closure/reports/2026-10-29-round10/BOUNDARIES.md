# 第十轮来源与构建边界

第九轮 Rust 候选只读：776 文件，树 SHA-256 `421530ae2c2cab7b537226e459905916c849c1cf76095db0a45f574f9c49e02e`。本轮重新核实清单与每个文件；20 包目标图、44 份许可材料及 Rust/Swift 编译与测试结果仍为第九轮历史记录，不列作第十轮重跑。旧 SDK 的许可缺口没有因此补齐。

本轮新增的是独立第一方 Objective-C++ peer 诊断，不链接 Rust Driver、SCK 或 Swift 桥。最终编译使用 15 个 `.mm` 翻译单元，29 个 native 材料摘要（含头文件、README、PROVENANCE、LICENSE）与最终源码一致。实际直接动态依赖为 Foundation、Security、libbsm、libobjc、libc++、libSystem、CoreFoundation，详见 `checks/native-final-libraries.log`；没有通过 DYLD 覆盖、复制系统库、忽略链接错误或省略 native 编译来获取通过。

固定选择 `macosx27.0`，本机 Apple clang 21.0.0，arm64，部署目标 14.2；这里只在当前机器启动运行。Intel 和最低 macOS 实机仍未验收。该可执行文件的系统依赖闭包不能替代将来真正 Helper 合并 R9 Rust/Swift 视觉代码后的消费者闭包；R9 的 Swift runtime/rpath 要求仍须在那个最终消费者上再次验证。

源码为第一方实现，无第三方源码派生或 registry patch；SDK 头文件只用作接口，未复制系统库。新增 LICENSE 与仓库 Apache-2.0 原文逐字摘要一致，`checks/native-final-integrity.json` 记录核验。来源、补丁和许可材料完整性是工程证据，不是法律审查或产品采用批准。

TypeScript 接线通过既有 `@zcode/contracts` 和 `@zcode/zcode-cua/control-channel` 公开接口借用 authority port，经 adapters/mcp 公开导出；测试在 core 包内组合本地 authority 与 adapters 公共入口。没有新增 npm/registry 依赖或生产 runtime 授权 owner。新增控制对象拥有的是连接、在途请求、不可逆失效锁存及清理结果，不签发可执行资格。

原生产物 codesign 显示 ad-hoc/linker-signed，无叶证书；这是诊断工具链产物事实，绝不是 local-self-signed Helper 通过。没有执行签名写操作、证书生成/安装、钥匙串修改、TCC 变更或权限放宽。

Node 校准只读取本机既有签名和公开叶证书。它的 stored designated requirement 不符合本项目严格 local-self-signed 规则，实际 entitlements 也与 Helper pin 不符，minos 为 13.5。即使下层 SecCode/叶证书比较成功，Helper 策略仍拒绝；没有改变这些 entitlements，也不把 Node 或其加载的 JS 当作可信 Helper。

路径上的 executable SHA-256、entitlements、架构与 minos 是本次检查时的产物观察，不证明加载后的字节不可替换或后续升级原子性；bundleShortVersion/bundleVersion/executableName 的实际 bundle 元数据未验收。socket 的 inode/device 检查能拒绝预存与已替换路径清理，但 lstat/unlink 不是抵抗任意同 UID 主动攻击的原子原语。所有诊断 JSON 都不能重新注入为产品能力。

ad-hoc真实对照的动态代码有效性检查返回OSStatus 0；实际叶证书缺失且指定requirement不匹配，最终`ad-hoc-signature`拒绝来自诊断策略。不能将这一结果写成系统阻止了进程运行或签名身份已获产品授权。
