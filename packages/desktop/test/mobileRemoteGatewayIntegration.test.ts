import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSocketFactory,
  type SocketFactory,
  type WebSocketLike,
} from "@zclaudia/gateway-client";
import {
  WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
  encodeWebRemoteControlRpcTransportMessage,
  WebRemoteControlRpcTransportAssembler,
  type WebRemoteControlAppPayload,
  type WebRemoteControlBootstrapResponsePayload,
  type WebRemoteControlFailure,
  type WebRemoteControlRpcTransportAssemblyEvent,
} from "@zcode/shared";
import { createGatewayDeviceTransport } from "../src/main/remote-access/gatewayDeviceTransport.js";
import type {
  GatewayDeviceSocket,
  GatewayDeviceSocketFactory,
  GatewayDeviceTransport,
  GatewayDeviceTransportSession,
} from "../src/main/remote-access/gatewayDeviceTransportTypes.js";
import { createRemoteGatewayBackend } from "../src/main/remote-access/remoteGatewayBackend.js";
import type { RemoteGatewayBackend } from "../src/main/remote-access/remoteGatewayBackendTypes.js";
import {
  GatewayTerminalTransport,
  type GatewayTerminalTransportDiagnostic,
  type GatewayTerminalTransportState,
} from "@web/mobile-remote/gatewayTerminalTransport.js";

/**
 * T3.5：真实 gateway 集成测试（方案「验收」第 7 条）。
 *
 * 用真实 SDK 驱动两端 transport：
 * - 桌面：`RemoteGatewayBackend`（`@zclaudia/gateway-backend@0.4.0`，内含 client 0.2.x）
 *   + `GatewayDeviceTransport`；
 * - 手机：`GatewayTerminalTransport`（`@zclaudia/gateway-client@0.3.0`，与 packages/web 一致）。
 *
 * 显式开启：只有同时设置 `ZCODE_GATEWAY_IT_URL` 与 `ZCODE_GATEWAY_IT_ADMIN_TOKEN` 才执行；
 * 缺失时整个 suite 跳过并在名称里说明原因（不伪造结果）。凭证由测试用管理 API 现签现删，
 * 不读取、也不打印任何已存在的凭证。gateway 重启场景需要显式提供
 * `ZCODE_GATEWAY_IT_RESTART_COMMAND`（例如 `docker restart <container>`），避免测试擅自
 * 重启共享实例。
 *
 * 说明：manager / bridge 的 ACK 与重放属于 (b)(c) 层，本测试不装配完整 manager；
 * 重放场景用真实的 `WebRemoteControlRpcTransportAssembler` 与 `rpc-frame-ack` 负载，
 * 在 transport 之上搭最小账本，验证「控制连接被杀后，未 ACK 的消息经新 channel 重放补齐」。
 *
 * 本地运行（T0.2 生成的 .env.gateway.local 已含 IT_URL/管理令牌）：
 *   set -a; source .env.gateway.local; set +a
 *   ZCODE_GATEWAY_IT_RESTART_COMMAND='docker restart zclaudia-gateway-gateway-1' \
 *     pnpm vitest run packages/desktop/test/mobileRemoteGatewayIntegration.test.ts
 * 不设置重启命令时只跳过「gateway 重启」一个场景。
 */

const gatewayUrl = process.env.ZCODE_GATEWAY_IT_URL?.trim();
const adminToken = process.env.ZCODE_GATEWAY_IT_ADMIN_TOKEN?.trim();
const namespace = process.env.ZCODE_GATEWAY_IT_NAMESPACE?.trim() || "zcode";
const restartCommand = process.env.ZCODE_GATEWAY_IT_RESTART_COMMAND?.trim();
const skipReason = !gatewayUrl
  ? "未设置 ZCODE_GATEWAY_IT_URL"
  : !adminToken
    ? "未设置 ZCODE_GATEWAY_IT_ADMIN_TOKEN"
    : undefined;

