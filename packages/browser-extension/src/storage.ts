import type { ExtensionProfileInstanceId } from "@zody/shared/browser-extension-transport";

export const STORAGE_KEYS = {
  profileInstanceId: "zody.profileInstanceId",
  clientKeyPair: "zody.clientKeyPair",
  sharedSecret: "zody.sharedSecret",
  bridgePort: "zody.bridgePort",
  pairing: "zody.pairing",
  status: "zody.status",
  attachments: "zody.attachments",
  /** Pending claim 只用于 Popup/badge 展示；授权事实由 Host 持有。 */
  claims: "zody.claims",
  /**
   * Zody 创建的 agent tab 本地台账。扩展重载会清空 storage.session，
   * 但该台账在 storage.local，用于重载后关闭遗留 agent tab。
   */
  agentTabs: "zody.agentTabs",
} as const;

export interface StoredPairingChallenge {
  pairingSessionId: string;
  nonce: string;
  serverPublicKey: string;
  expiresAt: number;
}

export type BridgeStatusState =
  | "idle"
  | "connecting"
  | "pairing"
  | "connected"
  | "disconnected"
  | "error";

export interface BridgeStatus {
  state: BridgeStatusState;
  profileInstanceId?: ExtensionProfileInstanceId;
  pairingSessionId?: string;
  generation?: number;
  message?: string;
  updatedAt: number;
}

export interface BridgeClientStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
