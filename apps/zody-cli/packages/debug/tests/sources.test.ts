import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDbPath, defaultLogDir } from "../server/sources.js";

describe("debug source defaults", () => {
  it("stores CLI logs and SQLite data under the only user data root", () => {
    expect(defaultLogDir()).toBe(join(homedir(), ".zody", "cli", "log"));
    expect(defaultDbPath()).toBe(join(homedir(), ".zody", "cli", "db", "db.sqlite"));
  });
});
