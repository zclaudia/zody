import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZODY_CUA_NODE_REPL_HOST_ENV_KEY,
  ZODY_CUA_OFFICIAL_PLUGIN_ID,
  ZODY_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZODY_PLUGIN_ID_ENV_KEY,
  resetCapturedZodyCuaBrokerCredentialsForTest,
  sanitizeZodyRuntimeEnvInPlace,
} from "@zody/shared";
import type { RunContext } from "@zody/shared-types";
import { runPluginHostCommand, ZODY_NODE_REPL_CONTROL_FLAG } from "../src/plugin-host-command.js";

type CapturedWriteStream = NodeJS.WriteStream & { output: () => string };

function createWriteStream(): CapturedWriteStream {
  let output = "";
  return {
    isTTY: false,
    output: () => output,
    write: ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as NodeJS.WriteStream["write"],
  } as CapturedWriteStream;
}

function createContext(argv: string[]): RunContext {
  return {
    argv,
    stderr: createWriteStream(),
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: createWriteStream(),
  };
}

const ENV_KEYS = [
  "ZODY_CUA_PERMISSION_BROKER_SOCKET",
  "ZCODE_PLUGIN_HOST_TEST_OUTPUT",
  ZODY_PLUGIN_ID_ENV_KEY,
  ZODY_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZODY_CUA_NODE_REPL_HOST_ENV_KEY,
] as const;

test("control-only plugin host does not restore captured broker credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-control-host-"));
  const serverPath = join(root, "server.mjs");
  const outputPath = join(root, "output.json");
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, JSON.stringify({
    argv: process.argv.slice(2),
    brokerSocket: process.env.ZODY_CUA_PERMISSION_BROKER_SOCKET ?? null,
  }));
}
`,
    );
    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    process.env[ZODY_PLUGIN_ID_ENV_KEY] = ZODY_CUA_OFFICIAL_PLUGIN_ID;
    process.env.ZODY_CUA_PERMISSION_BROKER_SOCKET = "/tmp/captured-control-broker.sock";
    process.env[ZODY_CUA_PLUGIN_AUTHORITY_ENV_KEY] = "captured-control-authority";
    process.env[ZODY_CUA_NODE_REPL_HOST_ENV_KEY] = "1";
    resetCapturedZodyCuaBrokerCredentialsForTest();
    sanitizeZodyRuntimeEnvInPlace(process.env);

    const ctx = createContext([ZODY_NODE_REPL_CONTROL_FLAG]);
    const exitCode = await runPluginHostCommand(ctx, [serverPath, ZODY_NODE_REPL_CONTROL_FLAG]);

    assert.equal(exitCode, 0);
    assert.equal(ctx.stderr.output(), "");
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      argv: [ZODY_NODE_REPL_CONTROL_FLAG],
      brokerSocket: null,
    });
  } finally {
    resetCapturedZodyCuaBrokerCredentialsForTest();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("control-only plugin host rejects extra arguments before importing the server", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-control-host-args-"));
  const serverPath = join(root, "server.mjs");
  const outputPath = join(root, "output.json");
  const originalOutput = process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, "imported");
export async function main() {}
`,
    );
    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    const ctx = createContext([ZODY_NODE_REPL_CONTROL_FLAG, "--script"]);
    const exitCode = await runPluginHostCommand(ctx, [
      serverPath,
      ZODY_NODE_REPL_CONTROL_FLAG,
      "--script",
    ]);

    assert.equal(exitCode, 1);
    assert.match(ctx.stderr.output(), /does not accept additional arguments/u);
    await assert.rejects(readFile(outputPath, "utf8"), { code: "ENOENT" });
  } finally {
    if (originalOutput === undefined) delete process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT;
    else process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = originalOutput;
    await rm(root, { force: true, recursive: true });
  }
});
