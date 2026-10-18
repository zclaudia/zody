import type { ApiClient } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { ZCODE_CLIENT_SCENES_URL } from "../providers/api/apiEndpoints.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

export function createClientScenesService(dependencies: {
  apiClient: ApiClient;
}): IClientScenesService {
  return {
    list: () => {
      // fork（F3.1）：未配置 ZCode endpoint 时关闭动态 scenes 能力，返回空数据；
      // UI 侧（推荐列表 / Automations）会自然回落内置内容，避免请求相对 URL 报错。
      if (!ZCODE_CLIENT_SCENES_URL) {
        const empty: ClientScenesResponse = { code: 0, msg: "", data: [] };
        return Promise.resolve(empty);
      }
      return readApiJson<ClientScenesResponse>(dependencies.apiClient, ZCODE_CLIENT_SCENES_URL, {
        method: "GET",
      });
    },
  };
}
