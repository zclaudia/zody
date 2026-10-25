import { z } from "zod";
const id = z.string().min(1).max(256);

/**
 * 第二批 E4：permission 类通知携带的操作按钮。envelope 只放 optionId + optionKind，
 * 不携带 label/命令/路径——按钮文案由 Android 端按 optionKind 用本地固定文案渲染。
 */
export const mobileNotificationActionKinds = ["allowOnce", "allowAlways", "deny"] as const;
export type MobileNotificationActionKind = (typeof mobileNotificationActionKinds)[number];

export interface MobileNotificationPushAction {
  optionId: string;
  optionKind: MobileNotificationActionKind;
}

export const mobileNotificationPushActionSchema = z
  .object({
    optionId: id,
    optionKind: z.enum(mobileNotificationActionKinds),
  })
  .strict();

/** 上限 3：与 Android 通知 action 的可用宽度一致；超出的选项点击进 App 处理。 */
export const mobileNotificationPushActionsSchema = z
  .array(mobileNotificationPushActionSchema)
  .max(3);

/**
 * 从 pendingInteraction 的 permission payload 提取通知按钮（第二批 E4）。
 * 只认 optionId 非空且 kind ∈ {allowOnce, allowAlways, deny} 的选项，按原顺序取前 3；
 * custom/自由文本选项不映射为通知按钮（点击进 App 处理）。非法输入返回 undefined。
 */
export function extractMobileNotificationPushActions(
  payload: unknown,
): MobileNotificationPushAction[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const options = (payload as { options?: unknown }).options;
  if (!Array.isArray(options)) return undefined;
  const actions: MobileNotificationPushAction[] = [];
  for (const option of options) {
    if (actions.length >= 3) break;
    if (typeof option !== "object" || option === null) continue;
    const optionId = (option as { optionId?: unknown }).optionId;
    const optionKind = (option as { kind?: unknown }).kind;
    if (typeof optionId !== "string" || optionId === "") continue;
    if (
      optionKind === "allowOnce" ||
      optionKind === "allowAlways" ||
      optionKind === "deny"
    ) {
      actions.push({ optionId, optionKind });
    }
  }
  return actions.length > 0 ? actions : undefined;
}

export const mobileNotificationReceiptSchema = z
  .object({
    status: z.enum(["accepted", "filtered", "retryable", "terminal"]),
    code: z.string().max(128).optional(),
  })
  .strict();
export type MobileNotificationReceipt = z.infer<typeof mobileNotificationReceiptSchema>;
export const mobileNotificationPublishSchema = z
  .object({
    type: z.literal("mobile-notification-publish"),
    requestId: id,
    backendId: id,
    event: z
      .object({
        name: z.string().min(1).max(128),
        title: z.string().max(256),
        body: z.string().max(4096),
        clickUrl: z.string().max(2048),
        severity: z.enum(["info", "success", "warning", "error"]).optional(),
      })
      .strict(),
  })
  .strict();
export type MobileNotificationPublish = z.infer<typeof mobileNotificationPublishSchema>;
export const mobileNotificationResultSchema = z
  .object({
    type: z.literal("mobile-notification-result"),
    requestId: id,
    receipt: mobileNotificationReceiptSchema,
  })
  .strict();
export const mobileNotificationContextSchema = z
  .object({
    type: z.literal("mobile-notification-context"),
    enabled: z.boolean(),
    backendId: id.optional(),
  })
  .strict();
