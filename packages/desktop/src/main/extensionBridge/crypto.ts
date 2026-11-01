import { createECDH, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  EXTENSION_BRIDGE_CLIENT_PROOF_PREFIX,
  EXTENSION_BRIDGE_HKDF_INFO,
  EXTENSION_BRIDGE_SERVER_PROOF_PREFIX,
} from "@zcode/shared/browser-extension-transport";

/** 192 bit 一次性配对码；只在发起窗口与 Popup 之间人工核对，不落日志。 */
export function createPairingCode(): string {
  return randomBytes(24).toString("base64url");
}

export function createNonce(): string {
  return randomBytes(32).toString("base64url");
}

export interface ServerEcdhSession {
  /** raw uncompressed P-256 公钥，base64url。 */
  publicKey: string;
  deriveSharedSecret(clientPublicKey: string): string;
}

/**
 * 每个配对会话生成一次 P-256 ECDH 私钥。
 * 共享密钥 = HKDF-SHA256(ECDH(serverPrivate, clientPublic), info=EXTENSION_BRIDGE_HKDF_INFO)。
 * 密钥不在 wire 上传输；端口抢占者无法从公钥推出共享密钥。
 */
export function createServerEcdhSession(): ServerEcdhSession {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey("base64url", "uncompressed");
  return {
    publicKey,
    deriveSharedSecret(clientPublicKey: string): string {
      const shared = ecdh.computeSecret(Buffer.from(clientPublicKey, "base64url"));
      const derived = hkdfSync(
        "sha256",
        shared,
        Buffer.alloc(0),
        Buffer.from(EXTENSION_BRIDGE_HKDF_INFO, "utf8"),
        32,
      );
      return Buffer.from(derived).toString("base64url");
    },
  };
}

function hmacBase64Url(key: string | Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("base64url");
}

/** 配对证明：HMAC(pairingCode, nonce)。 */
export function createPairingProof(pairingCode: string, nonce: string): string {
  return hmacBase64Url(pairingCode, nonce);
}

/** 扩展 → Main 的重连证明。 */
export function createClientResumeProof(
  sharedSecret: string,
  nonce: string,
  connectionId: string,
): string {
  return hmacBase64Url(
    Buffer.from(sharedSecret, "base64url"),
    `${EXTENSION_BRIDGE_CLIENT_PROOF_PREFIX}|${nonce}|${connectionId}`,
  );
}

/** Main → 扩展的反向证明；扩展验证通过后才进入 connected。 */
export function createServerResumeProof(
  sharedSecret: string,
  nonce: string,
  connectionId: string,
): string {
  return hmacBase64Url(
    Buffer.from(sharedSecret, "base64url"),
    `${EXTENSION_BRIDGE_SERVER_PROOF_PREFIX}|${nonce}|${connectionId}`,
  );
}

/** 定长比较，避免按字节提前返回。长度不同直接失败，不做补零。 */
export function verifyProof(expected: string, actual: string): boolean {
  let expectedBytes: Buffer;
  let actualBytes: Buffer;
  try {
    expectedBytes = Buffer.from(expected, "base64url");
    actualBytes = Buffer.from(actual, "base64url");
  } catch {
    return false;
  }
  if (expectedBytes.length === 0 || expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}
