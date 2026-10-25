import { z } from "zod";
import { mobileRequestContextSchema } from "./mobile-remote-phase1.js";

export const MOBILE_HISTORY_SEARCH_LIMITS = {
  queryLength: 256,
  resultLimits: [50, 100, 200],
} as const;

const querySchema = z.string().trim().min(1).max(MOBILE_HISTORY_SEARCH_LIMITS.queryLength);
const resultLimitSchema = z.union([z.literal(50), z.literal(100), z.literal(200)]);

/** A single-workspace request routed by Main to the owning Window Host. */
export const mobileHistorySearchRequestSchema = z
  .object({
    zcode_type: z.literal("mobile-history-search-request"),
    requestId: z.string().min(1).max(256),
    context: mobileRequestContextSchema,
    queryGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scopeSignature: z.string().min(1).max(8192),
    query: querySchema,
    includeArchived: z.boolean(),
    limit: resultLimitSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.requestId !== request.context.requestId) {
      context.addIssue({
        code: "custom",
        path: ["context", "requestId"],
        message: "requestId mismatch",
      });
    }
  });
export type MobileHistorySearchRequest = z.infer<typeof mobileHistorySearchRequestSchema>;

export const mobileHistorySearchStatusSchema = z.enum([
  "ok",
  "offline",
  "closed",
  "error",
  "unsupported",
]);

const mobileHistorySearchItemSchema = z
  .object({
    task: z
      .object({
        taskId: z.string().min(1),
        traceId: z.string().min(1),
        title: z.string(),
        titleOverridden: z.boolean().optional(),
        workspacePath: z.string().min(1),
        workspaceIdentity: z.string().optional(),
        workspacePurpose: z.enum(["project", "conversation"]).optional(),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        mode: z.enum([
          "default",
          "yolo",
          "guarded",
          "plan",
          "edit",
          "acceptEdits",
          "auto",
          "dontAsk",
          "bypassPermissions",
          "autoEdit",
          "build",
        ]),
        provider: z.string().optional(),
        model: z.string().optional(),
        status: z.string().optional(),
      })
      .strict(),
    workspaceKey: z.string().min(1),
    remoteSessionId: z.string().min(1).optional(),
    snippets: z.array(z.string()).max(4),
  })
  .strict();

export type MobileHistorySearchItem = z.infer<typeof mobileHistorySearchItemSchema>;

export const mobileHistorySearchOutcomeSchema = z
  .object({
    zcode_type: z.literal("mobile-history-search-outcome"),
    requestId: z.string().min(1).max(256),
    context: mobileRequestContextSchema,
    queryGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scopeSignature: z.string().min(1).max(8192),
    status: mobileHistorySearchStatusSchema,
    items: z.array(mobileHistorySearchItemSchema).max(200).optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.requestId !== outcome.context.requestId) {
      context.addIssue({
        code: "custom",
        path: ["context", "requestId"],
        message: "requestId mismatch",
      });
    }
    if (outcome.status === "ok" && !outcome.items) {
      context.addIssue({ code: "custom", path: ["items"], message: "ok outcome requires items" });
    }
    if (outcome.status !== "ok" && outcome.items !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "failed outcome cannot carry items",
      });
    }
  });
export type MobileHistorySearchOutcome = z.infer<typeof mobileHistorySearchOutcomeSchema>;
