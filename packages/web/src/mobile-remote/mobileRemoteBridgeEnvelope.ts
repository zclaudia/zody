import { MOBILE_UI_BRIDGE_SCHEMA_VERSION } from "@zcode/shared";

/**
 * `ZodyRemoteBridge` 的 JSON envelope 解析（与 M2-T5 `ZodyRemoteBridge.kt` 对齐）。
 *
 * 原生所有可调用方法都返回同一个线格式：
 * - 成功：`{ schemaVersion: 1, ok: true, ...命令字段 }`
 * - 失败：`{ schemaVersion: 1, ok: false, error: { code, message? } }`
 *
 * 页面只按 `error.code` 分支，不解析 message。损坏 JSON、缺少 schemaVersion/ok 或未知
 * envelope 都按 `native-bridge-unavailable` fail closed，避免把半截响应当成成功。
 */

export class MobileRemoteBridgeEnvelopeError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "MobileRemoteBridgeEnvelopeError";
    this.code = code;
  }
}

export interface MobileRemoteBridgeSuccessEnvelope {
  schemaVersion: number;
  ok: true;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解析成功 envelope；失败 envelope 转成带稳定 error.code 的异常。
 * `raw` 必须是字符串：原生 `@JavascriptInterface` 方法一律返回 JSON 字符串。
 */
export function parseMobileRemoteBridgeEnvelope(
  raw: unknown,
): MobileRemoteBridgeSuccessEnvelope {
  if (typeof raw !== "string") {
    throw new MobileRemoteBridgeEnvelopeError(
      "native-bridge-unavailable",
      "The native bridge did not return a JSON envelope.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MobileRemoteBridgeEnvelopeError(
      "native-bridge-unavailable",
      "Invalid native bridge JSON.",
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== MOBILE_UI_BRIDGE_SCHEMA_VERSION ||
    typeof parsed.ok !== "boolean"
  ) {
    throw new MobileRemoteBridgeEnvelopeError(
      "native-bridge-unavailable",
      "Invalid native bridge envelope.",
    );
  }
  if (!parsed.ok) {
    const error = isRecord(parsed.error) ? parsed.error : undefined;
    const code =
      typeof error?.code === "string" ? error.code : "native-bridge-unavailable";
    const message = typeof error?.message === "string" ? error.message : undefined;
    throw new MobileRemoteBridgeEnvelopeError(code, message);
  }
  return parsed as MobileRemoteBridgeSuccessEnvelope;
}

/** 读取成功 envelope 中必须存在的对象字段；缺失/类型错误按损坏响应处理。 */
export function requireMobileRemoteBridgeObject(
  envelope: MobileRemoteBridgeSuccessEnvelope,
  key: string,
): Record<string, unknown> {
  const value = envelope[key];
  if (!isRecord(value)) {
    throw new MobileRemoteBridgeEnvelopeError(
      "native-bridge-unavailable",
      `The native bridge response is missing ${key}.`,
    );
  }
  return value;
}

/** 读取成功 envelope 中必须存在的非空字符串字段。 */
export function requireMobileRemoteBridgeString(
  envelope: MobileRemoteBridgeSuccessEnvelope,
  key: string,
): string {
  const value = envelope[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MobileRemoteBridgeEnvelopeError(
      "native-bridge-unavailable",
      `The native bridge response is missing ${key}.`,
    );
  }
  return value;
}
