import { describe, expect, it } from "vitest";
import { HostMessageTypes } from "../src/channels.js";
import {
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
} from "../src/web-remote-control.js";
import {
  hostIncomingMessageSchema,
  parseWebRemoteControlAppPayload,
  webRemoteControlTaskTargetSchema,
  webRemoteControlWorkspaceTargetSchema,
} from "../src/validation.js";
import {
  hasObsoleteWebRemoteControlDiscriminator,
  encodeWebRemoteControlRpcTransportMessage,
} from "../src/web-remote-control-rpc-transport.js";

describe("webRemoteControlWorkspaceTargetSchema", () => {
  it("accepts disconnected remote workspace presentation state", () => {
    expect(
      webRemoteControlWorkspaceTargetSchema.parse({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        label: "app",
        kind: "remote",
        connectionState: "disconnected",
        lastConnectionError: "ssh connection closed",
      }),
    ).toMatchObject({
      connectionState: "disconnected",
      lastConnectionError: "ssh connection closed",
    });
  });
});

describe("resolveWebRemoteControlWorkspaceKey", () => {
  it("uses workspaceIdentity before workspacePath for isolation keys", () => {
    expect(
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: "/workspace/app",
        workspaceIdentity: "ssh://dev.example.com/workspace/app",
      }),
    ).toBe("ssh://dev.example.com/workspace/app");
  });

  it("falls back to workspacePath when workspaceIdentity is empty", () => {
    expect(
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: "/workspace/app",
        workspaceIdentity: "   ",
      }),
    ).toBe("/workspace/app");
  });
});

