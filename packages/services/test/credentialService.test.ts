import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zody/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICredentialService } from "../src/credential/credential.js";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const MALFORMED_CIPHERTEXT_REASON = "密文格式非法";
const CORRUPTED_OR_MISMATCHED_KEY_REASON = "密钥不匹配或密文已损坏";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

function createTestCipher(secret = "credential-value-format-secret") {
  return createCredentialCipherProvider({ env: { ZODY_CREDENTIAL_SECRET: secret } });
}

function splitEncryptedValue(encrypted: string): [string, string, string] {
  const parts = encrypted.slice(ENCRYPTED_VALUE_PREFIX.length).split(".");
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

function expectDecryptError(decrypt: () => string, reason?: string): void {
  let thrown: unknown;
  try {
    decrypt();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ code: CREDENTIAL_DECRYPT_ERROR_CODE });
  if (reason !== undefined) {
    expect((thrown as Error).message).toContain(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`);
  }
}

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-credential-home-"));
  tempHomes.push(home);
  return home;
}

async function createCredentialServiceInHome(
  home: string,
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void,
): Promise<ICredentialService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/credential/credentialService.js");
  return mod.createCredentialService({ onDidMutate });
}

afterEach(() => {
  process.env.HOME = originalHome;

  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("credentialService encryption", () => {
  it("notifies Host listeners only after a credential mutation is persisted", async () => {
    const home = makeTempHome();
    const onDidMutate = vi.fn();
    const service = await createCredentialServiceInHome(home, onDidMutate);

    await service.save("account-provider:demo:api-key", "secret");
    await service.delete("account-provider:demo:api-key");

    expect(onDidMutate.mock.calls).toEqual([
      [{ operation: "save", key: "account-provider:demo:api-key" }],
      [{ operation: "delete", key: "account-provider:demo:api-key" }],
    ]);
  });

  it("encrypts value before persisting and decrypts transparently on load", async () => {
    const home = makeTempHome();
    const service = await createCredentialServiceInHome(home);
    const credentialKey = "oauth:bigmodel:access_token";

    await service.save(credentialKey, "plain-access-token");

    const credentialsFile = join(home, ".zody", "v2", "credentials.json");
    const rawStore = JSON.parse(readFileSync(credentialsFile, "utf-8")) as Record<string, string>;
    const storedValue = rawStore[credentialKey];

    expect(storedValue).toBeDefined();
    expect(storedValue).toMatch(/^enc:v1:/);
    expect(storedValue).not.toContain("plain-access-token");
    await expect(service.load(credentialKey)).resolves.toBe("plain-access-token");
  });

  it("round-trips an empty credential value instead of treating it as a missing segment", async () => {
    const home = makeTempHome();
    const service = await createCredentialServiceInHome(home);
    const credentialKey = "oauth:test:empty-value";

    await service.save(credentialKey, "");

    const credentialsFile = join(home, ".zody", "v2", "credentials.json");
    const rawStore = JSON.parse(readFileSync(credentialsFile, "utf-8")) as Record<string, string>;
    const [iv, authTag, cipherText] = splitEncryptedValue(rawStore[credentialKey] ?? "");

    // 空明文必须落成结构完整的三段密文：第三段为空串，而不是缺段。
    expect(iv).not.toBe("");
    expect(authTag).not.toBe("");
    expect(cipherText).toBe("");
    await expect(service.load(credentialKey)).resolves.toBe("");
  });

  it("does not rewrite the credential store or key for every rejected ciphertext shape", async () => {
    const home = makeTempHome();
    const service = await createCredentialServiceInHome(home);
    const credentialKey = "oauth:test:tampered";
    await service.save(credentialKey, "value");

    const credentialsDir = join(home, ".zody", "v2");
    const credentialsFile = join(credentialsDir, "credentials.json");
    const keyFile = join(credentialsDir, "credentials.key");
    const rawStore = JSON.parse(readFileSync(credentialsFile, "utf-8")) as Record<string, string>;
    const [iv, authTag, cipherText] = splitEncryptedValue(rawStore[credentialKey] ?? "");
    const tamperedValues = [
      ["missing third segment", `${ENCRYPTED_VALUE_PREFIX}${iv}.${authTag}`],
      ["empty iv", `${ENCRYPTED_VALUE_PREFIX}.${authTag}.${cipherText}`],
      ["empty auth tag", `${ENCRYPTED_VALUE_PREFIX}${iv}..${cipherText}`],
      // 用另一个合法长度的 authTag 破坏 GCM 校验，模拟错 tag/密文损坏。
      [
        "mismatched auth tag",
        `${ENCRYPTED_VALUE_PREFIX}${iv}.AAAAAAAAAAAAAAAAAAAAAA.${cipherText}`,
      ],
    ] as const;

    for (const [label, tamperedValue] of tamperedValues) {
      const keyBefore = readFileSync(keyFile, "utf-8");
      rawStore[credentialKey] = tamperedValue;
      writeFileSync(credentialsFile, `${JSON.stringify(rawStore, null, 2)}\n`, "utf-8");
      const tamperedStore = readFileSync(credentialsFile, "utf-8");

      await expect(service.load(credentialKey), label).rejects.toMatchObject({
        code: CREDENTIAL_DECRYPT_ERROR_CODE,
      });
      expect(readFileSync(credentialsFile, "utf-8"), label).toBe(tamperedStore);
      expect(readFileSync(keyFile, "utf-8"), label).toBe(keyBefore);
    }
  });

  it("does not rewrite the credential store or key when the stored key does not match", async () => {
    const home = makeTempHome();
    const service = await createCredentialServiceInHome(home);
    const credentialKey = "oauth:test:wrong-key";
    await service.save(credentialKey, "value");

    const credentialsDir = join(home, ".zody", "v2");
    const credentialsFile = join(credentialsDir, "credentials.json");
    const keyFile = join(credentialsDir, "credentials.key");
    // 换入另一把合法格式的 32-byte key，模拟 key 与密文不匹配；解密失败不得再改写任一文件。
    writeFileSync(keyFile, `${Buffer.alloc(32, 0x5a).toString("base64url")}\n`, "utf-8");
    const keyBefore = readFileSync(keyFile, "utf-8");
    const storeBefore = readFileSync(credentialsFile, "utf-8");

    await expect(service.load(credentialKey)).rejects.toMatchObject({
      code: CREDENTIAL_DECRYPT_ERROR_CODE,
    });
    expect(readFileSync(credentialsFile, "utf-8")).toBe(storeBefore);
    expect(readFileSync(keyFile, "utf-8")).toBe(keyBefore);
  });

  it("keeps backward compatibility for legacy plaintext values", async () => {
    const home = makeTempHome();
    const credentialsDir = join(home, ".zody", "v2");
    const credentialsFile = join(credentialsDir, "credentials.json");
    await mkdir(credentialsDir, { recursive: true });
    writeFileSync(
      credentialsFile,
      JSON.stringify({ "oauth:bigmodel:access_token": "legacy-plaintext-token" }),
      "utf-8",
    );

    const service = await createCredentialServiceInHome(home);

    await expect(service.load("oauth:bigmodel:access_token")).resolves.toBe(
      "legacy-plaintext-token",
    );
  });

  it("preserves all keys when host callers save concurrently", async () => {
    const home = makeTempHome();
    const service = await createCredentialServiceInHome(home);
    const entries = Array.from(
      { length: 30 },
      (_, index) => [`oauth:test:key-${index}`, `value-${index}`] as const,
    );

    await Promise.all(entries.map(([key, value]) => service.save(key, value)));

    await Promise.all(
      entries.map(async ([key, value]) => {
        await expect(service.load(key)).resolves.toBe(value);
      }),
    );
  });

  it("backs up corrupt JSON and refuses to erase it during save", async () => {
    const home = makeTempHome();
    const credentialsDir = join(home, ".zody", "v2");
    const credentialsFile = join(credentialsDir, "credentials.json");
    await mkdir(credentialsDir, { recursive: true });
    writeFileSync(credentialsFile, "{not-json", "utf-8");
    const service = await createCredentialServiceInHome(home);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          expect(service.load("oauth:test:new")).rejects.toThrow("Zody credentials are corrupt"),
        ),
      );
      await expect(service.save("oauth:test:new", "value")).rejects.toThrow(
        "Zody credentials are corrupt",
      );
      expect(readFileSync(credentialsFile, "utf-8")).toBe("{not-json");
      const backups = readdirSync(credentialsDir).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[credentialService"),
        "read failed; refusing to overwrite corrupt credential store",
        expect.objectContaining({ credentialsFile }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("credential cipher value format", () => {
  it("round-trips non-empty values containing separators and multi-byte text", () => {
    const cipher = createTestCipher();
    const value = "line-1.中文\nline-2";

    const encrypted = cipher.encrypt(value);

    expect(encrypted.startsWith(ENCRYPTED_VALUE_PREFIX)).toBe(true);
    expect(cipher.decrypt(encrypted)).toBe(value);
  });

  it("round-trips an empty plaintext as a complete three-segment ciphertext", () => {
    const cipher = createTestCipher();

    const encrypted = cipher.encrypt("");
    const [iv, authTag, cipherText] = splitEncryptedValue(encrypted);

    expect(iv).not.toBe("");
    expect(authTag).not.toBe("");
    expect(cipherText).toBe("");
    expect(cipher.decrypt(encrypted)).toBe("");
  });

  it("rejects a ciphertext whose third segment is missing", () => {
    const cipher = createTestCipher();
    const [iv, authTag] = splitEncryptedValue(cipher.encrypt("value"));

    expectDecryptError(
      () => cipher.decrypt(`${ENCRYPTED_VALUE_PREFIX}${iv}.${authTag}`),
      MALFORMED_CIPHERTEXT_REASON,
    );
  });

  it("rejects empty iv/authTag segments and extra segments", () => {
    const cipher = createTestCipher();
    const [iv, authTag, cipherText] = splitEncryptedValue(cipher.encrypt("value"));

    for (const payload of [
      `.${authTag}.${cipherText}`,
      `${iv}..${cipherText}`,
      `${iv}.${authTag}.${cipherText}.extra`,
    ]) {
      expectDecryptError(() => cipher.decrypt(`${ENCRYPTED_VALUE_PREFIX}${payload}`));
    }
  });

  it("rejects a ciphertext whose auth tag does not match", () => {
    const cipher = createTestCipher();
    const [iv, , cipherText] = splitEncryptedValue(cipher.encrypt("value"));
    const [, otherAuthTag] = splitEncryptedValue(cipher.encrypt("another value"));

    expectDecryptError(
      () => cipher.decrypt(`${ENCRYPTED_VALUE_PREFIX}${iv}.${otherAuthTag}.${cipherText}`),
      CORRUPTED_OR_MISMATCHED_KEY_REASON,
    );
  });

  it("rejects decryption with a different key", () => {
    const encrypted = createTestCipher("first-key").encrypt("value");

    expectDecryptError(
      () => createTestCipher("second-key").decrypt(encrypted),
      CORRUPTED_OR_MISMATCHED_KEY_REASON,
    );
  });
});
