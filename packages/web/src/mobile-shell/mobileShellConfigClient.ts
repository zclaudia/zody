/* eslint-disable max-lines -- Shell 配置客户端同时承载 native 与 development 两条实现；拆分需同步公开入口和 focused 测试，超出本次 M2-T2 交接范围。 */
import {
  MOBILE_UI_BRIDGE_SCHEMA_VERSION,
  MOBILE_UI_BRIDGE_VERSION,
  ZODY_VERSION,
  mobileShellBridgeInfoResultSchema,
  mobileShellConfigReadResultSchema,
  mobileShellConfigSaveResultSchema,
  mobileShellDiagnosticsResultSchema,
  mobileShellOperationResultSchema,
  parseMobileShellConfig,
  parseMobileShellConfigWrite,
  type MobileBridgeErrorCode,
  type MobileBridgeFailure,
  type MobileShellBridge,
  type MobileShellBridgeInfo,
  type MobileShellConfig,
  type MobileShellDiagnostics,
  type MobileSessionContext,
  type PlatformSecureStore,
} from "@zody/shared";
import {
  MobileRemoteConfigStore,
  type MobileRemoteGatewayConfig,
} from "../mobile-remote/mobileRemoteConfigStore.js";
import { createMobileRemoteSecureStore } from "../mobile-remote/mobileRemoteSecureStore.js";
import {
  allocateDevelopmentClientInstanceId,
  clearDevelopmentRemoteHandoff,
  type MobileRemoteDevelopmentStorage,
  writeDevelopmentRemoteHandoff,
} from "../mobile-remote/mobileRemoteDevelopmentHandoff.js";

/**
 * Shell 连接配置客户端（M2-T1）。
 *
 * 生产路径唯一：Android `ZodyShellBridge` 持有并写入配置，本客户端只做严格 JSON/schema
 * 校验和 `configRevision` 透传。`clientInstanceId` 不在 Shell 生成或读取，它由原生配置
 * store 按 backendId 持久化，仅通过 Remote 的只读 session context 交给页面（M2-T2）。
 *
 * 开发路径（`pnpm dev:mobile-remote` 或普通浏览器）没有原生桥，允许降级到现有
 * `createMobileRemoteSecureStore`（仅开发构建会落到 localStorage）。`openRemote` 在开发
 * 模式写入一次性 handoff（含按 backendId 持久化的 clientInstanceId），Remote 开发桥再把
 * 它模拟成 `getSessionContext()`；URL 不再携带凭证。release 构建缺少 `ZodyShellBridge`
 * 时不会创建降级客户端，由入口直接 fail closed。
 */

export const MOBILE_SHELL_DEVELOPMENT_CONFIG_REVISION_KEY = "mobile-shell-config-revision";

/** 原生 bridge 的稳定错误；调用方按 code 分支，不解析 message。 */
export class MobileShellBridgeError extends Error {
  readonly code: MobileBridgeErrorCode;

  constructor(code: MobileBridgeErrorCode, message?: string) {
    super(message ?? code);
    this.name = "MobileShellBridgeError";
    this.code = code;
  }
}

export type MobileShellOpenOutcome =
  | { kind: "opened" }
  | { kind: "stale"; error: MobileBridgeFailure["error"] }
  | { kind: "failed"; error: MobileBridgeFailure["error"] };

export type MobileShellRuntimeMode = "native" | "development" | "unavailable";

/** 原生桥优先；生产构建缺少桥时不可用（fail closed），只有开发构建允许降级。 */
export function resolveMobileShellRuntimeMode(input: {
  bridge?: MobileShellBridge;
  isProduction: boolean;
}): MobileShellRuntimeMode {
  if (input.bridge) {
    return "native";
  }
  return input.isProduction ? "unavailable" : "development";
}

export interface MobileShellConfigClient {
  readonly mode: "native" | "development";
  /** 完整持久配置（含 configRevision），供 openRemote 前再次确认。 */
  read(): Promise<MobileShellConfig | null>;
  /** 首次配置/选电脑流程使用的只读视图；不含 configRevision。 */
  load(): Promise<MobileRemoteGatewayConfig | null>;
  /** 写入配置并返回原生递增后的 configRevision。 */
  save(config: MobileRemoteGatewayConfig): Promise<MobileShellConfig>;
  clear(): Promise<void>;
  openRemote(backendId: string, expectedConfigRevision: number): Promise<MobileShellOpenOutcome>;
  getInfo(): Promise<MobileShellBridgeInfo>;
  getDiagnostics(): Promise<MobileShellDiagnostics>;
}

