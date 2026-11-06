import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const READ_SESSION_CONTEXT_TOOL_NAME = "ReadSessionContext";
export const READ_SESSION_CONTEXT_DEFAULT_MAX_TOKENS = 6000;
export const READ_SESSION_CONTEXT_MAX_TOKENS = 12000;

// 最小 JSON Schema 校验器不检查 pattern；联合字符串会在 oneOf 中同时匹配，错误拒绝 current。
// 用单个字符串模式，具体身份格式继续由运行时 schema 严格验证。
// fork（bots 移除）：bot 话题归档（strategy="topic"）与话题附件读取随 bot channels 全量
// 删除（specs/bot-channels-removal.md），策略面收窄为 relevant/handoff，输入目标必须是显式 sess_*。
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/;

export const ReadSessionContextStrategySchema = z.enum(["relevant", "handoff"]);

export const ReadSessionContextInputSchema = z
  .object({
    sessionId: z
      .string()
      .regex(SESSION_ID_PATTERN, "Session id must use the sess_* format.")
      .describe(
        "Explicit sess_* target to read from; the current task's session is never readable by id omission.",
      ),
    query: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "Focused natural-language description of the context needed from the target session.",
      ),
    strategy: ReadSessionContextStrategySchema.optional()
      .default("relevant")
      .describe(
        "Use relevant for focused session retrieval or handoff for a continuation summary.",
      ),
    maxTokens: z
      .number()
      .int()
      .positive()
      .max(READ_SESSION_CONTEXT_MAX_TOKENS)
      .optional()
      .describe("Approximate maximum tokens to return to the model."),
  })
  .strict();

export type ReadSessionContextInput = z.infer<typeof ReadSessionContextInputSchema>;

export const ReadSessionContextInputJsonSchema = toToolJsonSchema(ReadSessionContextInputSchema);

export const ReadSessionContextReferenceSchema = z
  .object({
    messageId: z.string(),
    partId: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    role: z.enum(["user", "assistant"]).optional(),
    reason: z.string().optional(),
  })
  .strict();

export type ReadSessionContextReference = z.infer<typeof ReadSessionContextReferenceSchema>;

export const ReadSessionContextOutputSchema = z
  .object({
    status: z.enum(["success", "not_found", "failed"]),
    sessionId: z.string(),
    title: z.string().optional(),
    directory: z.string().optional(),
    path: z.string().optional(),
    strategy: ReadSessionContextStrategySchema,
    query: z.string(),
    source: z.enum(["lite", "local", "fallback", "none"]),
    content: z.string(),
    messageCount: z.number().int().nonnegative(),
    selectedMessageCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    error: z.string().optional(),
    nextCursor: z.number().int().nonnegative().optional(),
    references: z.array(ReadSessionContextReferenceSchema).optional(),
  })
  .strict();

export type ReadSessionContextOutput = z.infer<typeof ReadSessionContextOutputSchema>;

export const ReadSessionContextOutputJsonSchema = toToolJsonSchema(ReadSessionContextOutputSchema);
