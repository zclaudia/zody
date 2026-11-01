import {
  EXTENSION_BRIDGE_CLIENT_PROOF_PREFIX,
  EXTENSION_BRIDGE_HKDF_INFO,
  EXTENSION_BRIDGE_SERVER_PROOF_PREFIX,
} from "@zcode/shared/browser-extension-transport";

export interface StoredClientKeyPair {
  /** P-256 ECDH 私钥 JWK；保存在 chrome.storage.local，仅本扩展可读。 */
  privateJwk: JsonWebKey;
  /** raw uncompressed P-256 公钥，base64url。 */
  publicKey: string;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=");
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 定长字符串比较；WebCrypto 没有 timingSafeEqual，避免按字符提前返回。 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export async function generateClientKeyPair(): Promise<StoredClientKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateJwk, publicKey: bytesToBase64Url(rawPublicKey) };
}

async function deriveSharedBits(
  privateJwk: JsonWebKey,
  serverPublicKey: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const serverKey = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(serverPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, privateKey, 256),
  );
}

/**
 * 与 Desktop 端保持一致：
 * shared = HKDF-SHA256(ECDH(clientPrivate, serverPublic), salt=空, info=EXTENSION_BRIDGE_HKDF_INFO, 32B)。
 * 共享密钥本身从不在 WebSocket 上传输。
 */
export async function deriveSharedSecret(
  privateJwk: JsonWebKey,
  serverPublicKey: string,
): Promise<string> {
  const sharedBits = await deriveSharedBits(privateJwk, serverPublicKey);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(EXTENSION_BRIDGE_HKDF_INFO),
      },
      hkdfKey,
      256,
    ),
  );
  return bytesToBase64Url(derived);
}

export async function hmacBase64Url(
  key: string | Uint8Array<ArrayBuffer>,
  data: string,
): Promise<string> {
  const keyBytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(signature));
}

export function createPairingProof(pairingCode: string, nonce: string): Promise<string> {
  return hmacBase64Url(pairingCode, nonce);
}

export function createClientResumeProof(
  sharedSecret: string,
  nonce: string,
  connectionId: string,
): Promise<string> {
  return hmacBase64Url(
    base64UrlToBytes(sharedSecret),
    `${EXTENSION_BRIDGE_CLIENT_PROOF_PREFIX}|${nonce}|${connectionId}`,
  );
}

export async function verifyServerResumeProof(
  sharedSecret: string,
  nonce: string,
  connectionId: string,
  proof: string,
): Promise<boolean> {
  const expected = await hmacBase64Url(
    base64UrlToBytes(sharedSecret),
    `${EXTENSION_BRIDGE_SERVER_PROOF_PREFIX}|${nonce}|${connectionId}`,
  );
  return timingSafeStringEqual(expected, proof);
}
