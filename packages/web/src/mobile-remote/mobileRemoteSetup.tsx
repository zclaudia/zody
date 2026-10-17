import {
  ZCodeIntlProvider,
  WebRemoteControlMobileBackendPicker,
  WebRemoteControlMobileSettingsScreen,
  type WebRemoteControlMobileSettingsDraft,
} from "@zcode/ui";
import {
  startMobileRemoteBackendDiscovery,
  type MobileRemoteBackendDiscoverySnapshot,
} from "./mobileRemoteBackendDiscovery.js";
import {
  MobileRemoteConfigStore,
  validateMobileRemoteGatewayConfig,
  type MobileRemoteGatewayConfig,
} from "./mobileRemoteConfigStore.js";
import { resolveWebRemoteControlGatewayBootstrapConfig } from "./gatewayBootstrapConfig.js";
import { webEntryRoot } from "../webEntryRoot.js";

/**
 * 手机首次使用流程：设置页 → 选电脑页（T4.2）。
 *
 * 页面渲染在手机入口自己的 React 根上，和 Root 共用 `ZCodeIntlProvider`。
 * 配置的唯一写入方是 `MobileRemoteConfigStore`（经 `IPlatformService.secureStore`）；
 * 本模块只负责在「没有配置」「没有选电脑」「用户主动重开设置」三种情况下把用户带回对应页面。
 */

export interface ResolveMobileRemoteConnectionOptions {
  store: MobileRemoteConfigStore;
  allowUrlConfig: boolean;
  allowInsecureTransport: boolean;
  /** 注入点：单测用 fake discovery，不启动真实 gateway 连接。 */
  createBackendDiscovery?: typeof startMobileRemoteBackendDiscovery;
}

export type MobileRemoteSetupMode = "auto" | "settings" | "backend";

export type MobileRemoteConnectionConfig = MobileRemoteGatewayConfig & { backendId: string };

export interface ResolveMobileRemoteConnectionEntry {
  mode?: MobileRemoteSetupMode;
  initialConfig?: MobileRemoteGatewayConfig | null;
  /** auto 模式下是否重新解析 URL 参数（首次进入 true；重开设置 false）。 */
  readUrlConfig?: boolean;
}

function renderSettingsPage(
  initial: MobileRemoteGatewayConfig | null,
  options: ResolveMobileRemoteConnectionOptions,
): Promise<MobileRemoteGatewayConfig> {
  return new Promise((resolve) => {
    const initialGatewayUrl = initial?.gatewayUrl?.trim();
    const initialNamespace = initial?.namespace;
    webEntryRoot.render(
      <ZCodeIntlProvider>
        <WebRemoteControlMobileSettingsScreen
          initial={{
            ...(initial?.gatewayUrl ? { gatewayUrl: initial.gatewayUrl } : {}),
            ...(initial?.namespace ? { namespace: initial.namespace } : {}),
            credentialConfigured: Boolean(initial?.credential),
          }}
          allowInsecureTransport={options.allowInsecureTransport}
          onSubmit={async (draft: WebRemoteControlMobileSettingsDraft) => {
            // 换 gateway/namespace 或重新输入凭证后，原来选中的电脑可能已不在范围内；
            // 保留 backendId 只在「仅修改无关字段」时成立，避免带错误目标去建连。
            const scopeChanged =
              Boolean(draft.credential) ||
              draft.gatewayUrl.trim().replace(/\/+$/, "") !==
                (initialGatewayUrl ?? "").replace(/\/+$/, "") ||
              (draft.namespace.trim() || "zcode") !== (initialNamespace ?? "zcode");
            const next = validateMobileRemoteGatewayConfig(
              {
                gatewayUrl: draft.gatewayUrl,
                namespace: draft.namespace,
                credential: draft.credential || initial?.credential,
                ...(scopeChanged ? {} : initial?.backendId ? { backendId: initial.backendId } : {}),
              },
              { allowInsecureTransport: options.allowInsecureTransport },
            );
            await options.store.save(next);
            resolve(next);
          }}
        />
      </ZCodeIntlProvider>,
    );
  });
}

