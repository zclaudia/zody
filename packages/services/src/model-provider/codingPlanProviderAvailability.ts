/**
 * fork（F4.5）：官方 Coding Plan / Start Plan 权益查询链已删除（订阅服务、bigmodel
 * entitlement、额度 monitor 均随本任务移除）。本文件按任务要求先桩掉远端校验，
 * 统一返回不可用，避免 accountProviderConnectionResolver 留下断引用；文件本体
 * 与账号连接链由 F4.7 一并删除。
 */
import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";

export type CodingPlanUnavailableReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled";

interface CodingPlanAvailabilityContext {
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
}

export type CodingPlanAvailabilityResult =
  | { kind: "available"; models?: readonly string[] }
  | { kind: "pending"; effectiveAt: number; models: readonly string[] }
  | { kind: "unavailable"; reason: CodingPlanUnavailableReason }
  | { kind: "unknown" };

export interface CodingPlanAvailabilityProvider {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly planKind: "start-plan" | "individual-coding-plan" | "team-coding-plan";
  readonly apiKey?: string | null;
}

const UNAVAILABLE: CodingPlanAvailabilityResult = Object.freeze({
  kind: "unavailable",
  reason: "coding_plan_not_connected",
});

export async function validateZaiAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  _context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  return mapProvidersUnavailable(providers);
}

export async function validateBigModelAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  _context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  return mapProvidersUnavailable(providers);
}

function mapProvidersUnavailable(
  providers: readonly CodingPlanAvailabilityProvider[],
): Partial<Record<string, CodingPlanAvailabilityResult>> {
  const result: Record<string, CodingPlanAvailabilityResult> = {};
  for (const provider of providers) {
    result[provider.providerId] = UNAVAILABLE;
  }
  return result;
}
