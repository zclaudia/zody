import type {
  RemoteAccessGatewayConnectionStatus,
  RemoteAccessTestConnectionFailureReason,
} from "@zcode/shared";

/** gateway 连接状态 → 文案 key。设置页和远控弹层共用同一套状态描述。 */
export function getGatewayStatusLabelId(gateway: RemoteAccessGatewayConnectionStatus): string {
  switch (gateway.state) {
    case "connecting":
      return "settings.remoteAccess.gateway.connecting";
    case "online":
      return "settings.remoteAccess.gateway.online";
    case "error":
      switch (gateway.reason) {
        case "unconfigured":
          return "settings.remoteAccess.gateway.unconfigured";
        case "credential-invalid":
          return "settings.remoteAccess.gateway.credentialInvalid";
        case "replaced":
          return "settings.remoteAccess.gateway.replaced";
        case "unreachable":
          return "settings.remoteAccess.gateway.unreachable";
      }
    case "disabled":
      return "settings.remoteAccess.gateway.disabled";
  }
}

export function getGatewayStatusDotClassName(gateway: RemoteAccessGatewayConnectionStatus): string {
  if (gateway.state === "online") {
    return "bg-success";
  }
  if (gateway.state === "connecting") {
    return "bg-warning";
  }
  if (gateway.state === "error") {
    return "bg-destructive";
  }
  return "bg-border";
}

export function getTestConnectionFailureMessageId(
  reason: RemoteAccessTestConnectionFailureReason,
): string {
  switch (reason) {
    case "unconfigured":
      return "settings.remoteAccess.test.reason.unconfigured";
    case "mobile-connected":
      return "settings.remoteAccess.test.reason.mobileConnected";
    case "credential-invalid":
      return "settings.remoteAccess.test.reason.credentialInvalid";
    case "replaced":
      return "settings.remoteAccess.test.reason.replaced";
    case "unreachable":
      return "settings.remoteAccess.test.reason.unreachable";
  }
}
