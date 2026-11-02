import { Event, ProxyChannel, type IChannelServer } from "@zody/rpc";
import { IMobileNotificationReader } from "@zody/services";
import type { MobileNotificationPrincipal } from "@zody/shared";
import { bindMobileNotificationReader } from "@zody/services/mobile-notifications/node";
import type { IMobileNotificationService } from "@zody/services/mobile-notifications/node";

/** Register a reader on this attachment only; its authority comes from Main. */
export function registerMobileNotificationReaderChannel(
  server: IChannelServer,
  service: IMobileNotificationService | undefined,
  principal: MobileNotificationPrincipal | undefined,
): void {
  const reader: IMobileNotificationReader =
    service && principal
      ? bindMobileNotificationReader(service, principal)
      : {
          listFeed: async () => {
            throw new Error("mobile notification reader is not authorized");
          },
          getNotification: async () => {
            throw new Error("mobile notification reader is not authorized");
          },
          markRead: async () => {
            throw new Error("mobile notification reader is not authorized");
          },
          markAllRead: async () => {
            throw new Error("mobile notification reader is not authorized");
          },
          onFeedChanged: Event.None,
        };

  server.registerChannel(IMobileNotificationReader.channelName, ProxyChannel.fromService(reader));
}
