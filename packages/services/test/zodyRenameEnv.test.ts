import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoredCredentialCipher } from "../src/credential/providers/credentialKeyStore.js";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import { buildAgentRuntimeEnv } from "../src/runtime-tools/agentProxyEnv.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("renamed runtime environment", () => {
  it.each([
    ["new only", "/synthetic/new", undefined, "/synthetic/new"],
    ["old only", undefined, "/synthetic/old", undefined],
    ["both", "/synthetic/new", "/synthetic/old", "/synthetic/new"],
    ["neither", undefined, undefined, undefined],
  ])("selects the data base for %s", async (_label, current, old, selected) => {
    vi.stubEnv("ZODY_DATA_BASE_DIR", current);
    vi.stubEnv("ZCODE_DATA_BASE_DIR", old);
    vi.resetModules();
    const paths = await import("../src/paths.js");
    expect(paths.getDataBaseDir()).toBe(selected ?? homedir());
    paths.setDataBaseDir("/synthetic/explicit");
    expect(paths.getDataBaseDir()).toBe("/synthetic/explicit");
  });

  it.each([
    ["new only", "synthetic-new-key", undefined, true],
    ["old only", undefined, "synthetic-old-key", false],
    ["both", "synthetic-new-key", "synthetic-old-key", true],
    ["neither", undefined, undefined, false],
  ])("selects or persists a credential key for %s", async (_label, current, old, usesCurrent) => {
    const dir = await mkdtemp(join(tmpdir(), "zody-key-matrix-"));
    dirs.push(dir);
    const file = join(dir, "credentials.json");
    const actual = await createStoredCredentialCipher(file, {
      ZODY_CREDENTIAL_SECRET: current,
      ZCODE_CREDENTIAL_SECRET: old,
    });
    const selected = usesCurrent
      ? createCredentialCipherProvider({ env: { ZODY_CREDENTIAL_SECRET: "synthetic-new-key" } })
      : await createStoredCredentialCipher(file, {});
    expect(selected.decrypt(actual.encrypt("synthetic-payload"))).toBe("synthetic-payload");
    if (!usesCurrent) {
      const legacy = createCredentialCipherProvider({
        env: { ZODY_CREDENTIAL_SECRET: "synthetic-old-key" },
      });
      expect(() => legacy.decrypt(actual.encrypt("synthetic-payload"))).toThrow();
    }
  });

  it("passes proxy configuration through the active runtime environment", () => {
    const env = buildAgentRuntimeEnv({ httpProxy: "http://127.0.0.1:39123", noProxy: "localhost" });
    expect(env).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:39123",
      ZODY_HTTP_PROXY: "http://127.0.0.1:39123",
      ZODY_NO_PROXY: "localhost",
    });
  });
});

describe("agent child command environment", () => {
  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])("resolves active command, args and cwd (new=%s old=%s)", async (current, old) => {
    const dir = await mkdtemp(join(tmpdir(), "zody-child-matrix-"));
    dirs.push(dir);
    const script =
      "process.stdout.write(JSON.stringify({cwd: process.cwd(), arg: process.argv[1], proxy: process.env.ZODY_HTTP_PROXY, provider: process.env.SYNTHETIC_PROVIDER_KEY}))";
    for (const [prefix, enabled] of [
      ["ZODY", current],
      ["ZCODE", old],
    ] as const) {
      vi.stubEnv(`${prefix}_AGENT_SERVER_COMMAND`, enabled ? process.execPath : undefined);
      vi.stubEnv(
        `${prefix}_AGENT_SERVER_ARGS_JSON`,
        enabled ? JSON.stringify(["-e", script, prefix]) : undefined,
      );
      vi.stubEnv(`${prefix}_AGENT_SERVER_CWD`, enabled ? dir : undefined);
    }
    const { resolveDefaultZodyAgentCommand } =
      await import("../src/zody-agent/zodyAgentProcessManager.js");
    const command = resolveDefaultZodyAgentCommand({ workspacePath: dir, workspaceKey: dir });
    if (!current) {
      expect(command?.args).not.toContain(script);
      return;
    }
    expect(command).toMatchObject({
      command: process.execPath,
      cwd: dir,
      args: ["-e", script, "ZODY"],
    });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const env = {
      ...buildAgentRuntimeEnv({ httpProxy: "http://127.0.0.1:39123" }),
      SYNTHETIC_PROVIDER_KEY: "synthetic-provider",
    };
    const result = await promisify(execFile)(command!.command, command!.args ?? [], {
      cwd: command!.cwd,
      env,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      arg: "ZODY",
      proxy: "http://127.0.0.1:39123",
      provider: "synthetic-provider",
    });
  });
});
