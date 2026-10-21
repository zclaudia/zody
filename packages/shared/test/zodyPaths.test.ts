import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const injectedPathErrors = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const code = injectedPathErrors.get(String(args[0]));
      if (code) throw Object.assign(new Error(code), { code });
      return actual.statSync(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: (...args: Parameters<typeof actual.access>) => {
      const code = injectedPathErrors.get(String(args[0]));
      if (code) return Promise.reject(Object.assign(new Error(code), { code }));
      return actual.access(...args);
    },
  };
});
import {
  resolveProjectResourcePath,
  projectResourceBaseDir,
  resolveProjectResourcePaths,
  resolveProjectResourcePathsAsync,
  resolveProjectResourceRoots,
} from "../src/zody-paths.js";
import { ZCODE_DATA_ROOT_DIR_NAME } from "../src/dataDir.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zody-paths-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  injectedPathErrors.clear();
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("zody project paths", () => {
  it("uses .zody as the only user root and orders project directory candidates", () => {
    const project = makeRoot();
    expect(ZCODE_DATA_ROOT_DIR_NAME).toBe(".zody");
    expect(resolveProjectResourceRoots(project, "skills")).toEqual({
      writePath: join(project, ".zody", "skills"),
      readPaths: [join(project, ".zody", "skills"), join(project, ".zcode", "skills")],
      legacyPath: join(project, ".zcode", "skills"),
    });
    expect(projectResourceBaseDir(join(project, ".zody", "config.json"))).toBe(project);
    expect(projectResourceBaseDir(join(project, ".zcode", "config.json"))).toBe(project);
  });

  it("prefers .zody for reads and writes while retaining the legacy candidate", () => {
    const project = makeRoot();
    const paths = resolveProjectResourcePaths(project, "config.json");
    expect(paths.writePath).toBe(join(project, ".zody", "config.json"));
    expect(paths.legacyPath).toBe(join(project, ".zcode", "config.json"));
    expect(resolveProjectResourcePath(project, "config.json")).toBe(paths.writePath);

    mkdirSync(join(project, ".zcode"), { recursive: true });
    writeFileSync(paths.legacyPath, "{}", "utf8");
    expect(resolveProjectResourcePath(project, "config.json")).toBe(paths.legacyPath);

    mkdirSync(join(project, ".zody"), { recursive: true });
    writeFileSync(paths.readPath, "{}", "utf8");
    expect(resolveProjectResourcePath(project, "config.json")).toBe(paths.readPath);
  });

  it("falls back on ENOENT but propagates preferred-path access errors", async () => {
    const project = makeRoot();
    const legacyPath = join(project, ".zcode", "config.json");
    mkdirSync(join(project, ".zcode"), { recursive: true });
    writeFileSync(legacyPath, "{}", "utf8");

    await expect(resolveProjectResourcePathsAsync(project, "config.json")).resolves.toMatchObject({
      readPath: legacyPath,
      writePath: join(project, ".zody", "config.json"),
    });

    const preferredPath = join(project, ".zody", "config.json");
    injectedPathErrors.set(preferredPath, "EACCES");
    await expect(resolveProjectResourcePathsAsync(project, "config.json")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(() => resolveProjectResourcePaths(project, "config.json")).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
  });
});
