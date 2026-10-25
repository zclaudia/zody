import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@zcode/rpc";
import { IMobileNotificationReader } from "@zcode/services";
import { createMobileNotificationService } from "@zcode/services/mobile-notifications/node";
import { registerMobileNotificationReaderChannel } from "../src/host/mobileNotificationReaderChannel.js";

describe("mobile notification reader Host channel", () => {
  let directory: string | undefined;
  let service: Awaited<ReturnType<typeof createMobileNotificationService>> | undefined;

  afterEach(async () => {
    service?.dispose();
    service = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("registers a scoped reader channel and rejects an attachment without a principal", async () => {
    directory = await mkdtemp(join(tmpdir(), "mobile-notification-reader-channel-"));
    service = await createMobileNotificationService({
      databasePath: join(directory, "notifications.sqlite"),
      now: () => 100,
    });
    const notification = await service.record({
      target: {
        backendId: "backend-a",
        workspaceKey: "/repo",
        workspacePath: "/repo",
        taskId: "task-a",
        sessionId: "task-a",
      },
      sourceEventId: "event-a",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Completed",
    });
    await service.record({
      target: {
        backendId: "backend-b",
        workspaceKey: "/other",
        workspacePath: "/other",
        taskId: "task-b",
        sessionId: "task-b",
      },
      sourceEventId: "event-b",
      sourceKind: "turn.completed",
      occurredAt: 200,
      kind: "completed",
      title: "Other backend",
    });

    const [authorizedServerProtocol, authorizedClientProtocol] = createQueuePair();
    const authorizedServer = new ChannelServer(authorizedServerProtocol, "mobile-reader");
    const authorizedClient = new ChannelClient(authorizedClientProtocol);
    registerMobileNotificationReaderChannel(authorizedServer, service, {
      backendId: "backend-a",
      deviceSubject: "device-a",
      clientInstanceId: "phone-a",
    });
    const authorizedReader = ProxyChannel.toService<IMobileNotificationReader>(
      authorizedClient.getChannel(IMobileNotificationReader.channelName),
    );

    const [unauthorizedServerProtocol, unauthorizedClientProtocol] = createQueuePair();
    const unauthorizedServer = new ChannelServer(unauthorizedServerProtocol, "mobile-reader");
    const unauthorizedClient = new ChannelClient(unauthorizedClientProtocol);
    registerMobileNotificationReaderChannel(unauthorizedServer, service, undefined);
    const unauthorizedReader = ProxyChannel.toService<IMobileNotificationReader>(
      unauthorizedClient.getChannel(IMobileNotificationReader.channelName),
    );

    try {
      await expect(
        authorizedReader.getNotification({ notificationId: notification.notificationId }),
      ).resolves.toMatchObject({
        notificationId: notification.notificationId,
        read: false,
      });
      // The attachment-bound reader remains scoped to the trusted Main principal.
      await expect(authorizedReader.listFeed({})).resolves.toMatchObject({
        items: [{ target: { backendId: "backend-a" } }],
        unreadCount: 1,
      });
      await expect(unauthorizedReader.listFeed({})).rejects.toThrow(
        "mobile notification reader is not authorized",
      );
    } finally {
      authorizedClient.dispose();
      unauthorizedClient.dispose();
      authorizedServer.dispose();
      unauthorizedServer.dispose();
    }
  });

  it("isolates same-path notifications across Host attachments with different workspace identities", async () => {
    directory = await mkdtemp(join(tmpdir(), "mobile-notification-multi-host-"));
    const hostA = await createMobileNotificationService({
      databasePath: join(directory, "host-a.sqlite"),
      now: () => 100,
    });
    const hostB = await createMobileNotificationService({
      databasePath: join(directory, "host-b.sqlite"),
      now: () => 100,
    });
    const setupHost = (
      service: typeof hostA,
      hostName: string,
      backendId: string,
      identity: string,
    ) => {
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, hostName);
      const client = new ChannelClient(clientProtocol);
      registerMobileNotificationReaderChannel(server, service, {
        backendId,
        deviceSubject: "device-a",
        clientInstanceId: "phone-a",
      });
      const reader = ProxyChannel.toService<IMobileNotificationReader>(
        client.getChannel(IMobileNotificationReader.channelName),
      );
      return { server, client, reader, identity };
    };
    const a = setupHost(hostA, "host-a", "backend-a", "remote://same-path/alpha");
    const b = setupHost(hostB, "host-b", "backend-b", "remote://same-path/beta");
    const target = (backendId: string, workspaceIdentity: string) => ({
      backendId,
      workspaceKey: workspaceIdentity,
      workspacePath: "/repo",
      workspaceIdentity,
      remoteSessionId: `session-${backendId}`,
      taskId: "same-task-id",
      sessionId: "same-session-id",
    });
    try {
      const [notificationA, notificationB] = await Promise.all([
        hostA.record({
          target: target("backend-a", a.identity),
          sourceEventId: "same-event-id",
          sourceKind: "turn.completed",
          occurredAt: 100,
          kind: "completed",
          title: "Host A",
        }),
        hostB.record({
          target: target("backend-b", b.identity),
          sourceEventId: "same-event-id",
          sourceKind: "turn.completed",
          occurredAt: 100,
          kind: "completed",
          title: "Host B",
        }),
      ]);

      expect(notificationA.notificationId).not.toBe(notificationB.notificationId);
      await expect(a.reader.listFeed({})).resolves.toMatchObject({
        items: [{ target: { backendId: "backend-a", workspaceIdentity: a.identity } }],
        unreadCount: 1,
      });
      await expect(b.reader.listFeed({})).resolves.toMatchObject({
        items: [{ target: { backendId: "backend-b", workspaceIdentity: b.identity } }],
        unreadCount: 1,
      });
      await expect(
        a.reader.getNotification({ notificationId: notificationB.notificationId }),
      ).resolves.toBeNull();
      await expect(
        a.reader.getNotification({
          notificationId: notificationA.notificationId,
          backendId: "backend-b",
          workspaceKey: b.identity,
          workspaceIdentity: b.identity,
        } as never),
      ).resolves.toMatchObject({
        target: { backendId: "backend-a", workspaceIdentity: a.identity },
      });

      await a.reader.markRead({
        notificationId: notificationA.notificationId,
        backendId: "backend-b",
        workspaceKey: b.identity,
        workspaceIdentity: b.identity,
      } as never);
      await expect(a.reader.listFeed({})).resolves.toMatchObject({
        unreadCount: 0,
        items: [{ read: true }],
      });
      await expect(b.reader.listFeed({})).resolves.toMatchObject({
        unreadCount: 1,
        items: [{ read: false }],
      });

      // Click 的 Host reader 查找也必须遵循 backend attachment；相同 path/task/session 不构成回退依据。
      await expect(
        a.reader.getNotification({ notificationId: notificationB.notificationId }),
      ).resolves.toBeNull();
      await expect(
        b.reader.getNotification({ notificationId: notificationB.notificationId }),
      ).resolves.toMatchObject({
        target: {
          workspacePath: "/repo",
          workspaceIdentity: b.identity,
          remoteSessionId: "session-backend-b",
        },
      });
    } finally {
      a.client.dispose();
      a.server.dispose();
      b.client.dispose();
      b.server.dispose();
      hostA.dispose();
      hostB.dispose();
    }
  });

  it("keeps same-backend same-path notifications distinct by workspace identity", async () => {
    directory = await mkdtemp(join(tmpdir(), "mobile-notification-identity-feed-"));
    service = await createMobileNotificationService({
      databasePath: join(directory, "notifications.sqlite"),
      now: () => 100,
    });
    const principal = {
      backendId: "backend-shared",
      deviceSubject: "device-a",
      clientInstanceId: "phone-a",
    };
    const [alpha, beta] = await Promise.all([
      service.record({
        target: {
          backendId: principal.backendId,
          workspaceKey: "identity-alpha",
          workspacePath: "/repo",
          workspaceIdentity: "identity-alpha",
          remoteSessionId: "session-alpha",
          taskId: "same-task",
          sessionId: "same-session",
        },
        sourceEventId: "same-event",
        sourceKind: "turn.completed",
        occurredAt: 100,
        kind: "completed",
        title: "Alpha",
      }),
      service.record({
        target: {
          backendId: principal.backendId,
          workspaceKey: "identity-beta",
          workspacePath: "/repo",
          workspaceIdentity: "identity-beta",
          remoteSessionId: "session-beta",
          taskId: "same-task",
          sessionId: "same-session",
        },
        sourceEventId: "same-event",
        sourceKind: "turn.completed",
        occurredAt: 100,
        kind: "completed",
        title: "Beta",
      }),
    ]);
    expect(alpha.notificationId).not.toBe(beta.notificationId);

    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "identity-feed");
    const client = new ChannelClient(clientProtocol);
    registerMobileNotificationReaderChannel(server, service, principal);
    const reader = ProxyChannel.toService<IMobileNotificationReader>(
      client.getChannel(IMobileNotificationReader.channelName),
    );
    try {
      const initialFeed = await reader.listFeed({});
      expect(initialFeed.unreadCount).toBe(2);
      expect(initialFeed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "Beta",
            target: expect.objectContaining({
              workspacePath: "/repo",
              workspaceIdentity: "identity-beta",
            }),
          }),
          expect.objectContaining({
            title: "Alpha",
            target: expect.objectContaining({
              workspacePath: "/repo",
              workspaceIdentity: "identity-alpha",
            }),
          }),
        ]),
      );
      await reader.markRead({ notificationId: alpha.notificationId });
      const readFeed = await reader.listFeed({});
      expect(readFeed.unreadCount).toBe(1);
      expect(readFeed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ notificationId: beta.notificationId, read: false }),
          expect.objectContaining({ notificationId: alpha.notificationId, read: true }),
        ]),
      );
      await expect(
        reader.getNotification({ notificationId: alpha.notificationId }),
      ).resolves.toMatchObject({
        target: { workspaceIdentity: "identity-alpha", remoteSessionId: "session-alpha" },
      });
      await expect(
        reader.getNotification({ notificationId: beta.notificationId }),
      ).resolves.toMatchObject({
        target: { workspaceIdentity: "identity-beta", remoteSessionId: "session-beta" },
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
