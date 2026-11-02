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
import { ZCODE_NODE_REPL_CONTROL_FLAG } from "../src/control-only.js";

const buildTimeoutMs = 120_000;
const waitTimeoutMs = 10_000;
const STARTUP_PROOF_DOMAIN = "zody.cua.control.startup.v1";

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
    [serverPath, ZCODE_NODE_REPL_CONTROL_FLAG, ...(options.extraArgs ?? [])],
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

  it(
    "fails closed when the private bootstrap fd is not a private pipe",
    async () => {
      const bogusFd = openSync(join(directory, "not-a-private-pipe"), "w");
      const child = spawn(process.execPath, [serverPath, ZCODE_NODE_REPL_CONTROL_FLAG], {
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
        ["--import", tsxLoaderPath, fixturePath, ZCODE_NODE_REPL_CONTROL_FLAG],
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
