import type {
  BrowserExtensionBridgeStatus,
  BrowserExtensionPairingStatus,
  BrowserExtensionProfileStatus,
} from "@zcode/shared";
import type { ExtensionBridgeConnectionInfo, ExtensionStoredCredential } from "./types.js";

export interface ExtensionBridgeStatusSource {
  isStarted(): boolean;
  configuredPort: number;
  startError?: string;
  listeningPort(): number;
  listCredentials(): Promise<ExtensionStoredCredential[]>;
  getCredential(profileInstanceId: string): Promise<ExtensionStoredCredential | null>;
  isHostRegistered(windowId: number): boolean;
  getConnectionInfo(profileInstanceId: string): ExtensionBridgeConnectionInfo | null;
  getActivePairingForWindow(windowId: string): {
    pairingSessionId: string;
    expiresAt: number;
    extensionId?: string;
    profileInstanceId?: string;
  } | null;
  getDefaultBrowserId(windowId: number): string | undefined;
}

/**
 * 绑定窗口仍有活跃 Host 时，Profile 对其他窗口不可见。窗口退出后 Host 被 unregister，
 * 该 Profile 变为孤儿，任何窗口都可显式接管，避免窗口崩溃后无法恢复。
 */
export function bindingVisibility(
  credential: ExtensionStoredCredential,
  windowId: number,
  source: Pick<ExtensionBridgeStatusSource, "isHostRegistered">,
): BrowserExtensionProfileStatus["binding"] | null {
  const bound = credential.windowId?.trim();
  if (!bound) return "unbound";
  if (bound === String(windowId)) return "current-window";
  const numeric = Number(bound);
  if (!Number.isSafeInteger(numeric) || !source.isHostRegistered(numeric)) return "unbound";
  return null;
}

export async function visibleProfileEntries(
  source: ExtensionBridgeStatusSource,
  windowId: number,
): Promise<
  Array<{ credential: ExtensionStoredCredential; binding: "current-window" | "unbound" }>
> {
  const entries: Array<{
    credential: ExtensionStoredCredential;
    binding: "current-window" | "unbound";
  }> = [];
  for (const credential of await source.listCredentials()) {
    const binding = bindingVisibility(credential, windowId, source);
    if (binding) entries.push({ credential, binding });
  }
  return entries;
}

export async function isProfileVisibleToWindow(
  source: ExtensionBridgeStatusSource,
  profileInstanceId: string,
  windowId: number,
): Promise<boolean> {
  const credential = await source.getCredential(profileInstanceId);
  return credential !== null && bindingVisibility(credential, windowId, source) !== null;
}

export async function buildBridgeStatus(
  source: ExtensionBridgeStatusSource,
  windowId: number,
): Promise<BrowserExtensionBridgeStatus> {
  const profiles: BrowserExtensionProfileStatus[] = [];
  for (const { credential, binding } of await visibleProfileEntries(source, windowId)) {
    const connection = source.getConnectionInfo(credential.profileInstanceId);
    profiles.push({
      profileInstanceId: credential.profileInstanceId,
      browserId: `extension:${credential.profileInstanceId}`,
      extensionId: credential.extensionId,
      pairedAt: credential.pairedAt,
      connected: connection !== null,
      ...(connection ? { generation: connection.generation } : {}),
      ...(binding === "current-window" ? { boundWindowId: credential.windowId } : {}),
      binding,
    });
  }
  profiles.sort((left, right) => left.pairedAt.localeCompare(right.pairedAt));

  const pendingPairing = source.getActivePairingForWindow(String(windowId));
  const pairing: BrowserExtensionPairingStatus | undefined = pendingPairing
    ? {
        pairingSessionId: pendingPairing.pairingSessionId,
        expiresAt: pendingPairing.expiresAt,
        ...(pendingPairing.extensionId ? { extensionId: pendingPairing.extensionId } : {}),
        ...(pendingPairing.profileInstanceId
          ? { profileInstanceId: pendingPairing.profileInstanceId }
          : {}),
      }
    : undefined;
  const listeningPort = source.listeningPort();
  const defaultBrowserId = source.getDefaultBrowserId(windowId);
  return {
    available: source.isStarted() && listeningPort > 0,
    port: source.isStarted() && listeningPort > 0 ? listeningPort : null,
    configuredPort: source.configuredPort,
    ...(source.startError ? { error: source.startError } : {}),
    profiles,
    ...(pairing ? { pairing } : {}),
    ...(defaultBrowserId ? { defaultBrowserId } : {}),
  };
}
