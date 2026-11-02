import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupPackagedSourcemaps,
  removeSourceMapFilesInDirectory,
  stripSourceMappingUrlComments,
  stripSourceMappingUrlCommentsInDirectory,
} from "../scripts/packaged-sourcemap-cleanup.mjs";

describe("packaged sourcemap cleanup", () => {
  it("应删除 JS/CSS 里的 sourceMappingURL 注释但保留普通内容", () => {
    expect(
      stripSourceMappingUrlComments(
        [
          "const answer = 42;",
          "//# sourceMappingURL=index.js.map",
          "body{color:red}",
          "/*# sourceMappingURL=index.css.map */",
        ].join("\n"),
      ),
    ).toBe(["const answer = 42;", "body{color:red}"].join("\n"));
  });

  it("应递归清理发布资源目录里的 sourcemap 文件和路径注释", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "zcode-sourcemap-cleanup-test-"));
    try {
      const nestedDir = resolve(rootDir, "nested");
      mkdirSync(nestedDir, { recursive: true });
      const jsFile = resolve(nestedDir, "index.js");
      const cssFile = resolve(rootDir, "style.css");
      const mapFile = resolve(nestedDir, "index.js.map");
      const jsonFile = resolve(rootDir, "package.json");

      writeFileSync(jsFile, "console.log('ok');\n//# sourceMappingURL=index.js.map\n");
      writeFileSync(cssFile, ".x{color:red}\n/*# sourceMappingURL=style.css.map */");
      writeFileSync(mapFile, "{}");
      writeFileSync(jsonFile, '{"sourceMappingURL":"keep"}');

      expect(stripSourceMappingUrlCommentsInDirectory(rootDir)).toEqual({
        filesChanged: 2,
        referencesRemoved: 2,
      });
      expect(removeSourceMapFilesInDirectory(rootDir)).toEqual({ filesRemoved: 1 });

      expect(readFileSync(jsFile, "utf8")).toBe("console.log('ok');\n");
      expect(readFileSync(cssFile, "utf8")).toBe(".x{color:red}");
      expect(readFileSync(jsonFile, "utf8")).toBe('{"sourceMappingURL":"keep"}');
      expect(existsSync(mapFile)).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("不得改动 signed cua-narrow 槽内的 sourceMappingURL 和 map 文件", async () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "zcode-sourcemap-cleanup-signed-slot-"));
    try {
      const signedResources = resolve(
        rootDir,
        "cua-narrow",
        "Zody CUA Desktop Session.app",
        "Contents",
        "Resources",
      );
      const normalResources = resolve(rootDir, "remote-runtime");
      mkdirSync(signedResources, { recursive: true });
      mkdirSync(normalResources, { recursive: true });

      const signedEntry = resolve(signedResources, "host-entry.mjs");
      const signedMap = resolve(signedResources, "host-entry.mjs.map");
      const normalEntry = resolve(normalResources, "index.js");
      const normalMap = resolve(normalResources, "index.js.map");
      const signedSource = "export const signed = true;\n//# sourceMappingURL=host-entry.mjs.map\n";
      writeFileSync(signedEntry, signedSource);
      writeFileSync(signedMap, '{"signed":true}');
      writeFileSync(normalEntry, "console.log('ok');\n//# sourceMappingURL=index.js.map\n");
      writeFileSync(normalMap, "{}");

      await cleanupPackagedSourcemaps({
        appAsarPath: resolve(rootDir, "missing.asar"),
        resourcesDir: rootDir,
        runAsarCommand: () => undefined,
        runTimedSync: (_label, run) => run(),
        runTimedAsync: async (_label, run) => run(),
        replaceAppAsarFromStaging: async () => undefined,
        logger: { log: () => undefined },
      });

      expect(readFileSync(signedEntry, "utf8")).toBe(signedSource);
      expect(readFileSync(signedMap, "utf8")).toBe('{"signed":true}');
      expect(readFileSync(normalEntry, "utf8")).toBe("console.log('ok');\n");
      expect(existsSync(normalMap)).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
