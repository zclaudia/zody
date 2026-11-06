import { join, resolve } from "node:path";

import type { FileSystemPort, Logger, TraceContext } from "@zody/contracts";
import { isFileSystemPortError } from "@zody/contracts";
import { resolveProjectResourceRoots } from "@zody/shared/zody-paths";

import { ensureMemoryDirectoryExists } from "../memory/directory.js";
import type { AgentRuntimeConfig, MemoryRuntimeConfig } from "../runtime/types.js";
import type { AgentProfile, AgentMemoryScope } from "./profile.js";
import { buildPersistentAgentMemoryPrompt } from "./persistent-memory-prompt.js";

const PERSISTENT_MEMORY_TOOLS = ["Write", "Edit"] as const;

export function sanitizePersistentAgentMemoryKey(agentName: string): string {
  const key = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return key === "" ? "unknown" : key;
}

export function resolvePersistentAgentMemoryRoot(input: {
  agentName: string;
  scope: AgentMemoryScope;
  storageRoot: string;
  workspaceRoot: string;
}): string {
  const agentKey = sanitizePersistentAgentMemoryKey(input.agentName);
  if (input.scope === "user") {
    return join(input.storageRoot, "agent-memory", agentKey);
  }
  const workspace = resolve(input.workspaceRoot);
  return resolveProjectResourceRoots(
    workspace,
    input.scope === "project" ? "agent-memory" : "agent-memory-local",
    agentKey,
  ).writePath;
}

function isPersistentAgentMemoryEnabled(
  memory: MemoryRuntimeConfig | undefined,
): memory is MemoryRuntimeConfig & { storageRoot: string } {
  return memory?.enabled === true && memory.use !== false && Boolean(memory.storageRoot);
}

function withPersistentAgentMemoryTools(profile: AgentProfile): AgentProfile {
  if (!profile.memory || profile.tools === undefined) return profile;

  const tools = [...profile.tools];
  for (const tool of PERSISTENT_MEMORY_TOOLS) {
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools.length === profile.tools.length ? profile : { ...profile, tools };
}

export function projectPersistentAgentMemoryTools(config: AgentRuntimeConfig): AgentRuntimeConfig {
  const memory = config.memory;
  const profiles = config.subagents?.profiles;
  if (!profiles || !isPersistentAgentMemoryEnabled(memory)) return config;

  const projected = profiles.map(withPersistentAgentMemoryTools);
  if (projected.every((profile, index) => profile === profiles[index])) return config;
  return {
    ...config,
    subagents: {
      ...config.subagents,
      profiles: projected,
    },
  };
}

export interface PersistentAgentMemory {
  rootDir: string;
  prompt: string;
}

export async function loadPersistentAgentMemory(input: {
  fileSystemPort: FileSystemPort | undefined;
  memory: MemoryRuntimeConfig | undefined;
  logger?: Logger;
  profile: AgentProfile;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<PersistentAgentMemory | undefined> {
  if (!input.profile.memory || !input.fileSystemPort) return undefined;
  if (!isPersistentAgentMemoryEnabled(input.memory)) return undefined;

  const rootDir = resolvePersistentAgentMemoryRoot({
    agentName: input.profile.name,
    scope: input.profile.memory,
    storageRoot: input.memory.storageRoot,
    workspaceRoot: input.workspaceRoot,
  });
  await ensureMemoryDirectoryExists(
    input.fileSystemPort,
    rootDir,
    input.traceContext,
    input.logger,
  );

  let indexContent = "";
  const legacyRootDir =
    input.profile.memory === "user"
      ? undefined
      : resolveProjectResourceRoots(
          input.workspaceRoot,
          input.profile.memory === "project" ? "agent-memory" : "agent-memory-local",
          sanitizePersistentAgentMemoryKey(input.profile.name),
        ).legacyPath;
  try {
    indexContent = (await input.fileSystemPort.readTextFile({ path: join(rootDir, "MEMORY.md") }))
      .content;
  } catch (error) {
    if (legacyRootDir && isFileSystemPortError(error) && error.code === "not_found") {
      try {
        indexContent = (
          await input.fileSystemPort.readTextFile({ path: join(legacyRootDir, "MEMORY.md") })
        ).content;
      } catch {
        // 旧 index 不存在时使用 empty index 文案；新写入仍由 rootDir 指向 .zody。
      }
    }
    // 不存在或不可读的 MEMORY.md 都使用基线的 empty index 文案。
  }

  return {
    rootDir,
    prompt: buildPersistentAgentMemoryPrompt({
      indexContent,
      rootDir,
      scope: input.profile.memory,
    }),
  };
}
