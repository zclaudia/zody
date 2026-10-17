import {
  resolveWebRemoteControlAppProtocolVersion,
  WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";

/** spec「Channel 帧协议」：`bufferedAmount` 超过 4 MiB 时返回 unavailable，交给上层缓冲。 */
export const WEB_REMOTE_CONTROL_CHANNEL_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const textEncoder = new TextEncoder();

export function measureUtf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function isRawTransportCandidate(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

function hasPayloadFieldPath(payload: unknown, fieldPath: string): boolean {
  let current: unknown = payload;
  for (const segment of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

/** 只克隆待删除字段路径上的容器，不改写 manager 构造的 payload。 */
function deletePayloadField(payload: Record<string, unknown>, fieldPath: string): void {
  const segments = fieldPath.split(".");
  if (segments.length === 1) {
    delete payload[segments[0]!];
    return;
  }
  const [containerKey, ...rest] = segments;
  const container = payload[containerKey!];
  if (typeof container !== "object" || container === null) return;
  const clonedContainer = { ...(container as Record<string, unknown>) };
  let current = clonedContainer;
  for (let index = 0; index < rest.length - 1; index += 1) {
    const key = rest[index]!;
    const next = current[key];
    if (typeof next !== "object" || next === null) return;
    const clonedNext = { ...(next as Record<string, unknown>) };
    current[key] = clonedNext;
    current = clonedNext;
  }
  delete current[rest[rest.length - 1]!];
  payload[containerKey!] = clonedContainer;
}

/**
 * 发送侧版本闸门（方案「版本兼容」演进规则）：
 * - 类型引入版本高于协商版本时整帧不发（返回 null）；
 * - 字段引入版本高于协商版本时从 payload 中省略该字段。
 */
export function prepareOutboundPayload(
  payload: WebRemoteControlAppPayload,
  negotiatedAppProtocol: number,
): WebRemoteControlAppPayload | null {
  const typeVersion = resolveWebRemoteControlAppProtocolVersion(payload.zcode_type);
  if (typeVersion === null || typeVersion > negotiatedAppProtocol) {
    return null;
  }
  const fieldsToDrop = WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES.filter(
    (feature) =>
      feature.field !== undefined &&
      feature.zcodeType === payload.zcode_type &&
      feature.introducedIn > negotiatedAppProtocol &&
      hasPayloadFieldPath(payload, feature.field),
  );
  if (fieldsToDrop.length === 0) {
    return payload;
  }
  const clone = { ...(payload as unknown as Record<string, unknown>) };
  for (const feature of fieldsToDrop) {
    deletePayloadField(clone, feature.field!);
  }
  return clone as unknown as WebRemoteControlAppPayload;
}
