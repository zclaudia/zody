import { ZODY_PLUGIN_HOST_COMMAND } from "@zody/contracts/plugins";
import { CELL_RUN_FLAG } from "./cell-protocol.js";

const CELL_SCRIPT_PATTERN = /\.(?:mjs|cjs|js)$/u;
// 只有显式可信 composition 才要求关闭 JIT；普通 node_repl 启动保持原语义。
const CELL_JITLESS_FLAG = "--jitless";
// Node 从 stdin 读取 ESM 源码的固定入口；已核验内容只经私有 stdin，不进入 argv。
const CELL_STDIN_ENTRY = "-";
const CELL_STDIN_INPUT_TYPE = "--input-type=module";

// 子进程只继承非凭据、跨平台运行所需的最小变量面；NODE_OPTIONS/NODE_PATH/inspector、
// ZCODE_*、Helper/token 和云凭据一律不进入 cell。
export const CELL_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
] as const;

export interface CellLaunch {
  command: string;
  args: string[];
}

/**
 * 复用现有 single bundle：SEA 走 __zody-plugin-host，开发 bundle 直接执行 server.js。
 * 不传 process.execArgv，避免 inspector/loader 等调试入口进入 cell。
 */
export function resolveCellLaunch(input: {
  execPath: string;
  serverPath: string;
  sea: boolean;
  /** 仅显式可信 composition 开启；缺省/SEA 保持既有启动语义。 */
  jitless?: boolean;
}): CellLaunch {
  if (!input.sea && !CELL_SCRIPT_PATTERN.test(input.serverPath)) {
    throw new Error(
      "node_repl cell executor requires a built .js/.mjs server bundle; run the package build first",
    );
  }
  if (input.sea) {
    // SEA 单文件二进制不解释 Node CLI 旗标；本候选不实现 SEA jitless，显式拒绝而不是改默认。
    if (input.jitless) {
      throw new Error("node_repl cell jitless is not supported in SEA");
    }
    return {
      command: input.execPath,
      args: [ZODY_PLUGIN_HOST_COMMAND, input.serverPath, CELL_RUN_FLAG],
    };
  }
  return {
    command: input.execPath,
    args: [...(input.jitless ? [CELL_JITLESS_FLAG] : []), input.serverPath, CELL_RUN_FLAG],
  };
}

/**
 * 快照 cell 的固定启动形状：execPath --jitless --input-type=module - CELL_RUN_FLAG。
 *
 * 源码由父进程写入 stdin；serverPath 不再参与执行，避免校验后按路径重开形成 TOCTOU。
 */
export function resolveCellSnapshotLaunch(input: { execPath: string }): CellLaunch {
  return {
    command: input.execPath,
    args: [CELL_JITLESS_FLAG, CELL_STDIN_INPUT_TYPE, CELL_STDIN_ENTRY, CELL_RUN_FLAG],
  };
}

export function buildCellEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const byLower = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") byLower.set(key.toLowerCase(), value);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of CELL_ENV_ALLOWLIST) {
    const value = byLower.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  // 桌面打包态的 execPath 可能是 Electron Helper；只有父进程已显式处于 Node 模式时才传递。
  if (byLower.get("electron_run_as_node") === "1") env.ELECTRON_RUN_AS_NODE = "1";
  // Windows 的变量名大小写不敏感；这里保留平台参数，避免未来加平台专属变量时误删分支。
  void platform;
  return env;
}

export function isSeaRuntime(): boolean {
  type SeaModule = { isSea(): boolean };
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}
