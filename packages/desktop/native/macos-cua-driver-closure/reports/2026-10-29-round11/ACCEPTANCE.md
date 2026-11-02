# 第十一轮验收

2026-10-29。**本轮开发纵向链已完成真实签名、单窗口截图与撤销。** 用户批准后安装了固定 local-self-signed 身份；未修改 TCC。功能默认禁用，`zcodeCuaPlaceholder:true`。续验收及当前缺口见 [SIGNING-ACCEPTANCE.md](SIGNING-ACCEPTANCE.md)。下方无签名阶段结果保留为历史记录。

## 完成边界

新增显式开发 bundle：原生 supervisor 固定自身签名要求与执行资源，封装 Node 和已打包的既有 `CuaSubmissionAuthority`；Helper 双向核验实际 peer audit token，通过私有 FD 复核完整 submission ref，持有稳定的每用户机器 OS 锁，调用 R9 派生的单窗口截图 C ABI。撤销/authority EOF/启动者断连封闭接收；采集对象释放与撤销回调串行，资源未知时保留到进程终止，绝不据此声明 Fenced。

此开发入口实例化并执行既有 authority 类，**尚未连接运行中 Desktop/CommandInbox 的 authority 实例**。没有新增业务授权 map、TS leaseGranted 或业务 frame registry；未开放模型 cell、生产调用或 finalFrame。

## 独立执行结果

| 范围 | 结果 | 证据（本目录相对路径） |
| --- | --- | --- |
| Rust/Swift 真实编译 | 固定 Rust1.97.1、arm64 locked/offline staticlib 通过；Swift 对象 minOS14.2 | evidence/visual-build-manifest.json |
| 实际依赖图 | 20包：19 registry+1 path；Cargo.lock 与 R9 一致；未新增包 | evidence/visual-cargo-tree.txt |
| 视觉纯测试 | 43项 Rust 纯测试、3项构建包装测试通过；不运行截图 | evidence/visual-rust-tests.log、visual-test.log |
| 既有 authority | 5项真实 Node 子进程测试通过，涵盖完整绑定、撤销、断连及背压 | evidence/authority-test-fixed.log |
| 最终 Helper bundle | 全部 R11 native、所需 R10 peer 源码、Rust/Swift 库真实编译链接通过；arm64/minOS14.2，系统 Swift rpath=/usr/lib/swift | evidence/helper-build-manifest.json |
| 原生必要检查 | 3项通过：最终构建、未签名拒绝、真实两进程争锁及同 inode 释放后再取得 | evidence/native-accepted-tests.log |
| 实际打包 Node/JS | 干净 env、--jitless、私有 FD：bootstrap→revoked 事件及回执→close/exit0；与最终 bundle 的 Node/JS bytes 相同 | evidence/bundled-authority-smoke.json、resource-verification.json |
| 仓库检查 | 根 typecheck 通过；lint 301 warnings/0 errors，与开工相同；architecture 0 violations；CLI typecheck/lint通过 | evidence/*-final.log、cli-typecheck.log、cli-lint.log |
| 基线保留 | 开工18,539个文件无缺失；仅修改本轮 spec、tool change chain、core package.json 三个既有文件，其余保持原样；R9冻结树未变 | evidence/workspace-preservation.json、round9-tree-final.json |

实际 native 运行仅包含 Security preflight、锁测试和上述 Node 进程；**未执行可信签名 peer 正例、TCC 归属或 CG/SCK 截图**。链接器生成的 ad-hoc 签名被拒绝，不能当作 local-self-signed 验收。原生 Helper 通过链接和本机加载，不证明未来已签名消费者、最低系统或 Intel 自动通过。

## 冻结来源与制品

- R9只读基线：776文件，tree SHA-256 `421530ae2c2cab7b537226e459905916c849c1cf76095db0a45f574f9c49e02e`。
- R11视觉派生树：777文件，tree SHA-256 `03fc37adc98f44e0853784d39aa2480e8932535e35300fd3a6b5f9303074b3e1`。固定 patch/header/helper 源码摘要和原许可材料摘要见 visual prepare/build manifests。R11未修改Swift桥、原registry缓存或前轮材料。
- 本轮源码快照：57文件，清单见 `SOURCE-MANIFEST.json`；tree SHA-256 `0527c734fdcfcf7ba65f3b80f3de3fa43f46a1a7626d850a8c064b82577da64a`。`source-round11.tar.gz` SHA-256 `41bbb0bf5987e66afab6e11b71dbae285e673b161c0d0ea4d976dae692357050`。
- 独立候选：`output/cua-helper-round11/controller-accepted/helper/Zody CUA Helper Round11.app`。原生 executable SHA-256 `9a7fca3066bfa08a1e62dcdc7823866dcdc141d7f1f2c29c3a27f03dac421418`。身份 pins 全空，默认拒绝。
- Node24.14.0为固定本地副本；原文件未修改。Node和许可证摘要、打包authority实际输入摘要、原生头文件摘要、编译链接命令均已归档。Node自身Mach-O为arm64/minOS13.5；这只是元数据，不是最低系统实测。
- 图内第三方许可复用R9已归档正文及固定摘要，新增Node全文见 `licenses/node-LICENSE.txt`。源码/材料完整不等于法律审查或产品采用通过。

## 签名前的阻断记录（已由续验收推进）

最终只读查询仍为 **0 valid signing identities**（evidence/signing-identities-final.txt）。下一步按 `CERTIFICATE-PROPOSAL.md` 请求用户确认：建立固定 local-self-signed 身份并仅添加用户域 codeSign 信任。未获批不得安装。

获批后仍在第十一轮继续：签 Node 副本→读取真实 leaf/DR/CDHash 与资源摘要→带真实 pins 重建并签 Helper bundle→实际身份与加载链。如果 TCC 缺权，再单独说明具体屏幕录制权限并取得确认，然后对明确测试窗口执行一次截图与撤销。带真实 pins 的构建及签名分支本轮未执行；失败继续拒绝，不切换 ad-hoc、DYLD 覆盖或放宽 library validation。

当前没有真实PNG、native Fenced、完整D06或产品通过结论。完成开发纵向实测后，再接生产 Desktop/CommandInbox owner；不把开发实例冒充生产接线。

## 当前结论

签名身份、真实 Helper peer、既有 authority 开发实例、一次截图及随后撤销已通过。生产 Desktop/CommandInbox 的真实 owner 接线，以及独立启动/升级的 TCC 归属仍未完成。没有 native Fenced、完整D06或产品开放结论。具体证据见 SIGNING-ACCEPTANCE.md。
