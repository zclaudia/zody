import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile } from "vite";
import { readDualSSHRuntimeConfig } from "./e2e/helpers/ssh-remote-p0.js";

afterEach(() => vi.unstubAllEnvs());

describe("renamed desktop environment", () => {
  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])("reads dual SSH targets (new=%s old=%s)", (current, old) => {
    for (const prefix of ["ZODY", "ZCODE"]) {
      for (const side of ["A", "B"]) {
        for (const [key, value] of Object.entries({
          HOST: `${prefix.toLowerCase()}-${side.toLowerCase()}.example.invalid`,
          USERNAME: `user-${side}`,
          PASSWORD: "synthetic-password",
          PORT: side === "A" ? "2201" : "2202",
        })) {
          vi.stubEnv(
            `${prefix}_E2E_SSH_${side}_${key}`,
            (prefix === "ZODY" ? current : old) ? value : undefined,
          );
        }
      }
    }
    if (!current) expect(() => readDualSSHRuntimeConfig("synthetic")).toThrow();
    else {
      const result = readDualSSHRuntimeConfig("synthetic");
      expect(result.targets.map(({ host, port }) => ({ host, port }))).toEqual([
        { host: "zody-a.example.invalid", port: 2201 },
        { host: "zody-b.example.invalid", port: 2202 },
      ]);
    }
  });

  it.each([
    ["1", undefined, "1"],
    [undefined, "1", ""],
    ["1", "0", "1"],
    [undefined, undefined, ""],
  ])("selects only the current Vite bridge flag", async (current, old, expected) => {
    vi.stubEnv("VITE_ZODY_E2E_STORE_BRIDGE", current);
    vi.stubEnv("VITE_ZCODE_E2E_STORE_BRIDGE", old);
    const root = resolve(import.meta.dirname, "..");
    const result = await loadConfigFromFile(
      { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
      resolve(root, "vite.config.ts"),
      root,
      "silent",
    );
    expect(result?.config.define?.["import.meta.env.VITE_ZODY_E2E_STORE_BRIDGE"]).toBe(
      JSON.stringify(expected),
    );
  });
});
