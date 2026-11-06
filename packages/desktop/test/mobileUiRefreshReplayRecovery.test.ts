import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
  WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
  type WebRemoteControlAppPayload,
} from "@zody/shared";
import {
  connectViaProtocolOwned,
  createAcknowledgedWebRemoteControlRelayProtocol,
} from "@zody/client";
import { ChannelServer, MessagePortProtocol, ProxyChannel } from "@zody/rpc";
import { IZodyAgentService, IZodySessionService } from "@zody/services";
import {
  createGatewayDeviceTransport,
  type GatewayDeviceSocket,
  type GatewayDeviceSocketFactory,
} from "../src/main/remote-access/gatewayDeviceTransport.js";
import type {
  RemoteGatewayChannel,
  RemoteGatewayChannelMessage,
} from "../src/main/remote-access/remoteGatewayBackendTypes.js";
import { createRemoteWorkspaceDirectory } from "../src/main/remote-access/remoteWorkspaceDirectory.js";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";
import { createWebRemoteControlManager } from "../src/main/webRemoteControlManager.js";
import { createWindowHostAttachmentRegistry } from "../src/host/windowHostAttachmentRegistry.js";

/**
 * M3-T4：验证手机 WebView 刷新（旧页面 transport dispose → 同 backend 新页面重连）
 * 后 web-remote-replayable 恢复仍由原 owner 完成。
 *
 * 这里把桌面真实的 `GatewayDeviceTransport` + `WebRemoteControlManager` 接在一起，
 * 手机侧用真实 relay/ChannelClient 模拟；Host 侧只放一个持有运行时状态的假 Host，
 * 用来证明刷新不会创建第二个任务、Agent 或 Host attachment，也不会重复 admission。
 */

class FakeSocket {
  binaryType = "arraybuffer";
  readyState = 1;
  bufferedAmount = 0;
  addEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

class FakeChannel implements RemoteGatewayChannel {
  readonly kind = "zcode-remote";
  isOpen = true;
  readonly sent: string[] = [];
  private readonly messageHandlers = new Set<(message: RemoteGatewayChannelMessage) => void>();
  private readonly closeHandlers = new Set<() => void>();
  onSend?: (text: string) => void;

  constructor(readonly channelId: string) {}

  send(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.sent.push(text);
    this.onSend?.(text);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const handler of Array.from(this.closeHandlers)) handler();
  }

