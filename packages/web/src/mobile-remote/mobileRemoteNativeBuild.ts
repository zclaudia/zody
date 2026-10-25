/** Only the native debug APK may relax bundled-page Gateway transport validation. */
export function nativeAllowsInsecureGatewayTransport(target: unknown = globalThis): boolean {
  const bridge = (
    target as { ZcodeMobileBridge?: { allowsInsecureGatewayTransport?: () => unknown } }
  )?.ZcodeMobileBridge;
  try {
    return bridge?.allowsInsecureGatewayTransport?.() === true;
  } catch {
    return false;
  }
}