describe("recent projects / workspace open / desktop window open payloads", () => {
  const recentProject = { id: "opaque-id-1", label: "demo", location: "/workspace" };

  it("parses recent-projects-updated and the bootstrap-response additions", () => {
    const updated = {
      zody_type: "recent-projects-updated",
      result: { desktopWindowState: "none", recentProjects: [recentProject] },
    };
    expect(parseWebRemoteControlAppPayload(updated)).toEqual(updated);

    const bootstrap = {
      zody_type: "bootstrap-response",
      requestId: "bootstrap-1",
      success: true,
      result: {
        windowControlSessionId: "sid-1",
        workspaces: [],
        tasks: [],
        desktopWindowState: "open",
        recentProjects: [recentProject],
      },
    };
    expect(parseWebRemoteControlAppPayload(bootstrap)).toEqual(bootstrap);
    // 旧桌面不带新字段时仍可解析（协商版本 1）。
    expect(
      parseWebRemoteControlAppPayload({
        ...bootstrap,
        result: { windowControlSessionId: "sid-1", workspaces: [], tasks: [] },
      }),
    ).not.toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        ...bootstrap,
        result: { ...bootstrap.result, desktopWindowState: "opening" },
      }),
    ).toBeNull();
  });

  it("recent-projects-updated 是 strict schema：多余字段与不透明 id 的额外路径字段都被丢弃", () => {
    const valid = {
      zody_type: "recent-projects-updated",
      result: { desktopWindowState: "open", recentProjects: [recentProject] },
    };
    expect(parseWebRemoteControlAppPayload({ ...valid, extra: 1 })).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        ...valid,
        result: {
          ...valid.result,
          recentProjects: [{ ...recentProject, workspacePath: "/etc" }],
        },
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        ...valid,
        result: { ...valid.result, recentProjects: [{ ...recentProject, id: "" }] },
      }),
    ).toBeNull();
  });

  it("workspace-open-request 只接受 recentProjectId，手机无法夹带任意路径", () => {
    const request = {
      zody_type: "workspace-open-request",
      requestId: "open-1",
      recentProjectId: "opaque-id-1",
    };
    expect(parseWebRemoteControlAppPayload(request)).toEqual(request);
    // strict：带 workspacePath 的整帧被丢弃，而不是忽略多余字段后按 id 打开。
    expect(
      parseWebRemoteControlAppPayload({ ...request, workspacePath: "/etc/passwd" }),
    ).toBeNull();
    expect(parseWebRemoteControlAppPayload({ ...request, recentProjectId: "" })).toBeNull();
  });

  it("解析 workspace-open-response 的成功与失败形状", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-open-response",
        requestId: "open-1",
        success: true,
        workspaceKey: "/workspace/demo",
      }),
    ).not.toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-open-response",
        requestId: "open-1",
        success: false,
        error: "unknown recent project id",
      }),
    ).not.toBeNull();
    // 失败响应不能携带 workspaceKey，成功响应必须携带。
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-open-response",
        requestId: "open-1",
        success: false,
        error: "x",
        workspaceKey: "/workspace/demo",
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-open-response",
        requestId: "open-1",
        success: true,
      }),
    ).toBeNull();
  });

  it("解析 desktop-window-open-request/response", () => {
    const request = { zody_type: "desktop-window-open-request", requestId: "window-1" };
    expect(parseWebRemoteControlAppPayload(request)).toEqual(request);
    expect(parseWebRemoteControlAppPayload({ ...request, extra: true })).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "desktop-window-open-response",
        requestId: "window-1",
        success: true,
      }),
    ).not.toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "desktop-window-open-response",
        requestId: "window-1",
        success: false,
        error: "window creation blocked",
      }),
    ).not.toBeNull();
  });

  it("workspace-open-path-request 只接受 workspacePath（第二批 E1）；夹带字段整帧丢弃", () => {
    const request = {
      zody_type: "workspace-open-path-request",
      requestId: "open-path-1",
      workspacePath: "/workspace/demo",
    };
    expect(parseWebRemoteControlAppPayload(request)).toEqual(request);
    // strict：不允许借任意路径请求夹带 recentProjectId 等其他字段。
    expect(
      parseWebRemoteControlAppPayload({ ...request, recentProjectId: "opaque-1" }),
    ).toBeNull();
    expect(parseWebRemoteControlAppPayload({ ...request, workspacePath: "" })).toBeNull();
  });

  it("解析 workspace-open-path-response 的成功与失败形状；失败用稳定错误码", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-open-path-response",
        requestId: "open-path-1",
        success: true,
        workspaceKey: "/workspace/demo",
      }),
    ).not.toBeNull();
    for (const error of ["arbitrary-path-disabled", "path-invalid", "open-failed", "timeout"]) {
      expect(
        parseWebRemoteControlAppPayload({
          zody_type: "workspace-open-path-response",
          requestId: "open-path-1",
          success: false,
          error,
        }),
      ).not.toBeNull();
    }
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-open-path-response",
        requestId: "open-path-1",
        success: false,
      }),
    ).toBeNull();
  });

  it("mobile-directory-list-request 的 path 可省略，夹带字段整帧丢弃", () => {
    const request = {
      zody_type: "mobile-directory-list-request",
      requestId: "list-1",
    };
    expect(parseWebRemoteControlAppPayload(request)).toEqual(request);
    expect(
      parseWebRemoteControlAppPayload({ ...request, path: "/workspace" }),
    ).toEqual({ ...request, path: "/workspace" });
    expect(parseWebRemoteControlAppPayload({ ...request, extra: 1 })).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({ ...request, path: "" }),
    ).toBeNull();
  });

  it("mobile-directory-list-response 校验 entries 形状、上限与错误分支", () => {
    const entry = { name: "demo", path: "/workspace/demo", isSymbolicLink: false };
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "mobile-directory-list-response",
        requestId: "list-1",
        success: true,
        resolvedPath: "/workspace",
        parentPath: "/",
        entries: [entry, { name: "plain", path: "/workspace/plain" }],
      }),
    ).not.toBeNull();
    // 根目录 parentPath 为 null 是合法形状。
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "mobile-directory-list-response",
        requestId: "list-1",
        success: true,
        resolvedPath: "/",
        parentPath: null,
        entries: [],
      }),
    ).not.toBeNull();
    for (const error of ["not-found", "not-directory", "unreadable", "too-large", "path-invalid"]) {
      expect(
        parseWebRemoteControlAppPayload({
          zody_type: "mobile-directory-list-response",
          requestId: "list-1",
          success: false,
          error,
        }),
      ).not.toBeNull();
    }
    // entry 夹带文件字段被拒；entries 超过 1000 上限被拒。
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "mobile-directory-list-response",
        requestId: "list-1",
        success: true,
        resolvedPath: "/workspace",
        parentPath: "/",
        entries: [{ ...entry, type: "file" }],
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "mobile-directory-list-response",
        requestId: "list-1",
        success: true,
        resolvedPath: "/workspace",
        parentPath: "/",
        entries: Array.from({ length: 1001 }, (_, index) => ({
          name: `dir-${index}`,
          path: `/workspace/dir-${index}`,
        })),
      }),
    ).toBeNull();
  });
});

