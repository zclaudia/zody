import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duplex, type Readable, type Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createControlChannel,
  type ControlChannel,
  type ControlChannelAckResult,
} from "@zody/zody-cua/control-channel";
import type { ControlBinding } from "@zody/zody-cua/control-protocol";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";
import { ZODY_NODE_REPL_CONTROL_FLAG, isControlOnlyInvocation } from "../src/control-only.js";

describe("control-only marker", () => {
  it("activates only the new flag", () => {
    expect(isControlOnlyInvocation(["node", "server", "--zody-node-repl-control"])).toBe(true);
    expect(isControlOnlyInvocation(["node", "server", "--zcode-node-repl-control"])).toBe(false);
  });
});

const buildTimeoutMs = 120_000;
const waitTimeoutMs = 10_000;
const STARTUP_PROOF_DOMAIN = "zody.cua.control.startup.v1";
const missingFdMessages: Record<number, string> = {
  3: "private bootstrap fd unavailable",
  4: "ready write failed",
  5: "private control fd unavailable",
  6: "private control fd unavailable",
};

type KeyMaterial = {
  controllerPrivate: ReturnType<typeof generateKeyPairSync>["privateKey"];
  controllerPublic: ReturnType<typeof generateKeyPairSync>["publicKey"];
  producerPrivate: ReturnType<typeof generateKeyPairSync>["privateKey"];
  producerPublic: ReturnType<typeof generateKeyPairSync>["publicKey"];
};

const binding: ControlBinding = {
  appIncarnation: "app-incarnation-control-test",
  channelId: "channel-control-test",
  controllerIncarnation: "controller-incarnation-control-test",
  producerIncarnation: "producer-incarnation-control-test",
};

function createKeys(): KeyMaterial {
  const controller = generateKeyPairSync("ed25519");
  const producer = generateKeyPairSync("ed25519");
  return {
    controllerPrivate: controller.privateKey,
    controllerPublic: controller.publicKey,
    producerPrivate: producer.privateKey,
    producerPublic: producer.publicKey,
  };
}

function startupProof(challenge: string, producerPid: number): string {
  return [
    STARTUP_PROOF_DOMAIN,
    challenge,
    binding.channelId,
    binding.controllerIncarnation,
    binding.producerIncarnation,
    binding.appIncarnation,
    String(producerPid),
  ].join("\n");
}

function createBootstrap(keys: KeyMaterial, challenge: string): string {
  return `${JSON.stringify({
    version: 1,
    kind: "zody.cua.control.bootstrap",
    binding,
    challenge,
    producerKeyId: "producer",
    producerPrivateKeyPkcs8: keys.producerPrivate
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    controllerKeyId: "controller",
    controllerPublicKeySpki: keys.controllerPublic
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  })}\n`;
}

function rejectProducerRequest(): ControlChannelAckResult {
  return {
    phase: "rejected",
    facts: {
      projection: { admissionClosed: false, projectionApplied: false },
      revoked: { authorizationRevoked: false },
      stop: null,
    },
  };
}

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

async function readLine(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("control startup line exceeded limit");
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(chunk);
  }
  throw new Error("control startup stream ended before ready");
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function spawnChild(
  serverPath: string,
  options: { bootstrap?: string; extraArgs?: string[]; bootstrapFd?: boolean } = {},
): ReturnType<typeof spawn> {
  const stdio: Array<"ignore" | "pipe"> =
    options.bootstrapFd === false
      ? ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore"]
      : ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"];
  const child = spawn(
    process.execPath,
    [serverPath, ZODY_NODE_REPL_CONTROL_FLAG, ...(options.extraArgs ?? [])],
    { env: process.env, stdio },
  );
  if (options.bootstrap !== undefined) {
    (child.stdio[3] as Writable).end(options.bootstrap);
  } else {
    (child.stdio[3] as Writable | null)?.end();
  }
  return child;
}

