/**
 * Wire protocol for the signed Node Host bridge.
 *
 * Node child IPC cannot transfer Electron MessagePortMain objects. The bridge therefore
 * multiplexes a numeric port id: the main process keeps the renderer-facing Electron port
 * and forwards payloads over one ordered channel. The same protocol is used for the
 * native launcher's dedicated duplex fd (fd5), so both sides must agree byte-for-byte.
 */

export const NODE_HOST_BRIDGE_PROTOCOL_VERSION = 1 as const;
/** One control frame transfers renderer ports; keep the surrogate map bounded. */
export const MAX_NODE_HOST_BRIDGE_PORTS_PER_CONTROL = 64;

/**
 * Host announces its own identity as the first frame. Main adopts it; it is an instance
 * identity, never an authorization proof. A launcher may instead burn a hostId into the
 * signed wrapper, in which case the bridge uses that value.
 */
export interface NodeHostBridgeHelloFrame {
  v: typeof NODE_HOST_BRIDGE_PROTOCOL_VERSION;
  kind: "hello";
  hostId: string;
}

export interface NodeHostBridgeControlFrame {
  v: typeof NODE_HOST_BRIDGE_PROTOCOL_VERSION;
  kind: "control";
  message: unknown;
  portIds: readonly number[];
}

export interface NodeHostBridgePortDataFrame {
  v: typeof NODE_HOST_BRIDGE_PROTOCOL_VERSION;
  kind: "port-data";
  portId: number;
  data: unknown;
}

export interface NodeHostBridgePortCloseFrame {
  v: typeof NODE_HOST_BRIDGE_PROTOCOL_VERSION;
  kind: "port-close";
  portId: number;
}

export interface NodeHostBridgePortReadyFrame {
  v: typeof NODE_HOST_BRIDGE_PROTOCOL_VERSION;
  kind: "port-ready";
  portId: number;
}

export interface NodeHostBridgeErrorFrame {
  v: typeof NODE_HOST_BRIDGE_PROTOCOL_VERSION;
  kind: "error";
  portId?: number;
  message: string;
}

export type NodeHostBridgeFrame =
  | NodeHostBridgeHelloFrame
  | NodeHostBridgeControlFrame
  | NodeHostBridgePortDataFrame
  | NodeHostBridgePortCloseFrame
  | NodeHostBridgePortReadyFrame
  | NodeHostBridgeErrorFrame;

export interface NodeHostBridgeChannel {
  send(frame: NodeHostBridgeFrame): void;
  onFrame(listener: (frame: NodeHostBridgeFrame) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): void;
}

function isPortId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isNodeHostBridgeFrame(value: unknown): value is NodeHostBridgeFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (frame.v !== NODE_HOST_BRIDGE_PROTOCOL_VERSION) return false;
  switch (frame.kind) {
    case "hello":
      return typeof frame.hostId === "string" && frame.hostId.trim().length > 0;
    case "control":
      return (
        "message" in frame &&
        Array.isArray(frame.portIds) &&
        frame.portIds.length <= MAX_NODE_HOST_BRIDGE_PORTS_PER_CONTROL &&
        frame.portIds.every((portId) => isPortId(portId)) &&
        new Set(frame.portIds).size === frame.portIds.length
      );
    case "port-data":
      return isPortId(frame.portId) && "data" in frame;
    case "port-close":
    case "port-ready":
      return isPortId(frame.portId);
    case "error":
      return (
        typeof frame.message === "string" &&
        (frame.portId === undefined || isPortId(frame.portId))
      );
    default:
      return false;
  }
}

/**
 * Electron MessagePort sends MessagePortProtocol buffers as ArrayBuffer while Node IPC
 * advanced serialization carries Uint8Array. Normalize only binary views; flow-control
 * objects must stay plain JSON-shaped values.
 */
export function normalizeNodeHostBridgeData(data: unknown): unknown {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return data;
}

/** Conservative bound for process IPC send queues; v8 binary views may serialize larger. */
export function estimateNodeHostBridgeFrameBytes(frame: NodeHostBridgeFrame): number {
  try {
    return Buffer.byteLength(JSON.stringify(frame));
  } catch {
    return 0;
  }
}
