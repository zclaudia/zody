import type { TurnInputIntentMetadata } from "@zcode/contracts";

/** 引用只在模型边界转为材料，不能混入 canonical 用户正文或解析成控制命令。 */
export function withConversationQuotes(
  text: string,
  quotes: TurnInputIntentMetadata["conversationQuotes"],
): string {
  const parts = [text];
  if (quotes?.length)
    parts.push(`<conversation_quote>\n${JSON.stringify(quotes)}\n</conversation_quote>`);
  // fork（bots 移除）：原 botSource 参数（bot 群来源指令、可信 bot 身份、原生 mention 材料）
  // 随 bot channels 全量删除（specs/bot-channels-removal.md）；模型输入只保留通用引用材料。
  return parts.filter(Boolean).join("\n\n");
}
