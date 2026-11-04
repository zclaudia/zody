import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeReplHostBundle } from "../../node-repl-host/scripts/build.mjs";
import {
  buildControlOnlyChildEnvironment,
  resolveOfficialControlOnlyLauncher,
  startControlOnlyDiagnosticLauncher,
  ZODY_NODE_REPL_CONTROL_FLAG,
  type ControlOnlyDiagnosticLauncher,
  type ControlOnlyLauncherClosedEvent,
  type ControlOnlyLauncherInvalidatedEvent,
} from "../src/mcp/control-only-launcher.js";

const buildTimeoutMs = 120_000;
const waitTimeoutMs = 15_000;
const invalidationChildPath = resolve(
  import.meta.dirname,
  "fixtures/cua-submission-control-child.mjs",
);

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), waitTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function createBootstrapCapturingSpawn(): {
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  bootstrap: () => string;
} {
  let captured = "";
  return {
    spawn: (command, args, options) => {
      const child = spawn(command, [...args], options);
      const stdio = [...child.stdio];
      const writer = stdio[3] as Writable;
      stdio[3] = new Proxy(writer, {
        get(target, property) {
          if (property === "write") {
            return (chunk: string | Buffer, ...rest: unknown[]) => {
              captured += typeof chunk === "string" ? chunk : chunk.toString("utf8");
              return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
            };
          }
          if (property === "end") {
            return (chunk?: string | Buffer, ...rest: unknown[]) => {
              if (chunk !== undefined) {
                captured += typeof chunk === "string" ? chunk : chunk.toString("utf8");
              }
              return (target.end as (...args: unknown[]) => Writable)(chunk, ...rest);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Writable;
      Object.defineProperty(child, "stdio", { configurable: true, value: stdio });
      return child;
    },
    bootstrap: () => captured,
  };
}

describe("control-only diagnostic launcher", () => {
  let directory = "";
  let serverPath = "";
  let cliEntryPath = "";
  let tsxLoaderPath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-control-launcher-"));
    const built = await buildNodeReplHostBundle({ outfile: join(directory, "mcp", "server.mjs") });
    serverPath = built.outfile;
    cliEntryPath = resolve(import.meta.dirname, "../../cli/src/main.ts");
    tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));
  }, buildTimeoutMs);

  afterAll(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it("builds a trusted environment without loader, path override, or credential variables", () => {
    const env = buildControlOnlyChildEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/test",
      NODE_OPTIONS: "--inspect=0.0.0.0:9229",
      NODE_PATH: "/tmp/modules",
      NODE_DEBUG: "net",
      ZCODE_CUA_PERMISSION_BROKER_TOKEN: "secret-token",
      ZCODE_PLUGIN_ID: "computer-use@zcode-plugins-official",
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("resolves the official plugin-host launcher argument order", () => {
    const launch = resolveOfficialControlOnlyLauncher({
      cliEntryPath,
      cliPrefixArgs: ["--import", tsxLoaderPath],
      execPath: process.execPath,
      serverPath,
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([
      "--import",
      tsxLoaderPath,
      cliEntryPath,
      "__zcode-plugin-host",
      serverPath,
      ZODY_NODE_REPL_CONTROL_FLAG,
    ]);
  });

  it(
    "spawns the real official plugin host and node_repl bundle, then applies signed revoke/stop",
    async () => {
      const launch = resolveOfficialControlOnlyLauncher({
        cliEntryPath,
        cliPrefixArgs: ["--import", tsxLoaderPath],
        execPath: process.execPath,
        serverPath,
      });
      const capture = createBootstrapCapturingSpawn();
      const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
      const invalidatedEvents: ControlOnlyLauncherInvalidatedEvent[] = [];
      const lifecycleOrder: string[] = [];
      const launcher = await withTimeout(
        startControlOnlyDiagnosticLauncher({
          appIncarnation: "app-control-launcher-test",
          launch,
          onInvalidated: (event) => {
            lifecycleOrder.push("invalidated");
            invalidatedEvents.push(event);
          },
          onClosed: (event) => {
            lifecycleOrder.push("closed");
            closedEvents.push(event);
          },
          requestTimeoutMs: 5_000,
          spawn: capture.spawn,
          startupTimeoutMs: 30_000,
        }),
        "launcher did not become ready",
      );

      try {
        const binding = { ...launcher.binding };
        expect(Object.keys(binding).sort()).toEqual([
          "appIncarnation",
          "channelId",
          "controllerIncarnation",
          "producerIncarnation",
        ]);
        expect(JSON.stringify(binding)).not.toContain("private");
        expect("privateKey" in launcher).toBe(false);

        const bootstrap = JSON.parse(capture.bootstrap().trim()) as {
          producerPrivateKeyPkcs8: string;
        };
        expect(bootstrap.producerPrivateKeyPkcs8.length).toBeGreaterThan(32);
        expect(JSON.stringify(launch.args)).not.toContain(bootstrap.producerPrivateKeyPkcs8);
        const env = buildControlOnlyChildEnvironment(process.env);
        expect(Object.values(env)).not.toContain(bootstrap.producerPrivateKeyPkcs8);

        const revoke = await launcher.request({
          operation: "revoke_submission",
          submissionLineageId: "lineage-launcher-test",
          authorizationRevision: 1,
        });
        expect(revoke.ack.body.phase).toBe("revoked");
        expect(revoke.evaluation.revoked).toMatchObject({
          authorizationRevoked: true,
          complete: true,
        });

        const stop = await launcher.request({
          operation: "stop",
          submissionLineageId: "lineage-launcher-test",
          authorizationRevision: 2,
        });
        expect(stop.ack.body.phase).toBe("stop_pending");
        expect(stop.ack.body.phase).not.toBe("fenced");
        expect(stop.ack.body.phase).not.toBe("drained");
        expect(stop.evaluation.stop).toMatchObject({
          complete: false,
          leaseReleased: false,
          nativeFenced: false,
          ownedInputsReleased: false,
          pending: true,
        });
      } finally {
        const firstClose = launcher.close();
        const secondClose = launcher.close();
        expect(secondClose).toBe(firstClose);
        await withTimeout(firstClose, "launcher did not close");
      }

      expect(closedEvents).toHaveLength(1);
      expect(invalidatedEvents).toHaveLength(1);
      expect(lifecycleOrder).toEqual(["invalidated", "closed"]);
      expect(invalidatedEvents[0]).toMatchObject({ reason: "disposed" });
      expect(closedEvents[0]).toMatchObject({
        reason: "disposed",
        exitCode: 0,
        signal: null,
      });
      expect(JSON.stringify(closedEvents[0])).not.toContain("privateKey");
      await expect(
        launcher.request({
          operation: "revoke_submission",
          submissionLineageId: "lineage-after-close",
          authorizationRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "closed" });
    },
    buildTimeoutMs,
  );

  it("reports startup exit as failure once and never resolves a launcher", async () => {
    const sentinel = "STARTUP_STDERR_SENTINEL_SHOULD_NOT_ECHO";
    const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
    const invalidatedEvents: ControlOnlyLauncherInvalidatedEvent[] = [];
    const lifecycleOrder: string[] = [];
    await expect(
      startControlOnlyDiagnosticLauncher({
        appIncarnation: "app-startup-failure",
        launch: {
          args: ["-e", `process.stderr.write(${JSON.stringify(sentinel)}); process.exit(2);`],
          command: process.execPath,
        },
        onInvalidated: (event) => {
          lifecycleOrder.push("invalidated");
          invalidatedEvents.push(event);
        },
        onClosed: (event) => {
          lifecycleOrder.push("closed");
          closedEvents.push(event);
        },
        startupTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "startup_failed" });

    expect(closedEvents).toHaveLength(1);
    expect(invalidatedEvents).toHaveLength(1);
    expect(lifecycleOrder).toEqual(["invalidated", "closed"]);
    expect(closedEvents[0]).toMatchObject({ reason: "startup_failed", exitCode: 2 });
    expect(JSON.stringify(closedEvents[0])).not.toContain(sentinel);
  });

  it("fails startup when child error follows resolved ready in the same turn", async () => {
    const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
    const invalidatedEvents: ControlOnlyLauncherInvalidatedEvent[] = [];
    const logPath = join(directory, "ready-error-same-turn.log");
    await expect(
      withTimeout(
        startControlOnlyDiagnosticLauncher({
          appIncarnation: "app-ready-error-same-turn",
          launch: {
            args: [invalidationChildPath, "normal", logPath, "lineage-ready-error", "1"],
            command: process.execPath,
          },
          onClosed: (event) => {
            closedEvents.push(event);
          },
          onInvalidated: (event) => {
            invalidatedEvents.push(event);
          },
          spawn: (command, args, options) => {
            const child = spawn(command, [...args], options);
            const readySource = child.stdio[4] as Readable | null;
            if (!readySource) throw new Error("ready stream unavailable");
            const readyRelay = new PassThrough();
            let errored = false;
            readySource.on("data", (chunk: Buffer) => {
              readyRelay.write(chunk);
              if (!errored && chunk.includes(0x0a)) {
                errored = true;
                // 同一同步回合先完成 ready 写入，再发出 child error，覆盖 await 续体前的竞态。
                child.emit("error", new Error("same-turn child error"));
              }
            });
            readySource.on("end", () => readyRelay.end());
            readySource.on("error", (error) => readyRelay.destroy(error));
            const stdio = [...child.stdio];
            stdio[4] = readyRelay;
            Object.defineProperty(child, "stdio", { configurable: true, value: stdio });
            return child;
          },
          startupTimeoutMs: 5_000,
        }),
        "same-turn ready/error startup did not settle",
      ),
    ).rejects.toMatchObject({ code: "startup_failed" });

    expect(invalidatedEvents).toHaveLength(1);
    expect(closedEvents).toHaveLength(1);
    expect(invalidatedEvents[0]?.reason).toBe("startup_failed");
    expect(closedEvents[0]?.reason).toBe("startup_failed");
  });

  it("fails closed on a startup deadline and still performs observable cleanup", async () => {
    const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
    await expect(
      startControlOnlyDiagnosticLauncher({
        appIncarnation: "app-startup-timeout",
        closeTimeoutMs: 250,
        launch: { args: ["-e", "setInterval(() => {}, 1000);"], command: process.execPath },
        onClosed: (event) => {
          closedEvents.push(event);
        },
        startupTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "startup_timeout" });

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]?.reason).toBe("startup_failed");
    expect(closedEvents[0]?.message).not.toContain("setInterval");
  });

  it("turns spawn errors into a settled startup failure", async () => {
    const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
    await expect(
      startControlOnlyDiagnosticLauncher({
        appIncarnation: "app-spawn-error",
        launch: {
          args: [],
          command: join(directory, "missing-control-launcher"),
        },
        onClosed: (event) => {
          closedEvents.push(event);
        },
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "startup_failed" });
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]?.exitCode).toBeNull();
  });

  it.each(["ready-eof", "ready-protocol-error", "ready-exit"])(
    "notifies the first invalidation once before final cleanup for %s",
    async (mode) => {
      const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
      const invalidatedEvents: ControlOnlyLauncherInvalidatedEvent[] = [];
      const lifecycleOrder: string[] = [];
      const logPath = join(directory, `${mode}.log`);
      const lifecycle = {
        appIncarnation: "app-control-invalidation",
        launch: {
          args: [invalidationChildPath, mode, logPath, "lineage-launcher", "1"],
          command: process.execPath,
        },
        onInvalidated: (event: ControlOnlyLauncherInvalidatedEvent) => {
          lifecycleOrder.push("invalidated");
          invalidatedEvents.push(event);
        },
        onClosed: (event: ControlOnlyLauncherClosedEvent) => {
          lifecycleOrder.push("closed");
          closedEvents.push(event);
        },
        startupTimeoutMs: 5_000,
      };
      if (mode === "ready-exit") {
        let launcher: ControlOnlyDiagnosticLauncher | undefined;
        try {
          launcher = await withTimeout(
            startControlOnlyDiagnosticLauncher(lifecycle),
            "ready child did not settle startup",
          );
        } catch (error) {
          expect(error).toMatchObject({ code: "startup_failed" });
        }
        if (launcher) {
          await waitForCondition(
            () => invalidatedEvents.length === 1,
            "child exit invalidation did not arrive",
          );
          await withTimeout(launcher.close(), "launcher did not close");
        }
      } else {
        const launcher = await withTimeout(
          startControlOnlyDiagnosticLauncher(lifecycle),
          "child did not become ready",
        );
        await withTimeout(launcher.close(), "launcher did not close");
      }

      expect(invalidatedEvents).toHaveLength(1);
      expect(closedEvents).toHaveLength(1);
      expect(lifecycleOrder).toEqual(["invalidated", "closed"]);
      if (mode !== "ready-exit") {
        expect(["peer_eof", "protocol_error", "disposed"]).toContain(invalidatedEvents[0]?.reason);
      }
    },
  );

  it("returns the same real cleanup promise to a reentrant invalidation observer", async () => {
    const logPath = join(directory, "reentrant-invalidation.log");
    let launcher: ControlOnlyDiagnosticLauncher | undefined;
    let reentrantClose: Promise<void> | undefined;
    const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
    const started = await withTimeout(
      startControlOnlyDiagnosticLauncher({
        appIncarnation: "app-reentrant-invalidation",
        launch: {
          args: [invalidationChildPath, "normal", logPath, "lineage-reentrant", "1"],
          command: process.execPath,
        },
        onClosed: (event) => {
          closedEvents.push(event);
        },
        onInvalidated: () => {
          reentrantClose = launcher?.close();
          return Promise.reject(new Error("observer rejection must be observed"));
        },
        startupTimeoutMs: 5_000,
      }),
      "reentrant binding did not start",
    );
    launcher = started;
    const firstClose = started.close();
    expect(reentrantClose).toBe(firstClose);
    await withTimeout(Promise.all([firstClose, reentrantClose!]), "reentrant close did not finish");
    expect(closedEvents).toHaveLength(1);
    const log = await readFile(logPath, "utf8");
    expect(log).toContain('"event":"control-closed"');
  });
});
