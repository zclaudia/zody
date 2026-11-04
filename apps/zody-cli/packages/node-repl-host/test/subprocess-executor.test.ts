import { createServer, type Server } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NodeReplRunResult } from "@zody/core/repl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";
import { createSubprocessNodeReplExecutor } from "@zody/node-repl-host/subprocess-executor";
import { NODE_REPL_BROWSER_BRIDGE_SYMBOL } from "../src/runtime-bridge.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const buildTimeoutMs = 120_000;
const requestMeta = { session_id: "session-1", workspace_path: "/workspace" };

function resultObject(result: NodeReplRunResult): Record<string, unknown> {
  if (!result.result) throw new Error("node_repl result is empty");
  return JSON.parse(result.result) as Record<string, unknown>;
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

async function waitForFile(path: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function writeFixture(directory: string, name: string, body: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(
    path,
    [
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
      body,
    ].join("\n"),
    "utf8",
  );
  return path;
}

describe("candidate subprocess node_repl executor", () => {
  let directory = "";
  let serverPath = "";

  const execute = (
    code: string,
    overrides: Partial<Parameters<typeof createSubprocessNodeReplExecutor>[0]> = {},
    input: {
      signal?: AbortSignal;
      syncTimeoutMs?: number;
      requestMeta?: Record<string, unknown>;
    } = {},
  ) =>
    createSubprocessNodeReplExecutor({
      serverPath,
      cwd: packageRoot,
      abortGraceMs: 100,
      requestMaxBytes: 2 * 1024 * 1024,
      responseMaxBytes: 32 * 1024 * 1024,
      env: { ...process.env },
      ...overrides,
    })({
      code,
      requestMeta: input.requestMeta ?? requestMeta,
      signal: input.signal ?? AbortSignal.timeout(30_000),
      syncTimeoutMs: input.syncTimeoutMs ?? 20_000,
    });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-node-repl-subprocess-"));
    serverPath = join(directory, "server.mjs");
    await buildNodeReplHostBundle({ outfile: serverPath, cuaHelperBuildId: "" });
  }, buildTimeoutMs);

  afterAll(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it("runs every call in a real child process with fresh globals and no process reuse", async () => {
    const first = await execute(
      "globalThis.cellOnly = 41; ({ pid: process.pid, value: globalThis.cellOnly });",
    );
    const second = await execute(
      "({ pid: process.pid, leaked: typeof globalThis.cellOnly, argv: process.argv });",
    );
    const firstValue = resultObject(first);
    const secondValue = resultObject(second);

    expect(firstValue.value).toBe(41);
    expect(secondValue.leaked).toBe("undefined");
    expect(secondValue.pid).not.toBe(firstValue.pid);
    expect(firstValue.pid).not.toBe(process.pid);
    expect(secondValue.pid).not.toBe(process.pid);
    expect(secondValue.argv).toContain("--zcode-node-repl-cell");
    // 成功结果只能在直接子进程 exit 后返回；返回时 PID 必须已经消失。
    await waitForDead(Number(firstValue.pid));
    await waitForDead(Number(secondValue.pid));
  });

  it("does not reuse the module cache across cells", async () => {
    const modulePath = join(directory, "cache-state.cjs");
    await writeFile(
      modulePath,
      "globalThis.__zcodeModuleLoads = (globalThis.__zcodeModuleLoads ?? 0) + 1; module.exports = globalThis.__zcodeModuleLoads;\n",
      "utf8",
    );
    const code = `require(${JSON.stringify(modulePath)});`;
    const first = await execute(code);
    const second = await execute(code);
    expect(first.result).toBe("1");
    expect(second.result).toBe("1");
  });

  it("closes the original request fd before model code runs", async () => {
    // vm.runInContext 的同步 timeout 资源会在执行期间复用数字 fd 3（FIFO）。因此不能用
    // 同步 fstatSync(3) 判断请求管道仍打开；异步 probe 在 VM 资源释放后看到 EBADF。
    const result = await execute(
      [
        "(async () => {",
        '  const fs = require("node:fs");',
        "  const probe = () => new Promise((resolve) => fs.fstat(3, (error, stat) =>",
        "    resolve(error ? { open: false, code: error.code } : { open: true, fifo: stat.isFIFO() })));",
        "  await new Promise((resolve) => setTimeout(resolve, 0));",
        "  return probe();",
        "})();",
      ].join("\n"),
    );
    expect(JSON.parse(result.result ?? "{}")).toEqual({ open: false, code: "EBADF" });
  });

  it("inherits only the allowlisted environment and never the parent debug/Helper credentials", async () => {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ZCODE_TEST_SECRET: "synthetic-secret",
      ZCODE_CUA_PERMISSION_BROKER_TOKEN: "synthetic-cua-token",
      ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET: "/tmp/synthetic-browser.sock",
      ZODY_NODE_REPL_BROWSER_BROKER_SOCKET: "/tmp/synthetic-browser-new.sock",
      ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN: "synthetic-browser-token",
      ZODY_NODE_REPL_BROWSER_BROKER_TOKEN: "synthetic-browser-new-token",
      NODE_OPTIONS: "--inspect=127.0.0.1:65531",
      NODE_PATH: "/tmp/synthetic-node-path",
      ELECTRON_RUN_AS_NODE: "1",
    };
    const result = await execute(
      "({ env: process.env, execArgv: process.execArgv, electron: process.versions.electron });",
      { env },
    );
    const value = resultObject(result) as {
      env: Record<string, string>;
      execArgv: string[];
      electron?: string;
    };

    expect(value.env.HOME).toBe(process.env.HOME);
    expect(Object.keys(value.env).filter((key) => (key.startsWith("ZCODE_") || key.startsWith("ZODY_")))).toEqual([]);
    expect(value.env.NODE_OPTIONS).toBeUndefined();
    expect(value.env.NODE_PATH).toBeUndefined();
    expect(value.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(value.execArgv).toEqual([]);
    expect(value.electron).toBeUndefined();
  });

  it("does not expose old or new synthetic broker tokens to the child", async () => {
    const result = await execute(
      "({ oldPresent: process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN !== undefined, newPresent: process.env.ZODY_CUA_PERMISSION_BROKER_TOKEN !== undefined })",
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ZCODE_CUA_PERMISSION_BROKER_TOKEN: "synthetic-old-token",
          ZODY_CUA_PERMISSION_BROKER_TOKEN: "synthetic-new-token",
        },
      },
    );
    expect(resultObject(result)).toEqual({ oldPresent: false, newPresent: false });
  });

  it("only adds --jitless when the trusted composition explicitly requests it", async () => {
    const result = await execute("process.execArgv;", { jitless: true });
    expect(JSON.parse(result.result ?? "[]")).toEqual(["--jitless"]);
  });

  it("does not treat stdout/stderr diagnostics as the cell protocol", async () => {
    const result = await execute(
      'require("node:fs").writeSync(1, "raw-stdout-noise\\n"); require("node:fs").writeSync(2, "raw-stderr-noise\\n"); "ok";',
    );
    expect(result.result).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("delivers a large chunked response without truncating the tail", async () => {
    const result = await execute(
      'const value = "尾".repeat(1_000_000) + "😀".repeat(500_000); value;',
    );
    expect(result.result).toHaveLength(2_000_000);
    expect(result.result?.endsWith("😀")).toBe(true);
    expect(result.result).not.toContain("\uFFFD");
  });

  it("actually terminates the direct child on abort, before rejecting", async () => {
    const pidFile = join(directory, "abort.pid");
    const controller = new AbortController();
    const execution = execute(
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 60000));`,
      { abortGraceMs: 100 },
      { signal: controller.signal },
    );
    const outcome = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    const pid = await waitForFile(pidFile);
    controller.abort(new Error("synthetic abort"));
    await expect(outcome).resolves.toMatchObject({ message: "synthetic abort" });
    await waitForDead(pid);
  });

  it("actually terminates the direct child on the caller timeout", async () => {
    const pidFile = join(directory, "timeout.pid");
    const controller = new AbortController();
    const execution = execute(
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 60000));`,
      { abortGraceMs: 100 },
      { signal: controller.signal },
    );
    const outcome = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    const pid = await waitForFile(pidFile);
    // 冷启动不进入 timeout 窗口：先在子进程里拿到 PID，再让调用方 deadline 触发。
    controller.abort(new DOMException("synthetic timeout", "TimeoutError"));
    await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
    await waitForDead(pid);
  });

  it("does not let a descendant holding fd4 stall cancellation", async () => {
    const descPidFile = join(directory, "descendant.pid");
    const cellPidFile = join(directory, "cell.pid");
    const controller = new AbortController();
    let descendantPid: number | undefined;
    try {
      const execution = execute(
        [
          'const fs = require("node:fs");',
          'const { spawn } = require("node:child_process");',
          "fs.writeFileSync(" + JSON.stringify(cellPidFile) + ", String(process.pid));",
          'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {',
          '  stdio: ["ignore", "inherit", "inherit", "ignore", 4],',
          "});",
          "fs.writeFileSync(" + JSON.stringify(descPidFile) + ", String(descendant.pid));",
          "await new Promise((resolve) => setTimeout(resolve, 60000));",
        ].join("\n"),
        { abortGraceMs: 100 },
        { signal: controller.signal },
      );
      const outcome = execution.then(
        () => undefined,
        (error: unknown) => error,
      );
      const cellPid = await waitForFile(cellPidFile);
      descendantPid = await waitForFile(descPidFile);
      const started = Date.now();
      controller.abort(new Error("cancel with inherited fd4"));
      await expect(outcome).resolves.toMatchObject({ message: "cancel with inherited fd4" });
      expect(Date.now() - started).toBeLessThan(3000);
      await waitForDead(cellPid);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // 后代进程可能已自行退出；测试只负责不在本机留下它。
        }
      }
    }
  });

  it("rejects a forged success frame when the direct child exits non-zero", async () => {
    const fixture = await writeFixture(
      directory,
      "nonzero.mjs",
      'await writeLine(`${JSON.stringify({ version: 1, invocationId: request.invocationId, ok: true, result: { logs: "", result: "forged" } })}\\n`);\nprocess.exit(1);',
    );
    await expect(
      createSubprocessNodeReplExecutor({ serverPath: fixture, cwd: packageRoot })({
        code: "ignored",
        requestMeta,
        signal: AbortSignal.timeout(10_000),
        syncTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited with code=1/u);
  });

  it("propagates a structured error frame before rejecting the non-zero exit", async () => {
    const fixture = await writeFixture(
      directory,
      "error-frame.mjs",
      'await writeLine(`${JSON.stringify({ version: 1, invocationId: request.invocationId, ok: false, error: { name: "FixtureError", message: "structured failure" } })}\\n`);\nprocess.exit(1);',
    );
    await expect(
      createSubprocessNodeReplExecutor({ serverPath: fixture, cwd: packageRoot })({
        code: "ignored",
        requestMeta,
        signal: AbortSignal.timeout(10_000),
        syncTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ name: "FixtureError", message: "structured failure" });
  });

  it("rejects an invocation mismatch and a truncated frame", async () => {
    const mismatch = await writeFixture(
      directory,
      "mismatch.mjs",
      'await writeLine(`${JSON.stringify({ version: 1, invocationId: "other-invocation", ok: true, result: { logs: "", result: "x" } })}\\n`);\nprocess.exit(0);',
    );
    await expect(
      createSubprocessNodeReplExecutor({ serverPath: mismatch, cwd: packageRoot })({
        code: "ignored",
        requestMeta,
        signal: AbortSignal.timeout(10_000),
        syncTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/invocationId mismatch/u);

    const truncated = await writeFixture(
      directory,
      "truncated.mjs",
      "await writeLine('{\"version\":1');\nprocess.exit(0);",
    );
    await expect(
      createSubprocessNodeReplExecutor({ serverPath: truncated, cwd: packageRoot })({
        code: "ignored",
        requestMeta,
        signal: AbortSignal.timeout(10_000),
        syncTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/before returning a result/u);
  });

  it("rejects and terminates an oversized response", async () => {
    const oversized = await writeFixture(
      directory,
      "oversized.mjs",
      'await writeLine("x".repeat(200));\nprocess.exit(0);',
    );
    await expect(
      createSubprocessNodeReplExecutor({
        serverPath: oversized,
        cwd: packageRoot,
        responseMaxBytes: 100,
        abortGraceMs: 100,
      })({
        code: "ignored",
        requestMeta,
        signal: AbortSignal.timeout(10_000),
        syncTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exceeded 100 bytes/u);
  });

  it("rejects non-bundle server paths instead of pretending a source module is runnable", () => {
    expect(() =>
      createSubprocessNodeReplExecutor({ serverPath: join(packageRoot, "src/server.ts") }),
    ).toThrow(/built \.js\/\.mjs/u);
  });

  it("injects the real Browser bridge symbol and keeps env-only brokers unavailable", async () => {
    const browserSymbol = Symbol.keyFor(NODE_REPL_BROWSER_BRIDGE_SYMBOL);
    const result = await execute(
      [
        `const bridge = globalThis[Symbol.for(${JSON.stringify(browserSymbol)})];`,
        'if (!bridge) return "missing";',
        "try {",
        "  await bridge.list();",
        '  return "unexpected";',
        "} catch (error) {",
        "  return error.message;",
        "}",
      ].join("\n"),
      {
        env: {
          ...process.env,
          ZODY_NODE_REPL_BROWSER_BROKER_SOCKET: join(tmpdir(), "synthetic-does-not-exist.sock"),
          ZODY_NODE_REPL_BROWSER_BROKER_TOKEN: "synthetic",
        },
      },
    );
    expect(result.result).toContain("Browser control is unavailable");
  });

  it("uses an explicitly injected Browser capability but never the stripped parent env", async () => {
    const socketPath = join(tmpdir(), `znrb-${randomUUID()}.sock`);
    const browserBroker = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id?: string };
        socket.end(`${JSON.stringify({ id: request.id, ok: true, browsers: [] })}\n`);
      });
    });
    await listen(browserBroker, socketPath);
    const browserSymbol = Symbol.keyFor(NODE_REPL_BROWSER_BRIDGE_SYMBOL);
    const browserCode = [
      `const bridge = globalThis[Symbol.for(${JSON.stringify(browserSymbol)})];`,
      'if (!bridge) return "missing";',
      "try {",
      "  const browsers = await bridge.list();",
      "  return JSON.stringify(browsers);",
      "} catch (error) {",
      "  return `unavailable:${error.message}`;",
      "}",
    ].join("\n");
    try {
      const explicit = await execute(browserCode, {
        browserBroker: { socketPath, token: "synthetic" },
      });
      expect(explicit.result).toBe("[]");

      const withoutCapability = await execute(browserCode, {
        env: {
          ...process.env,
          ZODY_NODE_REPL_BROWSER_BROKER_SOCKET: socketPath,
          ZODY_NODE_REPL_BROWSER_BROKER_TOKEN: "synthetic",
        },
      });
      expect(withoutCapability.result).toContain("unavailable:");
    } finally {
      await closeServer(browserBroker);
    }
  });
});

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}


describe("CUA documentation root environment", () => {
  it.each([
    ["/synthetic/new", undefined, "/synthetic/new/docs"],
    [undefined, "/synthetic/old", "/synthetic/browser/docs"],
    ["/synthetic/new", "/synthetic/old", "/synthetic/new/docs"],
    [undefined, undefined, "/synthetic/browser/docs"],
  ])("consumes only the active CUA root", async (current, old, expected) => {
    vi.resetModules();
    vi.stubEnv("ZCODE_PLUGIN_ROOT", "/synthetic/browser");
    vi.stubEnv("ZODY_CUA_PLUGIN_ROOT", current);
    vi.stubEnv("ZCODE_CUA_PLUGIN_ROOT", old);
    try {
      const { DEFAULT_CUA_DOCUMENTATION_ROOT } = await import("../src/node-repl-session-executor.js");
      expect(DEFAULT_CUA_DOCUMENTATION_ROOT).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
