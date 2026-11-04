import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { pickRemoteRuntimeEnv } from "@zody/server/remote";
import { resolveRuntimeZodyEndpointOrigin } from "@zody/shared/zodyEndpoint";

const execFileAsync = promisify(execFile);
const newOrigin = "https://new.example.invalid";
const oldOrigin = "https://old.example.invalid";

const cases = [
  { name: "only new", env: { ZODY_BASE_URL: newOrigin }, expected: newOrigin },
  { name: "only old", env: { ZCODE_BASE_URL: oldOrigin }, expected: "" },
  {
    name: "both",
    env: { ZODY_BASE_URL: newOrigin, ZCODE_BASE_URL: oldOrigin },
    expected: newOrigin,
  },
  { name: "neither", env: {}, expected: "" },
] as const;

describe("R30 environment hard cut", () => {
  it.each(cases)(
    "resolves the production endpoint with $name",
    ({ env, expected }) => {
      expect(resolveRuntimeZodyEndpointOrigin(env)).toBe(expected);
    },
  );

  it.each(cases)(
    "selects remote runtime keys with $name",
    ({ env, expected }) => {
      const selected = pickRemoteRuntimeEnv(env);
      expect(selected).toEqual(expected ? { ZODY_BASE_URL: expected } : {});
    },
  );

  it("passes the new remote value to a real child without the old key or unrelated secrets", async () => {
    const selected = pickRemoteRuntimeEnv({
      ZODY_BASE_URL: newOrigin,
      ZCODE_BASE_URL: oldOrigin,
      SYNTHETIC_SECRET: "must-not-be-forwarded",
    });
    const child = await execFileAsync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({newValue: process.env.ZODY_BASE_URL ?? null, oldValue: process.env.ZCODE_BASE_URL ?? null, secret: process.env.SYNTHETIC_SECRET ?? null}))",
      ],
      { env: selected },
    );
    expect(JSON.parse(child.stdout)).toEqual({
      newValue: newOrigin,
      oldValue: null,
      secret: null,
    });
  });
});

describe("R30 Turbo environment inputs", () => {
  it.each(["build:desktop-agent", "@zody/cli#build"] as const)(
    "tracks only the new product environment in %s",
    async (task) => {
      const turbo = JSON.parse(
        await readFile(
          resolve(import.meta.dirname, "../../../turbo.json"),
          "utf8",
        ),
      ) as {
        tasks: Record<string, { env: string[] }>;
      };
      expect(turbo.tasks[task].env).toContain("ZODY_ENV");
      expect(turbo.tasks[task].env).not.toContain("ZCODE_ENV");
    },
  );
});

describe("R30 build time define", () => {
  it("derives the shared build time from the new injected define", async () => {
    vi.resetModules();
    vi.stubGlobal("__ZODY_BUILD_TIME__", "synthetic-build-time");
    try {
      const shared = await import("@zody/shared");
      expect(shared.ZODY_BUILD_TIME).toBe("synthetic-build-time");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
