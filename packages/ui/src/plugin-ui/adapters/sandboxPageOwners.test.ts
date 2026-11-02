// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { sandboxPages, type SandboxPageOwner } from "./sandboxPageOwners.js";
import type { UsePluginUiHostInput } from "./pluginUiHostTypes.js";
import { usePluginUiHost } from "./usePluginUiHost.js";

const mocks = vi.hoisted(() => ({
  createPage: vi.fn(),
  platform: {} as { pluginSandbox?: unknown },
  services: {} as { pluginUiBridgeService?: unknown },
}));
vi.mock("./pluginUiManagedPage.js", () => ({ createPage: mocks.createPage }));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => mocks.platform }));
vi.mock("@/hooks/useServices.js", () => ({ useOptionalServices: () => mocks.services }));

afterEach(() => {
  cleanup();
  sandboxPages.clear();
  mocks.createPage.mockClear();
});

function input(patch: Partial<UsePluginUiHostInput["scope"]> = {}): UsePluginUiHostInput {
  return {
    presentation: { pluginId: "p", serverName: "m", resourceUri: "ui://app" },
    scope: {
      workspacePath: "/w",
      sessionId: "s",
      scope: { kind: "toolCall", toolCallId: "c" },
      ...patch,
    },
    theme: "light",
    locale: "en",
    displayMode: "inline",
    // 契约要求显式携带（可为 undefined）：无工具输入/结果的宿主也要能创建页面。
    toolInput: undefined,
    toolResult: undefined,
    hostVersion: "zody",
    width: 0,
    enabled: true,
  };
}

it("counts MCP and Gen UI against one capacity and deletes both for the same task", async () => {
  const pages: SandboxPageOwner[] = [];
  for (let index = 0; index < 64; index++) {
    const page: SandboxPageOwner = {
      kind: index % 2 ? "mcp" : "gen-ui",
      key: String(index),
      task: "shared-task",
      visible: true,
      busy: () => false,
      running: () => true,
      suspend: vi.fn(),
      destroy: vi.fn(),
    };
    pages.push(page);
    await sandboxPages.add(page);
    await sandboxPages.reserve(page);
  }
  const extra = { ...pages[0]!, key: "overflow" };
  await sandboxPages.add(extra);
  await expect(sandboxPages.reserve(extra)).rejects.toThrow("capacity");
  sandboxPages.removeTask("shared-task");
  for (const page of pages) {
    expect(page.destroy).toHaveBeenCalled();
    expect(sandboxPages.get(page.key)).toBeUndefined();
    sandboxPages.released(page);
  }
});

// I20：手机/Web/远端没有本地沙箱平台，必须只回退普通 MCP 卡，不能进入页面创建。
it("does not create a local sandbox page on web or mobile platforms", () => {
  mocks.platform = {};
  mocks.services = {};
  const { result } = renderHook(() => usePluginUiHost(input()));
  expect(result.current.supported).toBe(false);
  expect(mocks.createPage).not.toHaveBeenCalled();
});

// I20：即使注入了沙箱平台，远端会话/远端 workspace identity 也不得创建本地 guest。
it("does not create a local guest for remote sessions or remote workspace identities", () => {
  mocks.platform = { pluginSandbox: {} };
  mocks.services = { pluginUiBridgeService: {} };
  const remoteSession = renderHook(() =>
    usePluginUiHost(input({ remoteSessionId: "remote-session" })),
  );
  expect(remoteSession.result.current.supported).toBe(false);
  const remoteWorkspace = renderHook(() =>
    usePluginUiHost(input({ workspaceIdentity: "remote:ssh:example.com:22:user:/repo" })),
  );
  expect(remoteWorkspace.result.current.supported).toBe(false);
  expect(mocks.createPage).not.toHaveBeenCalled();
});
