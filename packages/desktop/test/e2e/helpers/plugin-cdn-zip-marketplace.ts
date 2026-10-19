import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

export const PLUGIN_CDN_ZIP_MARKETPLACE_SPEC = "plugin-cdn-zip-marketplace-install.test.ts";
// 固定未来时间作为确定性 lastUpdated；fork（F6.2）已移除商店进入自动刷新，仅保持 fixture 稳定。
export const PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED = "2099-01-01T00:00:00.000Z";
// fork（F6.2）：官方市场只由本地 seed 提供，URL zip fixture 改用独立市场 id，
// 避免与 zcode-plugins-official 的 seed 记录冲突。
export const PLUGIN_CDN_ZIP_MARKETPLACE_ID = "e2e-cdn-zip-marketplace";
export const PLUGIN_CDN_ZIP_MARKETPLACE_NAME = "E2E CDN Zip Marketplace";
export const PLUGIN_CDN_ZIP_NAME = "e2e-cdn-zip-plugin";
export const PLUGIN_CDN_ZIP_ID = `${PLUGIN_CDN_ZIP_NAME}@${PLUGIN_CDN_ZIP_MARKETPLACE_ID}`;
export const PLUGIN_CDN_ZIP_VERSION = "7.8.9";
export const PLUGIN_CDN_ZIP_ARCHIVE_PATH = "/e2e-cdn-zip-plugin.zip";

export interface PluginCdnZipFixtureServer {
  baseUrl: string;
  server: Server;
  sha256: string;
}

const PLUGIN_CDN_ZIP_FIXTURE_SPECS = [PLUGIN_CDN_ZIP_MARKETPLACE_SPEC];

function matchesSpec(specName: string, specs: string[]): boolean {
  return process.argv.concat(specs).some((spec) => spec.includes(specName));
}

export function shouldUsePluginCdnZipMarketplaceFixture(specs: string[] = []): boolean {
  return PLUGIN_CDN_ZIP_FIXTURE_SPECS.some((specName) => matchesSpec(specName, specs));
}

export async function startPluginCdnZipFixtureServer(): Promise<PluginCdnZipFixtureServer> {
  const zipBuffer = createPluginCdnZipArchive();
  const sha256 = hashBytes(zipBuffer);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== PLUGIN_CDN_ZIP_ARCHIVE_PATH) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-length": String(zipBuffer.byteLength),
      "content-type": "application/zip",
    });
    response.end(zipBuffer);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Plugin CDN zip fixture server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    server,
    sha256,
  };
}

export async function stopPluginCdnZipFixtureServer(
  fixture: PluginCdnZipFixtureServer | undefined,
): Promise<void> {
  if (!fixture?.server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    fixture.server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export function seedPluginCdnZipMarketplaceFixture(input: {
  e2eHomeDir: string;
  server: PluginCdnZipFixtureServer;
}): void {
  const pluginStorageRoot = join(input.e2eHomeDir, ".zcoder", "cli", "plugins");
  const marketplaceSourceRoot = join(
    input.e2eHomeDir,
    "fixtures",
    "plugin-cdn-zip-marketplace-source",
  );
  const zipUrl = `${input.server.baseUrl}${PLUGIN_CDN_ZIP_ARCHIVE_PATH}`;
  const manifest = {
    name: PLUGIN_CDN_ZIP_MARKETPLACE_ID,
    description: "E2E marketplace seeded before desktop startup for CDN zip install.",
    plugins: [
      {
        name: PLUGIN_CDN_ZIP_NAME,
        version: PLUGIN_CDN_ZIP_VERSION,
        description: "E2E CDN zip plugin",
        commands: ["zip-command"],
        skills: ["zip-skill"],
        source: {
          source: "url",
          type: "zip",
          url: zipUrl,
          sha256: input.server.sha256,
        },
      },
    ],
  };
  const knownMarketplaces = {
    version: 1,
    marketplaces: [
      {
        id: PLUGIN_CDN_ZIP_MARKETPLACE_ID,
        // 独立市场用本地目录作为规范 source；测试不依赖远端刷新，manifest 已直接落盘。
        source: { source: "directory", path: marketplaceSourceRoot },
        name: PLUGIN_CDN_ZIP_MARKETPLACE_NAME,
        description: manifest.description,
        addedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED,
        pluginCount: manifest.plugins.length,
      },
      // 预置 claude-plugins-official 为已加载，避免任何通用刷新路径在离线 fixture 中触发 git clone。
      {
        id: "claude-plugins-official",
        source: { source: "github", repo: "anthropics/claude-plugins-official" },
        name: "claude-plugins-official",
        description: "Deterministic offline Claude marketplace marker",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED,
        pluginCount: 1,
      },
    ],
  };

  writeJsonFileSync(join(marketplaceSourceRoot, ".claude-plugin", "marketplace.json"), manifest);
  // 运行时读取托管缓存根目录的 marketplace.json；独立市场 id 不会被 bundled seed 重建。
  writeJsonFileSync(
    join(pluginStorageRoot, "marketplaces", PLUGIN_CDN_ZIP_MARKETPLACE_ID, "marketplace.json"),
    manifest,
  );
  writeJsonFileSync(join(pluginStorageRoot, "known_marketplaces.json"), knownMarketplaces);
}

function createPluginCdnZipArchive(): Buffer {
  return createStoredZip([
    {
      path: `${PLUGIN_CDN_ZIP_NAME}-${PLUGIN_CDN_ZIP_VERSION}/.claude-plugin/plugin.json`,
      content: JSON.stringify({
        commands: "commands",
        description: "E2E CDN zip plugin",
        name: PLUGIN_CDN_ZIP_NAME,
        skills: "skills",
        version: PLUGIN_CDN_ZIP_VERSION,
      }),
    },
    {
      path: `${PLUGIN_CDN_ZIP_NAME}-${PLUGIN_CDN_ZIP_VERSION}/skills/zip-skill/SKILL.md`,
      content: [
        "---",
        "description: E2E skill loaded from a CDN zip plugin",
        "---",
        "",
        "# zip-skill",
        "",
        "Use this skill to prove CDN zip plugin discovery.",
      ].join("\n"),
    },
    {
      path: `${PLUGIN_CDN_ZIP_NAME}-${PLUGIN_CDN_ZIP_VERSION}/commands/zip-command.md`,
      content: [
        "---",
        "description: E2E command loaded from a CDN zip plugin",
        "allowed-tools: Bash",
        "---",
        "",
        "Run a zip fixture command with $ARGUMENTS.",
      ].join("\n"),
    },
  ]);
}

function createStoredZip(entries: Array<{ content?: string; path: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.content ?? "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJsonFileSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
