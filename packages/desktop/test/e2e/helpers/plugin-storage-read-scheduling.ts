import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { dirname, join } from "node:path";

export const PLUGIN_READ_SCHEDULING_MARKETPLACE_ID = "e2e-plugin-read-scheduling-market";
export const PLUGIN_READ_SCHEDULING_MARKETPLACE_NAME = "E2E Plugin Read Scheduling Market";
export const PLUGIN_READ_SCHEDULING_NAME = "e2e-plugin-read-scheduling";
export const PLUGIN_READ_SCHEDULING_ID = `${PLUGIN_READ_SCHEDULING_NAME}@${PLUGIN_READ_SCHEDULING_MARKETPLACE_ID}`;
export const PLUGIN_READ_SCHEDULING_VERSION = "1.0.0";
export const PLUGIN_READ_SCHEDULING_STALLED_PATH = "/e2e-plugin-read-scheduling.zip";
// 详情读必须保持纯读：本地目录源在加入市场时已被复制进托管目录，describe 不再联网。
export const PLUGIN_READ_WARM_NAME = "e2e-plugin-read-warm";
export const PLUGIN_READ_WARM_ID = `${PLUGIN_READ_WARM_NAME}@${PLUGIN_READ_SCHEDULING_MARKETPLACE_ID}`;
export const PLUGIN_READ_WARM_SKILL_NAME = "warm-skill";

export interface StalledPluginDownloadServer {
  baseUrl: string;
  /** 等到安装流程真正发起 zip 下载，证明写闸门已被长安装占用。 */
  waitForDownload(timeoutMs?: number): Promise<void>;
  /** 断开挂起的下载，让长安装进入失败终态并释放写闸门。 */
  release(): Promise<void>;
}

export interface PluginReadSchedulingFixture {
  marketplaceRoot: string;
  marketplaceName: string;
}

/**
 * I06 桌面证据夹具：本地目录市场声明一个 URL zip 插件，zip 下载由本地服务器挂起。
 * 安装进入下载等待后仍持有 per-storageRoot 写闸门，用来验证读投影不被长写阻塞。
 */
export async function startStalledPluginDownloadServer(): Promise<StalledPluginDownloadServer> {
  const sockets = new Set<Socket>();
  let markDownloadStarted = (): void => {};
  let downloadStarted: Promise<void> | undefined = new Promise<void>((resolve) => {
    markDownloadStarted = resolve;
  });
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== PLUGIN_READ_SCHEDULING_STALLED_PATH) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    // 只发送响应头，不发送 body：安装侧的 zip 下载会一直挂起，
    // 从而保持插件存储写闸门被占用，直到 release() 主动断开连接。
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(64 * 1024 * 1024),
    });
    response.flushHeaders();
    markDownloadStarted();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Stalled plugin download server did not bind to a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return {
    baseUrl,
    async waitForDownload(timeoutMs = 30000): Promise<void> {
      await Promise.race([
        downloadStarted,
        new Promise<void>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("Plugin install did not start the zip download")),
            timeoutMs,
          );
        }),
      ]);
    },
    async release(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** 写入本地目录市场源；市场由测试在 app 启动后通过 agent 动作登记。 */
export function createPluginReadSchedulingMarketplace(input: {
  e2eHomeDir: string;
  server: StalledPluginDownloadServer;
}): PluginReadSchedulingFixture {
  const marketplaceRoot = join(input.e2eHomeDir, "fixtures", "plugin-read-scheduling-market");
  const manifest = {
    name: PLUGIN_READ_SCHEDULING_MARKETPLACE_ID,
    description: "E2E marketplace for plugin storage read scheduling",
    plugins: [
      {
        name: PLUGIN_READ_SCHEDULING_NAME,
        version: PLUGIN_READ_SCHEDULING_VERSION,
        description: "E2E plugin whose zip download is held open",
        source: {
          source: "url",
          type: "zip",
          url: `${input.server.baseUrl}${PLUGIN_READ_SCHEDULING_STALLED_PATH}`,
          // 下载被挂起后不会走到校验；固定 64 位 hex 满足 source schema。
          sha256: "0".repeat(64),
        },
      },
      {
        name: PLUGIN_READ_WARM_NAME,
        version: PLUGIN_READ_SCHEDULING_VERSION,
        description: "E2E plugin with a committed local source for detail reads",
        source: "./plugins/warm",
      },
    ],
  };
  const manifestPath = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const warmPluginRoot = join(marketplaceRoot, "plugins", "warm");
  const warmManifestPath = join(warmPluginRoot, ".claude-plugin", "plugin.json");
  mkdirSync(dirname(warmManifestPath), { recursive: true });
  writeFileSync(
    warmManifestPath,
    `${JSON.stringify(
      {
        name: PLUGIN_READ_WARM_NAME,
        version: PLUGIN_READ_SCHEDULING_VERSION,
        description: "E2E warm plugin for read scheduling",
        skills: "skills",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const skillPath = join(warmPluginRoot, "skills", PLUGIN_READ_WARM_SKILL_NAME, "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "---\ndescription: warm read scheduling skill\n---\n\n# warm\n", "utf8");
  return {
    marketplaceRoot,
    marketplaceName: PLUGIN_READ_SCHEDULING_MARKETPLACE_NAME,
  };
}
