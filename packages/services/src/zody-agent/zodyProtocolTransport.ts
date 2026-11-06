import type { Event, IDisposable } from "@zody/rpc";
import type { ZodyProtocolMessage } from "@zody/shared";

export type ZodyProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface ZodyProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface ZodyProtocolTransport extends IDisposable {
  readonly kind: ZodyProtocolTransportKind;
  readonly onMessage: Event<ZodyProtocolMessage>;
  readonly onClose: Event<ZodyProtocolTransportClosedEvent>;
  send(message: ZodyProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
