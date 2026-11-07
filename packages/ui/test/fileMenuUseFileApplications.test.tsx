// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileApplicationInfo, FileApplicationTarget, IPlatformService } from "@zody/shared";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { useFileApplications } from "../src/file-menu/useFileApplications.js";

// F16 useFileApplications（upstream v3.17.1，SHA a60ba6a7）：单一 per-target 查询
// 状态所有者；规则见 docs/ui/file-open-apps.md「状态所有者/事件顺序」。
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const toastModule = await import("@/components/ui/toast.js");

const TARGET: FileApplicationTarget = { path: "/workspace/报告.docx", pathKind: "file" };

function fakePlatform(
  overrides: Partial<Pick<IPlatformService, "getFileApplications" | "openFileWithApplication">>,
) {
  return { getFileApplications: vi.fn(), openFileWithApplication: vi.fn(), ...overrides } as never;
}

function renderHookWithPlatform(
  platform: IPlatformService,
  target: FileApplicationTarget | null,
  isRemote = false,
) {
  return renderHook(() => useFileApplications(target, isRemote), {
    wrapper: ({ children }) => <PlatformProvider platform={platform}>{children}</PlatformProvider>,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useFileApplications 查询与打开", () => {
  it("load 后默认项排在首位；空结果与失败都回到空列表", async () => {
    const apps: FileApplicationInfo[] = [
      { id: "b", name: "B", isDefault: false },
      { id: "a", name: "A", isDefault: true },
    ];
    const platform = fakePlatform({
      getFileApplications: vi.fn(async () => apps),
    });
    const { result } = renderHookWithPlatform(platform as IPlatformService, TARGET);
    expect(result.current.available).toBe(true);
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.apps.map((app) => app.id)).toEqual(["a", "b"]);
    expect(result.current.defaultApplication?.id).toBe("a");
    expect(result.current.loading).toBe(false);
  });

  it("远端身份或宿主能力缺席时不发起查询", async () => {
    const getFileApplications = vi.fn();
    const platform = fakePlatform({ getFileApplications });
    const remote = renderHookWithPlatform(platform as IPlatformService, TARGET, true);
    expect(remote.result.current.available).toBe(false);
    await act(async () => {
      await remote.result.current.load();
    });
    expect(getFileApplications).not.toHaveBeenCalled();

    const bare = renderHookWithPlatform({} as IPlatformService, TARGET);
    expect(bare.result.current.available).toBe(false);
    await act(async () => {
      await bare.result.current.load();
    });
    expect(getFileApplications).not.toHaveBeenCalled();
  });

  it("目标切换后旧目标的迟到响应被丢弃（卡片虚拟行重用防串台）", async () => {
    let resolveFirst: (apps: FileApplicationInfo[]) => void = () => undefined;
    const getFileApplications = vi.fn(
      (target: FileApplicationTarget) =>
        new Promise<FileApplicationInfo[]>((resolve) => {
          if (target.path === "/workspace/old.docx") {
            resolveFirst = resolve;
          } else {
            resolve([{ id: "new", name: "New", isDefault: true }]);
          }
        }),
    );
    const platform = fakePlatform({ getFileApplications });
    const platformService = platform as IPlatformService;
    const { result, rerender } = renderHook(
      ({ target }: { target: FileApplicationTarget }) => useFileApplications(target),
      {
        initialProps: {
          target: { ...TARGET, path: "/workspace/old.docx" } as FileApplicationTarget,
        },
        wrapper: ({ children }) => (
          <PlatformProvider platform={platformService}>{children}</PlatformProvider>
        ),
      },
    );
    void result.current.load();
    // 同一 hook 实例切换到新目标并完成新查询，旧查询仍挂起。
    rerender({ target: { ...TARGET, path: "/workspace/new.docx" } });
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.apps.map((app) => app.id)).toEqual(["new"]);
    // 旧目标查询此刻返回：新目标状态不被旧结果覆盖。
    await act(async () => {
      resolveFirst([{ id: "stale", name: "Stale", isDefault: true }]);
    });
    expect(result.current.apps.map((app) => app.id)).toEqual(["new"]);
  });

  it("open 分发 id+target；失败结果有可见 toast", async () => {
    const openFileWithApplication = vi.fn(async () => ({ success: false, error: "no_app" }));
    const platform = fakePlatform({
      getFileApplications: vi.fn(async () => [{ id: "a", name: "A", isDefault: true }]),
      openFileWithApplication,
    });
    const { result } = renderHookWithPlatform(platform as IPlatformService, TARGET);
    await act(async () => {
      await result.current.load();
    });
    await act(async () => {
      await result.current.open(result.current.defaultApplication!);
    });
    expect(openFileWithApplication).toHaveBeenCalledWith("a", TARGET);
    await waitFor(() =>
      expect(toastModule.toast).toHaveBeenCalledWith("chat.previewCards.openFileFailed"),
    );
  });
});
