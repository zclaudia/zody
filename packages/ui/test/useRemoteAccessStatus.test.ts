// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteAccessStatus } from "@zcode/shared";
import { useRemoteAccessStatus } from "@/hooks/useRemoteAccessStatus.js";

const platformMock = vi.hoisted(() => ({
  getRemoteAccessStatus: vi.fn(
    async (): Promise<RemoteAccessStatus> => ({
      enabled: true,
      status: { status: "idle" },
      gateway: { state: "online", backendId: "backend-1", epoch: 1 },
    }),
  ),
  onWebRemoteControlStatusChanged: vi.fn(() => () => {}),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => platformMock,
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  platformMock.getRemoteAccessStatus.mockClear();
  platformMock.onWebRemoteControlStatusChanged.mockClear();
});

describe("useRemoteAccessStatus", () => {
  it("读取 App 级开关、gateway 和 runtime 状态", async () => {
    const { result } = renderHook(() => useRemoteAccessStatus());

    await waitFor(() => expect(result.current.status?.gateway.state).toBe("online"));
    expect(result.current.status?.enabled).toBe(true);
    expect(result.current.status?.status.status).toBe("idle");
  });

  it("关闭时不查询状态", async () => {
    const { result } = renderHook(() => useRemoteAccessStatus({ enabled: false }));

    expect(result.current.status).toBeNull();
    expect(platformMock.getRemoteAccessStatus).not.toHaveBeenCalled();
  });

  it("运行态事件到达时立即刷新，而不是只等轮询", async () => {
    let emitStatusChanged: (() => void) | undefined;
    platformMock.onWebRemoteControlStatusChanged.mockImplementationOnce((handler) => {
      emitStatusChanged = handler;
      return () => {};
    });

    const { result } = renderHook(() => useRemoteAccessStatus({ intervalMs: 60_000 }));
    await waitFor(() => expect(platformMock.getRemoteAccessStatus).toHaveBeenCalledTimes(1));

    emitStatusChanged?.();

    await waitFor(() => expect(platformMock.getRemoteAccessStatus).toHaveBeenCalledTimes(2));
    expect(result.current.status).not.toBeNull();
  });

  it("refresh() 手动刷新最新状态", async () => {
    const { result } = renderHook(() => useRemoteAccessStatus({ intervalMs: 60_000 }));
    await waitFor(() => expect(platformMock.getRemoteAccessStatus).toHaveBeenCalledTimes(1));

    platformMock.getRemoteAccessStatus.mockResolvedValueOnce({
      enabled: true,
      status: { status: "active", mobileConnected: true },
      gateway: { state: "online", backendId: "backend-1", epoch: 2 },
    });

    await result.current.refresh();

    await waitFor(() => expect(result.current.status?.status.mobileConnected).toBe(true));
  });
});
