# Zody 用户级凭据密钥

状态：首发安全硬化实施规格，承接 `zody-0.1.0-release.md` 的凭据保护验收。

## 规则与所有者

- 不再从平台、用户名或 home 路径推导默认密钥。每个用户级配置目录使用随机 32-byte secret，存放在 credentials.json 同级的 `credentials.key`，POSIX 模式为 0600。
- 显式 `ZCODE_CREDENTIAL_SECRET` 保持既有优先级；未提供时由凭据 adapter 加载目录自己的随机密钥。UI、Main 和 gateway 不持有或分发另一个默认密钥。
- 密钥文件读写使用现有 shared 私有文件持久化与跨进程文件锁接口。锁内完成“读取或首次创建”，原子发布后才能用于加密；多个 Host / CLI 进程不得各生成一把并相互覆盖。
- `packages/shared/src/node` 是唯一密钥文件解析与持久化实现：异步 `resolveStoredCredentialSecret` 可在同一 key-file lock 下首次创建；同步 `readStoredCredentialSecretSync` 只读并拒绝缺失/损坏密钥，绝不创建或写入。Services 与 CLI 共用此入口。
- CLI cipher 只接受显式 secret，不再推导 platform/home/user 默认值。CLI store 每次操作前异步解析当前 credentials.json 所在目录的 key；同步 credential reader 只读取现有 key。自定义 cipher 与显式环境 secret 仍可注入测试或调用方。
- 保存凭据仍由 credentials.json 的既有读改写锁串行化；先确认 store 合法，再取得 key 加密并原子保存。Provisioning 从实际源 credentials.json 所在目录读取同一密钥，仅导出现有 allowlist，不同步本地 key。
- 密钥损坏，或存在加密凭据但密钥丢失时，明确失败，不重建密钥、清空数据或回落可预测派生。旧 home 不做迁移；本目录内既有明文兼容不扩大成旧目录自动导入。
- 这是用户级文件权限与随机密钥保护，不声称能抵抗同一 OS 用户同时读取 key 与 store，也不冒充系统钥匙串。环境变量或文件权限错误不能记录 secret 内容。

## 密文格式

- `enc:v1:` 之后的 payload 固定为 `iv.authTag.cipherText` 三个 base64url 段，恰好两个 `.` 分隔符；Services cipher 的结构判定以段数和分隔符为准，不能用「第三段非空」代替。
- Services cipher 视空明文为合法凭据：`encrypt("")` 产出 `enc:v1:<iv>.<authTag>.`，第三段是空串；`decrypt` 必须还原为空串。第三段缺失（payload 只有一个分隔符、拆不出三段）才是非法密文，不能与合法空串同等拒绝。
- 空 `iv` 或空 `authTag`、IV 非 12 字节、authTag 非 16 字节、错 tag 或错 key 导致的 GCM 校验失败，继续按既有解密错误契约拒绝，不返回空串或部分明文兜底。
- 不以 `enc:v1:` 开头的历史明文仍按原值返回；该兼容不因空密文段规则扩大。
- 解密失败只向上返回错误，不重建或改写 `credentials.key`，也不重写 `credentials.json`。本次只调整 Services cipher 的第三段判定，不改随机 key、文件锁、密文版本与旧明文兼容。
- CLI 对齐 follow-up（不包含在本项范围）：`apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts` 仍以 `!cipherRaw` 拒绝空第三段，`shared-credentials.ts` 的 `validateCredentialValue` 仍拒绝空凭据值。CLI 完成对齐前，空值合法性只属于 Services cipher；非空加密值仍按验收 6 互读。

## 验收

1. 两个独立 service 实例共享同一目录时均可解密已保存值；并发首次保存只产生一把 key。
2. 相同平台/用户信息的不同配置目录使用不同 key，复制 credentials.json 本身不能恢复数据。
3. key 不是 home / username 的确定性派生值；POSIX 文件权限为 0600。
4. key 缺失或损坏时不覆盖既有加密凭据，错误向上返回；显式 secret 的确定性读写仍可测试。
5. 不削弱损坏 store 备份、原子写入、并发保存不丢键和 Provisioning allowlist 的现有回归。
6. services 与 CLI 对同一目录的 key 文件和 `enc:v1` 非空密文格式互读；CLI 同步读取不会创建 key，缺失/损坏 key 会拒绝解密。空值互读待「密文格式」登记的 CLI 对齐 follow-up。
7. 空值经 service `save`/`load` 往返仍为空串；密文缺第三段、空 iv/authTag、错 tag、错 key 均拒绝解密，且这些解密失败路径不重写 `credentials.key` 与 `credentials.json`。
