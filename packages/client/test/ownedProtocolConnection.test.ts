import { describe, expect, it, vi } from "vitest";
import { ChannelServer, createQueuePair, Event } from "@zody/rpc";
import { IMobileNotificationReader } from "@zody/services";
import { connectViaProtocolOwned } from "../src/index.js";

describe("owned protocol connection", () => {
  it("rejects a request waiting for Initialize when its owner is disposed", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test", 1000, true);
    const owned = connectViaProtocolOwned(clientProtocol);
    const request =
      owned.services.mobileNotificationReaderService!.getNotification({
        notificationId: "pending-before-init",
      });

    owned.dispose();

    await expect(request).rejects.toMatchObject({ name: "ConnectionClosed" });
    server.ready();
    server.dispose();
  });

  it("rejects an in-flight RPC, ignores its late response, and leaves the new owner usable", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const oldServer = new ChannelServer(serverProtocol, "old");
    let resolveOld!: (value: null) => void;
    const oldCall = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveOld = resolve;
        }),
    );
    oldServer.registerChannel(IMobileNotificationReader.channelName, {
      call: oldCall,
      listen: () => Event.None,
    });
    const oldOwner = connectViaProtocolOwned(clientProtocol);
    const oldRequest =
      oldOwner.services.mobileNotificationReaderService!.getNotification({
        notificationId: "pending-in-flight",
      });
    await vi.waitFor(() => expect(oldCall).toHaveBeenCalledOnce());

    oldOwner.dispose();
    await expect(oldRequest).rejects.toMatchObject({
      name: "ConnectionClosed",
    });
    const [newServerProtocol, newClientProtocol] = createQueuePair();
    const newServer = new ChannelServer(newServerProtocol, "new");
    newServer.registerChannel(IMobileNotificationReader.channelName, {
      call: async () => null,
      listen: () => Event.None,
    });
    const newOwner = connectViaProtocolOwned(newClientProtocol);
    await expect(
      newOwner.services.mobileNotificationReaderService!.getNotification({
        notificationId: "new-bridge",
      }),
    ).resolves.toBeNull();
    resolveOld(null);
    await expect(oldRequest).rejects.toMatchObject({
      name: "ConnectionClosed",
    });

    newOwner.dispose();
    oldServer.dispose();
    newServer.dispose();
  });
});