describe("control-only node_repl entry", () => {
  let directory = "";
  let serverPath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-node-repl-control-"));
    const built = await buildNodeReplHostBundle({ outfile: join(directory, "server.mjs") });
    serverPath = built.outfile;
  }, buildTimeoutMs);

  afterAll(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it.each([3, 4, 5, 6])("fails closed when fd %i is unavailable", async (missingFd) => {
    const fixture = fileURLToPath(new URL("./fixtures/control-only-fd-reuse.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      env: { ...process.env, ZCONTROL_MISSING_FD: String(missingFd) },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    (child.stdio[3] as Writable).end(createBootstrap(createKeys(), "challenge-missing-fd"));
    try {
      const exit = await withTimeout(waitForExit(child), "child did not exit with unavailable fd");
      expect(exit).toEqual({ code: 1, signal: null });
      expect(JSON.parse(stdout)).toEqual({
        code: 1,
        selected: missingFd,
        verified: "EBADF",
        ...(missingFd === 4
          ? { closedCode: "disposed", closedCount: 1, transportClosed: true }
          : {}),
      });
      expect(stderr).toContain(missingFdMessages[missingFd]);
      expect(stderr).not.toContain("{");
      // fixture 只设置 exitCode 自然返回；父端 fd5 peer 保持打开，不得依赖强杀。
      expect(child.killed).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
  }, buildTimeoutMs);

  it(
    "cleans up when signed ready writing fails",
    async () => {
      const keys = createKeys();
      const challenge = randomBytes(32).toString("base64url");
      const child = spawnChild(serverPath, { bootstrap: createBootstrap(keys, challenge) });
      let stderr = "";
      let readyBytes = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const readyStream = child.stdio[4] as Readable;
      readyStream.setEncoding("utf8");
      readyStream.on("data", (chunk: string) => {
        readyBytes += chunk;
      });
      // 本用例验证入口清理；fstat 通过后真实写失败的精确归因由下面的受控诊断用例提供。
      // 关闭父端读端后 fd4 写端仍有效，signed ready 不会送达；fd5 写端保持打开。
      readyStream.destroy();
      try {
        const exit = await withTimeout(waitForExit(child), "ready write failure did not exit");
        expect(exit).toEqual({ code: 1, signal: null });
        expect(child.killed).toBe(false);
        expect(stderr).toContain("ready write failed");
        expect(stderr).not.toContain("{");
        expect(readyBytes).not.toContain('"kind":"ready"');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child).catch(() => undefined);
        }
      }
    },
    buildTimeoutMs,
  );

  it(
    "proves ready fstat succeeds before the real write fails with EPIPE",
    async () => {
      const fixture = fileURLToPath(new URL("./fixtures/control-only-fd-reuse.ts", import.meta.url));
      const child = spawn(process.execPath, ["--import", "tsx", fixture], {
        env: { ...process.env, ZCONTROL_READY_WRITE_DIAGNOSTIC: "1" },
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      (child.stdio[3] as Writable).end(
        createBootstrap(createKeys(), "challenge-ready-write-diagnostic"),
      );
      try {
        await withTimeout(
          waitForCondition(
            () => stdout.includes("ready-fstat-precheck\n"),
            "ready fstat precheck was not reported",
          ),
          "ready fstat precheck was not reported",
        );
        (child.stdio[4] as Readable).destroy();
        (child.stdin as Writable).write("go\n");
        const exit = await withTimeout(waitForExit(child), "ready diagnostic child did not exit");
        expect(exit).toEqual({ code: 0, signal: null });
        expect(child.killed).toBe(false);
        expect(stderr).toBe("");
        const resultLine = stdout
          .trim()
          .split("\n")
          .find((line) => line.startsWith("{"));
        expect(JSON.parse(resultLine ?? "null")).toEqual({
          cause: "EPIPE",
          phase: "ready_write_failed",
          precheck: true,
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child).catch(() => undefined);
        }
      }
    },
    buildTimeoutMs,
  );

  it(
    "keeps reused fd5/6 open after a repeated dispose",
    async () => {
      const keys = createKeys();
      const challenge = randomBytes(32).toString("base64url");
      const filePath = join(directory, "control-fd-reuse.txt");
      const fixture = fileURLToPath(new URL("./fixtures/control-only-fd-reuse.ts", import.meta.url));
      const child = spawn(process.execPath, ["--import", "tsx", fixture], {
        env: { ...process.env, ZCONTROL_CONTROL_FD_REUSE_FILE: filePath },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      (child.stdio[3] as Writable).end(createBootstrap(keys, challenge));
      try {
        const ready = JSON.parse(
          await withTimeout(
            readLine(child.stdio[4] as Readable, 4096),
            "signed ready was not received for fd reuse",
          ),
        ) as Record<string, unknown>;
        expect(
          verify(
            null,
            Buffer.from(startupProof(challenge, child.pid as number)),
            keys.producerPublic,
            Buffer.from(String(ready.signature), "base64"),
          ),
        ).toBe(true);
        const exit = await withTimeout(waitForExit(child), "control fd reuse child did not exit");
        expect(exit).toEqual({ code: 0, signal: null });
        expect(child.killed).toBe(false);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout.trim())).toEqual({
          closedCount: 1,
          code: 0,
          reused: [5, 6],
          writeError: null,
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child).catch(() => undefined);
        }
      }
    },
    buildTimeoutMs,
  );

  it(
    "settles once and closes the remaining direction when the read direction reaches EOF",
    async () => {
      const keys = createKeys();
      const challenge = randomBytes(32).toString("base64url");
      const fixture = fileURLToPath(new URL("./fixtures/control-only-fd-reuse.ts", import.meta.url));
      const child = spawn(process.execPath, ["--import", "tsx", fixture], {
        env: { ...process.env, ZCONTROL_HALF_CLOSE_REPORT: "1" },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      (child.stdio[3] as Writable).end(createBootstrap(keys, challenge));
      try {
        await withTimeout(
          readLine(child.stdio[4] as Readable, 4096),
          "signed ready was not received for half-close",
        );
        let writePeerEnded = false;
        const writePeerClosed = new Promise<void>((resolve) => {
          const stream = child.stdio[6] as Readable;
          stream.once("end", () => {
            writePeerEnded = true;
            resolve();
          });
          stream.resume();
        });
        // 在父端发送 EOF 之前，子进程不得提前退出（fixture 只在 run 返回后写 stdout）。
        expect(stdout).toBe("");
        (child.stdio[5] as Writable).end();
        const exit = await withTimeout(waitForExit(child), "half-close child did not exit");
        await withTimeout(writePeerClosed, "child write direction did not close after read EOF");
        expect(exit).toEqual({ code: 0, signal: null });
        expect(child.killed).toBe(false);
        expect(writePeerEnded).toBe(true);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout.trim())).toEqual({ closedCount: 1, code: 0 });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child).catch(() => undefined);
        }
      }
    },
    buildTimeoutMs,
  );

  it(
    "keeps the read direction active when only the write peer closes",
    async () => {
      const keys = createKeys();
      const challenge = randomBytes(32).toString("base64url");
      const fixture = fileURLToPath(new URL("./fixtures/control-only-fd-reuse.ts", import.meta.url));
      const child = spawn(process.execPath, ["--import", "tsx", fixture], {
        env: { ...process.env, ZCONTROL_HALF_CLOSE_REPORT: "1" },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      (child.stdio[3] as Writable).end(createBootstrap(keys, challenge));
      try {
        await withTimeout(
          readLine(child.stdio[4] as Readable, 4096),
          "signed ready was not received for write half-close",
        );
        (child.stdio[6] as Readable).destroy();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(stdout).toBe("");
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        (child.stdio[5] as Writable).end();
        const exit = await withTimeout(
          waitForExit(child),
          "half-close child did not exit after read EOF",
        );
        expect(exit).toEqual({ code: 0, signal: null });
        expect(child.killed).toBe(false);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout.trim())).toEqual({ closedCount: 1, code: 0 });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child).catch(() => undefined);
        }
      }
    },
    buildTimeoutMs,
  );

  it(
    "fails closed when the private bootstrap fd is not a private pipe",
    async () => {
      const bogusFd = openSync(join(directory, "not-a-private-pipe"), "w");
      const child = spawn(process.execPath, [serverPath, ZODY_NODE_REPL_CONTROL_FLAG], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", bogusFd, "ignore", "ignore", "ignore"],
      });
      closeSync(bogusFd);
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exit = await withTimeout(waitForExit(child), "child did not exit");
      expect(exit).toEqual({ code: 1, signal: null });
      expect(stderr).toContain("private bootstrap fd unavailable");
      expect(stderr).not.toContain("{");
    },
    buildTimeoutMs,
  );

  it(
    "does not echo malformed bootstrap material or key-like data",
    async () => {
      const sentinel = "BOOTSTRAP_SENTINEL_SHOULD_NOT_ECHO";
      const child = spawnChild(serverPath, {
        bootstrap: `{"privateKey":"${sentinel}","unexpected":true}\n`,
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exit = await withTimeout(waitForExit(child), "child did not exit");
      expect(exit).toEqual({ code: 1, signal: null });
      expect(stderr).toContain("invalid bootstrap");
      expect(stderr).not.toContain(sentinel);
      expect(stderr).not.toContain("privateKey");
    },
    buildTimeoutMs,
  );

  it(
    "rejects extra control-only arguments before opening the channel",
    async () => {
      const child = spawnChild(serverPath, { extraArgs: ["--arbitrary-script"] });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exit = await withTimeout(waitForExit(child), "child did not exit");
      expect(exit).toEqual({ code: 1, signal: null });
      expect(stderr).toContain("invalid control-only arguments");
    },
    buildTimeoutMs,
  );

  it(
    "validates private bootstrap, emits signed ready, and applies signed revoke/stop",
    async () => {
      const keys = createKeys();
      const challenge = randomBytes(32).toString("base64url");
      const child = spawnChild(serverPath, { bootstrap: createBootstrap(keys, challenge) });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      let controller: ControlChannel | undefined;
      try {
        const ready = JSON.parse(
          await withTimeout(
            readLine(child.stdio[4] as Readable, 4096),
            "signed ready was not received",
          ),
        ) as Record<string, unknown>;
        expect(ready).toMatchObject({
          version: 1,
          kind: "ready",
          challenge,
          binding,
          producerPid: child.pid,
        });
        expect(typeof ready.signature).toBe("string");
        expect(
          verify(
            null,
            Buffer.from(startupProof(challenge, child.pid as number)),
            keys.producerPublic,
            Buffer.from(String(ready.signature), "base64"),
          ),
        ).toBe(true);
        expect(JSON.stringify(ready)).not.toContain("private");
        expect(JSON.stringify(ready)).not.toContain(
          keys.producerPrivate
            .export({
              format: "der",
              type: "pkcs8",
            })
            .toString("base64"),
        );

        // child 读 fd5 / 写 fd6；测试 controller 必须反向使用 fd6/fd5。
        const duplex = Duplex.from({
          readable: child.stdio[6] as Readable,
          writable: child.stdio[5] as Writable,
        });
        controller = createControlChannel({
          binding,
          duplex,
          keyId: "controller",
          onRequest: rejectProducerRequest,
          privateKey: keys.controllerPrivate,
          role: "controller",
          trustedKeys: { producer: keys.producerPublic },
        });

        const revoke = await withTimeout(
          controller.request({
            operation: "revoke_submission",
            submissionLineageId: "lineage-control-test",
            authorizationRevision: 1,
          }),
          "revoke request did not settle",
        );
        expect(revoke.ack.body.phase).toBe("revoked");
        expect(revoke.evaluation.revoked).toMatchObject({
          authorizationRevoked: true,
          complete: true,
        });

        const stop = await withTimeout(
          controller.request({
            operation: "stop",
            submissionLineageId: "lineage-control-test",
            authorizationRevision: 2,
          }),
          "stop request did not settle",
        );
        expect(stop.ack.body.phase).toBe("stop_pending");
        expect(stop.ack.body.phase).not.toBe("fenced");
        expect(stop.ack.body.phase).not.toBe("drained");
        expect(stop.evaluation.stop).toMatchObject({
          nativeFenced: false,
          pending: true,
          ownedInputsReleased: false,
          leaseReleased: false,
          complete: false,
        });

        await controller.dispose();
        // 重复 dispose 必须幂等，不能再次关闭已释放或已复用的 fd。
        await controller.dispose();
        controller = undefined;
        const exit = await withTimeout(waitForExit(child), "child did not exit after dispose");
        expect(exit).toEqual({ code: 0, signal: null });
        expect(stderr).toBe("");
      } finally {
        await controller?.dispose().catch(() => undefined);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child).catch(() => undefined);
        }
      }
    },
    buildTimeoutMs,
  );
  it(
    "does not close a reused fd after bootstrap ownership is released",
    async () => {
      const keys = createKeys();
      const challenge = randomBytes(32).toString("base64url");
      const filePath = join(directory, "reused-fd.txt");
      const fixturePath = fileURLToPath(
        new URL("./fixtures/control-only-fd-reuse.ts", import.meta.url),
      );
      const tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));
      const child = spawn(
        process.execPath,
        ["--import", tsxLoaderPath, fixturePath, ZODY_NODE_REPL_CONTROL_FLAG],
        {
          env: { ...process.env, ZCONTROL_FD_REUSE_FILE: filePath },
          stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      (child.stdio[3] as Writable).end(createBootstrap(keys, challenge));

      const ready = JSON.parse(
        await withTimeout(
          readLine(child.stdio[4] as Readable, 4096),
          "signed ready was not received",
        ),
      ) as Record<string, unknown>;
      expect(
        verify(
          null,
          Buffer.from(startupProof(challenge, child.pid as number)),
          keys.producerPublic,
          Buffer.from(String(ready.signature), "base64"),
        ),
      ).toBe(true);

      const controller = createControlChannel({
        binding,
        duplex: Duplex.from({
          readable: child.stdio[6] as Readable,
          writable: child.stdio[5] as Writable,
        }),
        keyId: "controller",
        onRequest: rejectProducerRequest,
        privateKey: keys.controllerPrivate,
        role: "controller",
        trustedKeys: { producer: keys.producerPublic },
      });
      try {
        const revoke = await withTimeout(
          controller.request({
            operation: "revoke_submission",
            submissionLineageId: "lineage-fd-reuse",
            authorizationRevision: 1,
          }),
          "revoke request did not settle",
        );
        expect(revoke.ack.body.phase).toBe("revoked");
      } finally {
        await controller.dispose();
      }
      const exit = await withTimeout(waitForExit(child), "fd reuse child did not exit");
      expect(exit).toEqual({ code: 0, signal: null });
      const result = JSON.parse(stdout.trim()) as {
        code: number;
        reusedFd: number;
        writeError: string | null;
      };
      expect(result).toEqual({ code: 0, reusedFd: 3, writeError: null });
    },
    buildTimeoutMs,
  );
});
