# 第十一轮签名与真实截图续验收

2026-10-29。用户回复“允许”后，controller 完成此前提出的证书安装、签名和独立验收。**显式开发链已经真实完成：签名 supervisor → 签名 Node 中的既有 CuaSubmissionAuthority → 已认证 Helper/机器锁 → 一张单窗口 PNG → authority 撤销 → 资源和锁释放。** 功能仍默认禁用；不是生产 Desktop 会话接线完成。

## 身份与签名

- 固定身份 `Zody Local Computer Use`；RSA3072 / SHA256，自签 codeSigning 证书，有效期五年。
- SHA256 `a7f7afa6a507b71c996f4a9bfbf6eef908d67054acdca93833bcd4c94c13ef0b`；SHA1 `d2ad8f4bb39ad7dd13ceba3892cadb16659a4732`。
- 导入当前用户 login Keychain；Security API 实查私钥不可导出，仅 codesign ACL。新增信任只在用户域、只针对 CodeSigning。公开证书及策略证据见 `evidence/signed/identity/`；临时私钥文件已删除，无私钥归档。
- 首次空密码 PKCS12 导入失败，目标身份/钥匙查询确认未导入；随后用临时 PEM sequence 成功导入最终身份。没有扩大 ACL 或信任范围。
- 先签 Node 副本，取得实际 DR/CDHash，编入 Helper pins 再重建/签 bundle。Helper 与 Node 均 hardened runtime、空 entitlement、非 ad-hoc；没有伪造 Team ID、关闭 library validation、DYLD 覆盖或复制系统库。
- 最终 Helper 自身 Security preflight 返回 pass：证书/identifier/DR 全部匹配、实际代码有效、资源封口有效。两份 codesign strict verify 通过。实际执行的 Node 使用 --jitless，原 Node 摘要仍是 `20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55`。
- 签名候选：`output/cua-helper-round11/controller-signed/candidate/helper/Zody CUA Helper Round11.app`。最终 executable SHA256 `f321465c59b8b71625abc88a4fe4c298cc16cfa8fe433fb28566247fa74f0b1a`；签后全部文件摘要见 `evidence/signed/signing-manifest.json`。build manifest 描述签名前构建，不冒充签后摘要。

## 一次实际运行

`run-once-command.json` 固定实际窗口 ID85709、PID64169、layer0、bounds(680,76,1200,800)，来自当时 CGWindowList 的 Zody 单窗口元数据。干净环境 PATH/LANG/LC_ALL，无 DYLD 环境覆盖。

运行 exit0，返回 `{"status":"pass","reason":"captured-and-revoked","captureEntry":true}`，耗时0.770秒。controller 打开 PNG 确认是非空 Zody 窗口图。PNG为2400×1600、238063字节，SHA256 `08e3632568f1a71ff90f9e75c02a0d55f8ffd616bc68402c2d087c5a70617fe5`。原图仅留本地 `output/cua-helper-round11/controller-signed/capture-zody.png`，不归档用户窗口图到源码仓库。

这一成功分支必须经过：加载中的 Node 身份/CDHash 核验、双向 peer audit token 与真实 Security requirement 核验、实际 authority bootstrap/完整 ref 复核、机器锁取得、原生截图、callback 资源归还、authority revoke 回执、机器锁释放、Node 回收以及父进程核对 PNG 摘要/尺寸。并非只凭 child exit0 认定成功。controller 另外在运行后成功重新取得同一 inode 的 OS 锁。当前日志记录最终结果，过程条件依据冻结源码的成功分支审查；没有额外逐 checkpoint 运行轨迹。

真实撤销发生在本次截图完成后；本次不证明采集中撤销竞态、输入 Fenced、完整D06或生产 finalFrame 发布。

## 权限与实际剩余缺口

本次 `CGPreflightScreenCaptureAccess` 允许，实际截图成功；**未请求、授予、重置或修改 TCC**。这证明当前从控制器启动的进程链有可用权限，不能由此断言 TCC 独立归属于 Helper；未验证独立启动和升级后的权限归属与稳定性。

当前主要剩余工作是接入运行中 Desktop/CommandInbox 的真实 submission/producer owner。本轮开发 bundle 使用的是既有 authority 类为显式开发调用建立的实例，并非正在运行的生产会话实例；没有新建业务授权 map。下一步先打通该实例边界，再对独立启动的固定签名 Helper 核实 TCC 归属。需要证书或权限变更时另行说明并请求确认，不能为了演示开放默认开关。

## 必要复核与来源保持

57文件冻结源码逐项摘要保持不变，源码树 `0527c734fdcfcf7ba65f3b80f3de3fa43f46a1a7626d850a8c064b82577da64a`；本次没有改实现，无须新增 DeepSeek 实现任务。原 unsigned 候选、R9/R10 材料保留。

本次重跑 root typecheck 通过；最终 lint 301 warnings/0 errors；architecture 0 violations。第一次 lint 发现先前归档 `evidence/authority-bundle.mjs` 被作为源码触发 max-lines，现仅将归档改名为 `.mjs.txt`，字节/摘要不变；没有改运行 bundle 或放宽 lint。首次失败与修正后结果均保留。此前相关 Rust/Node/native 测试结果仍见主 ACCEPTANCE，无新的源码变更。

公开证书、pins、构建命令、签后摘要、preflight、真实 run-once 及独立 PNG/锁检查在 `evidence/signed/`；完整本地候选和安装过程证据在 `output/cua-helper-round11/controller-signed/`。
