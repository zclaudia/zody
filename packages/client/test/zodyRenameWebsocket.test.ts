import { afterEach, describe, expect, it, vi } from "vitest";
import { connectViaWebSocket } from "../src/websocket.js";

class FakeSocket extends EventTarget {
  static latest: FakeSocket;
  static OPEN = 1;
  readyState = 1;
  protocol = "";
  binaryType = "";
  send = vi.fn();
  close = vi.fn();
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    super();
    FakeSocket.latest = this;
  }
}
afterEach(() => vi.unstubAllGlobals());
describe("rename generation WebSocket", () => {
  it("offers the required protocol and rejects an unselected protocol before RPC", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const open = vi.fn();
    const connection = connectViaWebSocket("ws://example.test/ws", { onOpenSocket: open });
    const rejected = expect(connection).rejects.toThrow(/incompatible/i);
    expect(FakeSocket.latest.protocols).toContain("zody-generation-2");
    FakeSocket.latest.dispatchEvent(new Event("open"));
    await rejected;
    expect(open).not.toHaveBeenCalled();
    expect(FakeSocket.latest.send).not.toHaveBeenCalled();
    expect(FakeSocket.latest.close).toHaveBeenCalled();
  });
});
