import type { ModelRequestAuth } from "@zcode/contracts";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
// fork（F4.2）修复：原 import 路径 "../app/types.js" 自 src/ 出发解析不到 src/app/types.js，
// 属 M3 收尾遗留的坏路径（本次任务改動触发增量重编译后暴露）；修正为 ./app/types.js。
import type { SendInputOptions } from "./app/types.js";

/** 两种输入协议共用执行材料投影；不把 Secret/Ticket 放入可持久化的 intent。 */
export function createModelExecutionContext(
  input: NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>,
): NonNullable<SendInputOptions["modelExecution"]> {
  const requestAuth = input.requestAuth ? freezeRequestAuth(input.requestAuth) : undefined;
  return {
    ...(input.memoryExtraction ? { memoryExtraction: input.memoryExtraction } : {}),
    selectionScope: "execution",
    ...(requestAuth
      ? {
          requestDependencies: { requestAuth: { source: { resolve: async () => requestAuth } } },
        }
      : {}),
    ...(input.subagents ? { subagents: input.subagents } : {}),
    ...(input.selectionFallback ? { selectionFallback: input.selectionFallback } : {}),
  };
}

function freezeRequestAuth(input: ModelRequestAuth): ModelRequestAuth {
  return Object.freeze({
    ...(input.accountScope ? { accountScope: input.accountScope } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    ...(input.headers ? { headers: Object.freeze({ ...input.headers }) } : {}),
  });
}
