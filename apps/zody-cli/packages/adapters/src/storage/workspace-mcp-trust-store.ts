// fork（F23④，上游 a60ba6a7 workspace-mcp-trust 模块的 store 接线）：workspace MCP
// 信任门用户域存储的适配层。spec 见 docs/specs/workspace-mcp-trust.md §2.2/§3.3：
// 授权唯一 owner 是 Host 用户域信任存储（~/.zody/security/workspace-mcp-trust-v1.json，
// 与 hook trust store 同目录、同 storage.dir 解析规则——工作区内任何文件不能自授信任）；
// 唯一写路径 decide() 必须在文件锁内重读 + 原子写。本文件把这些 IO 适配成 core
// 纯域模块（@zody/core mcp/workspace-mcp-trust.ts）注入的 WorkspaceMcpTrustStorePort；
// 锁与原子写复用 @zody/shared/node 的单源实现（withFileLock + atomicWritePrivateTextFile），
// 与 hook store 的 FileWorkspaceHookTrustStore 同族但文件格式独立（shared
// workspace-mcp-trust-store-file.ts 单源 schema 校验）。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceMcpTrustRecord, WorkspaceMcpTrustStoreFile } from "@zody/shared";
import {
  WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION,
  parseWorkspaceMcpTrustStoreContent,
  workspaceMcpTrustStoreFileSchema,
} from "@zody/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zody/shared/node";
import { resolveWorkspaceHookTrustStorePath } from "./workspace-hook-trust-store.js";

/** 与 hook trust store 同目录（spec §2.2：同 storage.dir 解析规则）；文件名与上游一致。 */
export const WORKSPACE_MCP_TRUST_STORE_FILE = "workspace-mcp-trust-v1.json";

export interface WorkspaceMcpTrustStorePathOptions {
  homeDir?: string;
  userConfigPath?: string;
}

/**
 * 解析用户域 MCP trust store 路径：取 hook trust store 的目录（读取用户配置
 * storage.dir，缺省 ~/.zody/security），文件名替换为 workspace-mcp-trust-v1.json。
 * 上游 a60ba6a7 workspace-mcp-trust/index.ts 的 storePath() 同构。
 */
export async function resolveWorkspaceMcpTrustStorePath(
  options: WorkspaceMcpTrustStorePathOptions = {},
): Promise<string> {
  return join(
    dirname(await resolveWorkspaceHookTrustStorePath(options)),
    WORKSPACE_MCP_TRUST_STORE_FILE,
  );
}

/**
 * core WorkspaceMcpTrustStorePort 的文件适配：
 * - withLock：跨进程互斥（进程内 FIFO + OS 文件锁），core 的 decide() 在锁内重读。
 * - readRecords：缺文件 → []（尚无授权，default-deny）；损坏 → throw（fail-closed，
 *   core 侧 readRecordsSafe 捕获后按无记录投影，不得把已有声明显示为 trusted）。
 * - writeRecords：schema 校验后原子写（0600 临时文件 + rename）。
 */
export interface FileWorkspaceMcpTrustStorePortOptions extends WorkspaceMcpTrustStorePathOptions {
  /** 显式 store 路径（测试注入）；缺省按 resolveWorkspaceMcpTrustStorePath 解析。 */
  filePath?: string;
}

export interface FileWorkspaceMcpTrustStorePort {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  readRecords(): Promise<WorkspaceMcpTrustRecord[]>;
  writeRecords(records: readonly WorkspaceMcpTrustRecord[]): Promise<void>;
}

export function createFileWorkspaceMcpTrustStorePort(
  options: FileWorkspaceMcpTrustStorePortOptions = {},
): FileWorkspaceMcpTrustStorePort {
  // 路径惰性解析：构造保持同步（bootstrap 组装路径不等待 IO），首次使用时落定。
  let resolvedPath: Promise<string> | undefined;
  const storePath = () => {
    resolvedPath ??= options.filePath
      ? Promise.resolve(options.filePath)
      : resolveWorkspaceMcpTrustStorePath(options);
    return resolvedPath;
  };
  return {
    async withLock(operation) {
      // 锁文件与 store 同目录（withFileLock 以 `${filePath}.lock` 语义互斥）。
      return withFileLock(await storePath(), operation);
    },
    async readRecords() {
      const path = await storePath();
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
      const parsed = parseWorkspaceMcpTrustStoreContent(content);
      // 损坏（JSON 语法/schema 失败）统一 throw：core 侧 readRecordsSafe 按「无记录」
      // fail-closed 处理，decide 的锁内重读也会拒绝落盘（spec §3.3 规则 9）。
      if (parsed.status === "invalid") {
        throw new Error(`Workspace MCP trust store is invalid: ${path}`);
      }
      return [...parsed.file.records];
    },
    async writeRecords(records) {
      const path = await storePath();
      const file: WorkspaceMcpTrustStoreFile = {
        schemaVersion: WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION,
        records: [...records],
      };
      // 写前 schema 校验（含 workspaceIdentity+serverName 唯一性）：坏记录不得落盘。
      const validated = workspaceMcpTrustStoreFileSchema.parse(file);
      await atomicWritePrivateTextFile(path, `${JSON.stringify(validated, null, 2)}\n`);
    },
  };
}
