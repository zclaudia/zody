import type { ExtensionBridgeServer } from "./server.js";

export function beginWindowPairing(
  server: ExtensionBridgeServer,
  windowId: number,
): { pairingSessionId: string; pairingCode: string; expiresAt: number } | null {
  try {
    const ticket = server.beginPairing({ windowId: String(windowId) });
    return {
      pairingSessionId: ticket.pairingSessionId,
      pairingCode: ticket.pairingCode,
      expiresAt: ticket.expiresAt,
    };
  } catch {
    return null;
  }
}

export function cancelWindowPairing(
  server: ExtensionBridgeServer,
  windowId: number,
  pairingSessionId: string,
): void {
  const pending = server.getActivePairingForWindow(String(windowId));
  // 只有发起窗口能取消自己的配对会话。
  if (!pending || pending.pairingSessionId !== pairingSessionId) return;
  server.cancelPairing(pairingSessionId);
}
