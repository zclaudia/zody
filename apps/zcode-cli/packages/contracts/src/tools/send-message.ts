import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";
export const SEND_MESSAGE_MAX_CONTENT_CHARS = 20_000;
const SEND_MESSAGE_MAX_SUMMARY_CHARS = 200;
const SEND_MESSAGE_SUMMARY_ELLIPSIS = "…";

export const SendMessageInputSchema = z
  .object({
    to: z
      .string()
      .min(1)
      .max(200)
      .describe("Recipient: local agent ID returned by Agent (format agent_<uuid>)."),
    summary: z
      .string()
      .min(1)
      .max(200)
      .describe("A 5-10 word summary shown as a preview in the UI."),
    message: z
      .string()
      .min(1)
      .max(SEND_MESSAGE_MAX_CONTENT_CHARS)
      .describe("Plain text message content"),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const SendMessageInputJsonSchema = toToolJsonSchema(SendMessageInputSchema);

// fork 偏离说明（来源 a60ba6a7 contracts/src/interfaces/shared.ts）：上游把该工具函数定义在
// interfaces/shared.ts 并 export；本仓尚未移植 shared.ts 的代理对工具函数（属其他卡范围），
// 故在此以模块内等价实现，待 shared.ts 移植后应改回 import 并删除本副本。
/** 去掉末尾的孤立高位代理：按 UTF-16 码元截取开头后，不留下半个代理对（半个 emoji）。 */
function dropTrailingHighSurrogate(value: string): string {
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? value.slice(0, -1) : value;
}

// 修复来源：上游 v3.17.1 a60ba6a7（contracts/src/tools/send-message.ts）。
// 1) 只有空白的 message 能通过 provider schema（minLength 1），child 会拒收却在待发队列回报
//    queued，永远送不到；运行时立即判为输入错误，provider schema 不变。
// 2) 超长 summary 在运行时截断而不是拒绝，且截断按代理对留位，不切半个 emoji。
// fork 偏离：上游同提交还把 provider schema 的 summary 改为 optional（连带 subagent.port.ts 的
// summary?: string），port/handler 在本卡落点之外，故 provider schema 维持本仓现状（必填 min(1)）；
// runtime schema 通过 extend 整键替换 summary，运行时语义与上游一致。
export const SendMessageRuntimeInputSchema = SendMessageInputSchema.extend({
  message: SendMessageInputSchema.shape.message.refine((message) => message.trim().length > 0, {
    message: "message must not be empty",
  }),
  summary: z
    .string()
    .optional()
    .transform((summary) =>
      // 超长时留一位给省略号；修复原因：直接 slice 会切断 emoji 等代理对，留下孤立的高位代理。
      summary !== undefined && summary.length > SEND_MESSAGE_MAX_SUMMARY_CHARS
        ? `${dropTrailingHighSurrogate(summary.slice(0, SEND_MESSAGE_MAX_SUMMARY_CHARS - 1))}${SEND_MESSAGE_SUMMARY_ELLIPSIS}`
        : summary,
    ),
});

export const SendMessageOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    messageId: z.string(),
    agentId: z.string().optional(),
    delivery: z.enum(["queued", "steered", "resumed_background"]).optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    outputFile: z.string().optional(),
    taskId: z.string().optional(),
  })
  .strict();

export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

export const SendMessageOutputJsonSchema = toToolJsonSchema(SendMessageOutputSchema);