const DESKTOP_APP_VERSION = "0.0.0-integration";
const CLIENT_NAME = "integration-phone";
const DEFAULT_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  predicate: () => T | undefined | false | Promise<T | undefined | false>,
  description: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value as T;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `等待超时（${timeoutMs}ms）：${description}${lastError ? `；最后一次错误：${String(lastError)}` : ""}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 管理 API                                                                   */
/* -------------------------------------------------------------------------- */

interface IssuedCredential {
  id: string;
  token: string;
  backendId?: string;
}

interface AdminResponse {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

async function adminRequest(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  if (!gatewayUrl || !adminToken) {
    throw new Error("gateway integration environment is not configured");
  }
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => undefined)) as AdminResponse | undefined;
  if (!response.ok || !body?.success) {
    const code = body?.error?.code ?? `HTTP ${response.status}`;
    throw new Error(`admin ${init.method ?? "GET"} ${path} failed: ${code}`);
  }
  return body.data ?? {};
}

async function issueCredential(
  type: "backend" | "device",
  name: string,
): Promise<IssuedCredential> {
  const data = await adminRequest("/api/admin/credentials", {
    method: "POST",
    body: { type, namespace, name },
  });
  const token = data.token;
  const id = data.id;
  if (typeof token !== "string" || typeof id !== "string") {
    throw new Error(`admin issue ${type} did not return id/token`);
  }
  return { id, token, backendId: typeof data.backendId === "string" ? data.backendId : undefined };
}

/** 吊销（DELETE 会级联 access token），再永久删除吊销行，避免测试数据堆积。 */
async function revokeCredential(credential: IssuedCredential): Promise<void> {
  try {
    await adminRequest(`/api/admin/credentials/${encodeURIComponent(credential.id)}`, {
      method: "DELETE",
    });
  } catch {
    // 场景测试可能已经主动吊销；清理阶段重复吊销不是失败。
  }
  try {
    await adminRequest("/api/admin/credentials/purge", {
      method: "POST",
      body: { ids: [credential.id] },
    });
  } catch {
    // 清理是 best-effort，不影响测试结论。
  }
}

async function deleteBackendIdentity(backendId: string | undefined): Promise<void> {
  if (!backendId) return;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await adminRequest(`/api/admin/backends/${encodeURIComponent(backendId)}`, {
        method: "DELETE",
      });
      return;
    } catch {
      await delay(100);
    }
  }
}

async function isGatewayHealthy(): Promise<boolean> {
  if (!gatewayUrl) return false;
  try {
    const response = await fetch(`${gatewayUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 受控 socket                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 包装真实 backend 控制 socket。`simulateDrop()` 只向 SDK 投递一次 close 事件而不关闭底层
 * TCP：gateway 仍认为旧连接活着，于是同一凭证的新连接会触发 epoch 换代，channel 以
 * `epoch_changed` 关闭——这正是方案「桌面控制连接短抖后立即重连」的真实路径。
 */
class ControlledSocket implements WebSocketLike {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private closeEmitted = false;

  constructor(private readonly inner: WebSocketLike) {
    inner.addEventListener("open", () => this.dispatch("open", undefined));
    inner.addEventListener("message", (event) => this.dispatch("message", event));
    inner.addEventListener("error", (event) => this.dispatch("error", event));
    inner.addEventListener("close", (event) => {
      if (this.closeEmitted) return;
      this.closeEmitted = true;
      this.dispatch("close", event);
    });
  }

  get binaryType(): string {
    return this.inner.binaryType;
  }

  set binaryType(value: string) {
    this.inner.binaryType = value;
  }

  get readyState(): number {
    return this.inner.readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.inner.send(data);
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener as (event: unknown) => void);
    this.listeners.set(type, bucket);
  }

  /** 只让 SDK 看到断线，不关闭底层 socket；gateway 侧仍把旧连接当作在线。 */
  simulateDrop(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.dispatch("close", { code: 1006, reason: "simulated-drop", wasClean: false });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      listener(event);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 两端 harness                                                               */
/* -------------------------------------------------------------------------- */

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  args: unknown[];
}

interface DesktopHarnessOptions {
  credential: string;
  onRawTransportPayload?: (payload: unknown) => boolean;
}

interface DesktopHarness {
  backend: RemoteGatewayBackend;
  deviceTransport: GatewayDeviceTransport;
  session: GatewayDeviceTransportSession;
  readonly controlledSockets: ControlledSocket[];
  readonly payloads: WebRemoteControlAppPayload[];
  readonly stateEvents: string[];
  readonly channelIds: string[];
  readonly logs: CapturedLog[];
  readonly sendReadyCount: number;
  waitOnline(): Promise<void>;
  onPayload(handler: (payload: WebRemoteControlAppPayload) => void): () => void;
  waitPayload<T extends WebRemoteControlAppPayload["zcode_type"]>(
    type: T,
    predicate?: (payload: Extract<WebRemoteControlAppPayload, { zcode_type: T }>) => boolean,
  ): Promise<Extract<WebRemoteControlAppPayload, { zcode_type: T }>>;
  dispose(): Promise<void>;
}

function createDesktopHarness(options: DesktopHarnessOptions): DesktopHarness {
  const logs: CapturedLog[] = [];
  const logger = {
    debug: (...args: unknown[]) => logs.push({ level: "debug", args }),
    info: (...args: unknown[]) => logs.push({ level: "info", args }),
    warn: (...args: unknown[]) => logs.push({ level: "warn", args }),
    error: (...args: unknown[]) => logs.push({ level: "error", args }),
  };
  const deviceTransport = createGatewayDeviceTransport({
    logger,
    desktopAppVersion: DESKTOP_APP_VERSION,
  });
  const controlledSockets: ControlledSocket[] = [];
  // backend SDK 用同一个 socketFactory 拨控制连接（/ws）和数据连接。
  const socketFactory: GatewayDeviceSocketFactory = (socketUrl) => {
    const socket = deviceTransport.socketFactory(socketUrl);
    if (new URL(socketUrl).pathname === "/ws") {
      const controlled = new ControlledSocket(socket);
      controlledSockets.push(controlled);
      return controlled as unknown as GatewayDeviceSocket;
    }
    return socket;
  };
  const backend = createRemoteGatewayBackend({
    loadConfig: async () => ({
      enabled: true,
      gatewayUrl: gatewayUrl!,
      namespace,
      credential: options.credential,
    }),
    logger,
    allowInsecureTransport: true,
    socketFactory,
  });

  const payloads: WebRemoteControlAppPayload[] = [];
  const payloadHandlers = new Set<(payload: WebRemoteControlAppPayload) => void>();
  const stateEvents: string[] = [];
  const channelIds: string[] = [];
  let sendReadyCount = 0;

  backend.setChannelHandler((channel, offer) => {
    channelIds.push(channel.channelId);
    deviceTransport.handleChannel(channel, offer);
  });
  backend.onChannelClosed((info) => deviceTransport.handleGatewayChannelClosed(info));

  const session = deviceTransport.createSession({
    onStateChange: (state) => stateEvents.push(state),
    onPayload: (payload) => {
      payloads.push(payload);
      for (const handler of Array.from(payloadHandlers)) handler(payload);
    },
    onRawTransportPayload: (payload) => options.onRawTransportPayload?.(payload) ?? false,
    onSendReady: () => {
      sendReadyCount += 1;
    },
    onError: (error) => logs.push({ level: "error", args: [error] }),
  });
  session.start();

  const harness: DesktopHarness = {
    backend,
    deviceTransport,
    session,
    controlledSockets,
    payloads,
    stateEvents,
    channelIds,
    logs,
    get sendReadyCount() {
      return sendReadyCount;
    },
    async waitOnline() {
      // 与生产路径一致：session 先 start（等待手机），再让 RemoteGatewayBackend 读配置建连。
      await backend.reloadConfig();
      try {
        await waitFor(
          () => backend.getStatus().state === "online",
          "桌面 backend 连接 gateway（online）",
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；status=${JSON.stringify(
            backend.getStatus(),
          )}；logs=${JSON.stringify(logs.slice(-12))}`,
        );
      }
    },
    onPayload(handler) {
      payloadHandlers.add(handler);
      return () => {
        payloadHandlers.delete(handler);
      };
    },
    waitPayload(type, predicate) {
      return waitFor(() => {
        for (const payload of payloads) {
          if (payload.zcode_type !== type) continue;
          const typed = payload as Extract<WebRemoteControlAppPayload, { zcode_type: typeof type }>;
          if (!predicate || predicate(typed)) return typed;
        }
        return undefined;
      }, `桌面收到 ${type} payload`);
    },
    async dispose() {
      session.dispose();
      backend.setChannelHandler(undefined);
      await backend.dispose();
      deviceTransport.dispose();
    },
  };
  return harness;
}

interface PhoneHarnessOptions {
  credential: string;
  backendId: string;
  clientInstanceId: string;
  onRawTransportPayload?: (payload: unknown) => boolean;
  onPayload?: (payload: WebRemoteControlAppPayload) => void;
}

interface PhoneHarness {
  transport: GatewayTerminalTransport;
  readonly controlSockets: WebSocketLike[];
  readonly payloads: WebRemoteControlAppPayload[];
  readonly failures: WebRemoteControlFailure[];
  readonly diagnostics: GatewayTerminalTransportDiagnostic[];
  readonly states: GatewayTerminalTransportState[];
  readonly sendReadyCount: number;
  readonly version: { appProtocol: number; desktopAppVersion: string } | undefined;
  readonly state: GatewayTerminalTransportState;
  waitReady(): Promise<void>;
  waitPayload<T extends WebRemoteControlAppPayload["zcode_type"]>(
    type: T,
    predicate?: (payload: Extract<WebRemoteControlAppPayload, { zcode_type: T }>) => boolean,
  ): Promise<Extract<WebRemoteControlAppPayload, { zcode_type: T }>>;
  dispose(): void;
}

function createPhoneHarness(options: PhoneHarnessOptions): PhoneHarness {
  const controlSockets: WebSocketLike[] = [];
  // 只需要扣住控制连接：场景里用它模拟「手机控制连接被杀」。
  const socketFactory: SocketFactory = (socketUrl) => {
    const socket = defaultSocketFactory(socketUrl);
    if (!new URL(socketUrl).pathname.startsWith("/channel/")) {
      controlSockets.push(socket);
    }
    return socket;
  };
  const payloads: WebRemoteControlAppPayload[] = [];
  const failures: WebRemoteControlFailure[] = [];
  const diagnostics: GatewayTerminalTransportDiagnostic[] = [];
  const states: GatewayTerminalTransportState[] = [];
  let currentState: GatewayTerminalTransportState = "idle";
  let sendReadyCount = 0;
  let version: { appProtocol: number; desktopAppVersion: string } | undefined;

  const transport = new GatewayTerminalTransport({
    gatewayUrl: gatewayUrl!,
    namespace,
    credential: options.credential,
    backendId: options.backendId,
    clientInstanceId: options.clientInstanceId,
    clientName: CLIENT_NAME,
    appVersion: "0.0.0-integration",
    socketFactory,
    // 真机默认 1s → 30s；集成测试压缩退避，避免每个场景都等满。
    reconnectMinMs: 150,
    reconnectMaxMs: 600,
    onPayload: (payload) => {
      payloads.push(payload);
      options.onPayload?.(payload);
    },
    onRawTransportPayload: (payload) => options.onRawTransportPayload?.(payload) ?? false,
    onFailure: (failure) => failures.push(failure),
    onError: () => {},
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
      currentState = diagnostic.state;
    },
    onStateChange: (state) => {
      currentState = state;
      states.push(state);
    },
    onSendReady: () => {
      sendReadyCount += 1;
    },
    onVersionNegotiated: (info) => {
      version = info;
    },
  });

  return {
    transport,
    controlSockets,
    payloads,
    failures,
    diagnostics,
    states,
    get sendReadyCount() {
      return sendReadyCount;
    },
    get version() {
      return version;
    },
    get state() {
      return currentState;
    },
    async waitReady() {
      await waitFor(() => currentState === "ready", "手机 transport ready");
      // ready 之后 onSendReady 已同步触发；再等一个 tick 让上层完成 flush。
      await delay(0);
    },
    waitPayload(type, predicate) {
      return waitFor(() => {
        for (const payload of payloads) {
          if (payload.zcode_type !== type) continue;
          const typed = payload as Extract<WebRemoteControlAppPayload, { zcode_type: typeof type }>;
          if (!predicate || predicate(typed)) return typed;
        }
        return undefined;
      }, `手机收到 ${type} payload`);
    },
    dispose() {
      transport.dispose();
    },
  };
}

function buildBootstrapResponse(requestId: string): WebRemoteControlBootstrapResponsePayload {
  return {
    zcode_type: "bootstrap-response",
    requestId,
    success: true,
    result: {
      windowControlSessionId: "it-window-session",
      desktopAppVersion: DESKTOP_APP_VERSION,
      workspaces: [
        {
          workspacePath: "/tmp/zcode-it-workspace",
          label: "zcode-it-workspace",
          kind: "local",
          connectionState: "connected",
        },
      ],
      tasks: [],
      desktopWindowState: "open",
      recentProjects: [{ id: "it-recent-1", label: "recent-project", location: "/tmp" }],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 清理                                                                       */
/* -------------------------------------------------------------------------- */

const cleanupTasks: Array<() => Promise<void> | void> = [];
const issuedCredentials: IssuedCredential[] = [];
const issuedBackendIds = new Set<string>();

function registerCredential(credential: IssuedCredential): void {
  issuedCredentials.push(credential);
  if (credential.backendId) issuedBackendIds.add(credential.backendId);
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop()!;
    try {
      await task();
    } catch {
      // 清理失败不覆盖断言结果。
    }
  }
  for (const credential of issuedCredentials.splice(0)) {
    await revokeCredential(credential);
  }
  for (const backendId of issuedBackendIds) {
    await deleteBackendIdentity(backendId);
  }
  issuedBackendIds.clear();
});

interface IntegrationContext {
  desktop: DesktopHarness;
  phone: PhoneHarness;
  phoneCredential: IssuedCredential;
  backendCredential: IssuedCredential;
  backendId: string;
}

async function createIntegrationContext(input: {
  clientInstanceId?: string;
  desktopRawHandler?: (payload: unknown) => boolean;
  phoneRawHandler?: (payload: unknown) => boolean;
}): Promise<IntegrationContext> {
  const unique = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const backendCredential = await issueCredential("backend", `it-backend-${unique}`);
  const phoneCredential = await issueCredential("device", `it-device-${unique}`);
  registerCredential(backendCredential);
  registerCredential(phoneCredential);
  if (!backendCredential.backendId) {
    throw new Error("backend 凭证没有返回 backendId，无法定位 registry 条目");
  }

  const desktop = createDesktopHarness({
    credential: backendCredential.token,
    onRawTransportPayload: input.desktopRawHandler,
  });
  const phone = createPhoneHarness({
    credential: phoneCredential.token,
    backendId: backendCredential.backendId,
    clientInstanceId: input.clientInstanceId ?? `it-phone-${unique}`,
    onRawTransportPayload: input.phoneRawHandler,
  });
  cleanupTasks.push(async () => {
    phone.dispose();
    await desktop.dispose();
  });

  await desktop.waitOnline();
  phone.transport.start();
  return {
    desktop,
    phone,
    phoneCredential,
    backendCredential,
    backendId: backendCredential.backendId,
  };
}

/* -------------------------------------------------------------------------- */
/* 测试                                                                       */
/* -------------------------------------------------------------------------- */

const describeIntegration = skipReason ? describe.skip : describe;
// 不把 gateway 地址写进测试名：CI 日志里可能是不应外发的内部地址。
const integrationName = skipReason
  ? `真实 gateway 集成（T3.5 跳过：${skipReason}）`
  : "真实 gateway 集成（T3.5）";

describeIntegration(integrationName, () => {
  it("bootstrap：真实 SDK 完成 hello/hello_ack 协商并往返 bootstrap payload", async () => {
    const context = await createIntegrationContext({});
    const { desktop, phone } = context;
    await phone.waitReady();

    expect(phone.transport).toBeInstanceOf(GatewayTerminalTransport);
    expect(phone.version?.appProtocol).toBe(WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION);
    expect(phone.version?.desktopAppVersion).toBe(DESKTOP_APP_VERSION);
    expect(desktop.stateEvents).toContain("paired");

    expect(
      phone.transport.sendPayload({ zcode_type: "bootstrap-request", requestId: "bootstrap-1" }),
    ).toBe(true);
    await desktop.waitPayload(
      "bootstrap-request",
      (payload) => payload.requestId === "bootstrap-1",
    );

    const response = buildBootstrapResponse("bootstrap-1");
    const sendResult = desktop.session.sendPayloadResult(response);
    expect(sendResult.kind).toBe("sent");

    const received = await phone.waitPayload("bootstrap-response");
    expect(received.requestId).toBe("bootstrap-1");
    expect(received.result.workspaces[0]?.workspacePath).toBe("/tmp/zcode-it-workspace");
    expect(received.result.desktopWindowState).toBe("open");
    expect(received.result.recentProjects?.[0]?.id).toBe("it-recent-1");
  });

  it("超过 1 MiB 的逻辑消息按 rpc-frame 切片后经真实 gateway 双向完整送达", async () => {
    const phoneBridgeSessionId = "it-bridge-to-phone";
    const desktopBridgeSessionId = "it-bridge-to-desktop";
    const phoneAssembler = new WebRemoteControlRpcTransportAssembler({
      identity: { bridgeSessionId: phoneBridgeSessionId },
    });
    const desktopAssembler = new WebRemoteControlRpcTransportAssembler({
      identity: { bridgeSessionId: desktopBridgeSessionId },
    });
    const phoneEvents: WebRemoteControlRpcTransportAssemblyEvent[] = [];
    const desktopEvents: WebRemoteControlRpcTransportAssemblyEvent[] = [];
    const context = await createIntegrationContext({
      phoneRawHandler: (payload) => {
        if ((payload as { zcode_type?: string }).zcode_type !== "rpc-frame") return false;
        phoneEvents.push(phoneAssembler.accept(payload));
        return true;
      },
      desktopRawHandler: (payload) => {
        if ((payload as { zcode_type?: string }).zcode_type !== "rpc-frame") return false;
        desktopEvents.push(desktopAssembler.accept(payload));
        return true;
      },
    });
    const { desktop, phone } = context;
    await phone.waitReady();

    // 2.5 MiB 远大于单帧 1 MiB，编码器必须切出多帧。
    const downlink = new Uint8Array(randomBytes(2.5 * 1024 * 1024));
    const downlinkFrames = encodeWebRemoteControlRpcTransportMessage(downlink, {
      bridgeSessionId: phoneBridgeSessionId,
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    expect(downlinkFrames.length).toBeGreaterThan(1);
    for (const frame of downlinkFrames) {
      expect(desktop.session.sendPayloadResult(frame).kind).toBe("sent");
    }

    const uplink = new Uint8Array(randomBytes(2.5 * 1024 * 1024));
    const uplinkFrames = encodeWebRemoteControlRpcTransportMessage(uplink, {
      bridgeSessionId: desktopBridgeSessionId,
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    expect(uplinkFrames.length).toBeGreaterThan(1);
    for (const frame of uplinkFrames) {
      expect(phone.transport.sendPayload(frame)).toBe(true);
    }

    const phoneComplete = await waitFor(
      () => phoneEvents.find((event) => event.kind === "complete"),
      `手机侧重组 2.5 MiB 消息（events=${JSON.stringify(phoneEvents)}）`,
      30_000,
    );
    const desktopComplete = await waitFor(
      () => desktopEvents.find((event) => event.kind === "complete"),
      `桌面侧重组 2.5 MiB 消息（events=${JSON.stringify(desktopEvents)}）`,
      30_000,
    );
    if (phoneComplete.kind !== "complete" || desktopComplete.kind !== "complete") {
      throw new Error("unreachable");
    }
    expect(phoneComplete.bytes.byteLength).toBe(downlink.byteLength);
    expect(Buffer.from(phoneComplete.bytes).equals(Buffer.from(downlink))).toBe(true);
    expect(desktopComplete.bytes.byteLength).toBe(uplink.byteLength);
    expect(Buffer.from(desktopComplete.bytes).equals(Buffer.from(uplink))).toBe(true);
  });

  it("杀掉手机控制连接后重连，未 ACK 的消息经新 channel 重放补齐", async () => {
    const bridgeSessionId = "it-bridge-replay";
    const assembler = new WebRemoteControlRpcTransportAssembler({
      identity: { bridgeSessionId },
    });
    const completed: number[] = [];
    const acks: number[] = [];
    let phone!: PhoneHarness;

    const sendAck = (ackMessageSeq: number): void => {
      expect(
        phone.transport.sendPayload({
          zcode_type: "rpc-frame-ack",
          bridgeSessionId,
          ackMessageSeq,
        }),
      ).toBe(true);
    };

    const context = await createIntegrationContext({
      phoneRawHandler: (payload) => {
        if ((payload as { zcode_type?: string }).zcode_type === "rpc-frame-ack") {
          return false;
        }
        if ((payload as { zcode_type?: string }).zcode_type !== "rpc-frame") return false;
        const event = assembler.accept(payload);
        if (event.kind === "complete") {
          completed.push(event.messageSeq);
          // 消息 1 正常 ACK；消息 2 的 ACK 在断线时丢失，由重放后的 duplicate 事件补发。
          if (event.messageSeq === 1) sendAck(1);
        } else if (event.kind === "duplicate" && event.ackMessageSeq !== null) {
          sendAck(event.ackMessageSeq);
        }
        return true;
      },
      desktopRawHandler: (payload) => {
        if ((payload as { zcode_type?: string }).zcode_type !== "rpc-frame-ack") return false;
        acks.push((payload as { ackMessageSeq: number }).ackMessageSeq);
        return true;
      },
    });
    phone = context.phone;
    const { desktop } = context;
    await phone.waitReady();

    const sendMessage = (messageSeq: number, firstPhysicalSeq: number): void => {
      const frames = encodeWebRemoteControlRpcTransportMessage(
        new Uint8Array(Buffer.from(`message-${messageSeq}`)),
        { bridgeSessionId, firstPhysicalSeq, messageSeq },
      );
      for (const frame of frames) {
        const result = desktop.session.sendPayloadResult(frame);
        expect(result.kind).toBe("sent");
      }
    };

    sendMessage(1, 1);
    await waitFor(() => completed.includes(1), "手机收到消息 1");
    await waitFor(() => acks.includes(1), "桌面收到消息 1 的 ACK");

    // 消息 2：手机已重组，但测试故意不发 ACK，模拟 ACK 在断线时丢失。
    sendMessage(2, 2);
    await waitFor(() => completed.includes(2), "手机收到消息 2");
    expect(acks).not.toContain(2);

    const channelCountBefore = desktop.channelIds.length;
    const controlSocket = phone.controlSockets.at(-1);
    expect(controlSocket).toBeDefined();
    // 关闭真实控制连接：SDK 自动重连，gateway 拆除旧 channel。
    controlSocket!.close(1000, "integration-kill");
    await waitFor(
      () => desktop.channelIds.length > channelCountBefore,
      "手机重连后桌面收到新 channel",
    );
    await waitFor(() => phone.sendReadyCount >= 2, "手机重连后再次 ready");
    await phone.waitReady();

    // 上层在 onSendReady 后重放未 ACK 的消息；assembler 把重复帧识别为 duplicate 并补 ACK。
    sendMessage(2, 2);
    await waitFor(() => acks.includes(2), "桌面收到重放后的消息 2 ACK");

    expect(phone.failures).toEqual([]);
    expect(phone.diagnostics.some((diagnostic) => diagnostic.type === "socket-close")).toBe(true);
  });

  it("两部手机先后接入：后到者取得控制权，先到者进入 session-conflict 且不自动夺回", async () => {
    const context = await createIntegrationContext({ clientInstanceId: "it-phone-a" });
    const { desktop, backendId } = context;
    const phoneA = context.phone;
    await phoneA.waitReady();

    // 第二部手机用另一张设备凭证，覆盖真实的多设备接入（不只是换 clientInstanceId）。
    const secondCredential = await issueCredential(
      "device",
      `it-device-b-${Date.now().toString(36)}`,
    );
    registerCredential(secondCredential);
    const phoneB = createPhoneHarness({
      credential: secondCredential.token,
      backendId,
      clientInstanceId: "it-phone-b",
    });
    cleanupTasks.push(() => phoneB.dispose());

    // 桌面收到 bootstrap-request 就回一份响应，用来证明哪部手机仍处于活跃通道。
    const unsubscribe = desktop.onPayload((payload) => {
      if (payload.zcode_type !== "bootstrap-request") return;
      desktop.session.sendPayloadResult(buildBootstrapResponse(payload.requestId));
    });
    cleanupTasks.push(() => unsubscribe());

    expect(
      phoneA.transport.sendPayload({ zcode_type: "bootstrap-request", requestId: "from-a" }),
    ).toBe(true);
    await phoneA.waitPayload("bootstrap-response", (payload) => payload.requestId === "from-a");

    phoneB.transport.start();
    await phoneB.waitReady();

    const conflict = await waitFor(
      () => phoneA.failures.find((failure) => failure.reason === "session-conflict"),
      "先到手机收到 close{superseded} 并进入 session-conflict",
    );
    expect(conflict.message).toContain("replaced");
    expect(desktop.stateEvents.filter((state) => state === "paired").length).toBeGreaterThanOrEqual(
      2,
    );

    // 后到者仍可用；先到者已锁死，不再自动重开 channel（方案硬性规则）。
    expect(
      phoneB.transport.sendPayload({ zcode_type: "bootstrap-request", requestId: "from-b" }),
    ).toBe(true);
    await phoneB.waitPayload("bootstrap-response", (payload) => payload.requestId === "from-b");
    const channelCountAfterReplace = desktop.channelIds.length;
    await delay(1_200);
    expect(phoneA.failures.filter((failure) => failure.reason === "session-conflict")).toHaveLength(
      1,
    );
    expect(desktop.channelIds.length).toBe(channelCountAfterReplace);
    expect(phoneB.failures).toEqual([]);
  });

  it("桌面控制连接短抖后立即重连：手机观察到 epoch_changed 并自动恢复", async () => {
    const context = await createIntegrationContext({});
    const { desktop, phone } = context;
    await phone.waitReady();

    const initialChannelCount = desktop.channelIds.length;
    const backendSocket = desktop.controlledSockets.at(-1);
    expect(backendSocket).toBeDefined();
    // 只让 SDK 认为断线，底层 TCP 保持打开；gateway 在新连接握手时才判定 epoch 换代。
    backendSocket!.simulateDrop();

    const epochClose = await waitFor(
      () =>
        phone.diagnostics.find(
          (diagnostic) =>
            diagnostic.type === "socket-close" &&
            diagnostic.channel === "data" &&
            diagnostic.reason === "epoch_changed",
        ),
      "手机数据 socket 收到 close(1000, epoch_changed)",
      15_000,
    );
    expect(epochClose.type).toBe("socket-close");

    await waitFor(
      () => desktop.channelIds.length > initialChannelCount,
      "桌面 backend 重连后手机重新打开 channel",
    );
    await phone.waitReady();
    expect(desktop.backend.getStatus()).toMatchObject({ state: "online" });
    expect(phone.failures).toEqual([]);

    // 恢复后业务帧仍可往返。
    expect(
      phone.transport.sendPayload({ zcode_type: "bootstrap-request", requestId: "after-epoch" }),
    ).toBe(true);
    await desktop.waitPayload(
      "bootstrap-request",
      (payload) => payload.requestId === "after-epoch",
    );
  });

  const restartTestName = restartCommand
    ? "gateway 重启后两端自动重连并恢复业务"
    : "gateway 重启后两端自动重连并恢复业务（跳过：未设置 ZCODE_GATEWAY_IT_RESTART_COMMAND）";
  (restartCommand ? it : it.skip)(
    restartTestName,
    async () => {
      const context = await createIntegrationContext({});
      const { desktop, phone } = context;
      await phone.waitReady();
      const initialReadyCount = phone.sendReadyCount;
      const initialChannelCount = desktop.channelIds.length;

      // Windows 没有 sh；重启命令由调用方提供，按平台选择执行壳。
      const shell = process.platform === "win32" ? "cmd.exe" : "sh";
      const shellFlag = process.platform === "win32" ? "/c" : "-c";
      await execFileAsync(shell, [shellFlag, restartCommand!], { timeout: 60_000 });
      await waitFor(isGatewayHealthy, "gateway 重启后 /health 恢复", 30_000);

      // 先看到断开，再看到重新 ready，避免把重启前的状态误判为恢复。
      await waitFor(
        () =>
          phone.states.slice(-1)[0] !== "ready" || desktop.backend.getStatus().state !== "online",
        "重启期间两端观察到断开",
        15_000,
      );
      await waitFor(
        () => desktop.backend.getStatus().state === "online",
        "桌面 backend 在 gateway 重启后重新 online",
        30_000,
      );
      await waitFor(
        () => phone.sendReadyCount > initialReadyCount,
        "手机在 gateway 重启后重新 ready",
        30_000,
      );
      await waitFor(
        () => desktop.channelIds.length > initialChannelCount,
        "手机在 gateway 重启后重新打开 channel",
        30_000,
      );
      await phone.waitReady();

      expect(
        phone.transport.sendPayload({
          zcode_type: "bootstrap-request",
          requestId: "after-restart",
        }),
      ).toBe(true);
      await desktop.waitPayload(
        "bootstrap-request",
        (payload) => payload.requestId === "after-restart",
      );
    },
    60_000,
  );

  it("吊销设备凭证：手机经 discoverBackends 复核确认 401 后进入 gateway-credential-invalid", async () => {
    const context = await createIntegrationContext({});
    const { desktop, phone, phoneCredential } = context;
    await phone.waitReady();
    const channelCountBefore = desktop.channelIds.length;

    // DELETE 会立即吊销并断开在线 peer（gateway close 1008）。
    await adminRequest(`/api/admin/credentials/${encodeURIComponent(phoneCredential.id)}`, {
      method: "DELETE",
    });

    const failure = await waitFor(
      () => phone.failures.find((item) => item.reason === "gateway-credential-invalid"),
      "手机确认凭证被吊销并进入终态",
      15_000,
    );
    expect(failure.reason).toBe("gateway-credential-invalid");
    expect(
      phone.diagnostics.some(
        (diagnostic) =>
          diagnostic.type === "credential-reverify" && diagnostic.outcome === "unauthorized",
      ),
    ).toBe(true);

    // 终态后 SDK 的静默重连必须停止，不能继续顶 channel。
    await delay(1_000);
    expect(desktop.channelIds.length).toBe(channelCountBefore);
  });
});
