import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ExtensionCredentialStore,
  ExtensionGenerationStore,
  ExtensionStoredCredential,
} from "./types.js";

const STATE_FILE_VERSION = 1;
const STATE_DIRECTORY = "browser-extension";
const STATE_FILE_NAME = "bridge-state.json";
const STATE_FILE_MODE = 0o600;

interface PersistedProfileState {
  lastGeneration: number;
  credential?: ExtensionStoredCredential;
}

interface PersistedBridgeState {
  version: typeof STATE_FILE_VERSION;
  profiles: Record<string, PersistedProfileState>;
}

const EMPTY_STATE: PersistedBridgeState = { version: STATE_FILE_VERSION, profiles: {} };

export interface ExtensionPersistentStores {
  credentialStore: ExtensionCredentialStore;
  generationStore: ExtensionGenerationStore;
}

/** Desktop 用户数据区内的唯一凭据/generation 文件。 */
export function resolveExtensionBridgeStatePath(userDataPath: string): string {
  return join(userDataPath, STATE_DIRECTORY, STATE_FILE_NAME);
}

function isPersistedProfileState(value: unknown): value is PersistedProfileState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { lastGeneration?: unknown; credential?: unknown };
  return (
    typeof candidate.lastGeneration === "number" &&
    Number.isSafeInteger(candidate.lastGeneration) &&
    candidate.lastGeneration >= 0
  );
}

function parseState(raw: string): PersistedBridgeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("extension bridge state is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== STATE_FILE_VERSION
  ) {
    throw new Error("extension bridge state has an unsupported version");
  }
  const profiles = (parsed as { profiles?: unknown }).profiles;
  if (typeof profiles !== "object" || profiles === null) {
    throw new Error("extension bridge state is missing profiles");
  }
  const validated: Record<string, PersistedProfileState> = {};
  for (const [profileInstanceId, value] of Object.entries(profiles)) {
    if (!isPersistedProfileState(value)) {
      throw new Error(`extension bridge state has an invalid profile record: ${profileInstanceId}`);
    }
    validated[profileInstanceId] = {
      lastGeneration: value.lastGeneration,
      ...(value.credential ? { credential: value.credential } : {}),
    };
  }
  return { version: STATE_FILE_VERSION, profiles: validated };
}

/**
 * Main 唯一持有的 Pairing 凭据 + generation 持久化。
 *
 * 同一文件承载两者，保证 generation 在进程重启后仍严格递增；写入使用同目录临时文件 +
 * rename，并在 POSIX 上收紧到 0600。读操作与写操作共用同一条串行链，避免并发握手读到
 * 未落盘的 generation。文件损坏时 fail closed，不能悄悄从 0 重新计数。
 */
export function createExtensionPersistentStores(input: {
  userDataPath: string;
  stateFilePath?: string;
}): ExtensionPersistentStores & { flush(): Promise<void> } {
  const stateFilePath = input.stateFilePath ?? resolveExtensionBridgeStatePath(input.userDataPath);
  let chain: Promise<unknown> = Promise.resolve();
  let state: PersistedBridgeState | null = null;

  const readState = async (): Promise<PersistedBridgeState> => {
    if (state) return state;
    try {
      const raw = await readFile(stateFilePath, "utf8");
      state = parseState(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state = { ...EMPTY_STATE, profiles: {} };
      } else {
        throw error;
      }
    }
    return state;
  };

  const persist = async (next: PersistedBridgeState): Promise<void> => {
    await mkdir(dirname(stateFilePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${stateFilePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: STATE_FILE_MODE,
      });
      await rename(temporaryPath, stateFilePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const withState = <T>(operation: (current: PersistedBridgeState) => Promise<T>): Promise<T> => {
    const next = chain.then(async () => operation(await readState()));
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    credentialStore: {
      get(profileInstanceId) {
        return withState(
          async (current) => current.profiles[profileInstanceId]?.credential ?? null,
        );
      },
      set(credential) {
        return withState(async (current) => {
          const existing = current.profiles[credential.profileInstanceId];
          current.profiles[credential.profileInstanceId] = {
            lastGeneration: existing?.lastGeneration ?? 0,
            credential,
          };
          await persist(current);
        });
      },
      delete(profileInstanceId) {
        return withState(async (current) => {
          const existing = current.profiles[profileInstanceId];
          if (!existing) return;
          // 撤销配对只删除密钥，保留 generation 游标；重新配对不得回退代次。
          delete existing.credential;
          await persist(current);
        });
      },
      list() {
        return withState(async (current) =>
          Object.values(current.profiles).flatMap((profile) =>
            profile.credential ? [{ ...profile.credential }] : [],
          ),
        );
      },
    },
    generationStore: {
      next(profileInstanceId) {
        return withState(async (current) => {
          const existing = current.profiles[profileInstanceId];
          const generation = (existing?.lastGeneration ?? 0) + 1;
          current.profiles[profileInstanceId] = {
            ...(existing?.credential ? { credential: existing.credential } : {}),
            lastGeneration: generation,
          };
          await persist(current);
          return generation;
        });
      },
    },
    async flush() {
      await chain;
    },
  };
}
