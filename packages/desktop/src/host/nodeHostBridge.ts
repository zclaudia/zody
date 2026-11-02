import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import {
  NODE_HOST_BRIDGE_PROTOCOL_VERSION,
  isNodeHostBridgeFrame,
  type NodeHostBridgeChannel,
  type NodeHostBridgeFrame,
} from "../common/nodeHostBridgeProtocol.js";
import { createLengthPrefixedV8Channel } from "../common/nodeHostBridgeTransport.js";

const MAX_PENDING_FRAMES_PER_PORT = 64;

export interface HostParentPortMessageEvent {
  data: unknown;
  ports: readonly NodeHostBridgePort[];
}

export interface HostParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: HostParentPortMessageEvent) => void): unknown;
  off(event: "message", listener: (event: HostParentPortMessageEvent) => void): unknown;
}

export interface HostMessagePortLike {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  off(event: "message", listener: (event: { data: unknown }) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

export interface NodeHostBridgeLogger {
  warn(message: string, details?: unknown): void;
}

/**
 * Host-side surrogate for one Electron MessagePortMain.
 *
 * Inbound payloads are queued until `start()` is called, mirroring MessagePortMain.
 * `close()` is idempotent and always emits exactly one `close` event so attachment
 * registries can release resources without a second owner.
 */
export class NodeHostBridgePort extends EventEmitter implements HostMessagePortLike {
  private started = false;
  private closed = false;
  private readonly inboundQueue: unknown[] = [];

  constructor(
    private readonly portId: number,
    private readonly sendFrame: (frame: NodeHostBridgeFrame) => void,
  ) {
    super();
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.sendFrame({
      v: NODE_HOST_BRIDGE_PROTOCOL_VERSION,
      kind: "port-data",
      portId: this.portId,
      data: message,
    });
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    while (!this.closed && this.inboundQueue.length > 0) {
      const data = this.inboundQueue.shift();
      this.emit("message", { data });
    }
    if (this.closed) this.inboundQueue.length = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inboundQueue.length = 0;
    this.sendFrame({ v: NODE_HOST_BRIDGE_PROTOCOL_VERSION, kind: "port-close", portId: this.portId });
    this.emit("close");
  }

  /** Main closed the bridge end; do not echo another port-close frame. */
  remoteClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.inboundQueue.length = 0;
    this.emit("close");
  }

  acceptData(data: unknown): void {
    if (this.closed) return;
    if (!this.started) {
      if (this.inboundQueue.length >= MAX_PENDING_FRAMES_PER_PORT) {
        this.fail(new Error("Node Host bridge port inbound queue overflow"));
        return;
      }
      this.inboundQueue.push(data);
      return;
    }
    this.emit("message", { data });
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.inboundQueue.length = 0;
    if (this.listenerCount("error") > 0) this.emit("error", error);
    this.emit("close");
  }
}

export class NodeHostBridgeParentPort extends EventEmitter implements HostParentPortLike {
  private closed = false;

