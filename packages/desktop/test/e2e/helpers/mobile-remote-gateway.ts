import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewayClient, type GatewayChannel } from "@zclaudia/gateway-client";

/**
 * T4.1 桌面 E2E 的真实 gateway 环境读取。
 *
 * 优先使用测试进程环境变量；本地 `pnpm dev:gateway` 会把地址和凭证写到仓库根目录的
 * `.env.gateway.local`。这里只把配置读进内存，不打印任何凭证。
 */
export interface GatewayE2EConfig {
  gatewayUrl: string;
  namespace: string;
  backendCredential: string;
  deviceCredential: string;
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function readGatewayEnvFile(): Promise<Record<string, string>> {
  const candidates = [
    process.env.ZCODE_GATEWAY_ENV_FILE?.trim(),
    join(process.cwd(), ".env.gateway.local"),
    join(process.cwd(), "../../.env.gateway.local"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return parseEnvFile(await readFile(candidate, "utf8"));
    } catch {
      // 没配置本地 gateway 时继续尝试下一个路径；E2E 会跳过相关用例。
    }
  }
  return {};
}

export async function resolveGatewayE2EConfig(): Promise<GatewayE2EConfig | null> {
  const fileValues = await readGatewayEnvFile();
  const read = (key: string) => process.env[key]?.trim() || fileValues[key]?.trim() || "";
  const gatewayUrl = read("ZCODE_GATEWAY_IT_URL");
  const backendCredential = read("ZCODE_GATEWAY_BACKEND_CREDENTIAL");
  const deviceCredential = read("ZCODE_GATEWAY_DEVICE_CREDENTIAL");
  if (!gatewayUrl || !backendCredential || !deviceCredential) {
    return null;
  }
  return {
    gatewayUrl,
    namespace: read("ZCODE_GATEWAY_NAMESPACE") || "zcode",
    backendCredential,
    deviceCredential,
  };
}

interface ChannelFrame {
  type?: string;
  [key: string]: unknown;
}

async function waitForOnlineBackend(
  client: GatewayClient,
  timeoutMs = 15_000,
): Promise<{ backendId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const backends = await client.discoverBackends();
    const online = backends.find((candidate) => candidate.online);
    if (online) {
      return online;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Gateway has no online backend for the E2E device credential");
}

export interface FakePhoneSession {
  /** 发送一帧应用层 payload（自动包成 data 帧）。 */
  sendPayload(payload: unknown): void;
  /** 等待满足条件的应用层 payload；超时抛出便于 E2E 定位。 */
  waitForPayload(
    predicate: (payload: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * 用 Node 侧的 gateway-client SDK 模拟手机 channel。
 *
 * 这里只实现 E2E 需要的最小帧协议：hello/hello_ack、data、ping/pong。完整的手机行为
 * （重放、恢复、bootstrap 状态机）由 T3.4 的 GatewayTerminalTransport 覆盖。
 */
export async function connectFakePhone(
  config: GatewayE2EConfig,
  options: { clientInstanceId: string; clientName?: string; appVersion?: string },
): Promise<FakePhoneSession> {
  const client = new GatewayClient({
    url: config.gatewayUrl,
    credential: config.deviceCredential,
    namespace: config.namespace,
    reconnect: false,
  });
  // backendId 是 gateway 在 backend 首次注册时分配的，不等于签发凭证的 credential id；
  // 这里用设备凭证的 discovery 结果解析当前在线 backend，避免把环境变量里的 id 猜错。
  const backend = await waitForOnlineBackend(client);
  await client.connect();
  const channel: GatewayChannel = await client.openChannel(backend.backendId, "zcode-remote");

  const payloadWaiters = new Set<{
    predicate: (payload: Record<string, unknown>) => boolean;
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const handleFrame = (frame: ChannelFrame) => {
    if (frame.type === "ping" && typeof frame.id === "string") {
      channel.send(JSON.stringify({ type: "pong", id: frame.id }));
      return;
    }
    if (frame.type !== "data" || typeof frame.payload !== "object" || frame.payload === null) {
      return;
    }
    const payload = frame.payload as Record<string, unknown>;
    for (const waiter of Array.from(payloadWaiters)) {
      if (!waiter.predicate(payload)) {
        continue;
      }
      clearTimeout(waiter.timer);
      payloadWaiters.delete(waiter);
      waiter.resolve(payload);
    }
  };

  channel.onMessage((message) => {
    if (message.binary) {
      return;
    }
    let frame: ChannelFrame;
    try {
      frame = JSON.parse(String(message.data)) as ChannelFrame;
    } catch {
      return;
    }
    handleFrame(frame);
  });

  channel.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      appProtocol: { min: 1, max: 2 },
      clientInstanceId: options.clientInstanceId,
      clientName: options.clientName ?? "ZCode E2E phone",
      appVersion: options.appVersion ?? "1.0.0",
    }),
  );

  return {
    sendPayload(payload: unknown) {
      channel.send(JSON.stringify({ type: "data", payload }));
    },
    waitForPayload(predicate, timeoutMs = 20_000) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            payloadWaiters.delete(waiter);
            reject(new Error("Timed out waiting for a mobile payload frame"));
          }, timeoutMs),
        };
        payloadWaiters.add(waiter);
      });
    },
    close() {
      for (const waiter of payloadWaiters) {
        clearTimeout(waiter.timer);
      }
      payloadWaiters.clear();
      channel.close();
      client.close();
    },
  };
}
