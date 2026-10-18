import type { IBroadcastService } from "@zcode/services";
import { beforeEach, describe, expect, it } from "vitest";
import { createZCodeStore } from "@/store/index.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      classList: {
        contains: () => false,
        toggle: () => {},
      },
    },
  },
});

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

describe("createZCodeStore global state", () => {
  beforeEach(() => {
    localStorageState.clear();
  });

  // fork（F4.7）：OAuth 恢复态、统一登录入口与 OAuth 成功序号随官方账号链删除，
  // store 不再暴露对应字段；这里只保留仍在使用的全局状态断言。

  it("只在用户从未登录进入登录态时推进鉴权会话序号", () => {
    const store = createZCodeStore(mockBroadcastService);
    const user = { id: "user-1", username: "tester", displayName: "Tester" };

    store.getState().setUser(user);
    expect(store.getState().authSessionSeq).toBe(1);

    // 已登录时刷新用户信息或连接额外 provider，不属于重新登录。
    store.getState().setUser({ ...user, displayName: "Tester Updated" });
    expect(store.getState().authSessionSeq).toBe(1);

    store.getState().setUser(null);
    store.getState().setUser(user);
    expect(store.getState().authSessionSeq).toBe(2);
  });

  it("性能模式默认关闭，并持久化用户选择", () => {
    const store = createZCodeStore(mockBroadcastService);

    expect(store.getState().performanceMode).toBe(false);

    store.getState().setPerformanceMode(true);

    expect(store.getState().performanceMode).toBe(true);
    expect(localStorageState.get("zcode-performance-mode")).toBe("true");
    expect(createZCodeStore(mockBroadcastService).getState().performanceMode).toBe(true);
  });
});
