import { describe, expect, it, vi } from "vitest";
import type { WebRemoteControlWindowBootstrapResult } from "@zcode/shared";
import { createWebRemoteControlVersionGuard } from "../src/webRemoteControlVersion.js";

const bootstrap = (desktopAppVersion?: string): WebRemoteControlWindowBootstrapResult => ({
  windowControlSessionId: "device-1",
  workspaces: [],
  tasks: [],
  ...(desktopAppVersion === undefined ? {} : { desktopAppVersion }),
});

function harness(options: { ready?: boolean; version?: string } = {}) {
  const requestBootstrap = vi.fn(async () => bootstrap(options.version));
  const onVersionChanged = vi.fn();
  const guard = createWebRemoteControlVersionGuard({
    requestBootstrap,
    isPageReady: () => options.ready ?? false,
    onVersionChanged,
  });
  return { guard, requestBootstrap, onVersionChanged };
}

describe("desktop version observer (T4.2, URL-free)", () => {
  it("records the first desktop version as the baseline without notifying", async () => {
    const h = harness({ ready: true, version: "3.12.1" });
    expect(await h.guard.check()).toEqual(bootstrap("3.12.1"));
    expect(h.onVersionChanged).not.toHaveBeenCalled();
  });

  it("keeps returning bootstrap results when the version is unchanged or missing", async () => {
    const h = harness({ ready: true, version: "3.12.1" });
    await h.guard.check();
    expect(await h.guard.check()).toEqual(bootstrap("3.12.1"));
    h.requestBootstrap.mockResolvedValueOnce(bootstrap(undefined));
    expect(await h.guard.check()).toEqual(bootstrap(undefined));
    expect(h.onVersionChanged).not.toHaveBeenCalled();
  });

  it("notifies once when the desktop version changes on a mounted page", async () => {
    const h = harness({ ready: true, version: "3.12.1" });
    await h.guard.check();
    h.requestBootstrap.mockResolvedValue(bootstrap("3.13.0"));
    expect(await h.guard.check()).toEqual(bootstrap("3.13.0"));
    expect(h.onVersionChanged).toHaveBeenCalledExactlyOnceWith("3.13.0");
    await h.guard.check();
    expect(h.onVersionChanged).toHaveBeenCalledTimes(1);
  });

  it("does not notify while the page is still bootstrapping", async () => {
    const h = harness({ ready: false, version: "3.12.1" });
    await h.guard.check();
    h.requestBootstrap.mockResolvedValue(bootstrap("3.13.0"));
    await h.guard.check();
    expect(h.onVersionChanged).not.toHaveBeenCalled();
  });

  it("never blocks business bootstrap results on a version mismatch", async () => {
    // 旧实现会返回 undefined 并把版本写回 URL；APK 内置页面没有可导航的资源，
    // 因此不兼容必须交给 appProtocol 协商，而不是让调用方一直等不到结果。
    const h = harness({ ready: false, version: "3.12.2" });
    expect(await h.guard.check()).toEqual(bootstrap("3.12.2"));
  });

  it("coalesces concurrent checks and checks again after invalidation", async () => {
    const h = harness({ version: "3.12.1" });
    await Promise.all([h.guard.check(), h.guard.check()]);
    expect(h.requestBootstrap).toHaveBeenCalledTimes(1);
    h.guard.invalidate();
    await h.guard.check();
    expect(h.requestBootstrap).toHaveBeenCalledTimes(2);
  });

  it("ignores a late result from an obsolete connection", async () => {
    const h = harness({ version: "3.12.1" });
    let resolveOld!: (value: WebRemoteControlWindowBootstrapResult) => void;
    h.requestBootstrap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const old = h.guard.check();
    h.guard.invalidate();
    expect(await h.guard.check()).toEqual(bootstrap("3.12.1"));
    resolveOld(bootstrap("3.13.0"));
    expect(await old).toBeUndefined();
    expect(h.onVersionChanged).not.toHaveBeenCalled();
  });

  it("suppresses obsolete errors but propagates current failures", async () => {
    const h = harness();
    let rejectOld!: (error: Error) => void;
    h.requestBootstrap.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const old = h.guard.check();
    await Promise.resolve();
    h.guard.invalidate();
    rejectOld(new Error("old connection"));
    expect(await old).toBeUndefined();
    h.requestBootstrap.mockRejectedValueOnce(new Error("current connection"));
    await expect(h.guard.check()).rejects.toThrow("current connection");
  });

  it("stops observing after disposal", async () => {
    const h = harness({ ready: true, version: "3.12.1" });
    await h.guard.check();
    h.guard.dispose();
    expect(await h.guard.check()).toBeUndefined();
    expect(h.onVersionChanged).not.toHaveBeenCalled();
  });
});
