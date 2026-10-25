import { useRef, type ReactNode } from "react";
import { Emitter } from "@zcode/rpc";
import { StoreProvider } from "@/store/StoreProvider.js";
import type { BroadcastMessage, IBroadcastService } from "@zcode/services";

/**
 * 无 host services 的独立远控页面（如空态启动页）所需的本地 store 上下文。
 *
 * 修复原因：空态 StartPage 的渲染树只有 ZCodeIntlProvider，而页面头部的
 * WebRemoteControlThemeMenu 无条件使用 useZCodeStore——没有 StoreProvider 时
 * 整页抛「useZCodeStore 必须在 StoreProvider 内使用」白屏（A-MO-01 实测发现）。
 * 聊天页走 Root 自带 Provider 不受影响。
 *
 * 这里的 IBroadcastService 是进程内 no-op 实现：独立页面没有可同步的对端窗口
 * （空态时桌面本来就没有打开的 workspace），send 丢弃、onMessage 永不触发、
 * claim 语义退化为页面内首次占用；不引 @zcode/services/node 的
 * createBroadcastService，避免把 node 依赖带进浏览器 bundle（mobile web 构建隔离）。
 */
function createStandaloneBroadcastService(): IBroadcastService {
  // 独立页面没有对端：onMessage 只需满足 Event 形状，永不触发。
  const emitter = new Emitter<BroadcastMessage>();
  const localClaims = new Set<string>();
  return {
    async send() {},
    async acquireClaim() {
      // 单页面无竞争：直接视为已占用（claim token 不会被 commit/release 使用）。
      return { status: "committed" as const };
    },
    async commitClaim() {},
    async releaseClaim() {},
    async tryClaim(key: string) {
      if (localClaims.has(key)) return false;
      localClaims.add(key);
      return true;
    },
    onMessage: emitter.event,
  };
}

export function WebRemoteControlStandaloneStoreProvider({ children }: { children: ReactNode }) {
  const broadcastRef = useRef<IBroadcastService | null>(null);
  if (!broadcastRef.current) {
    broadcastRef.current = createStandaloneBroadcastService();
  }
  return <StoreProvider broadcastService={broadcastRef.current}>{children}</StoreProvider>;
}
