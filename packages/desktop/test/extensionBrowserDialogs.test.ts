import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionDialogManager } from "../src/host/extensionBrowserDialogs.js";

const attachment = {
  attachmentId: "attachment-1",
  nativeTabId: 42,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ExtensionDialogManager", () => {
  it("tracks opening/closing events with their target", () => {
    const manager = new ExtensionDialogManager(1_000);
    manager.handleEvent("tab-1", {
      ...attachment,
      method: "Page.javascriptDialogOpening",
      params: { type: "confirm", message: "Submit?" },
    });
    expect(manager.get("tab-1")).toEqual({ type: "confirm", message: "Submit?" });
    expect(manager.state("tab-1")).toMatchObject({
      attachmentId: "attachment-1",
      nativeTabId: 42,
    });

    manager.handleEvent("tab-1", {
      ...attachment,
      method: "Page.javascriptDialogClosed",
      params: { result: false },
    });
    expect(manager.get("tab-1")).toBeUndefined();
  });

  it("invalidates a dialog when the owning attachment detaches", () => {
    const manager = new ExtensionDialogManager(1_000);
    manager.handleEvent("tab-1", {
      ...attachment,
      method: "Page.javascriptDialogOpening",
      params: { type: "alert", message: "hi" },
    });
    manager.clear("tab-1");
    expect(manager.get("tab-1")).toBeUndefined();
  });

  it("dismisses an unhandled user-tab dialog with the default callback", async () => {
    vi.useFakeTimers();
    const manager = new ExtensionDialogManager(1_000);
    manager.handleEvent("tab-1", {
      ...attachment,
      targetId: "child-target",
      method: "Page.javascriptDialogOpening",
      params: { type: "confirm", message: "Submit?" },
    });
    const dismiss = vi.fn(async () => true);
    const unresolved = vi.fn(async () => undefined);
    manager.beginUserCommand("tab-1", dismiss, unresolved);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(unresolved).not.toHaveBeenCalled();
    expect(manager.get("tab-1")).toBeUndefined();
  });

  it("revokes when accept:false still cannot unblock the page", async () => {
    vi.useFakeTimers();
    const manager = new ExtensionDialogManager(1_000);
    manager.handleEvent("tab-1", {
      ...attachment,
      method: "Page.javascriptDialogOpening",
      params: { type: "alert", message: "still blocked" },
    });
    const dismiss = vi.fn(async () => false);
    const unresolved = vi.fn(async () => undefined);
    manager.beginUserCommand("tab-1", dismiss, unresolved);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(unresolved).toHaveBeenCalledTimes(1);
  });

  it("does not auto-dismiss when no dialog is open", async () => {
    vi.useFakeTimers();
    const manager = new ExtensionDialogManager(1_000);
    const dismiss = vi.fn(async () => true);
    const unresolved = vi.fn(async () => undefined);
    manager.beginUserCommand("tab-1", dismiss, unresolved);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    expect(dismiss).not.toHaveBeenCalled();
    expect(unresolved).not.toHaveBeenCalled();
  });
});