  constructor(private readonly sendFrame: (frame: NodeHostBridgeFrame) => void) {
    super();
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.sendFrame({
      v: NODE_HOST_BRIDGE_PROTOCOL_VERSION,
      kind: "control",
      message,
      portIds: [],
    });
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (error && this.listenerCount("error") > 0) this.emit("error", error);
    this.emit("close");
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface NodeHostBridge {
  readonly parentPort: NodeHostBridgeParentPort;
  readonly hostId: string;
  readonly disposed: boolean;
  /** Test seam; production frames arrive through the channel subscription. */
  handleFrame(frame: unknown): void;
  dispose(error?: Error): void;
}

export function createNodeHostBridge(options: {
  channel: NodeHostBridgeChannel;
  hostId: string;
  announceHostId?: boolean;
  logger?: NodeHostBridgeLogger;
}): NodeHostBridge {
  const hostId = options.hostId.trim();
  if (!hostId) {
    throw new Error("Node Host bridge requires a launcher-generated hostId");
  }

  let disposed = false;
  const ports = new Map<number, NodeHostBridgePort>();
  let unsubscribeFrame = () => {};
  let unsubscribeClose = () => {};

  const sendFrame = (frame: NodeHostBridgeFrame): void => {
    if (disposed) return;
    try {
      options.channel.send(frame);
    } catch (error) {
      dispose(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const parentPort = new NodeHostBridgeParentPort(sendFrame);

  const dispose = (error?: Error): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeFrame();
    unsubscribeClose();
    const closeError = error ?? new Error("Node Host bridge closed");
    for (const port of ports.values()) port.fail(closeError);
    ports.clear();
    parentPort.close(error);
    try {
      options.channel.close();
    } catch {
      // best-effort transport teardown
    }
  };

  const protocolFailure = (message: string, details?: unknown): void => {
    options.logger?.warn(message, details);
    dispose(new Error(message));
  };

  const handleFrame = (raw: unknown): void => {
    if (disposed) return;
    // 根因：只检查对象形状会把非法 portIds/未知字段继续送进 createPort，桥接状态
    // 与对端不一致后仍继续收发。所有入站帧必须先通过共享协议校验，非法即关闭传输。
    if (!isNodeHostBridgeFrame(raw)) {
      protocolFailure("Invalid Node Host bridge frame");
      return;
    }
    const frame = raw;
    switch (frame.kind) {
      case "control": {
        for (const portId of frame.portIds) {
          if (ports.has(portId)) {
            protocolFailure("Node Host bridge control reused a live portId", { portId });
            return;
          }
        }
        const eventPorts: NodeHostBridgePort[] = [];
        for (const portId of frame.portIds) eventPorts.push(createPort(portId));
        parentPort.emit("message", { data: frame.message, ports: eventPorts });
        return;
      }
      case "port-data": {
        const port = ports.get(frame.portId);
        if (!port) {
          protocolFailure("Node Host bridge received data for an unknown or closed port", {
            portId: frame.portId,
          });
          return;
        }
        port.acceptData(frame.data);
        return;
      }
      case "port-close": {
        const port = ports.get(frame.portId);
        if (!port) {
          protocolFailure("Node Host bridge closed an unknown or already closed port", {
            portId: frame.portId,
          });
          return;
        }
        ports.delete(frame.portId);
        port.remoteClose();
        return;
      }
      case "error": {
        const error = new Error(frame.message);
        if (frame.portId === undefined) {
          dispose(error);
          return;
        }
        const port = ports.get(frame.portId);
        if (!port) {
          protocolFailure("Node Host bridge errored an unknown or closed port", {
            portId: frame.portId,
          });
          return;
        }
        ports.delete(frame.portId);
        port.fail(error);
        return;
      }
      case "port-ready":
        // Informational only; the Host does not need a second handshake.
        return;
      case "hello":
      default:
        protocolFailure(`Unexpected Node Host bridge frame: ${String(frame.kind)}`);
        return;
    }
  };

  const createPort = (portId: number): NodeHostBridgePort => {
    const port = new NodeHostBridgePort(portId, sendFrame);
    ports.set(portId, port);
    return port;
  };

  unsubscribeFrame = options.channel.onFrame(handleFrame);
  unsubscribeClose = options.channel.onClose((error) => {
    dispose(error ?? new Error("Node Host bridge transport closed"));
  });
  if (options.announceHostId !== false) {
    sendFrame({ v: NODE_HOST_BRIDGE_PROTOCOL_VERSION, kind: "hello", hostId });
  }

  return {
    parentPort,
    hostId,
    get disposed() {
      return disposed;
    },
    handleFrame,
    dispose,
  };
}

/** Opens the native launcher-provided fd as a length-prefixed v8 duplex channel. */
export function createNodeHostSocketChannel(fd: number): NodeHostBridgeChannel {
  if (!Number.isInteger(fd) || fd < 3) {
    throw new Error(`Invalid Node Host bridge fd: ${fd}`);
  }
  const socket = new Socket({ fd, readable: true, writable: true });
  return createLengthPrefixedV8Channel(socket);
}
