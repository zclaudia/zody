import { randomUUID } from "node:crypto";
import {
  installNodeHostEntryConfig,
  type NodeHostEntryNetworkDependencies,
  type NodeHostAgentRuntimeConfig,
} from "./nodeHostEntryConfig.js";
import type { HostStorageResources } from "./hostStorageResources.js";
import { createNodeHostSocketChannel } from "./nodeHostBridge.js";
import { createCandidateNetworkTransportDependencies } from "./candidateNodeNetwork.js";

/** Native launcher contract: the Host bridge duplex fd is always fd5. */
export const NODE_HOST_BRIDGE_FD = 5;

export interface SealedNodeHostEntryConfig {
  /** Optional fixed id burned in by the launcher; otherwise the signed Host self-generates it. */
  readonly hostId?: string;
  /** Required fixed resources for the original Host/session storage preparation flow. */
  readonly storageResources: HostStorageResources;
  /** Native launcher/bundle build injects this object directly; never read from env. */
  readonly agentRuntime?: NodeHostAgentRuntimeConfig;
  /** Optional override; defaults to the sealed candidate's explicit proxy/CA rejection. */
  readonly networkTransportDependencies?: NodeHostEntryNetworkDependencies;
}

/**
 * Sealed ESM entry for `--entry-name host-entry.mjs`.
 *
 * The native launcher owns fd5 and passes it into Node. The wrapper injects a closure
 * config (including the CLI native launcher path and fds) before loading the existing
 * Host entry, so this path only exists when a trusted composition imports this entry.
 * The name "sealed" describes that assembly boundary, not an OS trust proof; the native
 * launcher/authority still verifies signatures, pid and audit token on every connection.
 */
export async function startSealedNodeHostEntry(
  config: SealedNodeHostEntryConfig,
): Promise<void> {
  if (!config?.storageResources) {
    throw new Error("Sealed Node Host entry requires fixed storage resources");
  }
  const hostId = config.hostId?.trim() || randomUUID();
  installNodeHostEntryConfig({
    hostId,
    storageResources: config.storageResources,
    ...(config.agentRuntime ? { agentRuntime: config.agentRuntime } : {}),
    networkTransportDependencies:
      config.networkTransportDependencies ?? createCandidateNetworkTransportDependencies(),
    createChannel: () => createNodeHostSocketChannel(NODE_HOST_BRIDGE_FD),
  });
  await import("./index.js");
}
