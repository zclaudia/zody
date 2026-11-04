import { randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "./privateFilePersistence.js";

const SECRET_ENV_KEY = "ZODY_CREDENTIAL_SECRET";

/** Resolve the shared credential secret, creating one only while holding its cross-process lock. */
export async function resolveStoredCredentialSecret(
  credentialsFile: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const configured = env[SECRET_ENV_KEY]?.trim();
  if (configured) return configured;
  const keyFile = join(dirname(credentialsFile), "credentials.key");
  return withFileLock(keyFile, async () => {
    try {
      const existing = validateSecret((await readFile(keyFile, "utf8")).trim());
      await chmod(keyFile, 0o600);
      return existing;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    let store: Record<string, unknown> = {};
    try {
      store = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (
      Object.values(store).some((value) => typeof value === "string" && value.startsWith("enc:v1:"))
    ) {
      throw new Error(
        "Zody credentials key is missing; refusing to replace encrypted credentials.",
      );
    }
    const secret = randomBytes(32).toString("base64url");
    await atomicWritePrivateTextFile(keyFile, `${secret}\n`);
    return secret;
  });
}

/** Read an existing key without creating files; intended for synchronous legacy call sites. */
export function readStoredCredentialSecretSync(
  credentialsFile: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[SECRET_ENV_KEY]?.trim();
  if (configured) return configured;
  const keyFile = join(dirname(credentialsFile), "credentials.key");
  if (!existsSync(keyFile)) {
    throw new Error("Zody credentials key is missing; refusing to replace encrypted credentials.");
  }
  return validateSecret(readFileSync(keyFile, "utf8").trim());
}

function validateSecret(secret: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, "base64url").length !== 32) {
    throw new Error("Zody credentials key is invalid; refusing to replace it.");
  }
  return secret;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
