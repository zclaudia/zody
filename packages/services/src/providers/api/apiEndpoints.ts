import { buildRuntimeZCodeApiUrl } from "@zcode/shared";

export const ZCODE_CLIENT_SCENES_URL = buildRuntimeZCodeApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

// fork（F4.11）：ZAI_API_HOST（原 resolveZaiBusinessBaseUrl(process.env)，指向官方 business
// 网关）随官方账号链路删除；BYOK 请求地址由 provider 配置模板提供。
