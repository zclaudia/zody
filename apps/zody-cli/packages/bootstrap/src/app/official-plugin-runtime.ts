import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ZODY_OFFICIAL_PLUGIN_MARKETPLACE,
  ZODY_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@zody/contracts";
import { ZODY_PLUGIN_ID_ENV_KEY } from "@zody/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;
// R54：运行期重写目标固定为新格式；旧 `.zcode-plugin/plugin.json` 只作渲染源回退，
// 字节保留（R30 preserve-legacy-discovery）。
const CANONICAL_PLUGIN_MANIFEST_SEGMENTS = [".zody-plugin", "plugin.json"] as const;
const LEGACY_PLUGIN_MANIFEST_SEGMENTS = [".zcode-plugin", "plugin.json"] as const;

function canonicalPluginManifestPath(rootPath: string): string {
  return join(rootPath, ...CANONICAL_PLUGIN_MANIFEST_SEGMENTS);
}

/**
 * 按 S1 优先规则选择渲染源：新格式存在即唯一 manifest，否则回退旧格式。
 * 新格式存在但不可读时直接抛错，不静默改用旧格式（不合并 manifest）。
 */
function readRuntimeManifest(rootPath: string): { path: string; contents: string } {
  const path = canonicalPluginManifestPath(rootPath);
  try {
    return { path, contents: readFileSync(path, "utf8") };
  } catch (error) {
    // existsSync=false 还可能是 EACCES/EPERM；快慢路径都只能在明确 ENOENT 时回退。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const legacyPath = join(rootPath, ...LEGACY_PLUGIN_MANIFEST_SEGMENTS);
  return { path: legacyPath, contents: readFileSync(legacyPath, "utf8") };
}

export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // 桌面打包态 process.execPath 是 ZCode Helper；缺少 Node 模式会误进 Electron main。
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

interface OfficialRuntimeManifestInput {
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  const manifestPath = canonicalPluginManifestPath(input.rootPath);
  // 升级首跑：旧缓存只有 `.zcode-plugin/plugin.json`（内含旧隐藏命令），此时以它为渲染源，
  // 结果写入新路径；旧文件字节保持不动，发现层按 S1 读新路径得到重渲染后的命令。
  const { path: readPath, contents: currentContents } = readRuntimeManifest(input.rootPath);
  const nextContents = renderOfficialPluginRuntimeManifest(input, currentContents);
  if (nextContents === undefined) return;
  // 启动时无条件 rename 同内容的 plugin.json 会放大 Windows 杀毒/索引器
  // 的短暂文件占用。字节完全一致时不触碰文件；真正有更新时仍保持原子的失败语义。
  // legacy 即使字节已是当前渲染结果，也仍需首次提交 canonical，才能结束升级慢路径。
  if (nextContents === currentContents && readPath === manifestPath) return;
  // 升级首跑时缓存里只有旧格式目录；新目标目录必须由这里补齐，否则临时文件 rename
  // 会以 ENOENT 失败并被 seed 降级路径吞成“可用旧缓存”，重渲染永远不会发生。
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

/**
 * I06：读快路径只读检查运行期 manifest 是否已是当前进程要提交的内容。
 * 命中时 seed 读路径不必进入跨进程 seed 锁；读取/解析失败按"需要慢路径"处理，
 * 由慢路径在锁内重试并保留原有失败语义。
 */
export function isOfficialPluginRuntimeManifestCurrent(
  input: OfficialRuntimeManifestInput,
): boolean {
  try {
    const manifestPath = canonicalPluginManifestPath(input.rootPath);
    const { path, contents: currentContents } = readRuntimeManifest(input.rootPath);
    if (path !== manifestPath) {
      // 无 MCP 的 legacy seed 不会生成新 manifest；只读验证后即可复用，避免热读永久取写锁。
      const legacy = parseOfficialRuntimeManifest(input, currentContents);
      return legacy.mcpServers === undefined;
    }
    const nextContents = renderOfficialPluginRuntimeManifest(input, currentContents);
    return nextContents === undefined || nextContents === currentContents;
  } catch {
    return false;
  }
}

function parseOfficialRuntimeManifest(
  input: OfficialRuntimeManifestInput,
  contents: string,
): Record<string, unknown> {
  const manifest: unknown = JSON.parse(contents);
  // JSON 可解析不等于插件身份合法；否则空对象/错名会被无 MCP 的快路径当作提交态。
  if (!isRecord(manifest) || manifest.name !== input.pluginName) {
    throw new Error("Official plugin manifest has invalid name.");
  }
  return manifest;
}

/** 计算重写后的 manifest 内容；无需重写（无 mcpServers 或无可用的 host 入口）时返回 undefined。 */
function renderOfficialPluginRuntimeManifest(
  input: OfficialRuntimeManifestInput,
  currentContents: string,
): string | undefined {
  const manifest = parseOfficialRuntimeManifest(input, currentContents);
  // skill-only / command-only 类型的 official plugin 不带 mcpServers，直接跳过 rewrite。
  // 之前这里无脑 asRecord(manifest.mcpServers) 会对 undefined 抛错，
  // 把 seed 流程整个阻断，连带 listZodySkills 拉不出 plugin skill。
  if (manifest.mcpServers === undefined) return undefined;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;

  // 保留对其他历史 official plugin MCP 的通用重写；zcode-cua 当前是 skill/SDK-only，
  // 不会进入这个分支，也不会生成独立的 CUA MCP server。
  const pluginId = `${input.pluginName}@${ZODY_OFFICIAL_PLUGIN_MARKETPLACE}`;
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    mcpServer.command = process.execPath;
    mcpServer.args = [...hostPrefixArgs, join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)];
    mcpServer.env = {
      ...mcpServerEnv,
      // 桌面打包态的 process.execPath 是 ZCode Helper。
      // 官方插件 MCP server 缺少 Node 模式 env 时会误进 Electron main，触发 deep-link 注册等桌面副作用。
      ELECTRON_RUN_AS_NODE: "1",
      // 权威写入插件身份（pluginName@marketplace，来自本地 plugin registry，manifest/user env 不可覆盖）。
      // R55：ZODY_/ZCODE_ 两套身份键从同一插件上下文一次生成；本层在 seed 阶段拿不到 dataPath，
      // 因此只写 ROOT/ID/NAME，DATA 由后续 MCP resolver 用加载上下文的 dataPath 补齐
      // （specs/zody-rename-plugin-env.md §S2）。其他 official plugin 仍带上不可伪造的 plugin
      // identity；CUA broker 凭据由 shared node_repl 的可信配置注入，不再写入独立 server。
      ZODY_PLUGIN_ID: pluginId,
      ZODY_PLUGIN_NAME: input.pluginName,
      ZODY_PLUGIN_ROOT: input.rootPath,
      [ZODY_PLUGIN_ID_ENV_KEY]: pluginId,
      ZCODE_PLUGIN_NAME: input.pluginName,
      ZCODE_PLUGIN_ROOT: input.rootPath,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZODY_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZODY_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
