import {
  ZODY_AGENT_PROVIDER,
  ZODY_AGENT_PROVIDER_LABEL,
  type ZodyProvider,
} from "@zody/shared";

export const ZODY_AGENT_PROVIDERS: ZodyProvider[] = [ZODY_AGENT_PROVIDER];

export const ZODY_AGENT_PROVIDER_LABELS: Record<ZodyProvider, string> = {
  glm: ZODY_AGENT_PROVIDER_LABEL,
};

export function supportsZodySessionFork(provider: ZodyProvider): boolean {
  void provider;
  // 功能开关：fork 入口恢复对所有 ZCode provider 开放；实际可操作性仍由 task 状态、
  // assistant 目标和运行中保护 guard 控制，避免把 active/failed 分支暴露为可 fork。
  return true;
}

export function shouldHideZodySessionForkAction(provider: ZodyProvider): boolean {
  return !supportsZodySessionFork(provider);
}
