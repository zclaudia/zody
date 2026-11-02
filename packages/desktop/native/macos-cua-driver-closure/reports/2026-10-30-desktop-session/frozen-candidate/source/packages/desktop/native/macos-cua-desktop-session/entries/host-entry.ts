// sealed host-entry.mjs：显式 import 并调用 Host 的 sealed 启动函数。
// stdin-eval 下 import.meta.url 不会等于 argv[1]，因此不能依赖 Host 模块的自动入口。
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { startSealedNodeHostEntry } from "../../../src/host/hostEntry.js";
import { installCandidateFetch } from "../runtime/candidate-fetch.js";
import { installFatalReporting } from "./entry-fatal.js";

declare const __CUA_TASKS_STORAGE_WORKER_SHA256__: string;
declare const __CUA_TASKS_STORAGE_WORKER_SOURCE__: string;
declare const __CUA_SESSION_STORAGE_ENTRY_SHA256__: string;
declare const __CUA_SESSION_STORAGE_ENTRY_SOURCE__: string;

// Hostworker contract: source 由 native builder 以 define 嵌入，host-entry 最终
// hash 覆盖；Host 只能消费这里的内存字符串，不读取 UI/env 或可替换文件。
export const candidateStorageResources = {
  tasksStorageWorker: {
    sha256: __CUA_TASKS_STORAGE_WORKER_SHA256__,
    source: __CUA_TASKS_STORAGE_WORKER_SOURCE__,
  },
  sessionStorageEntry: {
    sha256: __CUA_SESSION_STORAGE_ENTRY_SHA256__,
    source: __CUA_SESSION_STORAGE_ENTRY_SOURCE__,
  },
} as const;

installFatalReporting();
// candidate Host 在真实启动前安装唯一网络适配；不依赖 --jitless 下不可用的 undici wasm。
installCandidateFetch();

// 这个路径由固定 app 布局和 native launcher 已验证的 Node 可执行文件推导，
// 不来自 UI/env/argv；native launcher 自身以同一目录布局发布。
const resourcesDir = dirname(realpathSync(process.execPath));
const launcherPath = join(resourcesDir, "..", "MacOS", "macos-cua-desktop-session");

await startSealedNodeHostEntry({
  agentRuntime: {
    launcherPath,
    entryName: "cli-entry.mjs",
    cliInFd: 6,
    cliOutFd: 7,
  },
  storageResources: candidateStorageResources,
});
