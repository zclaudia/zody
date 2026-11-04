import {
  MOBILE_UI_BRIDGE_VERSION,
  resolveMobileShellBridge,
  type MobileBridgeFailure,
  type MobileShellBridge,
  type PlatformSecureStore,
} from "@zcode/shared";
import { resolveWebRemoteControlThemeFromSearchParams } from "../mobile-remote/gatewayBootstrapConfig.js";
import {
  resolveMobileRemoteConnection,
  type ResolveMobileRemoteConnectionOptions,
} from "../mobile-remote/mobileRemoteSetup.js";
import { startMobileRemoteBackendDiscovery } from "../mobile-remote/mobileRemoteBackendDiscovery.js";
import { createMobileRemoteSecureStore } from "../mobile-remote/mobileRemoteSecureStore.js";
import { seedWebRemoteControlThemePreference } from "../webRemoteControlThemeSeed.js";
import {
  renderWebRemoteControlFailure,
  toWebRemoteControlFailure,
} from "../webRemoteControlFailureView.js";
import {
  createDevelopmentMobileShellBridgeInfo,
  createMobileShellConfigClient,
  openMobileShellBackend,
  readMobileShellBridgeInfo,
  resolveMobileShellRuntimeMode,
  type MobileShellConfigClient,
  type MobileShellRuntimeMode,
} from "./mobileShellConfigClient.js";

/**
 * Shell 入口（spec 第 3、7、9.1 节）：只做配对、Gateway 设置、discovery、选电脑、
 * 错误/升级提示和 `openRemote(backendId, expectedConfigRevision)`。
 *
 * Shell 不创建 GatewayTerminalTransport、不加载 Remote 工作台，也不保存 task/session
 * 业务状态。配置写入只经 `MobileShellConfigClient`（生产 = 原生 `ZodyShellBridge`）。
 */

export interface BootstrapMobileShellOptions {
  /** 测试注入；缺省从 `globalThis.ZodyShellBridge` 发现。 */
  bridge?: MobileShellBridge;
  /** 测试注入；缺省按原生桥 + `import.meta.env.PROD` 推导。 */
  mode?: MobileShellRuntimeMode;
  /** 测试注入；缺省创建开发/原生安全存储。 */
  secureStore?: PlatformSecureStore;
  /** 测试注入；避免真实连接 gateway。 */
  createBackendDiscovery?: typeof startMobileRemoteBackendDiscovery;
  /** 测试注入；开发模式 openRemote 的导航目标。 */
  navigate?: (url: string) => void;
  /** 测试注入；缺省 `import.meta.env.PROD`。 */
  isProduction?: boolean;
}

function renderShellFailure(
  reason: Parameters<typeof toWebRemoteControlFailure>[0],
  message: string,
  options: {
    upgrade?: "mobile" | "desktop";
    onRetry?(): void;
    onChooseBackend?(): void;
    onOpenSettings?(): void;
  } = {},
): void {
  const failure = {
    ...toWebRemoteControlFailure(reason, message),
    ...(options.upgrade ? { upgrade: options.upgrade } : {}),
  };
  renderWebRemoteControlFailure(failure, {
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.onChooseBackend ? { onChooseBackend: options.onChooseBackend } : {}),
    ...(options.onOpenSettings ? { onOpenSettings: options.onOpenSettings } : {}),
  });
}

function mapOpenFailureToReason(
  error: MobileBridgeFailure["error"],
): Parameters<typeof toWebRemoteControlFailure>[0] {
  switch (error.code) {
    case "backend-ui-unsupported":
    case "backend-remote-control-unsupported":
    case "backend-not-found":
      return "backend-unsupported";
    case "native-bridge-unavailable":
    case "bridge-version-unsupported":
      return "incompatible-version";
    default:
      return "unexpected-error";
  }
}

