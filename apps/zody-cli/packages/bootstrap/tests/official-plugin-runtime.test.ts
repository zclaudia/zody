import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOfficialPluginRuntimeManifestCurrent,
  writeOfficialPluginRuntimeManifest,
} from "../src/app/official-plugin-runtime.js";

const deniedCanonical = vi.hoisted(() => ({ path: "", legacyPath: "", legacyReads: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      path === deniedCanonical.path ? false : actual.existsSync(path),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === deniedCanonical.path) {
        throw Object.assign(new Error("synthetic canonical access denied"), { code: "EACCES" });
      }
      if (args[0] === deniedCanonical.legacyPath) deniedCanonical.legacyReads += 1;
      return actual.readFileSync(...args);
    },
  };
});

describe("official plugin runtime manifest", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];

  afterEach(async () => {
    deniedCanonical.path = "";
    deniedCanonical.legacyPath = "";
    deniedCanonical.legacyReads = 0;
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

  it("reuses a skill-only legacy manifest without writing or changing its bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-skill-only-"));
    cleanups.push(root);
    const legacyPath = join(root, ".zcode-plugin", "plugin.json");
    const canonicalPath = join(root, ".zody-plugin", "plugin.json");
    await writeJson(legacyPath, { name: "computer-use", skills: "skills" });
    const bytes = await readFile(legacyPath);
    const before = await stat(legacyPath);
    const input = { pluginName: "computer-use", rootPath: root };

    expect(isOfficialPluginRuntimeManifestCurrent(input)).toBe(true);
    writeOfficialPluginRuntimeManifest(input);
    expect(isOfficialPluginRuntimeManifestCurrent(input)).toBe(true);
    expect(await readFile(legacyPath)).toEqual(bytes);
    expect((await stat(legacyPath)).mtimeMs).toBe(before.mtimeMs);
    await expect(stat(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["invalid-json", "directory"] as const)(
    "does not reuse skill-only legacy when canonical is %s",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-no-fallback-"));
      cleanups.push(root);
      await writeJson(join(root, ".zcode-plugin", "plugin.json"), {
        name: "computer-use",
        skills: "skills",
      });
      const canonical = join(root, ".zody-plugin", "plugin.json");
      await mkdir(dirname(canonical), { recursive: true });
      if (kind === "directory") await mkdir(canonical);
      else await writeFile(canonical, "{not json", "utf8");
      const input = { pluginName: "computer-use", rootPath: root };

      expect(isOfficialPluginRuntimeManifestCurrent(input)).toBe(false);
      expect(() => writeOfficialPluginRuntimeManifest(input)).toThrow();
    },
  );

  it.each([null, [], {}, { name: "wrong" }])(
    "rejects a canonical JSON value without the expected official identity: %j",
    async (manifest) => {
      const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-identity-"));
      cleanups.push(root);
      await writeJson(join(root, ".zcode-plugin", "plugin.json"), { name: "computer-use" });
      await writeJson(join(root, ".zody-plugin", "plugin.json"), manifest);
      const input = { pluginName: "computer-use", rootPath: root };

      expect(isOfficialPluginRuntimeManifestCurrent(input)).toBe(false);
      expect(() => writeOfficialPluginRuntimeManifest(input)).toThrow();
    },
  );

  it("writes canonical for an already rendered MCP legacy manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-rendered-legacy-"));
    cleanups.push(root);
    process.argv[1] = join(root, "zody.cjs");
    const legacyPath = join(root, ".zcode-plugin", "plugin.json");
    const canonicalPath = join(root, ".zody-plugin", "plugin.json");
    const input = { pluginName: "browser-use", rootPath: root };
    await writeRaw(legacyPath, legacyManifestContents("__zcode-plugin-host"));
    writeOfficialPluginRuntimeManifest(input);
    const rendered = await readFile(canonicalPath, "utf8");
    await writeRaw(legacyPath, rendered);
    await rm(canonicalPath);

    expect(isOfficialPluginRuntimeManifestCurrent(input)).toBe(false);
    writeOfficialPluginRuntimeManifest(input);

    expect(await readFile(canonicalPath, "utf8")).toBe(rendered);
    expect(await readFile(legacyPath, "utf8")).toBe(rendered);
    expect(isOfficialPluginRuntimeManifestCurrent(input)).toBe(true);
  });

  it("does not read legacy after canonical stat/read is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-eacces-"));
    cleanups.push(root);
    const canonicalPath = join(root, ".zody-plugin", "plugin.json");
    const legacyPath = join(root, ".zcode-plugin", "plugin.json");
    await writeJson(canonicalPath, { name: "computer-use", skills: "canonical-skills" });
    await writeJson(legacyPath, { name: "computer-use", skills: "legacy-skills" });
    deniedCanonical.path = canonicalPath;
    deniedCanonical.legacyPath = legacyPath;
    const input = { pluginName: "computer-use", rootPath: root };

    expect(isOfficialPluginRuntimeManifestCurrent(input)).toBe(false);
    expect(() => writeOfficialPluginRuntimeManifest(input)).toThrow(
      "synthetic canonical access denied",
    );
    expect(deniedCanonical.legacyReads).toBe(0);
    expect(JSON.parse(await readFile(canonicalPath, "utf8")).skills).toBe("canonical-skills");
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
