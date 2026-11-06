// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsePluginUiHostInput } from "./pluginUiHostTypes.js";
import { pluginUiPages } from "./pluginUiPageRegistry.js";

// F18（上游 a60ba6a7 pluginUiManagedPage）：回收必须先经保留策略 claim 预占，
// 再走 controller.tryRecycle 的 Agent 原子裁决，finally 释放预占；声明页在 4/30 边界内
// 不得触发裁决（docs/plugin-ui-background-execution.md §12.2.6/§12.2.7/§12.5）。
const mocks = vi.hoisted(() => ({
  createPluginUiHostController: vi.fn(),
  connection: {
    release: vi.fn(),
    layer: { acquire: vi.fn() },
    transport: { onRuntimeRestart: vi.fn(() => () => {}) },
  },
  attachPluginUiResourceDeltaFeed: vi.fn(() => vi.fn()),
}));
vi.mock("@/plugin-ui/app/pluginUiHostController.js", () => ({
  createPluginUiHostController: mocks.createPluginUiHostController,
}));
vi.mock("@/v4/workspaceConnectionRegistry.js", () => ({
  acquireWorkspaceConnection: () => mocks.connection,
}));
vi.mock("./pluginUiResourceDeltaFeed.js", () => ({
  attachPluginUiResourceDeltaFeed: mocks.attachPluginUiResourceDeltaFeed,
}));

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

const handle = (sandboxId: string, initId: number, backgroundRetention?: boolean) => ({
  sandboxId,
  initId,
  shellUrl: "about:blank",
  partition: "persist:test",
  instance: { runtimeId: "r", generation: 1, token: "t", appIdentity: "a".repeat(64) },
  ...(backgroundRetention !== undefined ? { resourceMeta: { backgroundRetention } } : {}),
});

function input(): UsePluginUiHostInput {
  return {
    presentation: { pluginId: "p", serverName: "m", resourceUri: "ui://app" },
    scope: {
      workspacePath: "/w",
      sessionId: `s-${Math.random().toString(36).slice(2)}`,
      scope: { kind: "toolCall", toolCallId: "c1" },
    },
    theme: "light",
    locale: "en",
    displayMode: "inline",
    toolInput: undefined,
    toolResult: undefined,
    hostVersion: "zody",
    width: 0,
    enabled: true,
  };
}

interface FakeController {
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  tryRecycle: ReturnType<typeof vi.fn>;
  isBusy: () => boolean;
  updateHostContext: ReturnType<typeof vi.fn>;
  notifyToolInput: ReturnType<typeof vi.fn>;
  notifyToolResult: ReturnType<typeof vi.fn>;
  notifyToolCancelled: ReturnType<typeof vi.fn>;
}

async function createStartedPage() {
  const { createPage } = await import("./pluginUiManagedPage.js");
  const pageInput = input();
  const controller: FakeController = {
    start: vi.fn(),
    dispose: vi.fn(async () => {}),
    tryRecycle: vi.fn(async () => true),
    isBusy: () => false,
    updateHostContext: vi.fn(),
    notifyToolInput: vi.fn(),
    notifyToolResult: vi.fn(),
    notifyToolCancelled: vi.fn(),
  };
  mocks.createPluginUiHostController.mockReturnValue(controller);
  mocks.connection.layer.acquire.mockReturnValue({ release: vi.fn(), store: {} });
  const page = createPage(
    pageInput.scope.sessionId,
    pageInput,
    { pluginSandbox: {} } as Parameters<typeof createPage>[2],
    {
      pluginUiBridgeService: {},
      zodyTaskService: { onDynamicWorkspaceEvent: vi.fn(() => () => ({ dispose: vi.fn() })) },
      zodyAgentService: {},
    } as unknown as Parameters<typeof createPage>[3],
  );
  await pluginUiPages.add(page);
  const node = document.createElement("div");
  document.body.append(node);
  page.bind(node, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const deps = mocks.createPluginUiHostController.mock.calls.at(-1)![0] as {
    onPhase: (phase: string, detail?: { handle?: unknown }) => void;
  };
  return { controller, deps, page };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pluginUiManagedPage recycle arbitration", () => {
  afterEach(() => {
    pluginUiPages.clear();
    document.querySelector("[data-sandbox-page-parking]")?.remove();
    mocks.createPluginUiHostController.mockReset();
    mocks.connection.layer.acquire.mockReset();
  });

  it("shields a declared page from recycle arbitration inside the 4/30 bounds", async () => {
    const { controller, deps, page } = await createStartedPage();
    deps.onPhase("running", { handle: handle("s1", 1, true) });
    // 声明页 claim 拒绝：不得进入 Agent 裁决，也不得 teardown。
    await expect(page.suspend()).resolves.toBe(false);
    expect(controller.tryRecycle).not.toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();
    page.destroy();
    await flush();
  });

  it("arbitrates an undeclared page through tryRecycle and releases the claim after refusal", async () => {
    const { controller, deps, page } = await createStartedPage();
    deps.onPhase("running", { handle: handle("s1", 1) });
    controller.tryRecycle.mockResolvedValueOnce(false);
    await expect(page.suspend()).resolves.toBe(false);
    expect(controller.tryRecycle).toHaveBeenCalledTimes(1);
    expect(controller.dispose).not.toHaveBeenCalled();
    // Agent 拒绝后预占已释放：下一次裁决可以再次进入。
    controller.tryRecycle.mockResolvedValueOnce(false);
    await expect(page.suspend()).resolves.toBe(false);
    expect(controller.tryRecycle).toHaveBeenCalledTimes(2);
    page.destroy();
    await flush();
  });

  it("tears the page down after the agent approves a recycle", async () => {
    const { controller, deps, page } = await createStartedPage();
    deps.onPhase("running", { handle: handle("s1", 1) });
    controller.tryRecycle.mockResolvedValueOnce(true);
    await expect(page.suspend()).resolves.toBe(true);
    expect(controller.dispose).toHaveBeenCalled();
    // jsdom 无可见锚点：回收后不自动重建。
    expect(mocks.createPluginUiHostController).toHaveBeenCalledTimes(1);
    page.destroy();
    await flush();
  });

  it("merges concurrent recycle attempts into one arbitration", async () => {
    const { controller, deps, page } = await createStartedPage();
    deps.onPhase("running", { handle: handle("s1", 1) });
    const gate = Promise.withResolvers<boolean>();
    controller.tryRecycle.mockReturnValueOnce(gate.promise);
    const first = page.suspend();
    const second = page.suspend();
    gate.resolve(false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(controller.tryRecycle).toHaveBeenCalledTimes(1);
    page.destroy();
    await flush();
  });

  it("re-declares retention when a fresh handle changes the resource declaration", async () => {
    const { controller, deps, page } = await createStartedPage();
    deps.onPhase("running", { handle: handle("s1", 1, true) });
    await expect(page.suspend()).resolves.toBe(false);
    expect(controller.tryRecycle).not.toHaveBeenCalled();
    // 换代句柄未再声明：fresh 上报 prepared(false)，claim 放行进入裁决。
    deps.onPhase("running", { handle: handle("s2", 2) });
    controller.tryRecycle.mockResolvedValueOnce(false);
    await expect(page.suspend()).resolves.toBe(false);
    expect(controller.tryRecycle).toHaveBeenCalledTimes(1);
    page.destroy();
    await flush();
  });
});
