import { createECDH, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXTENSION_BRIDGE_HKDF_INFO } from "@zcode/shared/browser-extension-transport";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  createClientResumeProof,
  createPairingProof,
  deriveSharedSecret,
  generateClientKeyPair,
  timingSafeStringEqual,
  verifyServerResumeProof,
} from "../src/crypto.js";

function nodeHmac(key: string | Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("base64url");
}

describe("extension crypto", () => {
  it("derives the same ECDH + HKDF shared secret as Desktop", async () => {
    const client = await generateClientKeyPair();
    const serverEcdh = createECDH("prime256v1");
    serverEcdh.generateKeys();
    const serverPublicKey = serverEcdh.getPublicKey("base64url", "uncompressed");

    const extensionSecret = await deriveSharedSecret(client.privateJwk, serverPublicKey);
    const shared = serverEcdh.computeSecret(Buffer.from(client.publicKey, "base64url"));
    const desktopSecret = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        Buffer.alloc(0),
        Buffer.from(EXTENSION_BRIDGE_HKDF_INFO, "utf8"),
        32,
      ),
    ).toString("base64url");

    expect(extensionSecret).toBe(desktopSecret);
  });

  it("matches the Desktop pairing and resume HMAC formats", async () => {
    const nonce = "nonce-1234567890";
    const connectionId = "connection-1234567890";
    const pairingCode = "pairing-code-1234567890";
    const sharedSecret = bytesToBase64Url(new Uint8Array(32).fill(7));

    expect(await createPairingProof(pairingCode, nonce)).toBe(nodeHmac(pairingCode, nonce));
    expect(await createClientResumeProof(sharedSecret, nonce, connectionId)).toBe(
      nodeHmac(Buffer.from(sharedSecret, "base64url"), `client|${nonce}|${connectionId}`),
    );

    const serverProof = nodeHmac(
      Buffer.from(sharedSecret, "base64url"),
      `server|${nonce}|${connectionId}`,
    );
    await expect(
      verifyServerResumeProof(sharedSecret, nonce, connectionId, serverProof),
    ).resolves.toBe(true);
    await expect(
      verifyServerResumeProof(sharedSecret, nonce, connectionId, `${serverProof}x`),
    ).resolves.toBe(false);
  });

  it("round-trips base64url bytes and compares strings without early exit", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    expect([...base64UrlToBytes(bytesToBase64Url(bytes))]).toEqual([...bytes]);
    expect(timingSafeStringEqual("same-value", "same-value")).toBe(true);
    expect(timingSafeStringEqual("same-value", "same-valuf")).toBe(false);
    expect(timingSafeStringEqual("short", "longer")).toBe(false);
  });
});
