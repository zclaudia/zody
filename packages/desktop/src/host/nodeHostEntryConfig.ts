import { isAbsolute } from "node:path";
import type { HostApiNetworkTransportDependencies } from "@zody/services/node";
import type { NodeHostBridgeChannel } from "../common/nodeHostBridgeProtocol.js";
import type {
  NodeHostBridgeProcessLike,
} from "../common/nodeHostBridgeTransport.js";
import {
  validateHostStorageResources,
  type HostStorageResources,
  type VerifiedHostStorageResources,
} from "./hostStorageResources.js";
import { createNodeHostBridge, type NodeHostBridge } from "./nodeHostBridge.js";

/**
 * Agent launch config is a closure object injected by the signed `host-entry.mjs`
 * wrapper. It must never be parsed from env, argv, Renderer messages, or JSON files.
 * The shape is structural so services can own the authoritative type without a Host
 * dependency cycle.
 */
export interface NodeHostAgentRuntimeConfig {
  readonly launcherPath: string;
  readonly entryName?: "cli-entry.mjs";
  readonly cliInFd?: number;
  readonly cliOutFd?: number;
  /** Fixed relay choice injected by the sealed wrapper; never read from env/argv/UI. */
  readonly launchMode?: "direct" | "workspace-relay";
  readonly env?: Readonly<Record<string, string>>;
}

/** Candidate-only network capability injection; must not be parsed from env/argv/JSON. */
export type NodeHostEntryNetworkDependencies = HostApiNetworkTransportDependencies;

export interface NodeHostEntryConfig {
  /** Generated inside the signed wrapper (or burned in by the native launcher). */
  readonly hostId: string;
  /** Fixed preparation workers/entries shipped in the same sealed resource closure. */
  readonly storageResources: HostStorageResources;
  readonly agentRuntime?: NodeHostAgentRuntimeConfig;
  readonly networkTransportDependencies?: NodeHostEntryNetworkDependencies;
  /**
   * Non-serializable channel factory supplied only by the sealed wrapper.
   *
   * This registration is an assembly boundary, not a trust proof: it shows which
   * module wired the bridge, while the native launcher/authority separately verifies
   * signatures, pid and audit token.
   */
  readonly createChannel: (processLike: NodeHostBridgeProcessLike) => NodeHostBridgeChannel;
}

export interface InjectedNodeHostBridge {
  readonly bridge: NodeHostBridge;
  readonly storageResources: VerifiedHostStorageResources;
  readonly agentRuntime?: NodeHostAgentRuntimeConfig;
  readonly networkTransportDependencies?: NodeHostEntryNetworkDependencies;
}

type InstalledNodeHostEntryConfig = Omit<NodeHostEntryConfig, "storageResources"> & {
  readonly storageResources: VerifiedHostStorageResources;
};

const ENTRY_CONFIG_KEY = Symbol.for("zcode.signed-node-host.entry-config.v1");

function validateAgentRuntime(config: NodeHostAgentRuntimeConfig): void {
  if (!isAbsolute(config.launcherPath)) {
    throw new Error("Node Host agent launcherPath must be absolute");
  }
  if (config.entryName !== undefined && config.entryName !== "cli-entry.mjs") {
    throw new Error(`Unsupported Node Host agent entry: ${config.entryName}`);
  }
  for (const [name, fd] of [
    ["cliInFd", config.cliInFd],
    ["cliOutFd", config.cliOutFd],
  ] as const) {
    if (fd !== undefined && (!Number.isInteger(fd) || fd < 3)) {
      throw new Error(`Node Host agent ${name} must be an fd >= 3`);
    }
  }
  if (
    config.launchMode !== undefined &&
    config.launchMode !== "direct" &&
    config.launchMode !== "workspace-relay"
  ) {
    throw new Error(`Unsupported Node Host agent launchMode: ${config.launchMode}`);
  }
  if (config.env && Object.prototype.hasOwnProperty.call(config.env, "ELECTRON_RUN_AS_NODE")) {
    throw new Error("Node Host agent runtime must not set ELECTRON_RUN_AS_NODE");
  }
}

/** Called by the signed wrapper before importing the Host entry. */
export function installNodeHostEntryConfig(config: NodeHostEntryConfig): void {
  // 根因：后加载的模块可以再次覆盖全局槽位，把已固定的 launcher/fd 配置换成另一份。
  // 这里只允许同进程首次注册；后续调用直接失败，避免静默替换可信装配形状。
  if (Object.prototype.hasOwnProperty.call(globalThis, ENTRY_CONFIG_KEY)) {
    throw new Error("Signed Node Host entry config is already installed");
  }
  const hostId = config.hostId.trim();
  if (!hostId) throw new Error("Signed Node Host entry requires a hostId");
  if (typeof config.createChannel !== "function") {
    throw new Error("Signed Node Host entry requires a channel factory");
  }
  const storageResources = validateHostStorageResources(config.storageResources);
  if (config.agentRuntime) validateAgentRuntime(config.agentRuntime);
  const agentRuntime = config.agentRuntime
    ? Object.freeze({
        ...config.agentRuntime,
        ...(config.agentRuntime.env
          ? { env: Object.freeze({ ...config.agentRuntime.env }) }
          : {}),
      })
    : undefined;
  const snapshot = Object.freeze({
    hostId,
    storageResources,
    createChannel: config.createChannel,
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(config.networkTransportDependencies
      ? { networkTransportDependencies: Object.freeze({ ...config.networkTransportDependencies }) }
      : {}),
  });
  Object.defineProperty(globalThis, ENTRY_CONFIG_KEY, {
    value: snapshot,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

export function readNodeHostEntryConfig(): InstalledNodeHostEntryConfig | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[ENTRY_CONFIG_KEY];
  return typeof value === "object" && value !== null
    ? (value as InstalledNodeHostEntryConfig)
    : undefined;
}

/**
 * Creates the bridge only when the sealed wrapper installed an explicit entry config.
 * The default Electron utilityProcess path has no config and keeps using `process.parentPort`.
 */
export function createInjectedNodeHostBridge(
  processLike: NodeHostBridgeProcessLike,
): InjectedNodeHostBridge | null {
  const config = readNodeHostEntryConfig();
  if (!config) return null;
  const bridge = createNodeHostBridge({
    channel: config.createChannel(processLike),
    hostId: config.hostId,
  });
  return {
    bridge,
    storageResources: config.storageResources,
    ...(config.agentRuntime ? { agentRuntime: config.agentRuntime } : {}),
    ...(config.networkTransportDependencies
      ? { networkTransportDependencies: config.networkTransportDependencies }
      : {}),
  };
}
