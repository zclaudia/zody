import { buildRuntimeZodyApiUrl } from "@zody/shared";

// fork（F3.1）：端点未配置时 buildRuntimeZodyApiUrl 返回空字符串；
// clientScenesService 据此关闭动态能力并返回空数据（UI 回落内置内容）。
export const ZODY_CLIENT_SCENES_URL = buildRuntimeZodyApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

// fork（F4.11）：ZAI_API_HOST（原 resolveZaiBusinessBaseUrl(process.env)，指向官方 business
// 网关）随官方账号链路删除；BYOK 请求地址由 provider 配置模板提供。
