import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeReplRunResult } from "@zcode/core/repl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";
import { CELL_RUN_FLAG } from "../src/cell-protocol.js";
import { readSealedResourceSnapshot } from "../src/sealed-resource.js";
import { createSubprocessNodeReplExecutor } from "../src/subprocess-executor.js";
import { resolveCellSnapshotLaunch } from "../src/subprocess-launch.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const buildTimeoutMs = 120_000;
const requestMeta = { session_id: "snapshot-session", workspace_path: "/workspace" };

function cellModule(marker: string): string {
  return [
    'import { createReadStream, createWriteStream } from "node:fs";',
    'let input = "";',
    'for await (const chunk of createReadStream("", { fd: 3, encoding: "utf8", autoClose: true })) {',
    "  input += chunk;",
    '  if (input.includes("\\n")) break;',
    "}",
    'const request = JSON.parse(input.slice(0, input.indexOf("\\n")));',
    "const writeLine = async (line) => await new Promise((resolve) => {",
    '  const stream = createWriteStream("", { fd: 4, autoClose: true });',
    '  stream.once("close", resolve);',
    "  stream.end(line);",
    "});",
    `await writeLine(\`\${JSON.stringify({ version: 1, invocationId: request.invocationId, ok: true, result: { logs: "", result: ${JSON.stringify(marker)} } })}\\n\`);`,
    "process.exit(0);",
  ].join("\n");
}

