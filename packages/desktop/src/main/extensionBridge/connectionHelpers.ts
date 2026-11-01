import type { RawData } from "ws";
import type { ExtensionPairingSession } from "./types.js";

export function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

/** hello 没有 pairingSessionId；取当前最新且未过期的待配对会话。 */
export function pickActivePairingSession(
  sessions: Map<string, ExtensionPairingSession>,
  now: number,
): ExtensionPairingSession | null {
  let selected: ExtensionPairingSession | null = null;
  for (const session of sessions.values()) {
    if (session.consumed || session.expiresAt <= now) continue;
    if (!selected || session.expiresAt > selected.expiresAt) selected = session;
  }
  return selected;
}
