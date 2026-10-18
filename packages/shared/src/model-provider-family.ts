/**
 * fork（F4.11）：官方账号 Provider Family（Z.ai / BigModel 的 OAuth、Coding Plan、Start Plan、
 * Team Plan 身份与判定）随官方账号链路删除。
 *
 * 这里只保留旧 app settings / provisioning 协议中的域字段类型，供 `providerFamilyDomain`
 * 等持久化字段做兼容解析与透传；运行时代码不得再据此筛选或解析 Provider。
 *
 * @deprecated 仅用于存量设置字段的类型兼容，不参与 Provider 选择。
 */
export type ProviderFamilyDomain = "zai" | "bigmodel";
