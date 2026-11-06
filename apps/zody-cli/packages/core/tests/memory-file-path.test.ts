import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  containsSensitiveMemoryPathSegment,
  resolveSafeMemoryFilePath,
} from "../src/memory/memory-file-path.js";

describe("memory file sensitive path segments", () => {
  it.each([".zody", ".zcode", ".claude", ".git"])("treats %s as sensitive", (segment) => {
    expect(containsSensitiveMemoryPathSegment(`${segment}/notes.md`)).toBe(true);
    expect(containsSensitiveMemoryPathSegment(`nested\\${segment}\\notes.md`)).toBe(true);
  });

  it("normalizes case and trailing dots for .zody", () => {
    expect(containsSensitiveMemoryPathSegment(".ZODY./agents/reviewer.md")).toBe(true);
  });

  it("rejects memory writes into a project .zody directory", () => {
    const workspaceRoot = join("/workspace", "app");
    const rootDir = workspaceRoot;
    expect(
      resolveSafeMemoryFilePath({
        filePath: join(workspaceRoot, ".zody", "agents", "reviewer.md"),
        rootDir,
        workingDirectory: workspaceRoot,
        workspaceRoot,
      }),
    ).toBeUndefined();
    expect(
      resolveSafeMemoryFilePath({
        filePath: join(workspaceRoot, "memory", "MEMORY.md"),
        rootDir,
        workingDirectory: workspaceRoot,
        workspaceRoot,
      }),
    ).toBe(join(workspaceRoot, "memory", "MEMORY.md"));
  });
});