describe("bootstrap response version", () => {
  it("validates the optional authoritative desktop version in bootstrap responses", () => {
    const response = {
      zody_type: "bootstrap-response",
      requestId: "bootstrap-1",
      success: true,
      result: { windowControlSessionId: "sid-1", workspaces: [], tasks: [] },
    };
    expect(parseWebRemoteControlAppPayload(response)).not.toBeNull();
    const result = { ...response.result, desktopAppVersion: "3.12.2" };
    expect(parseWebRemoteControlAppPayload({ ...response, result })).toMatchObject({ result });
    for (const desktopAppVersion of ["", "   ", 123]) {
      expect(
        parseWebRemoteControlAppPayload({
          ...response,
          result: { ...result, desktopAppVersion },
        }),
      ).toBeNull();
    }
  });
});

describe("resolveWebRemoteControlInitialWorkspaceSelection", () => {
  const workspaces = [
    {
      workspacePath: "/tmp/first",
      label: "first",
      kind: "local" as const,
    },
    {
      workspacePath: "/tmp/second",
      label: "second",
      kind: "local" as const,
    },
  ];

  it("prefers the last mobile view state over the desktop launch task", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces,
        mobileViewState: {
          activeWorkspaceKey: "/tmp/second",
          activeTaskId: "mobile-task",
          updatedAt: 2,
        },
        initialViewState: {
          activeWorkspaceKey: "/tmp/first",
          activeTaskId: "desktop-task",
          updatedAt: 1,
        },
      }),
    ).toEqual({
      workspaceKey: "/tmp/second",
      taskId: "mobile-task",
      canBridge: true,
    });
  });

  it("uses the desktop launch task when the phone has no view state yet", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces,
        initialViewState: {
          activeWorkspaceKey: "/tmp/first",
          activeTaskId: "desktop-task",
          updatedAt: 1,
        },
      }),
    ).toEqual({
      workspaceKey: "/tmp/first",
      taskId: "desktop-task",
      canBridge: true,
    });
  });

  it("falls back to the first workspace when no selected view state is valid", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces,
        initialViewState: {
          activeWorkspaceKey: "/tmp/missing",
          activeTaskId: "missing-task",
          updatedAt: 1,
        },
      }),
    ).toEqual({
      workspaceKey: "/tmp/first",
      canBridge: true,
    });
  });

  it("skips disconnected remote workspaces when choosing the initial bridge", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces: [
          {
            workspacePath: "/remote/app",
            workspaceIdentity: "ssh://dev/remote/app",
            label: "remote",
            kind: "remote",
            connectionState: "disconnected",
          },
          {
            workspacePath: "/local/app",
            label: "local",
            kind: "local",
          },
        ],
        mobileViewState: {
          activeWorkspaceKey: "ssh://dev/remote/app",
          activeTaskId: "remote-task",
          updatedAt: 2,
        },
      }),
    ).toEqual({
      workspaceKey: "/local/app",
      canBridge: true,
    });
  });

  it("returns a disconnected remote workspace for home-only mobile reconnect when no bridge target exists", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces: [
          {
            workspacePath: "/remote/app",
            workspaceIdentity: "ssh://dev/remote/app",
            label: "remote",
            kind: "remote",
            connectionState: "disconnected",
          },
        ],
        mobileViewState: {
          activeWorkspaceKey: "ssh://dev/remote/app",
          activeTaskId: "remote-task",
          updatedAt: 2,
        },
      }),
    ).toEqual({
      workspaceKey: "ssh://dev/remote/app",
      taskId: "remote-task",
      canBridge: false,
    });
  });
});

describe("webRemoteControlTaskTargetSchema", () => {
  it("accepts optional mobile display status", () => {
    expect(
      webRemoteControlTaskTargetSchema.parse({
        taskId: "task-status",
        title: "Task status",
        workspacePath: "/workspace/app",
        workspaceLabel: "App",
        workspaceKind: "local",
        createdAt: 1,
        updatedAt: 2,
        displayStatus: "running",
      }).displayStatus,
    ).toBe("running");
  });
});

