import type { ExtensionStoredCredential } from "./types.js";

export interface WindowDefaultBackendsDeps {
  /** 把当前值 push 给该窗口 Host；undefined 表示恢复 IAB。 */
  publish(windowId: number, defaultBrowserId: string | undefined): void;
  getCredential(profileInstanceId: string): Promise<ExtensionStoredCredential | null>;
  isBoundToCurrentWindow(credential: ExtensionStoredCredential, windowId: number): boolean;
}

/**
 * 当前窗口默认 backend 的唯一 owner。
 *
 * 只活在 Main 内存：renderer reload 保持（webContents 身份不变），app restart 后安全回落
 * IAB；不写入 AppSettings，也不使用 numeric windowId 做跨重启持久身份。
 */
export function createWindowDefaultBackends(deps: WindowDefaultBackendsDeps) {
  const values = new Map<number, string>();
  const publish = (windowId: number) => deps.publish(windowId, values.get(windowId));

  return {
    get(windowId: number): string | undefined {
      return values.get(windowId);
    },

    async set(
      windowId: number,
      browserId: string | null,
    ): Promise<{ ok: boolean; error?: string }> {
      const normalized = browserId?.trim() || undefined;
      if (!normalized) {
        values.delete(windowId);
        publish(windowId);
        return { ok: true };
      }
      const profileInstanceId = normalized.startsWith("extension:")
        ? normalized.slice("extension:".length)
        : "";
      if (!profileInstanceId) {
        return { ok: false, error: "default browser must be an extension browserId or null" };
      }
      const credential = await deps.getCredential(profileInstanceId);
      if (!credential) return { ok: false, error: "profile is not paired" };
      // 默认 backend 必须属于当前窗口；孤儿 Profile 要先转移，不能直接成为默认。
      if (!deps.isBoundToCurrentWindow(credential, windowId)) {
        return { ok: false, error: "profile is not bound to this window" };
      }
      values.set(windowId, normalized);
      publish(windowId);
      return { ok: true };
    },

    clearProfile(profileInstanceId: string): void {
      const browserId = `extension:${profileInstanceId}`;
      for (const [windowId, value] of values) {
        if (value !== browserId) continue;
        values.delete(windowId);
        publish(windowId);
      }
    },

    publishCurrent(windowId: number): void {
      publish(windowId);
    },

    clearAll(): void {
      values.clear();
    },
  };
}
