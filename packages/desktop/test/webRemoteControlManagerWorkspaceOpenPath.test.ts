import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebRemoteControlAppPayload, WebRemoteControlWorkspaceTarget } from "@zody/shared";
import { createWebRemoteControlManager } from "../src/main/webRemoteControlManager.js";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";
import { createRemoteWorkspaceDirectory } from "../src/main/remote-access/remoteWorkspaceDirectory.js";

/**
 * 第二批 E1/E2：`workspace-open-path-request` 的受理边界。
 * 开关关闭是 terminal 拒绝；路径校验复用 deep link 的 `isValidLocalWorkspaceDirectory`。
 */

function createHarness(options: { allowArbitraryPath?: boolean } = {}) {
  const sentPayloads: WebRemoteControlAppPayload[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ensurePrimaryWindow = vi.fn(async () => {});
  const openWorkspacePath = vi.fn(() => true);
  const listMobileDirectory = vi.fn(async () => ({
    ok: true as const,
    resolvedPath: "/workspace",
    parentPath: "/" as string | null,
    entries: [],
  }));

  const manager = createWebRemoteControlManager({
    appVersion: "1.5.0",
    remoteAccessSettings: {
      isEnabled: async () => true,
      setEnabled: async () => {},
      isArbitraryPathOpenAllowed: async () => options.allowArbitraryPath !== false,
    },
    featureGate: createWebRemoteControlFeatureGate(),
    remoteWorkspaceDirectory: createRemoteWorkspaceDirectory(),
    logger,
    platformHandlers: {
      isDockerAvailable: async () => true,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      createTempTextAttachment: async () => ({
        filename: "attachment.txt",
        localPath: "/tmp/attachment.txt",
        mimeType: "text/plain" as const,
        sizeBytes: 0,
      }),
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
    },
    hasOpenWindow: () => true,
    canCreateWindow: () => true,
    ensurePrimaryWindow,
    openWorkspacePath,
    listMobileDirectory,
    reconnectWorkspace: async () => {},
    attachWorkspaceHost: async () => {
      throw new Error("本测试不建立 bridge");
    },
    releaseWorkspaceHostAttachment: () => {},
    disposeWorkspaceHostAttachmentsForWindow: () => {},
    disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
    createDeviceTransport: (transportOptions) => ({
      start: () => {
        deliverPayload = transportOptions.onPayload;
        transportOptions.onStateChange("waiting_terminal");
      },
      sendPayload: (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      measurePayloadBytes: (payload) => JSON.stringify(payload).length,
      sendPayloadResult: (payload) => {
        sentPayloads.push(payload);
        return { kind: "sent" as const, bytes: JSON.stringify(payload).length };
      },
      disconnectClient: () => {},
      dispose: vi.fn(),
    }),
  });

  let deliverPayload: ((payload: WebRemoteControlAppPayload) => void) | undefined;
  return {
    logger,
    manager,
    openWorkspacePath,
    ensurePrimaryWindow,
    listMobileDirectory,
    sentPayloads,
    deliver: (payload: WebRemoteControlAppPayload) => {
      if (!deliverPayload) throw new Error("transport not started");
      deliverPayload(payload);
    },
  };
}

function findResponse(
  payloads: WebRemoteControlAppPayload[],
  requestId: string,
): Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-open-path-response" }> | undefined {
  return payloads.find(
    (payload): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-open-path-response" }> =>
      payload.zcode_type === "workspace-open-path-response" && payload.requestId === requestId,
  );
}

describe("webRemoteControlManager workspace-open-path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("开关关闭时立即拒绝 arbitrary-path-disabled，不建窗口不投递打开", async () => {
    const harness = createHarness({ allowArbitraryPath: false });
    await harness.manager.start({ workspacePath: "/workspace/current" });
    harness.sentPayloads.length = 0;

    harness.deliver({
      zcode_type: "workspace-open-path-request",
      requestId: "open-1",
      workspacePath: "/workspace/demo",
    });
    await vi.waitFor(() => {
      expect(findResponse(harness.sentPayloads, "open-1")).toMatchObject({
        success: false,
        error: "arbitrary-path-disabled",
      });
    });
    expect(harness.ensurePrimaryWindow).not.toHaveBeenCalled();
    expect(harness.openWorkspacePath).not.toHaveBeenCalled();
  });

  it("相对路径与不存在的绝对路径都回 path-invalid", async () => {
    const harness = createHarness();
    await harness.manager.start({ workspacePath: "/workspace/current" });
    harness.sentPayloads.length = 0;

    harness.deliver({
      zcode_type: "workspace-open-path-request",
      requestId: "open-relative",
      workspacePath: "relative/path",
    });
    harness.deliver({
      zcode_type: "workspace-open-path-request",
      requestId: "open-missing",
      workspacePath: "/nonexistent-zody-mobile-open-path",
    });
    await vi.waitFor(() => {
      expect(findResponse(harness.sentPayloads, "open-relative")).toMatchObject({
        success: false,
        error: "path-invalid",
      });
      expect(findResponse(harness.sentPayloads, "open-missing")).toMatchObject({
        success: false,
        error: "path-invalid",
      });
    });
    expect(harness.openWorkspacePath).not.toHaveBeenCalled();
  });

  it("已存在目录走共用打开链路：投递 OpenWorkspacePath，聚合列表出现后回 workspaceKey", async () => {
    const harness = createHarness();
    const realDirectory = await mkdtemp(join(tmpdir(), "zody-open-path-"));
    const workspace: WebRemoteControlWorkspaceTarget = {
      workspacePath: realDirectory,
      label: "temp",
      kind: "local",
    };
    await harness.manager.start({ workspacePath: "/workspace/current" });
    harness.sentPayloads.length = 0;

    harness.deliver({
      zcode_type: "workspace-open-path-request",
      requestId: "open-real",
      workspacePath: realDirectory,
    });
    await vi.waitFor(() =>
      expect(harness.openWorkspacePath).toHaveBeenCalledWith(realDirectory),
    );

    harness.manager.syncAvailableWorkspaces(1, [workspace]);
    await vi.waitFor(() => {
      expect(findResponse(harness.sentPayloads, "open-real")).toEqual({
        zcode_type: "workspace-open-path-response",
        requestId: "open-real",
        success: true,
        workspaceKey: realDirectory,
      });
    });
  });

  it("打开超过 10 秒未出现在聚合列表时回稳定错误码 timeout", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const realDirectory = await mkdtemp(join(tmpdir(), "zody-open-path-"));
    await harness.manager.start({ workspacePath: "/workspace/current" });
    harness.sentPayloads.length = 0;

    harness.deliver({
      zcode_type: "workspace-open-path-request",
      requestId: "open-timeout",
      workspacePath: realDirectory,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.openWorkspacePath).toHaveBeenCalledWith(realDirectory);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(findResponse(harness.sentPayloads, "open-timeout")).toMatchObject({
      success: false,
      error: "timeout",
    });
  });

  it("mobile-directory-list-request 转发到 listMobileDirectory 并原样回执错误码", async () => {
    const harness = createHarness();
    harness.listMobileDirectory.mockResolvedValue({
      ok: false as const,
      error: "too-large",
    });
    await harness.manager.start({ workspacePath: "/workspace/current" });
    harness.sentPayloads.length = 0;

    harness.deliver({
      zcode_type: "mobile-directory-list-request",
      requestId: "list-1",
      path: "/workspace",
    });
    await vi.waitFor(() => {
      expect(harness.listMobileDirectory).toHaveBeenCalledWith("/workspace");
      const response = harness.sentPayloads.find(
        (payload) => payload.zcode_type === "mobile-directory-list-response",
      );
      expect(response).toMatchObject({ requestId: "list-1", success: false, error: "too-large" });
    });
  });
});
