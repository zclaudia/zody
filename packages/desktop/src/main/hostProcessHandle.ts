import type { MessagePortMain } from "electron";

/**
 * The narrow host-child surface actually used by Main.
 *
 * Both Electron UtilityProcess (default) and the fixed-Node child adapter satisfy this
 * interface. Keeping it narrow avoids casting a Node child to UtilityProcess and hiding
 * missing lifecycle/port semantics.
 */
export interface HostProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: unknown, transfer?: MessagePortMain[]): void;
  on(event: "message" | "exit", listener: (...args: any[]) => void): this;
  once(event: "message" | "exit", listener: (...args: any[]) => void): this;
  off(event: "message" | "exit", listener: (...args: any[]) => void): this;
  removeListener(event: "message" | "exit", listener: (...args: any[]) => void): this;
  kill(): boolean;
}