export async function bootstrapMobileShell(
  params: URLSearchParams,
  options: BootstrapMobileShellOptions = {},
): Promise<void> {
  seedWebRemoteControlThemePreference(
    resolveWebRemoteControlThemeFromSearchParams(params),
  );

  const isProduction = options.isProduction ?? import.meta.env.PROD;
  const bridge = options.bridge ?? resolveMobileShellBridge();
  const mode = options.mode ?? resolveMobileShellRuntimeMode({ bridge, isProduction });

  if (mode === "unavailable") {
    renderShellFailure(
      "incompatible-version",
      "This app build has no Shell bridge. Reinstall or update the Zody app.",
      { upgrade: "mobile", onRetry: () => globalThis.location.reload() },
    );
    return;
  }

  let bridgeInfo;
  try {
    bridgeInfo =
      mode === "native"
        ? readMobileShellBridgeInfo(bridge as MobileShellBridge)
        : createDevelopmentMobileShellBridgeInfo();
  } catch (error) {
    renderShellFailure(
      "incompatible-version",
      error instanceof Error ? error.message : String(error),
      { upgrade: "mobile", onRetry: () => globalThis.location.reload() },
    );
    return;
  }
  if (bridgeInfo.bridgeVersion !== MOBILE_UI_BRIDGE_VERSION) {
    renderShellFailure(
      "incompatible-version",
      `Unsupported Shell bridge version ${bridgeInfo.bridgeVersion}. Update the Zody app.`,
      { upgrade: "mobile", onRetry: () => globalThis.location.reload() },
    );
    return;
  }

  const allowInsecureTransport = !isProduction || bridgeInfo.allowsInsecureGatewayTransport;
  let client: MobileShellConfigClient;
  try {
    client = createMobileShellConfigClient({
      mode: mode === "native" ? "native" : "development",
      ...(bridge ? { bridge } : {}),
      allowInsecureTransport,
      secureStore: options.secureStore ?? createMobileRemoteSecureStore(),
      ...(options.navigate ? { navigate: options.navigate } : {}),
    });
  } catch (error) {
    renderShellFailure(
      "incompatible-version",
      error instanceof Error ? error.message : String(error),
      { upgrade: "mobile", onRetry: () => globalThis.location.reload() },
    );
    return;
  }

  const setupOptions: ResolveMobileRemoteConnectionOptions = {
    store: client,
    allowUrlConfig: false,
    allowInsecureTransport,
    ...(options.createBackendDiscovery
      ? { createBackendDiscovery: options.createBackendDiscovery }
      : {}),
  };
  const retry = () => {
    void bootstrapMobileShell(params, options);
  };

  // 每次都经过选电脑页：discovery 必须同时确认 zcode-remote-control 与
  // zcode-remote-ui-v1，缺 UI 能力时只停留在 Shell，不发起 openRemote。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let config;
    try {
      config = await resolveMobileRemoteConnection(null, setupOptions, { mode: "backend" });
    } catch (error) {
      renderShellFailure(
        "unexpected-error",
        error instanceof Error ? error.message : String(error),
        { onRetry: retry },
      );
      return;
    }
    if (!config) {
      return;
    }

    let outcome;
    try {
      outcome = await openMobileShellBackend(client, config.backendId);
    } catch (error) {
      renderShellFailure(
        "unexpected-error",
        error instanceof Error ? error.message : String(error),
        { onRetry: retry },
      );
      return;
    }

    if (outcome.kind === "opened") {
      return;
    }
    if (outcome.kind === "stale" && attempt === 0) {
      // 原生配置在读取与 openRemote 之间换代：重新展示选电脑页，不沿用旧 revision。
      continue;
    }
    const reason = mapOpenFailureToReason(outcome.error);
    renderShellFailure(reason, outcome.error.message ?? outcome.error.code, {
      ...(reason === "incompatible-version" ? { upgrade: "mobile" as const } : {}),
      onRetry: retry,
      ...(reason === "backend-unsupported" ? { onChooseBackend: retry } : {}),
    });
    return;
  }

  renderShellFailure(
    "unexpected-error",
    "The shell configuration changed while opening the desktop. Choose the desktop again.",
    { onRetry: retry, onChooseBackend: retry },
  );
}
