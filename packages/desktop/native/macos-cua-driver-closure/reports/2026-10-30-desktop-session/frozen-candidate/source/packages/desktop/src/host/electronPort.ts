import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";

interface ElectronMessagePortLike {
  on(event: "message", listener: (event: { data: MessagePortPayload }) => void): unknown;
  off(event: "message", listener: (event: { data: MessagePortPayload }) => void): unknown;
  postMessage(data: MessagePortPayload): void;
  start(): void;
  close(): void;
}

/**
 * 将 Electron MessagePortMain 适配为 RPC 层的 MessagePortLike 接口。
 *
 * Electron 的 MessagePortMain 使用 Node EventEmitter 风格 (.on/.off)，
 * 而 MessagePortLike 使用 Web 标准风格 (addEventListener/removeEventListener)。
 * 此适配器弥合两者差异，使 MessagePortProtocol 可以直接在 utilityProcess 中使用。
 */
export function wrapElectronPort(port: ElectronMessagePortLike): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      // MessagePortMain 的 message 事件已经是 { data } 结构，直接转发
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}
