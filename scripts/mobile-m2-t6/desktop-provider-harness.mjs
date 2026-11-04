#!/usr/bin/env node
/**
 * M2-T6 桌面 provider harness。
 *
 * 使用真实 `RemoteGatewayBackend` + `MobileUiAssetProvider` 连接本地 Gateway；仅用最小协议
 * 响应器实现 `zcode-remote` 的 hello/bootstrap（workspaces 为空），用于验证 Android WebView
 * 的 Shell/Remote 双源链路。不会打印任何凭证。
 *
 * 环境：
 *   node --import tsx --env-file=.env.gateway.local scripts/mobile-m2-t6/desktop-provider-harness.mjs
 *   ZODY_E2E_NAMESPACE=zcode
 *   ZODY_E2E_PUBLIC_GATEWAY_URL=http://10.0.2.2:3200   # 模拟器可见地址，用于 CSP
 *   ZODY_E2E_CONTROL_PORT=39555
 *   ZODY_E2E_MODE=new|old                              # old 不注册 mobileUiHandler
 *
 * 控制端点（仅 127.0.0.1）：
 *   GET /status
 *   GET /mode?value=new|old
 *   GET /offline
 *   GET /delay?ms=<n>
 *   GET /quit
 *
 * M3-T5 扩展（不改变 M2-T6 默认行为）：
 *   GET /root?value=<absolute dir>    只替换 Remote 制品根目录，不重建 Gateway backend，
 *                                     保持 backendId/session 不变，用于 release A→B→A。
 *   GET /release-status?value=<http>  对 /mobile-ui/release 强制返回 429/5xx（0 关闭）。
 *   GET /workspaces?value=none|disconnected
 *                                     控制 bootstrap 返回的 workspace 列表。
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "../..");
const { createMobileUiAssetProvider } = await import(
  `${repoRoot}/packages/desktop/src/main/remote-access/mobileUiAssetProvider.ts`
);
const { createRemoteGatewayBackend } = await import(
  `${repoRoot}/packages/desktop/src/main/remote-access/remoteGatewayBackend.ts`
);

const gatewayUrl = process.env.ZCODE_GATEWAY_IT_URL?.replace(/\/+$/u, "");
const credential = process.env.ZCODE_GATEWAY_BACKEND_CREDENTIAL;
const namespace = process.env.ZODY_E2E_NAMESPACE || process.env.ZCODE_GATEWAY_NAMESPACE || "zody";
const controlPort = Number(process.env.ZODY_E2E_CONTROL_PORT || 39555);
const publicGatewayUrl = (process.env.ZODY_E2E_PUBLIC_GATEWAY_URL || gatewayUrl)?.replace(
  /\/+$/u,
  "",
);
let remoteRoot = resolve(
  process.env.ZODY_E2E_REMOTE_ROOT || `${repoRoot}/packages/web/dist-mobile-remote`,
);
let remoteProvider = null;
let releaseFailureStatus = 0;
let workspaceMode = process.env.ZODY_E2E_WORKSPACES === "disconnected" ? "disconnected" : "none";
let activeChannelCount = 0;
let totalChannelCount = 0;
let releaseFetchCount = 0;
let lastReleaseFetchAt = null;
const releaseFetchTimes = [];
if (!gatewayUrl || !credential || !publicGatewayUrl) {
  console.error("[provider] missing gateway environment");
  process.exit(1);
}

const logger = {
  debug: () => {},
  info: (...args) => console.error("[provider:info]", ...args),
  warn: (...args) => console.error("[provider:warn]", ...args),
  error: (...args) => console.error("[provider:error]", ...args),
};

let mode = process.env.ZODY_E2E_MODE === "old" ? "old" : "new";
let bootstrapDelayMs = 0;
let backend = null;
let backendId = null;
let state = "idle";
let channelCount = 0;
let lastHello = null;
let httpProxyPaths = [];

function send(channel, frame) {
  if (channel.isOpen !== false) channel.send(JSON.stringify(frame));
}

function bootstrapWorkspaces() {
  if (workspaceMode === "disconnected") {
    // 关键：没有 remoteSessionId 的 remote workspace 让页面进入 home-only Root，
    // 从而挂载 composer/settings 等真实 UI 状态；不触发 workspace bridge 协议。
    return [
      {
        kind: "remote",
        workspacePath: "/e2e/disconnected-workspace",
        label: "Disconnected E2E Workspace",
        connectionState: "disconnected",
      },
    ];
  }
  return [];
}

function handleChannel(channel) {
  channelCount += 1;
  totalChannelCount += 1;
  activeChannelCount += 1;
  console.error("[provider] channel open", channel.channelId, channel.kind);
  channel.onMessage((message) => {
    if (message.binary) return;
    let frame;
    try {
      frame = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (frame.type === "ping") {
      send(channel, { type: "pong", id: frame.id });
      return;
    }
    if (frame.type === "hello") {
      lastHello = {
        protocolVersion: frame.protocolVersion,
        appProtocol: frame.appProtocol,
        clientName: frame.clientName,
        appVersion: frame.appVersion,
      };
      console.error("[provider] hello", JSON.stringify(frame.appProtocol));
      send(channel, {
        type: "hello_ack",
        appProtocol: 4,
        desktopAppVersion: "0.1.0-e2e",
      });
      return;
    }
    if (frame.type !== "data" || !frame.payload || typeof frame.payload !== "object") return;
    const payload = frame.payload;
    if (payload.zcode_type === "workspace-list-request") {
      // home-only Root 在渲染前调用 listWorkspaces；不响应会让 M3 guard 场景一直等超时。
      send(channel, {
        type: "data",
        payload: {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: {
            workspaces: bootstrapWorkspaces(),
            tasks: [],
          },
        },
      });
      return;
    }
    if (payload.zcode_type !== "bootstrap-request") return;
    const respond = () => {
      send(channel, {
        type: "data",
        payload: {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: {
            windowControlSessionId: "m2-t6-e2e-window",
            desktopAppVersion: "0.1.0-e2e",
            mobileCapabilities: {},
            workspaces: bootstrapWorkspaces(),
            tasks: [],
            desktopWindowState: "open",
            recentProjects: [],
          },
        },
      });
    };
    if (bootstrapDelayMs > 0) setTimeout(respond, bootstrapDelayMs);
    else respond();
  });
  channel.onClose(() => {
    activeChannelCount = Math.max(0, activeChannelCount - 1);
    console.error("[provider] channel closed", channel.channelId);
  });
}

function createRemoteProvider() {
  remoteProvider = createMobileUiAssetProvider({
    rootDir: remoteRoot,
    resolveSecurityContext: () => ({
      gatewayHttpOrigin: new URL(publicGatewayUrl).origin,
      gatewayWsOrigin: new URL(publicGatewayUrl).origin.replace(/^http/u, "ws"),
    }),
  });
}

async function stopBackend() {
  if (!backend) return;
  try {
    await backend.dispose();
  } catch (error) {
    console.error("[provider] dispose failed", error);
  }
  backend = null;
  state = "disabled";
}

async function startBackend(nextMode) {
  await stopBackend();
  mode = nextMode;
  createRemoteProvider();
  const mobileUiHandler =
    mode === "new"
      ? async (request) => {
          httpProxyPaths.push(request.path);
          if (request.path === "/mobile-ui/release") {
            releaseFetchCount += 1;
            lastReleaseFetchAt = Date.now();
            releaseFetchTimes.push(lastReleaseFetchAt);
            if (releaseFailureStatus !== 0) {
              return {
                status: releaseFailureStatus,
                headers: { "cache-control": "no-store", "content-type": "application/json" },
              };
            }
          }
          return remoteProvider(request);
        }
      : undefined;
  backend = createRemoteGatewayBackend({
    loadConfig: async () => ({ enabled: true, gatewayUrl, namespace, credential }),
    logger,
    allowInsecureTransport: true,
    mobileUiHandler,
  });
  backend.setChannelHandler(handleChannel);
  backend.onStatusChanged((next) => {
    state = next.state;
    if (next.backendId) backendId = next.backendId;
    console.error("[provider] status", next.state, next.backendId ?? "");
  });
  await backend.reloadConfig();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = backend.getStatus();
    state = current.state;
    if (current.backendId) backendId = current.backendId;
    if (current.state === "online") break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (backend.getStatus().state !== "online") {
    console.error("[provider] failed to reach online:", backend.getStatus().state);
  }
}

const control = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          mode,
          state,
          backendId,
          channelCount,
          activeChannelCount,
          totalChannelCount,
          releaseFailureStatus,
          releaseFetchCount,
          lastReleaseFetchAt,
          releaseFetchTimes: releaseFetchTimes.slice(-20),
          remoteRoot,
          workspaceMode,
          lastHello,
          bootstrapDelayMs,
          httpProxyPaths: httpProxyPaths.slice(-20),
          namespace,
          publicGatewayUrl,
        }),
      );
      return;
    }
    if (url.pathname === "/mode") {
      const nextMode = url.searchParams.get("value");
      if (nextMode !== "new" && nextMode !== "old") {
        response.writeHead(400).end("mode must be new|old");
        return;
      }
      await startBackend(nextMode);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, mode, state }));
      return;
    }
    if (url.pathname === "/root") {
      const nextRoot = url.searchParams.get("value");
      if (!nextRoot) {
        response.writeHead(400).end("root value is required");
        return;
      }
      // 只换制品根目录，不重建 backend：GATEWAY backendId / Host channel 保持原所有者，
      // 这样已在运行的 Remote 页面不需要重新配对即可观察到新 releaseId。
      remoteRoot = resolve(nextRoot);
      createRemoteProvider();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, remoteRoot }));
      return;
    }
    if (url.pathname === "/release-status") {
      const nextStatus = Number(url.searchParams.get("value") || 0);
      if (!Number.isInteger(nextStatus) || nextStatus < 0 || nextStatus > 599) {
        response.writeHead(400).end("status must be 0 or a valid HTTP status");
        return;
      }
      releaseFailureStatus = nextStatus;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, releaseFailureStatus }));
      return;
    }
    if (url.pathname === "/workspaces") {
      const nextMode = url.searchParams.get("value");
      if (nextMode !== "none" && nextMode !== "disconnected") {
        response.writeHead(400).end("workspaces must be none|disconnected");
        return;
      }
      workspaceMode = nextMode;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, workspaceMode }));
      return;
    }
    if (url.pathname === "/offline") {
      await stopBackend();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, state }));
      return;
    }
    if (url.pathname === "/delay") {
      bootstrapDelayMs = Number(url.searchParams.get("ms") || 0);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, bootstrapDelayMs }));
      return;
    }
    if (url.pathname === "/quit") {
      await stopBackend();
      response.writeHead(200).end("ok");
      setTimeout(() => process.exit(0), 100);
      return;
    }
    response.writeHead(404).end("not found");
  } catch (error) {
    console.error("[provider] control error", error);
    response.writeHead(500).end(String(error));
  }
});

await startBackend(mode);
control.listen(controlPort, "127.0.0.1", () => {
  console.error(`[provider] control listening on ${controlPort}`);
});
