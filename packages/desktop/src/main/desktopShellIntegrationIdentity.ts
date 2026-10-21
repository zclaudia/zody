import { desktopProductIdentities } from "../../scripts/desktop-product-identity.mjs";

/**
 * 系统集成（深链协议、Finder 快捷操作、Windows 右键菜单）使用的产品身份。
 *
 * 只有正式版应用名 `Zody` 使用正式身份；Preview、本地 Dev 与 e2e 隔离名一律落到
 * Preview 身份，保证这些构建不会覆盖正式版注册的协议、Finder 服务或注册表项。
 */
export interface DesktopShellIntegrationIdentity {
  flavor: "production" | "preview";
  productName: string;
  appId: string;
  protocolScheme: string;
}

export function resolveDesktopShellIntegrationIdentity(
  appName: string,
): DesktopShellIntegrationIdentity {
  const identity =
    appName === desktopProductIdentities.production.productName
      ? desktopProductIdentities.production
      : desktopProductIdentities.preview;
  return {
    flavor: identity.flavor === "production" ? "production" : "preview",
    productName: identity.productName,
    appId: identity.appId,
    protocolScheme: identity.protocolScheme,
  };
}
