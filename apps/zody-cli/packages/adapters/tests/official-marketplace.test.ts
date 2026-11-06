import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeBundledOfficialMarketplacePartitionSync } from "../src/plugins/index.js";

describe("ZCode official marketplace partitions", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  async function makeStorageRoot(): Promise<string> {
    const storageRoot = await mkdtemp(join(tmpdir(), "zcode-official-marketplace-"));
    cleanups.push(storageRoot);
    return storageRoot;
  }

  it("writes the bundled seed as the only official catalog", async () => {
    const storageRoot = await makeStorageRoot();

    writeBundledOfficialMarketplacePartitionSync({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [
          { name: "browser-use", source: "filesystem", version: "1.0.0" },
          { name: "documents", source: "filesystem", version: "1.0.0" },
        ],
        version: 1,
      },
      storageRoot,
    });

    const merged = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { name: string; plugins: Array<{ name: string }> };
    expect(merged.name).toBe("zcode-plugins-official");
    expect(merged.plugins.map((plugin) => plugin.name)).toEqual(["browser-use", "documents"]);
  });

  it("ignores and removes a legacy CDN partition", async () => {
    const storageRoot = await makeStorageRoot();
    const marketplaceRoot = join(storageRoot, "marketplaces", "zcode-plugins-official");
    await mkdir(marketplaceRoot, { recursive: true });

    // 模拟旧版本升级：磁盘上残留 CDN 分片。fork（F6.2）后它不得再进入合并目录。
    await writeFile(
      join(marketplaceRoot, "cdn-marketplace.json"),
      JSON.stringify({
        name: "zcode-plugins-official",
        plugins: [{ name: "remote", source: { source: "url", type: "zip" } }],
      }),
    );
    writeBundledOfficialMarketplacePartitionSync({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "bundled-v2", source: "sea", version: "2.0.0" }],
        version: 1,
      },
      storageRoot,
    });

    const merged = JSON.parse(
      await readFile(join(marketplaceRoot, "marketplace.json"), "utf8"),
    ) as { plugins: Array<{ name: string }> };
    expect(merged.plugins.map((plugin) => plugin.name)).toEqual(["bundled-v2"]);
    await expect(stat(join(marketplaceRoot, "cdn-marketplace.json"))).rejects.toThrow();
  });

  it("does not rewrite unchanged official marketplace files", async () => {
    const storageRoot = await makeStorageRoot();
    const bundledManifest = {
      name: "zcode-plugins-official",
      plugins: [{ name: "bundled", source: "filesystem", version: "1.0.0" }],
    };
    const marketplaceRoot = join(storageRoot, "marketplaces", "zcode-plugins-official");

    writeBundledOfficialMarketplacePartitionSync({
      manifest: bundledManifest,
      storageRoot,
    });
    const paths = [
      join(marketplaceRoot, "bundled-marketplace.json"),
      join(marketplaceRoot, "marketplace.json"),
    ];
    const firstMtimes = await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs));
    await delay(30);

    writeBundledOfficialMarketplacePartitionSync({
      manifest: bundledManifest,
      storageRoot,
    });

    expect(await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs))).toEqual(
      firstMtimes,
    );
  });

  it("rejects a manifest that is not named after the official marketplace", async () => {
    const storageRoot = await makeStorageRoot();

    expect(() =>
      writeBundledOfficialMarketplacePartitionSync({
        manifest: { name: "zcode-plugins", plugins: [] },
        storageRoot,
      }),
    ).toThrow("Official marketplace manifest must be named zcode-plugins-official");
  });
});
