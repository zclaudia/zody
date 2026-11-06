// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IFileWatcherService } from "@zody/services";
import { describe, expect, it, vi } from "vitest";
import { useSavedWorkflowsDirectoryWatch } from "@/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.js";

function fixture() {
  const listeners = new Map<string, () => void>();
  const dispose = vi.fn();
  const watch = vi.fn(async ({ path }: { path: string }) => ({ id: path }));
  const unwatch = vi.fn(async () => {});
  const service = {
    watch,
    unwatch,
    onDynamicChange: (id: string) => (listener: () => void) => {
      listeners.set(id, listener);
      return { dispose };
    },
  } as unknown as IFileWatcherService;
  return { service, watch, unwatch, listeners, dispose };
}

describe("saved workflow directory compatibility", () => {
  it("watches both Windows project roots and releases every watcher", async () => {
    const f = fixture();
    const refresh = vi.fn(async () => {});
    const { unmount } = renderHook(() =>
      useSavedWorkflowsDirectoryWatch({
        fileWatcherService: f.service,
        workspacePath: "C:\\project\\",
        enabled: true,
        refresh,
      }),
    );
    await waitFor(() => expect(f.listeners.size).toBe(2));
    expect(f.watch.mock.calls.map(([input]) => input.path)).toEqual([
      "C:\\project\\.zody\\workflows",
      "C:\\project\\.zcode\\workflows",
    ]);
    act(() => f.listeners.get("C:\\project\\.zcode\\workflows")?.());
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ bypassCache: true }));
    unmount();
    expect(f.dispose).toHaveBeenCalledTimes(2);
    expect(f.unwatch).toHaveBeenCalledTimes(2);
  });

  it("uses only the Agent-provided global directory", async () => {
    const f = fixture();
    const { unmount } = renderHook(() =>
      useSavedWorkflowsDirectoryWatch({
        fileWatcherService: f.service,
        workspacePath: "/repo",
        directory: "/home/.zody/workflows",
        enabled: true,
        refresh: async () => {},
      }),
    );
    await waitFor(() => expect(f.listeners.size).toBe(1));
    expect(f.watch).toHaveBeenCalledWith({ path: "/home/.zody/workflows" });
    unmount();
    expect(f.unwatch).toHaveBeenCalledOnce();
  });

  it("unwatches results that arrive after unmount", async () => {
    const f = fixture();
    let resolve!: (value: { id: string }) => void;
    f.watch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { unmount } = renderHook(() =>
      useSavedWorkflowsDirectoryWatch({
        fileWatcherService: f.service,
        directory: "/global",
        enabled: true,
        refresh: async () => {},
      }),
    );
    unmount();
    await act(async () => resolve({ id: "late" }));
    expect(f.unwatch).toHaveBeenCalledWith({ id: "late" });
    expect(f.listeners.size).toBe(0);
  });
});