  onMessage(handler: (message: RemoteGatewayChannelMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  deliver(frame: unknown): void {
    const text = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const handler of Array.from(this.messageHandlers)) {
      handler({ data: text, binary: false });
    }
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

function hello(clientInstanceId: string) {
  return {
    type: "hello",
    protocolVersion: WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
    appProtocol: { min: 1, max: WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION },
    clientInstanceId,
    clientName: "Phone",
    appVersion: "1.0.0",
  };
}

function dataFrame(payload: unknown) {
  return { type: "data", payload };
}

function createTransportHarness() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const transport = createGatewayDeviceTransport({
    logger,
    desktopAppVersion: "9.9.9",
    createSocket: (() =>
      new FakeSocket() as unknown as GatewayDeviceSocket) as GatewayDeviceSocketFactory,
  });
  const states: string[] = [];
  const payloads: WebRemoteControlAppPayload[] = [];
  const session = transport.createSession({
    onStateChange: (state) => states.push(state),
    onPayload: (payload) => payloads.push(payload),
  });
  session.start();
  let channelSequence = 0;
  function attach(clientInstanceId: string) {
    channelSequence += 1;
    const channelId = `channel-${channelSequence}`;
    const channel = new FakeChannel(channelId);
    transport.handleChannel(channel, { channelId, kind: "zcode-remote" });
    channel.deliver(hello(clientInstanceId));
    return channel;
  }
  return { transport, session, states, payloads, attach, logger };
}

interface HostRuntime {
  process: object;
  counts: { create: number; resume: number; read: number; prompts: number };
  task: {
    status: "running" | "completed";
    pendingRequestIds: string[];
    messages: Array<{ messageId: string }>;
    eventSeq: number;
  };
  sessionService: Record<string, unknown>;
  agentService: Record<string, unknown>;
}

function createHostRuntime(): HostRuntime {
  const runtime: HostRuntime = {
    process: { hostProcessId: "host-1" },
    counts: { create: 0, resume: 0, read: 0, prompts: 0 },
    task: {
      status: "running",
      pendingRequestIds: ["prompt-1"],
      messages: [{ messageId: "message-1" }],
      eventSeq: 3,
    },
    sessionService: {},
    agentService: {},
  };
  const snapshot = () => ({
    session: { sessionId: "task-1", status: runtime.task.status, title: "Task one" },
    runtime: {
      activeTurnId: "turn-1",
      eventSeq: runtime.task.eventSeq,
      pendingRequestIds: [...runtime.task.pendingRequestIds],
      stateRevision: runtime.task.eventSeq,
    },
    messages: runtime.task.messages.map((message) => ({ ...message })),
    meta: { status: runtime.task.status },
  });
  runtime.sessionService = {
    createSession: async () => {
      runtime.counts.create += 1;
      return snapshot();
    },
    // 刷新后的页面按既有 replayable 协议重新 resume 同一 session；幂等激活，不创建新 Agent。
    resumeSession: async () => {
      runtime.counts.resume += 1;
      return snapshot();
    },
    readSession: async () => {
      runtime.counts.read += 1;
      return snapshot();
    },
    readSessionMessages: async () => [],
  };
  runtime.agentService = {
    // 只统计真正的 runtime admission；刷新恢复不应经过这里。
    sendPrompt: async () => {
      runtime.counts.prompts += 1;
      return { sessionId: "task-1", accepted: true, stateRevision: runtime.task.eventSeq };
    },
  };
  return runtime;
}

interface TestPort {
  on: EventEmitter["on"];
  off: EventEmitter["off"];
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(data: unknown): void;
  emitMessage(data: unknown): void;
  start(): void;
  close(): void;
}

function createPortPair(): readonly [TestPort, TestPort] {
  const createPort = () => {
    const emitter = new EventEmitter();
    let peer: TestPort | undefined;
    const port: TestPort = {
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      addEventListener(_type, listener) {
        emitter.on("message", listener);
      },
      removeEventListener(_type, listener) {
        emitter.off("message", listener);
      },
      postMessage(data: unknown) {
        queueMicrotask(() => peer?.emitMessage(data));
      },
      emitMessage(data: unknown) {
        emitter.emit("message", { data });
      },
      start() {},
      close() {},
    };
    return {
      port,
      connect(next: TestPort) {
        peer = next;
      },
    };
  };
  const left = createPort();
  const right = createPort();
  left.connect(right.port);
  right.connect(left.port);
  return [left.port, right.port] as const;
}

function createAttachmentHost(hostRuntime: HostRuntime) {
  let nextAttachmentId = 0;
  const attachments = new Map<
    string,
    {
      port: ReturnType<typeof createPortPair>[0];
      server: ChannelServer;
      protocol: MessagePortProtocol;
      workspacePath: string;
      taskId?: string;
    }
  >();
  const attachWorkspaceHost = vi.fn(
    async (_windowId: number, context: { workspacePath: string; initialTaskId?: string }) => {
      const [mainPort, hostPort] = createPortPair();
      const protocol = new MessagePortProtocol(hostPort as never);
      const server = new ChannelServer(protocol, "host", 1000, true);
      server.registerChannel(
        IZodySessionService.channelName,
        ProxyChannel.fromService(hostRuntime.sessionService as never),
      );
      server.registerChannel(
        IZodyAgentService.channelName,
        ProxyChannel.fromService(hostRuntime.agentService as never),
      );
      // 与真实 Host 一样，服务端口挂到同一个 Host 进程；延迟一拍等新页面建好 ChannelClient。
      setTimeout(() => server.ready(), 0);
      const attachmentId = `attachment-${++nextAttachmentId}`;
      attachments.set(attachmentId, {
        port: mainPort,
        server,
        protocol,
        workspacePath: context.workspacePath,
        taskId: context.initialTaskId,
      });
      return {
        entryId: "entry-1",
        attachmentId,
        process: hostRuntime.process as never,
        port: mainPort as never,
      };
    },
  );
  const releaseWorkspaceHostAttachment = vi.fn((attachmentId: string) => {
    const attachment = attachments.get(attachmentId);
    if (!attachment) return;
    attachments.delete(attachmentId);
    attachment.server.dispose();
    attachment.protocol.disconnect();
  });
  return {
    attachWorkspaceHost,
    releaseWorkspaceHostAttachment,
    attachments,
    disposeAll() {
      for (const attachmentId of Array.from(attachments.keys())) {
        releaseWorkspaceHostAttachment(attachmentId);
      }
    },
  };
}

interface MobilePage {
  channel: FakeChannel;
  received: WebRemoteControlAppPayload[];
  bridge?: { bridgeSessionId: string };
  bridgeReady: Promise<{ bridgeSessionId: string }>;
  relay?: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
  owned?: ReturnType<typeof connectViaProtocolOwned>;
  dropRpc: boolean;
  handleDesktopPayload(payload: WebRemoteControlAppPayload): void;
  attachRelay(bridge: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
  }): ReturnType<typeof connectViaProtocolOwned>["services"];
  dispose(): void;
}

function createMobilePage(channel: FakeChannel, onReady: (bridge: unknown) => void): MobilePage {
  let resolveBridgeReady: (bridge: { bridgeSessionId: string }) => void = () => {};
  const page: MobilePage = {
    channel,
    received: [],
    bridgeReady: new Promise((resolve) => {
      resolveBridgeReady = resolve;
    }),
    dropRpc: false,
    handleDesktopPayload(payload) {
      page.received.push(payload);
      if (payload.zody_type === "workspace-bridge-ready") {
        page.bridge = payload.bridge;
        resolveBridgeReady(payload.bridge);
        onReady(payload.bridge);
        return;
      }
      if (
        !page.dropRpc &&
        (payload.zody_type === "rpc-frame" || payload.zody_type === "rpc-frame-ack")
      ) {
        page.relay?.acceptPayload(payload);
      }
    },
    attachRelay(bridge) {
      const relay = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridge.bridgeSessionId,
        ...(bridge.bridgeGeneration === undefined
          ? {}
          : { bridgeGeneration: bridge.bridgeGeneration }),
        measureFrameBytes: (frame) => JSON.stringify(frame).length,
        sendFrame: (frame) => {
          if (!channel.isOpen) return false;
          channel.deliver(dataFrame(frame));
          return true;
        },
      });
      const owned = connectViaProtocolOwned(relay.protocol);
      page.relay = relay;
      page.owned = owned;
      return owned.services;
    },
    dispose() {
      page.owned?.dispose();
      page.relay?.dispose();
      page.relay = undefined;
      page.owned = undefined;
    },
  };
  return page;
}