describe("parseWebRemoteControlAppPayload", () => {
  it("accepts pushed workspace list updates", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-list-updated",
        result: {
          workspaces: [
            {
              workspacePath: "/workspace/app",
              label: "app",
              kind: "local",
            },
          ],
          tasks: [
            {
              taskId: "task-1",
              title: "Task one",
              workspacePath: "/workspace/app",
              workspaceLabel: "app",
              workspaceKind: "local",
              createdAt: 1,
              updatedAt: 2,
              displayStatus: "idle",
              archived: true,
            },
          ],
        },
      }),
    ).toMatchObject({
      zody_type: "workspace-list-updated",
      result: {
        tasks: [expect.objectContaining({ taskId: "task-1", archived: true })],
      },
    });
  });

  it("accepts workspace reconnect requests and responses", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-reconnect-request",
        requestId: "reconnect-1",
        workspaceKey: "remote:ssh:dev:/workspace/app",
      }),
    ).toMatchObject({
      zody_type: "workspace-reconnect-request",
      workspaceKey: "remote:ssh:dev:/workspace/app",
    });

    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-reconnect-response",
        requestId: "reconnect-1",
        workspaceKey: "remote:ssh:dev:/workspace/app",
        success: true,
      }),
    ).toMatchObject({
      zody_type: "workspace-reconnect-response",
      success: true,
    });
  });

  it("preserves mobile device info on mobile view state updates", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "mobile-view-state-update",
        viewState: {
          activeWorkspaceKey: "/workspace/app",
          activeTaskId: "task-1",
          updatedAt: 1,
        },
        deviceInfo: {
          platform: "web",
          version: "1.7.0",
          name: "mobile-browser",
          userAgent: "Mozilla/5.0 Mobile Safari/604.1",
          language: "zh-CN",
          languages: ["zh-CN", "en-US"],
          browserPlatform: "iPhone",
          viewport: {
            width: 390,
            height: 844,
            devicePixelRatio: 3,
          },
          screen: {
            width: 390,
            height: 844,
          },
          timezone: "Asia/Shanghai",
          online: true,
          updatedAt: 2,
        },
      }),
    ).toMatchObject({
      zody_type: "mobile-view-state-update",
      deviceInfo: {
        platform: "web",
        userAgent: "Mozilla/5.0 Mobile Safari/604.1",
        viewport: {
          width: 390,
          height: 844,
        },
      },
    });
  });

  it("removes the legacy one-shot rpc-frame branch from the production app parser", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        seq: 1,
        dataBase64: "AQID",
      }),
    ).toBeNull();
  });

  it("accepts strict acknowledged rpc fragments and cumulative ACKs in the production app parser", () => {
    const [fragment] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    expect(parseWebRemoteControlAppPayload(fragment)).toEqual(fragment);
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "rpc-frame-ack",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        ackMessageSeq: 1,
      }),
    ).toEqual({
      zody_type: "rpc-frame-ack",
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      ackMessageSeq: 1,
    });
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        seq: 1,
        dataBase64: "AQID",
        fragmentCount: 1,
      }),
    ).toBeNull();
  });

  it("bounds rpc-frame transport ids so the physical envelope meter is authoritative", () => {
    // 生成器使用 prefix + UUID / Date / Math.random，只产生这组 JSON-safe ASCII。
    // 所有合法字符均为单字节且无需 JSON escaping；`~` 覆盖字符集边界。
    const boundary = "~".repeat(256);
    const [boundaryFrame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: boundary,
      recoveryId: boundary,
      bridgeGeneration: Number.MAX_SAFE_INTEGER,
      firstPhysicalSeq: Number.MAX_SAFE_INTEGER,
      messageSeq: Number.MAX_SAFE_INTEGER,
    });
    expect(parseWebRemoteControlAppPayload(boundaryFrame)).toEqual(boundaryFrame);
    expect(
      parseWebRemoteControlAppPayload({
        ...boundaryFrame,
        bridgeSessionId: `${boundary}x`,
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        ...boundaryFrame,
        recoveryId: `${boundary}x`,
      }),
    ).toBeNull();
    for (const invalid of ['"', "\\", "\n", "中", "🙂"]) {
      expect(
        parseWebRemoteControlAppPayload({
          ...boundaryFrame,
          bridgeSessionId: `bridge-${invalid}-id`,
        }),
      ).toBeNull();
      expect(
        parseWebRemoteControlAppPayload({
          ...boundaryFrame,
          recoveryId: `recovery-${invalid}-id`,
        }),
      ).toBeNull();
    }
    for (const key of ["bridgeGeneration", "seq", "messageSeq"] as const) {
      expect(
        parseWebRemoteControlAppPayload({
          ...boundaryFrame,
          [key]: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toBeNull();
    }
  });

  it("accepts bridge degraded recovery payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "bridge-degraded",
        bridgeSessionId: "bridge-1",
        reason: "buffer-timeout",
        droppedCount: 1,
      }),
    ).toMatchObject({
      zody_type: "bridge-degraded",
      bridgeSessionId: "bridge-1",
      reason: "buffer-timeout",
      droppedCount: 1,
    });
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "bridge-degraded",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        reason: "rpc-transport-fault",
      }),
    ).toMatchObject({
      zody_type: "bridge-degraded",
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      reason: "rpc-transport-fault",
    });
    // 兼容旧 desktop 在原子升级窗口内仍可能发送的细分枚举。
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "bridge-degraded",
        bridgeSessionId: "bridge-legacy",
        reason: "rpc-frame-gap",
      }),
    ).not.toBeNull();
  });

  it("preserves bridge metadata on workspace bridge payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-bridge-open",
        requestId: "bridge-open-1",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        workspaceKey: "/workspace/app",
        taskId: "task-1",
      }),
    ).toMatchObject({
      zody_type: "workspace-bridge-open",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
    });

    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "workspace-bridge-ready",
        requestId: "bridge-open-1",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        bridge: {
          bridgeSessionId: "bridge-1",
          bridgeGeneration: 2,
          recoveryId: "recovery-1",
          kind: "local",
          workspaceKey: "/workspace/app",
          workspacePath: "/workspace/app",
        },
      }),
    ).toMatchObject({
      zody_type: "workspace-bridge-ready",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      bridge: {
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
      },
    });
  });

  it("accepts low-frequency mobile diagnostic payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "mobile-diagnostic",
        event: "socket-close",
        timestamp: 1710000000000,
        state: "reconnecting",
        closeCode: 1006,
        wasPaired: true,
        visibilityState: "visible",
        online: true,
      }),
    ).toMatchObject({
      zody_type: "mobile-diagnostic",
      event: "socket-close",
      closeCode: 1006,
      wasPaired: true,
    });
  });

  it("rejects invalid rpc-frame payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        seq: -1,
        dataBase64: "AQID",
      }),
    ).toBeNull();
  });
});

