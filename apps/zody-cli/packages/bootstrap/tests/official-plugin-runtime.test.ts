import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  isOfficialPluginRuntimeManifestCurrent,
  writeOfficialPluginRuntimeManifest,
} from "../src/app/official-plugin-runtime.js";

describe("official plugin runtime manifest", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("does not rewrite an unchanged runtime manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-manifest-"));
    cleanups.push(root);
    const manifestPath = join(root, ".zody-plugin", "plugin.json");
    await writeJson(manifestPath, {
      mcpServers: {
        "browser-use": {
          args: [],
          command: "old-node",
        },
      },
      name: "browser-use",
    });
    process.argv[1] = join(root, "zody.cjs");

    writeOfficialPluginRuntimeManifest({
      pluginName: "browser-use",
      rootPath: root,
    });
    const expectedContents = await readFile(manifestPath, "utf8");
    const firstStat = await stat(manifestPath);
    await delay(30);

    writeOfficialPluginRuntimeManifest({
      pluginName: "browser-use",
      rootPath: root,
    });
    const secondStat = await stat(manifestPath);

    expect(await readFile(manifestPath, "utf8")).toBe(expectedContents);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("re-renders a legacy manifest into the canonical path without touching legacy bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-upgrade-"));
    cleanups.push(root);
    const legacyPath = join(root, ".zcode-plugin", "plugin.json");
    const canonicalPath = join(root, ".zody-plugin", "plugin.json");
    // 模拟升级前缓存：只有旧格式 manifest，且 args 里持久化了旧隐藏命令。
    await writeRaw(legacyPath, legacyManifestContents("__zcode-plugin-host"));
    const legacyBytes = await readFile(legacyPath, "utf8");
    process.argv[1] = join(root, "zody.cjs");

    expect(
      isOfficialPluginRuntimeManifestCurrent({
        pluginName: "browser-use",
        rootPath: root,
      }),
    ).toBe(false);

    writeOfficialPluginRuntimeManifest({
      pluginName: "browser-use",
      rootPath: root,
    });

    const canonicalContents = await readFile(canonicalPath, "utf8");
    expect(canonicalContents).toContain("__zody-plugin-host");
    expect(canonicalContents).not.toContain("__zcode-plugin-host");
    // 旧格式字节保留（R30 preserve-legacy-discovery），不清理也不改写。
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBytes);
    expect(
      isOfficialPluginRuntimeManifestCurrent({
        pluginName: "browser-use",
        rootPath: root,
      }),
    ).toBe(true);
  });

  it("keeps invalid mcpServers structural errors fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-invalid-"));
    cleanups.push(root);
    await writeJson(join(root, ".zcode-plugin", "plugin.json"), {
      mcpServers: "invalid",
      name: "browser-use",
    });
    process.argv[1] = join(root, "zody.cjs");

    expect(() =>
      writeOfficialPluginRuntimeManifest({
        pluginName: "browser-use",
        rootPath: root,
      }),
    ).toThrow("Official plugin manifest has invalid mcpServers.");
  });
});

function legacyManifestContents(hostCommand: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        "browser-use": {
          args: ["zody.cjs", hostCommand, "dist/mcp/server.js"],
          command: "old-node",
        },
      },
      name: "browser-use",
    },
    null,
    2,
  )}\n`;
}

async function writeRaw(path: string, contents: string): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  await writeFile(path, contents);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeRaw(path, `${JSON.stringify(value, null, 2)}\n`);
}
