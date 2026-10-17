import { z } from "zod";

const helpConfigSchema = z.object({
  community_urls: z
    .object({
      "zh-CN": z.string().optional().catch(undefined),
      "en-US": z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  feedback_url: z.string().optional().catch(undefined),
  feedback_use_external_form: z.boolean().optional().catch(undefined),
});
export type HelpAppConfig = z.infer<typeof helpConfigSchema>;

/**
 * fork（F2.7）：帮助与社群配置只读内置 config/default.json。
 * 原实现会构造并请求远端 /api/v1/client/configs（buildHelpAppConfigUrl/createHelpAppConfigReader，
 * 附带设备标识，官方还能改写反馈与社群入口），现已删除：本函数只做本地解析，
 * 非法或缺失字段逐项降级为 undefined/false，不发起任何网络请求。
 */
export function resolveLocalHelpAppConfig(config: unknown): HelpAppConfig {
  const localConfig = helpConfigSchema.safeParse(config).data;
  return {
    community_urls: {
      "zh-CN": localConfig?.community_urls?.["zh-CN"],
      "en-US": localConfig?.community_urls?.["en-US"],
    },
    feedback_url: localConfig?.feedback_url,
    // false 是缺省语义：未明确配置外开表单时，反馈一律走应用内弹窗。
    feedback_use_external_form: localConfig?.feedback_use_external_form ?? false,
  };
}
