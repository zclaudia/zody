import { z } from "zod";

export const CUA_CONTROL_AUDIT_PREFIX = "[cua-control] ";

// 仅接收 native 固定派发事实，防止正文、窗口或原始身份进入生产日志。
export const controlAuditSchema = z
  .object({
    event: z.enum(["rejected", "admitted", "completed"]),
    attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    scope: z.string().regex(/^[0-9a-f]{16}$/u),
    dispatch_status: z.enum(["not_sent", "sent", "possibly_sent"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.event === "rejected" && value.dispatch_status !== "not_sent") ||
      (value.event === "admitted" && value.dispatch_status !== "possibly_sent") ||
      (value.event === "completed" && value.dispatch_status === "not_sent")
    ) {
      context.addIssue({ code: "custom", message: "control dispatch is inconsistent" });
    }
  })
  .transform((value) => ({
    event: value.event,
    attempt: value.attempt,
    scope: value.scope,
    dispatch_status: value.dispatch_status,
  }));
