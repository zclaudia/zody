import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStoredCredentialCipher } from "../src/credential/providers/credentialKeyStore.js";

const directories: string[] = [];
async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "zody-credential-key-"));
  directories.push(directory);
  return { directory, file: join(directory, "credentials.json") };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Zody credential key ownership", () => {
  it("shares one random private key across simultaneous first-use instances", async () => {
    const { directory, file } = await temporaryStore();
    const ciphers = await Promise.all(
      Array.from({ length: 8 }, () => createStoredCredentialCipher(file, {})),
    );
    const encrypted = ciphers[0]!.encrypt("secret");
    for (const cipher of ciphers) expect(cipher.decrypt(encrypted)).toBe("secret");
    const key = await readFile(join(directory, "credentials.key"), "utf8");
    expect(Buffer.from(key.trim(), "base64url")).toHaveLength(32);
    if (process.platform !== "win32") {
      expect((await stat(join(directory, "credentials.key"))).mode & 0o777).toBe(0o600);
    }
  });

  it("uses distinct keys for different data roots", async () => {
    const first = await temporaryStore();
    const second = await temporaryStore();
    const a = await createStoredCredentialCipher(first.file, {});
    const b = await createStoredCredentialCipher(second.file, {});
    expect(() => b.decrypt(a.encrypt("secret"))).toThrow();
  });

  it("does not recreate a lost key or overwrite existing encrypted credentials", async () => {
    const { directory, file } = await temporaryStore();
    const cipher = await createStoredCredentialCipher(file, {});
    const record = JSON.stringify({ "ssh:password": cipher.encrypt("secret") });
    await writeFile(file, record);
    await unlink(join(directory, "credentials.key"));
    await expect(createStoredCredentialCipher(file, {})).rejects.toThrow("missing");
    expect(await readFile(file, "utf8")).toBe(record);
  });

  it("refuses a corrupt key and preserves explicit secret overrides", async () => {
    const { directory, file } = await temporaryStore();
    await writeFile(join(directory, "credentials.key"), "broken");
    await expect(createStoredCredentialCipher(file, {})).rejects.toThrow("invalid");
    const a = await createStoredCredentialCipher(file, { ZCODE_CREDENTIAL_SECRET: "explicit" });
    const b = await createStoredCredentialCipher(file, { ZCODE_CREDENTIAL_SECRET: "explicit" });
    expect(b.decrypt(a.encrypt("secret"))).toBe("secret");
  });
});