function createManagerHarness(hostRuntime: HostRuntime) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const directory = createRemoteWorkspaceDirectory({});
  const sentPayloads: WebRemoteControlAppPayload[] = [];
  const states: string[] = [];
  let activePage: MobilePage | undefined;
  let channelSequence = 0;

  const transport = createGatewayDeviceTransport({
    logger,
    desktopAppVersion: "9.9.9",
    createSocket: (() =>
      new FakeSocket() as unknown as GatewayDeviceSocket) as GatewayDeviceSocketFactory,
  });
  const attachmentHost = createAttachmentHost(hostRuntime);
  const manager = createWebRemoteControlManager({
    appVersion: "1.5.0",
    remoteAccessSettings: {
      isEnabled: async () => true,
      setEnabled: async () => {},
    },
    featureGate: createWebRemoteControlFeatureGate(true),
    remoteWorkspaceDirectory: directory,
    logger,
    platformHandlers: {
      isDockerAvailable: async () => true,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
    },
    reconnectWorkspace: vi.fn(async () => undefined),
    attachWorkspaceHost: attachmentHost.attachWorkspaceHost as never,
    releaseWorkspaceHostAttachment: attachmentHost.releaseWorkspaceHostAttachment,
    disposeWorkspaceHostAttachmentsForWindow: vi.fn(),
    disposeWorkspaceHostAttachmentsForRemoteSession: vi.fn(),
    createDeviceTransport: (options) =>
      transport.createSession({
        ...options,
        onStateChange: (state) => {
          states.push(state);
          options.onStateChange(state);
        },
      }),
  });

  function bindChannel(channel: FakeChannel) {
    channel.onSend = (text) => {
      const frame = JSON.parse(text) as { type?: string; payload?: WebRemoteControlAppPayload };
      if (frame.type === "data" && frame.payload) {
        sentPayloads.push(frame.payload);
        activePage?.handleDesktopPayload(frame.payload);
      }
    };
  }

  function attachClient(clientInstanceId: string) {
    channelSequence += 1;
    const channelId = `channel-${channelSequence}`;
    const channel = new FakeChannel(channelId);
    transport.handleChannel(channel, { channelId, kind: "zcode-remote" });
    channel.deliver(hello(clientInstanceId));
    bindChannel(channel);
    return channel;
  }

  return {
    manager,
    directory,
    attachmentHost,
    hostRuntime,
    states,
    sentPayloads,
    attachClient,
    usePage(page: MobilePage | undefined) {
      activePage = page;
    },
    pageOn(channel: FakeChannel) {
      const page = createMobilePage(channel, () => {});
      activePage = page;
      return page;
    },
    dispose() {
      activePage?.dispose();
      attachmentHost.disposeAll();
      transport.dispose();
    },
  };
}

