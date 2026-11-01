import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExtensionPersistentStores,
  resolveExtensionBridgeStatePath,
} from "../src/main/extensionBridge/persistentStores.js";

const PROFILE = "profile-instance-1234567890";
const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zody-extension-stores-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("extension bridge persistent stores", () => {
  it("keeps generation monotonic across store restarts", async () => {
    const directory = await createDirectory();
    const first = createExtensionPersistentStores({ userDataPath: directory });
    expect(await first.generationStore.next(PROFILE)).toBe(1);
    expect(await first.generationStore.next(PROFILE)).toBe(2);
    await first.flush();

    const reopened = createExtensionPersistentStores({ userDataPath: directory });
    expect(await reopened.generationStore.next(PROFILE)).toBe(3);

    const secondProfile = "profile-instance-abcdefghijkl";
    expect(await reopened.generationStore.next(secondProfile)).toBe(1);
  });

  it("persists credentials with user-only permissions and keeps the generation cursor on revoke", async () => {
    const directory = await createDirectory();
    const stores = createExtensionPersistentStores({ userDataPath: directory });
    await stores.generationStore.next(PROFILE);
    await stores.credentialStore.set({
      profileInstanceId: PROFILE,
      extensionId: "extension-id",
      sharedSecret: "secret",
      clientPublicKey: "public-key",
      pairedAt: "2026-10-31T00:00:00.000Z",
      windowId: "42",
    });
    await stores.flush();

    const reopened = createExtensionPersistentStores({ userDataPath: directory });
    await expect(reopened.credentialStore.get(PROFILE)).resolves.toMatchObject({
      profileInstanceId: PROFILE,
      windowId: "42",
    });
    await reopened.credentialStore.delete(PROFILE);
    await reopened.flush();
    await expect(reopened.credentialStore.get(PROFILE)).resolves.toBeNull();
    // 撤销后重新配对不得回退 generation。
    expect(await reopened.generationStore.next(PROFILE)).toBe(2);

    if (process.platform !== "win32") {
      const file = resolveExtensionBridgeStatePath(directory);
      const mode = (await stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
      const raw = JSON.parse(await readFile(file, "utf8"));
      expect(raw.profiles[PROFILE].credential).toBeUndefined();
      expect(raw.profiles[PROFILE].lastGeneration).toBe(2);
    }
  });

  it("fails closed instead of resetting generation when the state file is corrupt", async () => {
    const directory = await createDirectory();
    const stores = createExtensionPersistentStores({ userDataPath: directory });
    await stores.generationStore.next(PROFILE);
    await stores.flush();

    const file = resolveExtensionBridgeStatePath(directory);
    await rm(file);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "{not json"));
    const reopened = createExtensionPersistentStores({ userDataPath: directory });
    await expect(reopened.generationStore.next(PROFILE)).rejects.toThrow(/not valid JSON/);
  });
});