describe("hostIncomingMessageSchema", () => {
  it("accepts attach service port host messages", () => {
    expect(
      hostIncomingMessageSchema.parse({
        type: HostMessageTypes.AttachServicePort,
        requestId: "request-1",
        attachmentId: "attachment-1",
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      }),
    ).toEqual({
      type: HostMessageTypes.AttachServicePort,
      requestId: "request-1",
      attachmentId: "attachment-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
    });
  });

  it("accepts explicit service port detach messages", () => {
    expect(
      hostIncomingMessageSchema.parse({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: "attachment-1",
      }),
    ).toEqual({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: "attachment-1",
    });
  });
});

describe("phone discriminator hard cut", () => {
  it("rejects old and mixed top-level keys but preserves nested user data", () => {
    expect(
      parseWebRemoteControlAppPayload({ zcode_type: "bootstrap-request", requestId: "r" }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zody_type: "bootstrap-request",
        zcode_type: "bootstrap-request",
        requestId: "r",
      }),
    ).toBeNull();
    const nested = { zcode_type: "historical", text: "中文🙂 zcode_type remains user text" };
    const request = {
      zody_type: "platform-request",
      requestId: "r",
      method: "isDockerAvailable",
      args: nested,
    };
    // guard 只判断外层自身属性；opaque args 的保留由实际解析结果验证。
    expect(hasObsoleteWebRemoteControlDiscriminator(request)).toBe(false);
    expect(parseWebRemoteControlAppPayload(request)).toEqual(request);
  });
});
