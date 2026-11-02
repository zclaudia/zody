# 本地代码签名身份：已获批并执行

**2026-10-29 用户回复“允许”，已按下述范围执行。** 系统现有 1 个有效的 `Zody Local Computer Use` 身份；实际指纹、CodeSigning 用户域信任及不可导出私钥检查见 SIGNING-ACCEPTANCE.md 与 evidence/signed/identity。以下保留获批的原操作说明。未修改 TCC。

拟建立固定名称 `Zody Local Computer Use` 的本地自签代码签名身份（RSA 3072 / SHA-256，证书用途 codeSigning；有效期五年，后续仍采用 local-self-signed，不要求迁移 Developer ID 或 Apple 公证）。证书与私钥导入当前用户 login keychain，私钥导入后不可导出，仅允许系统 `/usr/bin/codesign` 使用，不使用 allow-all ACL。信任设置只在当前用户域、只针对 codeSign，不增加系统域或 TLS 信任。临时私钥材料仅置于权限0700的临时目录，导入后删除，不写仓库、日志或聊天。

影响是新增一个持久的本地签名身份和对应用户级 codeSign 信任，可用于稳定识别自有 Helper。仅使用它签名本轮新 bundle 中的 Node 副本、原生程序和 app；不改原 Node、其他应用、library validation、系统库或全局工具链。记录公开证书、SHA-256/SHA-1、指定要求和实际制品摘要，不导出私钥。

签名顺序：先签新 bundle 内 Node 副本（hardened runtime、空 entitlement、执行 `--jitless`）；取得该副本实际摘要/代码目录摘要；据此编译原生资源 pin；最后签原生代码及 bundle 资源封口，再执行身份/加载预检。任何失败停止，不退回 ad-hoc，不忽略未解析符号，不使用 DYLD 覆盖。

此确认不包括屏幕录制/TCC 变更。身份链通过后若 TCC preflight 拒绝，将说明具体 app 与权限，再单独请求用户确认；未获批不触发权限请求、不执行截图。功能保持默认禁用。