function renderBackendPicker(
  initial: MobileRemoteGatewayConfig,
  options: ResolveMobileRemoteConnectionOptions,
): Promise<{ kind: "selected"; backendId: string } | { kind: "settings" }> {
  const createDiscovery = options.createBackendDiscovery ?? startMobileRemoteBackendDiscovery;
  return new Promise((resolve) => {
    let disposed = false;
    let stopDiscovery: (() => void) | undefined;

    const finish = (result: { kind: "selected"; backendId: string } | { kind: "settings" }) => {
      if (disposed) {
        return;
      }
      disposed = true;
      stopDiscovery?.();
      stopDiscovery = undefined;
      resolve(result);
    };

    const render = (snapshot: MobileRemoteBackendDiscoverySnapshot) => {
      if (disposed) {
        return;
      }
      webEntryRoot.render(
        <ZCodeIntlProvider>
          <WebRemoteControlMobileBackendPicker
            backends={snapshot.backends}
            loading={snapshot.loading}
            {...(snapshot.failure ? { failure: snapshot.failure } : {})}
            {...(initial.backendId ? { selectedBackendId: initial.backendId } : {})}
            onRefresh={() => {
              if (disposed) {
                return;
              }
              stopDiscovery?.();
              stopDiscovery = createDiscovery({
                gatewayUrl: initial.gatewayUrl,
                namespace: initial.namespace,
                credential: initial.credential,
                onUpdate: render,
              });
            }}
            onSelect={async (backendId) => {
              await options.store.save({ ...initial, backendId });
              finish({ kind: "selected", backendId });
            }}
            onBackToSettings={() => finish({ kind: "settings" })}
          />
        </ZCodeIntlProvider>,
      );
    };

    render({ loading: true, backends: [] });
    stopDiscovery = createDiscovery({
      gatewayUrl: initial.gatewayUrl,
      namespace: initial.namespace,
      credential: initial.credential,
      onUpdate: render,
    });
  });
}

async function readInitialConfig(
  params: URLSearchParams | null,
  options: ResolveMobileRemoteConnectionOptions,
  entry: ResolveMobileRemoteConnectionEntry,
): Promise<MobileRemoteGatewayConfig | null> {
  if (entry.initialConfig !== undefined) {
    return entry.initialConfig;
  }
  if (
    options.allowUrlConfig &&
    entry.readUrlConfig !== false &&
    params &&
    (entry.mode ?? "auto") === "auto"
  ) {
    const fromUrl = resolveWebRemoteControlGatewayBootstrapConfig(params);
    if (fromUrl) {
      try {
        const normalized = validateMobileRemoteGatewayConfig(fromUrl, {
          allowInsecureTransport: options.allowInsecureTransport,
        });
        // 开发模式的 URL 覆盖同样写入存储，刷新后不必重新拼参数；
        // release 构建不会走到这里（allowUrlConfig=false）。
        await options.store.save(normalized);
        return normalized;
      } catch {
        // URL 参数不合法时回到设置页，而不是带着坏配置建连。
      }
    }
  }
  return options.store.load();
}

/**
 * 解析出可建连的配置：必要时先渲染设置页/选电脑页，直到拿到 `backendId`。
 * 返回 null 只在页面被卸载等无法继续的情况下出现。
 */
export async function resolveMobileRemoteConnection(
  params: URLSearchParams | null,
  options: ResolveMobileRemoteConnectionOptions,
  entry: ResolveMobileRemoteConnectionEntry = {},
): Promise<MobileRemoteConnectionConfig | null> {
  let mode: MobileRemoteSetupMode = entry.mode ?? "auto";
  let config = await readInitialConfig(params, options, entry);
  let forcePicker = mode === "backend";

  // 设置页和选电脑页之间可以来回切换；两个页面都不会自行结束流程。
  for (let guard = 0; guard < 10; guard += 1) {
    if (mode === "settings" || !config) {
      config = await renderSettingsPage(config, options);
      mode = "auto";
    }
    if (forcePicker || !config.backendId) {
      forcePicker = false;
      const selection = await renderBackendPicker(config, options);
      if (selection.kind === "settings") {
        mode = "settings";
        continue;
      }
      config = { ...config, backendId: selection.backendId };
    }
    if (config.backendId) {
      return config as MobileRemoteConnectionConfig;
    }
  }
  return null;
}