const localWorkspace = { workspacePath: "/workspace/demo", label: "demo", kind: "local" as const };
const localTask = {
  taskId: "task-1",
  title: "Task one",
  workspacePath: "/workspace/demo",
  workspaceLabel: "demo",
  workspaceKind: "local" as const,
  createdAt: 1,
  updatedAt: 9,
  displayStatus: "running" as const,
  hasBackgroundWork: true,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("mobile UI refresh replay recovery", () => {
  it("同 clientInstanceId 的新页面接管 channel，旧页面关闭不重启 transport session", () => {
    const h = createTransportHarness();
    const first = h.attach("phone-1");
    expect(h.states).toEqual(["waiting_terminal", "paired"]);
    first.deliver(dataFrame({ zody_type: "bootstrap-request", requestId: "bootstrap-1" }));
    expect(h.payloads).toHaveLength(1);

    // 旧页面刷新：transport dispose 会发 close{client-leaving} 并关闭 socket。
    first.deliver({ type: "close", reason: "client-leaving" });
    expect(first.isOpen).toBe(false);
    expect(h.states.at(-1)).toBe("waiting_terminal");

    const second = h.attach("phone-1");
    expect(h.states.at(-1)).toBe("paired");
    expect(first.frames().some((frame) => frame.type === "close")).toBe(false);
    expect(second.isOpen).toBe(true);

    second.deliver(dataFrame({ zody_type: "bootstrap-request", requestId: "bootstrap-2" }));
    expect(h.payloads).toHaveLength(2);
    expect(
      h.session.sendPayloadResult({
        zody_type: "workspace-list-request",
        requestId: "list-1",
      }).kind,
    ).toBe("sent");
    expect(second.frames()).toContainEqual(
      dataFrame({ zody_type: "workspace-list-request", requestId: "list-1" }),
    );
    // 旧页面之后不会再收到新数据。
    expect(first.frames().filter((frame) => frame.type === "data")).toHaveLength(0);

    h.session.dispose();
    h.transport.dispose();
  });

  it("gateway 报告旧 channel 关闭后，迟到帧不会进入业务层", () => {
    const h = createTransportHarness();
    const first = h.attach("phone-1");
    expect(h.payloads).toHaveLength(0);

    // backend 换代/epoch 变化：gateway 控制面要求关闭当前 channel。
    h.transport.handleGatewayChannelClosed({ channelId: first.channelId, reason: "epoch_changed" });
    expect(h.states.at(-1)).toBe("waiting_terminal");
    expect(
      h.session.sendPayloadResult({
        zody_type: "workspace-list-request",
        requestId: "after-close",
      }),
    ).toEqual({ kind: "unavailable" });

    // 旧 channel 的 socket 可能还有已入队的迟到帧；不能绕过关闭事实。
    first.deliver(dataFrame({ zody_type: "bootstrap-request", requestId: "stale-bootstrap" }));
    expect(h.payloads).toHaveLength(0);

    h.session.dispose();
    h.transport.dispose();
  });

  it("不同 clientInstanceId 仍走 superseded，刷新不能绕过旧 channel 关闭", () => {
    const h = createTransportHarness();
    const first = h.attach("phone-a");
    first.sent.length = 0;

    // 同一 backend 但不同安装/身份（例如重新配对）：必须发 close{superseded}。
    const second = h.attach("phone-b");
    expect(first.frames()).toEqual([{ type: "close", reason: "superseded" }]);
    expect(first.isOpen).toBe(true);

    first.sent.length = 0;
    first.deliver(dataFrame({ zody_type: "bootstrap-request", requestId: "stale" }));
    expect(h.payloads).toHaveLength(0);
    expect(first.frames()).toEqual([]);
    expect(second.isOpen).toBe(true);

    h.session.dispose();
    h.transport.dispose();
  });

  it("运行中的任务跨刷新由原 Host 恢复，不重复 createSession/Agent/prompt admission", async () => {
    const hostRuntime = createHostRuntime();
    const h = createManagerHarness(hostRuntime);
    try {
      await h.manager.start({ workspacePath: localWorkspace.workspacePath }, 1);
      h.directory.syncWorkspaces(1, [localWorkspace]);
      h.directory.syncTasks(1, [localTask]);

      // 旧 Remote 页面：连接、拿到任务列表、切到 task-1、打开 bridge。
      const firstChannel = h.attachClient("phone-1");
      const page1 = h.pageOn(firstChannel);
      firstChannel.deliver(dataFrame({ zody_type: "bootstrap-request", requestId: "bootstrap-1" }));
      const bootstrap1 = h.sentPayloads.find(
        (payload) =>
          payload.zody_type === "bootstrap-response" && payload.requestId === "bootstrap-1",
      );
      expect(bootstrap1).toMatchObject({
        result: { tasks: [expect.objectContaining({ taskId: "task-1" })] },
      });
      firstChannel.deliver(
        dataFrame({
          zody_type: "mobile-view-state-update",
          viewState: {
            activeWorkspaceKey: localWorkspace.workspacePath,
            activeTaskId: "task-1",
            updatedAt: 10,
          },
        }),
      );
      firstChannel.deliver(
        dataFrame({
          zody_type: "workspace-bridge-open",
          requestId: "bridge-open-1",
          bridgeSessionId: "bridge-1",
          workspaceKey: localWorkspace.workspacePath,
          taskId: "task-1",
        }),
      );
      const bridge1 = await page1.bridgeReady;
      expect(bridge1).toMatchObject({ bridgeSessionId: "bridge-1", initialTaskId: "task-1" });
      const services1 = page1.attachRelay(bridge1 as never);

      // 旧页面按 replayable 协议恢复并提交一次输入（admission 只应发生这一次）。
      await services1.zodySessionService.resumeSession({
        workspacePath: localWorkspace.workspacePath,
        sessionId: "task-1",
      });
      const snapshot1 = await services1.zodySessionService.readSession({
        workspacePath: localWorkspace.workspacePath,
        sessionId: "task-1",
        deliveryKind: "web-remote-replayable",
      });
      expect(snapshot1).toMatchObject({
        runtime: { pendingRequestIds: ["prompt-1"] },
      });
      const promptResult = await services1.zodyAgentService.sendPrompt({
        workspacePath: localWorkspace.workspacePath,
        sessionId: "task-1",
        traceId: "trace-1",
        content: "continue",
        clientMode: "web-remote-replayable",
      } as never);
      expect(promptResult).toMatchObject({ accepted: true });
      expect(hostRuntime.counts.prompts).toBe(1);

      // 第一次刷新：旧页面不再消费 desktop 数据，transport 看到 client-leaving。
      page1.dropRpc = true;
      page1.dispose();
      firstChannel.deliver({ type: "close", reason: "client-leaving" });
      expect(firstChannel.isOpen).toBe(false);

      // 同 backend 新页面重连，任务仍在运行，pending prompt 由 Host 快照恢复。
      const secondChannel = h.attachClient("phone-1");
      const page2 = h.pageOn(secondChannel);
      secondChannel.deliver(
        dataFrame({ zody_type: "bootstrap-request", requestId: "bootstrap-2" }),
      );
      const bootstrap2 = h.sentPayloads.find(
        (payload) =>
          payload.zody_type === "bootstrap-response" && payload.requestId === "bootstrap-2",
      );
      expect(bootstrap2).toMatchObject({
        result: {
          tasks: [expect.objectContaining({ taskId: "task-1" })],
          mobileViewState: expect.objectContaining({ activeTaskId: "task-1" }),
        },
      });

      // 新页面为同一个 task 重开 bridge：只轮换 attachment，不新建 Host/Agent/任务。
      secondChannel.deliver(
        dataFrame({
          zody_type: "workspace-bridge-open",
          requestId: "bridge-open-2",
          bridgeSessionId: "bridge-2",
          workspaceKey: localWorkspace.workspacePath,
          taskId: "task-1",
        }),
      );
      const bridge2 = await page2.bridgeReady;
      expect(bridge2).toMatchObject({ bridgeSessionId: "bridge-2", initialTaskId: "task-1" });
      const services2 = page2.attachRelay(bridge2 as never);

      await services2.zodySessionService.resumeSession({
        workspacePath: localWorkspace.workspacePath,
        sessionId: "task-1",
      });
      const snapshot2 = await services2.zodySessionService.readSession({
        workspacePath: localWorkspace.workspacePath,
        sessionId: "task-1",
        deliveryKind: "web-remote-replayable",
      });
      expect(snapshot2).toMatchObject({
        session: { status: "running" },
        runtime: { eventSeq: 3, pendingRequestIds: ["prompt-1"] },
      });

      // 第二次刷新：任务在 reload 间隙完成；完成事实属于 Host runtime，不依赖旧页面。
      page2.dropRpc = true;
      page2.dispose();
      secondChannel.deliver({ type: "close", reason: "client-leaving" });
      hostRuntime.task.status = "completed";
      hostRuntime.task.pendingRequestIds = [];
      hostRuntime.task.eventSeq = 4;
      hostRuntime.task.messages.push({ messageId: "message-2" });

      const thirdChannel = h.attachClient("phone-1");
      const page3 = h.pageOn(thirdChannel);
      thirdChannel.deliver(dataFrame({ zody_type: "bootstrap-request", requestId: "bootstrap-3" }));
      thirdChannel.deliver(
        dataFrame({
          zody_type: "workspace-bridge-open",
          requestId: "bridge-open-3",
          bridgeSessionId: "bridge-3",
          workspaceKey: localWorkspace.workspacePath,
          taskId: "task-1",
        }),
      );
      const bridge3 = await page3.bridgeReady;
      expect(bridge3).toMatchObject({ bridgeSessionId: "bridge-3", initialTaskId: "task-1" });
      const services3 = page3.attachRelay(bridge3 as never);
      await services3.zodySessionService.resumeSession({
        workspacePath: localWorkspace.workspacePath,
        sessionId: "task-1",
      });
      const snapshot3 = await services3.zodySessionService.readSession({
        workspacePath: localWorkspace.workspacePath,
        sessionId: "task-1",
        deliveryKind: "web-remote-replayable",
      });
      expect(snapshot3).toMatchObject({
        session: { status: "completed" },
        runtime: { eventSeq: 4, pendingRequestIds: [] },
        messages: [{ messageId: "message-1" }, { messageId: "message-2" }],
      });

      // 证据：Host 进程同一个、attachment 只轮换、没有重复任务/Agent/admission。
      expect(h.attachmentHost.attachWorkspaceHost).toHaveBeenCalledTimes(3);
      expect(h.attachmentHost.attachWorkspaceHost).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({
          workspacePath: localWorkspace.workspacePath,
          initialTaskId: "task-1",
          kind: "local",
        }),
      );
      expect(h.attachmentHost.releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1");
      expect(h.attachmentHost.releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-2");
      expect(h.attachmentHost.attachments.size).toBe(1);
      expect(hostRuntime.counts.create).toBe(0);
      expect(hostRuntime.counts.resume).toBe(3);
      expect(hostRuntime.counts.read).toBe(3);
      expect(hostRuntime.counts.prompts).toBe(1);
      expect(h.states.filter((state) => state === "paired")).toHaveLength(3);
      expect(h.directory.listTasks().filter((task) => task.taskId === "task-1")).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it("未进入 runtime 的未提交输入不会被刷新恢复或重复 admission", async () => {
    const hostRuntime = createHostRuntime();
    const h = createManagerHarness(hostRuntime);
    try {
      await h.manager.start({ workspacePath: localWorkspace.workspacePath }, 1);
      h.directory.syncWorkspaces(1, [localWorkspace]);
      h.directory.syncTasks(1, [localTask]);

      // 旧页面只有草稿/optimistic overlay，没有 bridge、没有 sendPrompt。
      const firstChannel = h.attachClient("phone-1");
      const page1 = h.pageOn(firstChannel);
      firstChannel.deliver(dataFrame({ zody_type: "bootstrap-request", requestId: "bootstrap-1" }));
      firstChannel.deliver(
        dataFrame({
          zody_type: "mobile-view-state-update",
          viewState: { activeWorkspaceKey: localWorkspace.workspacePath, updatedAt: 11 },
        }),
      );
      page1.dispose();
      firstChannel.deliver({ type: "close", reason: "client-leaving" });

      const secondChannel = h.attachClient("phone-1");
      h.pageOn(secondChannel);
      secondChannel.deliver(
        dataFrame({ zody_type: "bootstrap-request", requestId: "bootstrap-2" }),
      );

      // 桌面从未收到任何 bridge/prompt；刷新不能把页面本地草稿变成 runtime 输入。
      expect(h.attachmentHost.attachWorkspaceHost).not.toHaveBeenCalled();
      expect(hostRuntime.counts.prompts).toBe(0);
      expect(hostRuntime.counts.create).toBe(0);
      expect(h.sentPayloads.some((payload) => payload.zody_type === "workspace-bridge-ready")).toBe(
        false,
      );
    } finally {
      h.dispose();
    }
  });
});

describe("desktop-continuous shares Host state without refresh pollution", () => {
  it("移动页面刷新只轮换 replayable attachment，不影响 desktop-continuous attachment", () => {
    const disposeDesktop = vi.fn();
    const disposeMobileOld = vi.fn();
    const disposeMobileNew = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: disposeDesktop })
      .mockReturnValueOnce({ dispose: disposeMobileOld })
      .mockReturnValueOnce({ dispose: disposeMobileNew });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "host-services", generation: 1 }),
      expose,
    });
    const port = () => ({ once: vi.fn() });
    registry.attach({
      requestId: "desktop-1",
      attachmentId: "desktop-1",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: port(),
    });
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: port(),
    });

    // 刷新：旧移动 attachment 释放，新页面建立同 Host 的第二个 attachment。
    registry.detach("mobile-1");
    registry.attach({
      requestId: "mobile-2",
      attachmentId: "mobile-2",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: port(),
    });

    expect(disposeMobileOld).toHaveBeenCalledTimes(1);
    expect(disposeMobileNew).not.toHaveBeenCalled();
    expect(disposeDesktop).not.toHaveBeenCalled();
    expect(registry.list().map((attachment) => attachment.attachmentId)).toEqual([
      "desktop-1",
      "mobile-2",
    ]);
    expect(expose).toHaveBeenCalledTimes(3);
    expect(expose.mock.calls.map(([params]) => params.services)).toEqual([
      "host-services",
      "host-services",
      "host-services",
    ]);
  });
});
