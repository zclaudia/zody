import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  readRequestVerificationConfig,
  resolveDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
  type RequestVerificationConfig,
  type ZCodeModelContextBudgetStrategy,
} from "@zcode/shared";

/**
 * fork（F2.6b）Host 侧 client-config 本地值：`/api/v1/client/configs` 不再被请求，
 * 全部非账号消费者改读本模块的固定值。取值与改造前「远端缺省 / 断网」时的回落一致
 * （阶段 2 细则 D1b「灰度开关的本地默认值」），本模块是这些值独立于官方账号的唯一所有者，
 * F4.5 删除 `coding-plan-subscription/` 后不受影响。
 */

/**
 * 动态工作流 offer：`ZCODE_DYNAMIC_WORKFLOW_MODE` 三档覆盖规则不变（shared 折叠裁决），
 * 覆盖缺省时落到 fork 固定提供值 `onDemand`（来源 default），再叠加用户设置
 * `dynamicWorkflowMode`（launch.md「The user's choice」；读取失败按抛错上抛，
 * 与原订阅服务路径一致，由调用方按各自契约降级）。
 * 恒以 `remote: undefined` 调用 shared 纯函数：fork 没有远端来源，取值域与优先级不在此复述。
 */
export async function resolveLocalDynamicWorkflowClientConfig(input: {
  env?: Record<string, string | undefined>;
  resolveUserMode?: () => Promise<unknown>;
}): Promise<DynamicWorkflowClientConfig> {
  const userMode = input.resolveUserMode ? await input.resolveUserMode() : undefined;
  return resolveDynamicWorkflowClientConfig({
    remote: undefined,
    env: input.env,
    userMode,
  });
}

/**
 * 请求验证配置：shared 裁决（readRequestVerificationConfig）恒返回 null，
 * 与「远端不可达 / key 缺省」一致。当前订阅服务之外无消费者，导出仅为 F4.5
 * 删除订阅服务后保留本地所有者声明。
 */
export function resolveLocalRequestVerificationConfig(): RequestVerificationConfig | null {
  return readRequestVerificationConfig(undefined);
}

/** 上下文预算策略：3.12.2 起统一 preflight-v1，不再为建会话等待远端配置。 */
export const LOCAL_MODEL_CONTEXT_BUDGET_STRATEGY: ZCodeModelContextBudgetStrategy =
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
