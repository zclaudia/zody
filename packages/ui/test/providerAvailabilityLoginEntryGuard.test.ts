// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";

const registryViewModel = {
  revision: 1,
  providers: [
    {
      providerId: "registry-provider",
      config: { kind: "api" as const },
      models: [{ modelId: "registry-model", config: {} }],
    },
  ],
};

describe("useProviderAvailabilityLoginEntryGuard", () => {
  it("首次 Selection 读取失败结束启动等待且不伪装成无 Provider", async () => {
    const setLoginEntryOpen = vi.fn();
    const { result } = renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        modelSelectionView: null,
        modelSelectionError: new Error("registry unavailable"),
        refreshProviderState: vi.fn(async () => {}),
        readModelSelectionView: vi.fn(),
        setLoginEntryOpen,
      }),
    );

    await waitFor(() => expect(result.current.startupCheckCompleted).toBe(true));
    expect(setLoginEntryOpen).not.toHaveBeenCalled();
  });

  it("等待 Selection View 水合后再判断启动可用性", async () => {
    const setLoginEntryOpen = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const view = registryViewModel;
    const { rerender } = renderHook(
      (props: { hydrated: boolean }) =>
        useProviderAvailabilityLoginEntryGuard({
            modelSelectionView: props.hydrated ? view : null,
          refreshProviderState,
          readModelSelectionView: async () => view,
          setLoginEntryOpen,
        }),
      { initialProps: { hydrated: false } },
    );

    await Promise.resolve();
    expect(setLoginEntryOpen).not.toHaveBeenCalled();

    rerender({ hydrated: true });

    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(false));
    expect(refreshProviderState).not.toHaveBeenCalled();
  });

  // fork（F4.1a）：官方账号下线后，首启门只看是否有可用 provider。
  it("有可用自定义 provider、无 providerFamilyDomain 且未登录时不弹登录", async () => {
    const setLoginEntryOpen = vi.fn();
    renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        modelSelectionView: registryViewModel,
        refreshProviderState: vi.fn(async () => {}),
        readModelSelectionView: async () => registryViewModel,
        setLoginEntryOpen,
      }),
    );

    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(false));
  });

  it("没有任何可用 provider 时弹引导（登录态不再影响判定）", async () => {
    const setLoginEntryOpen = vi.fn();
    renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        modelSelectionView: { revision: 1, providers: [] },
        refreshProviderState: vi.fn(async () => {}),
        readModelSelectionView: async () => ({ revision: 1, providers: [] }),
        setLoginEntryOpen,
      }),
    );

    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(true));
  });
});