interface SafeParseSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

function parseBridgeJsonOrThrow<T>(
  json: string,
  schema: SafeParseSchema<T>,
  code: MobileBridgeErrorCode,
): T {
  if (typeof json !== "string") {
    throw new MobileShellBridgeError(code, "Mobile bridge JSON must be a string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new MobileShellBridgeError(
      code,
      `Invalid mobile bridge JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new MobileShellBridgeError(code, `Invalid mobile bridge JSON: ${result.error.message}`);
  }
  return result.data;
}

function toGatewayConfig(config: MobileShellConfig): MobileRemoteGatewayConfig {
  return {
    gatewayUrl: config.gatewayUrl,
    namespace: config.namespace,
    credential: config.credential,
    ...(config.backendId ? { backendId: config.backendId } : {}),
  };
}

function failure(id: MobileBridgeErrorCode, message: string): MobileShellOpenOutcome {
  return { kind: "failed", error: { code: id, message } };
}

/** 读取并严格校验 Shell bridge 构建信息；bridge 不可读取时抛出稳定错误。 */
export function readMobileShellBridgeInfo(bridge: MobileShellBridge): MobileShellBridgeInfo {
  const result = parseBridgeJsonOrThrow(
    bridge.getBridgeInfo(),
    mobileShellBridgeInfoResultSchema,
    "native-bridge-unavailable",
  );
  if (!result.ok) {
    throw new MobileShellBridgeError(result.error.code, result.error.message);
  }
  return result.info;
}

/** 开发模式的固定 bridge 信息：没有原生壳，允许本地 http gateway。 */
export function createDevelopmentMobileShellBridgeInfo(): MobileShellBridgeInfo {
  return {
    schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
    bridgeVersion: MOBILE_UI_BRIDGE_VERSION,
    appVersion: ZODY_VERSION,
    allowsInsecureGatewayTransport: true,
  };
}

function createNativeMobileShellConfigClient(
  bridge: MobileShellBridge,
  allowInsecureTransport: boolean,
): MobileShellConfigClient {
  const validation = { allowInsecureTransport };
  let configRevision: number | undefined;

  const readConfig = async (): Promise<MobileShellConfig | null> => {
    const result = parseBridgeJsonOrThrow(
      bridge.readConfig(),
      mobileShellConfigReadResultSchema,
      "config-invalid",
    );
    if (!result.ok) {
      throw new MobileShellBridgeError(result.error.code, result.error.message);
    }
    if (!result.config) {
      configRevision = undefined;
      return null;
    }
    const config = parseMobileShellConfig(result.config, validation);
    if (!config) {
      throw new MobileShellBridgeError(
        "config-invalid",
        "Native shell config is invalid or uses insecure transport.",
      );
    }
    configRevision = config.configRevision;
    return config;
  };

  return {
    mode: "native",
    read: readConfig,
    async load() {
      const config = await readConfig();
      return config ? toGatewayConfig(config) : null;
    },
    async save(input) {
      const write = parseMobileShellConfigWrite(input, validation);
      if (!write) {
        throw new MobileShellBridgeError("invalid-argument", "Invalid shell config draft.");
      }
      const result = parseBridgeJsonOrThrow(
        bridge.saveConfig(JSON.stringify(write)),
        mobileShellConfigSaveResultSchema,
        "config-write-failed",
      );
      if (!result.ok) {
        throw new MobileShellBridgeError(result.error.code, result.error.message);
      }
      const config = parseMobileShellConfig(result.config, validation);
      if (!config) {
        throw new MobileShellBridgeError(
          "config-invalid",
          "Native shell config is invalid or uses insecure transport.",
        );
      }
      configRevision = config.configRevision;
      return config;
    },
    async clear() {
      const result = parseBridgeJsonOrThrow(
        bridge.clearConfig(),
        mobileShellOperationResultSchema,
        "config-write-failed",
      );
      if (!result.ok) {
        throw new MobileShellBridgeError(result.error.code, result.error.message);
      }
      configRevision = undefined;
    },
    async openRemote(backendId, expectedConfigRevision) {
      let result;
      try {
        result = parseBridgeJsonOrThrow(
          bridge.openRemote(backendId, expectedConfigRevision),
          mobileShellOperationResultSchema,
          "open-remote-failed",
        );
      } catch (error) {
        return failure(
          "open-remote-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (result.ok) {
        return { kind: "opened" };
      }
      return result.error.code === "config-revision-stale"
        ? { kind: "stale", error: result.error }
        : { kind: "failed", error: result.error };
    },
    async getInfo() {
      return readMobileShellBridgeInfo(bridge);
    },
    async getDiagnostics() {
      const result = parseBridgeJsonOrThrow(
        bridge.getDiagnostics(),
        mobileShellDiagnosticsResultSchema,
        "native-bridge-unavailable",
      );
      if (!result.ok) {
        throw new MobileShellBridgeError(result.error.code, result.error.message);
      }
      return result.diagnostics;
    },
  };
}

function readDevelopmentRevision(secureStore: PlatformSecureStore): Promise<number> {
  return secureStore.get(MOBILE_SHELL_DEVELOPMENT_CONFIG_REVISION_KEY).then((raw) => {
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  });
}

async function writeDevelopmentRevision(
  secureStore: PlatformSecureStore,
  revision: number,
): Promise<number> {
  await secureStore.set(MOBILE_SHELL_DEVELOPMENT_CONFIG_REVISION_KEY, String(revision));
  return revision;
}

function buildDevelopmentRemoteUrl(): string {
  // 凭证只经 handoff 交给 Remote，导航 URL 不再携带 Gateway/namespace/credential/backend。
  const url = new URL("mobile.html", globalThis.location?.href ?? "http://localhost/");
  url.search = "";
  return url.toString();
}

function createDevelopmentSessionContext(
  config: MobileRemoteGatewayConfig,
  backendId: string,
  clientInstanceId: string,
  sessionId: string,
): MobileSessionContext {
  const bridgeInfo = createDevelopmentMobileShellBridgeInfo();
  return {
    schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
    sessionId,
    gatewayUrl: config.gatewayUrl,
    namespace: config.namespace,
    backendId,
    credential: config.credential,
    clientInstanceId,
    appVersion: bridgeInfo.appVersion,
    bridgeCapabilities: {
      schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
      bridgeVersion: MOBILE_UI_BRIDGE_VERSION,
      appVersion: bridgeInfo.appVersion,
      // 开发桥只实现只读会话与 returnShell；不声明不存在的文件/通知能力。
      capabilities: ["session-context", "insecure-gateway-transport"],
    },
  };
}

/**
 * 开发降级客户端：复用现有 `MobileRemoteConfigStore`，只额外维护一个开发期的
 * configRevision。production 不会走到这里（入口先检查原生桥）。
 */
function createDevelopmentMobileShellConfigClient(options: {
  secureStore: PlatformSecureStore;
  allowInsecureTransport: boolean;
  handoffStorage?: MobileRemoteDevelopmentStorage;
  navigate?: (url: string) => void;
  sessionIdFactory?: () => string;
}): MobileShellConfigClient {
  const store = new MobileRemoteConfigStore(options.secureStore, {
    allowInsecureTransport: options.allowInsecureTransport,
  });
  let configRevision: number | undefined;
  let lastConfig: MobileRemoteGatewayConfig | null = null;
  const resolveRevision = () => readDevelopmentRevision(options.secureStore);
  const newSessionId = () =>
    options.sessionIdFactory?.() ??
    globalThis.crypto?.randomUUID?.() ??
    `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const readConfig = async (): Promise<MobileShellConfig | null> => {
    const config = await store.load();
    if (!config) {
      lastConfig = null;
      configRevision = undefined;
      return null;
    }
    lastConfig = config;
    const revision = await resolveRevision();
    configRevision = revision;
    return {
      schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
      ...config,
      configRevision: revision,
    };
  };

  return {
    mode: "development",
    read: readConfig,
    async load() {
      return (await readConfig()) ? lastConfig : null;
    },
    async save(input) {
      const write = parseMobileShellConfigWrite(input, {
        allowInsecureTransport: options.allowInsecureTransport,
      });
      if (!write) {
        throw new MobileShellBridgeError("invalid-argument", "Invalid shell config draft.");
      }
      await store.save(write);
      const config = await store.load();
      if (!config) {
        throw new MobileShellBridgeError("config-write-failed", "Config was not persisted.");
      }
      lastConfig = config;
      // 配置换代后旧 handoff 必须失效，避免 Remote 用上一个 backend 的上下文启动。
      clearDevelopmentRemoteHandoff(options.handoffStorage);
      const revision = await writeDevelopmentRevision(
        options.secureStore,
        (await resolveRevision()) + 1,
      );
      configRevision = revision;
      return {
        schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
        ...config,
        configRevision: revision,
      };
    },
    async clear() {
      await store.clear();
      lastConfig = null;
      clearDevelopmentRemoteHandoff(options.handoffStorage);
      configRevision = await writeDevelopmentRevision(
        options.secureStore,
        (await resolveRevision()) + 1,
      );
    },
    async openRemote(backendId, expectedConfigRevision) {
      const config = lastConfig ?? (await readConfig());
      if (!config) {
        return failure("config-unavailable", "No shell config is available.");
      }
      if (config.backendId !== backendId) {
        return {
          kind: "stale",
          error: { code: "config-revision-stale", message: "Selected backend changed." },
        };
      }
      if (configRevision !== expectedConfigRevision) {
        return {
          kind: "stale",
          error: { code: "config-revision-stale", message: "Config revision changed." },
        };
      }
      try {
        // clientInstanceId 的唯一生成/持久所有者仍是 Shell；Remote 只从 handoff 读取。
        const clientInstanceId = allocateDevelopmentClientInstanceId(
          backendId,
          options.handoffStorage,
        );
        writeDevelopmentRemoteHandoff(
          createDevelopmentSessionContext(config, backendId, clientInstanceId, newSessionId()),
          options.handoffStorage,
        );
      } catch (error) {
        return failure(
          "config-write-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      const navigate = options.navigate ?? ((url: string) => globalThis.location.assign(url));
      navigate(buildDevelopmentRemoteUrl());
      return { kind: "opened" };
    },
    async getInfo() {
      return createDevelopmentMobileShellBridgeInfo();
    },
    async getDiagnostics() {
      const revision = configRevision ?? (await resolveRevision());
      return {
        schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
        configRevision: revision,
        ...(lastConfig?.backendId ? { selectedBackendId: lastConfig.backendId } : {}),
      };
    },
  };
}

export interface CreateMobileShellConfigClientOptions {
  mode: "native" | "development";
  bridge?: MobileShellBridge;
  allowInsecureTransport: boolean;
  secureStore?: PlatformSecureStore;
  /** 开发模式 Shell → Remote handoff 的同步存储；缺省 localStorage。 */
  handoffStorage?: MobileRemoteDevelopmentStorage;
  navigate?: (url: string) => void;
  /** 测试注入；开发模式生成 sessionId。 */
  sessionIdFactory?: () => string;
}

/** 创建唯一配置客户端；native 模式缺少 bridge 时立即 fail closed。 */
export function createMobileShellConfigClient(
  options: CreateMobileShellConfigClientOptions,
): MobileShellConfigClient {
  if (options.mode === "native") {
    if (!options.bridge) {
      throw new MobileShellBridgeError(
        "native-bridge-unavailable",
        "ZodyShellBridge is not available.",
      );
    }
    return createNativeMobileShellConfigClient(options.bridge, options.allowInsecureTransport);
  }
  const secureStore = options.secureStore ?? createMobileRemoteSecureStore();
  return createDevelopmentMobileShellConfigClient({
    secureStore,
    allowInsecureTransport: options.allowInsecureTransport,
    ...(options.handoffStorage ? { handoffStorage: options.handoffStorage } : {}),
    ...(options.navigate ? { navigate: options.navigate } : {}),
    ...(options.sessionIdFactory ? { sessionIdFactory: options.sessionIdFactory } : {}),
  });
}

/**
 * openRemote 前重新读取原生配置，保证 expectedConfigRevision 是最新值。
 * backend 被并发替换时按 stale 处理，不导航。
 */
export async function openMobileShellBackend(
  client: MobileShellConfigClient,
  backendId: string,
): Promise<MobileShellOpenOutcome> {
  const persisted = await client.read();
  if (!persisted?.backendId) {
    return failure("config-unavailable", "No backend is selected.");
  }
  if (persisted.backendId !== backendId) {
    return {
      kind: "stale",
      error: { code: "config-revision-stale", message: "Selected backend changed." },
    };
  }
  return client.openRemote(backendId, persisted.configRevision);
}