function resultText(result: NodeReplRunResult): string {
  if (result.error) {
    throw new Error(`cell error: ${result.error.name}: ${result.error.message}`);
  }
  if (result.result === undefined) {
    throw new Error(`cell returned no result: ${JSON.stringify(result)}`);
  }
  return result.result;
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForDead(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} is still alive`);
}

function executeSnapshot(input: {
  serverPath: string;
  sourceSnapshot: string;
  code?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}) {
  return createSubprocessNodeReplExecutor({
    serverPath: input.serverPath,
    sourceSnapshot: input.sourceSnapshot,
    cwd: packageRoot,
    abortGraceMs: 100,
    requestMaxBytes: 2 * 1024 * 1024,
    responseMaxBytes: 32 * 1024 * 1024,
    ...(input.env ? { env: input.env } : {}),
  })({
    code: input.code ?? "1 + 1",
    requestMeta,
    signal: input.signal ?? AbortSignal.timeout(30_000),
    syncTimeoutMs: 20_000,
  });
}

describe.skipIf(process.platform === "win32")("sealed cell source snapshot execution", () => {
  let directory = "";
  let bundlePath = "";
  let bundleSource = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-cell-snapshot-"));
    bundlePath = join(directory, "server.mjs");
    await buildNodeReplHostBundle({ outfile: bundlePath, cuaHelperBuildId: "" });
    bundleSource = await readFile(bundlePath, "utf8");
  }, buildTimeoutMs);

  afterAll(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it("uses the fixed Node stdin ESM launch shape", () => {
    expect(resolveCellSnapshotLaunch({ execPath: "/signed/node" })).toEqual({
      command: "/signed/node",
      args: ["--jitless", "--input-type=module", "-", CELL_RUN_FLAG],
    });
  });

  it("runs the current real bundle from stdin with jitless and without source in argv/env", async () => {
    const marker = "CUA_SNAPSHOT_MARKER_7f3d";
    const sourceWithMarker = `${bundleSource}\n// ${marker}\n`;
    const result = await executeSnapshot({
      serverPath: bundlePath,
      sourceSnapshot: sourceWithMarker,
      code: "JSON.stringify({ argv: process.argv, execArgv: process.execArgv, env: process.env })",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ZCODE_CUA_PERMISSION_BROKER_TOKEN: "synthetic-token",
        NODE_OPTIONS: "--inspect=127.0.0.1:65531",
      },
    });
    const value = JSON.parse(resultText(result)) as {
      argv: string[];
      execArgv: string[];
      env: Record<string, string>;
    };

    expect(value.argv).toEqual([process.execPath, "-", CELL_RUN_FLAG]);
    expect(value.execArgv).toEqual(["--jitless", "--input-type=module"]);
    expect(Object.keys(value.env).filter((key) => key.startsWith("ZCODE_"))).toEqual([]);
    expect(value.env.NODE_OPTIONS).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain(marker);
  }, 60_000);

  it("aborts a real stdin snapshot cell that never returns", async () => {
    const pidFile = join(directory, "snapshot-abort.pid");
    const controller = new AbortController();
    const execution = executeSnapshot({
      serverPath: bundlePath,
      sourceSnapshot: bundleSource,
      code: [
        'const fs = await import("node:fs");',
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "await new Promise((resolve) => setTimeout(resolve, 60000));",
      ].join("\n"),
      signal: controller.signal,
    });
    const outcome = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    const pid = await waitForFile(pidFile);
    controller.abort(new Error("snapshot abort"));
    await expect(outcome).resolves.toMatchObject({ message: "snapshot abort" });
    await waitForDead(pid);
  }, 15_000);

  it("demonstrates the opening path launch executing replaced bytes after verification", async () => {
    const path = join(directory, "path-launch.mjs");
    await writeFile(path, cellModule("ORIGINAL"), "utf8");
    const verified = await readSealedResourceSnapshot({
      path,
      expectedSha256: createHash("sha256").update(cellModule("ORIGINAL")).digest("hex"),
      maxBytes: 64 * 1024,
      expectedUid: process.getuid?.(),
    });
    expect(verified.source).toContain("ORIGINAL");
    await writeFile(path, cellModule("MUTATED"), "utf8");

    const pathExecutor = createSubprocessNodeReplExecutor({
      serverPath: path,
      cwd: packageRoot,
      abortGraceMs: 100,
    });
    const result = await pathExecutor({
      code: "ignored by fixture",
      requestMeta,
      signal: AbortSignal.timeout(10_000),
      syncTimeoutMs: 5_000,
    });
    expect(resultText(result)).toBe("MUTATED");
  });

  it("keeps executing verified bytes after the source is replaced in place", async () => {
    const path = join(directory, "overwrite.mjs");
    await writeFile(path, cellModule("ORIGINAL"), "utf8");
    const snapshot = await readSealedResourceSnapshot({
      path,
      expectedSha256: createHash("sha256").update(cellModule("ORIGINAL")).digest("hex"),
      maxBytes: 64 * 1024,
      expectedUid: process.getuid?.(),
    });
    await writeFile(path, cellModule("MUTATED"), "utf8");

    const result = await executeSnapshot({
      serverPath: path,
      sourceSnapshot: snapshot.source,
    });
    expect(resultText(result)).toBe("ORIGINAL");
  });

  it("keeps executing verified bytes after the source is renamed away", async () => {
    const path = join(directory, "rename.mjs");
    await writeFile(path, cellModule("ORIGINAL"), "utf8");
    const snapshot = await readSealedResourceSnapshot({
      path,
      expectedSha256: createHash("sha256").update(cellModule("ORIGINAL")).digest("hex"),
      maxBytes: 64 * 1024,
      expectedUid: process.getuid?.(),
    });
    await rename(path, `${path}.moved`);

    const result = await executeSnapshot({
      serverPath: path,
      sourceSnapshot: snapshot.source,
    });
    expect(resultText(result)).toBe("ORIGINAL");
  });

  it("keeps executing verified bytes after the source is unlinked", async () => {
    const path = join(directory, "unlink.mjs");
    await writeFile(path, cellModule("ORIGINAL"), "utf8");
    const snapshot = await readSealedResourceSnapshot({
      path,
      expectedSha256: createHash("sha256").update(cellModule("ORIGINAL")).digest("hex"),
      maxBytes: 64 * 1024,
      expectedUid: process.getuid?.(),
    });
    await unlink(path);

    const result = await executeSnapshot({
      serverPath: path,
      sourceSnapshot: snapshot.source,
    });
    expect(resultText(result)).toBe("ORIGINAL");
  });

  it("refuses to combine a verified snapshot with a launch override", () => {
    expect(() =>
      createSubprocessNodeReplExecutor({
        serverPath: bundlePath,
        sourceSnapshot: bundleSource,
        launch: { command: "/signed/node", args: ["/other/server.mjs"] },
      }),
    ).toThrow(/launch override/u);
  });
});
