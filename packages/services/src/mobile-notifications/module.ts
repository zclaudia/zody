export const mobileNotificationModule = {
  id: "mobile-notifications-service",
  requires: ["services", "shared", "rpc"],
  provides: ["mobile-notifications"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
