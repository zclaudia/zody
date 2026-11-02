import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CuaSubmissionTurnScope } from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import {
  createCuaTestRuntime,
  createDeferred,
  cuaIntent,
  modelText,
} from "./fixtures/cua-runtime-fixture.js";

type AdapterMcpModule = typeof import("@zcode/adapters/mcp");

const waitTimeoutMs = 20_000;
const childPath = resolve(
  import.meta.dirname,
  "../../adapters/tests/fixtures/cua-submission-control-child.mjs",
);

async function resolveAdapterMcpEntry(): Promise<URL> {
  const packageJsonPath = fileURLToPath(new URL("../../adapters/package.json", import.meta.url));
  const adapterRequire = createRequire(packageJsonPath);
  const adapterPackage = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    exports?: Record<string, { import?: string }>;
  };
  const exportTarget = adapterPackage.exports?.["./mcp"]?.import;
  if (!exportTarget) {
    throw new Error("@zcode/adapters does not expose the ./mcp public entry");
  }
  // 修复原因：@zcode/adapters/mcp 仅声明 import 条件，createRequire.resolve(包名) 会抛
  // ERR_PACKAGE_PATH_NOT_EXPORTED；按同一 package.json 的 exports 目标解析并只 dynamic import 产物。
  return pathToFileURL(adapterRequire.resolve(exportTarget));
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

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWake) => setTimeout(resolveWake, 20));
  }
  throw new Error(message);
}

async function waitForActiveTurn(runtime: AgentRuntime): Promise<void> {
  await waitFor(() => runtime.getActiveTurnInfo() !== undefined, "active turn did not start");
}

type LoggedEvent = Record<string, unknown>;

async function readEvents(path: string): Promise<LoggedEvent[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LoggedEvent);
  } catch {
    return [];
  }
}

async function waitForEvent(path: string, event: string): Promise<LoggedEvent> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(path);
    const match = events.find((item) => item.event === event);
    if (match) return match;
    await new Promise((resolveWake) => setTimeout(resolveWake, 20));
  }
  throw new Error(`log event did not appear: ${event}`);
}

interface TurnRig {
  readonly runtime: AgentRuntime;
  readonly gates: Array<ReturnType<typeof createDeferred<unknown>>>;
}

function createRig(key: string): TurnRig {
  const gates: Array<ReturnType<typeof createDeferred<unknown>>> = [];
  const runtime = createCuaTestRuntime({
    key,
    generateText: async () => {
      const gate = gates.shift();
      if (gate) await gate.promise;
      return modelText("done");
    },
  });
  return { runtime, gates };
}

function registerDesktop(runtime: AgentRuntime, id: string): void {
  const registrar = runtime.getCuaSubmissionRegistrar();
  if (!registrar) throw new Error("missing CUA registrar");
  const registration = registrar.register({
    origin: "desktop",
    inputKind: "new-submission",
    sourceCommandId: id,
    queueItemId: `queue_${id}`,
  });
  if (!registration.accepted) throw new Error(`desktop registration rejected: ${registration.reason}`);
}

async function startDesktopTurn(
  rig: TurnRig,
  id: string,
): Promise<{
  scope: CuaSubmissionTurnScope;
  completion: Promise<unknown>;
  gate: ReturnType<typeof createDeferred<unknown>>;
}> {
  registerDesktop(rig.runtime, id);
  const gate = createDeferred<unknown>();
  rig.gates.push(gate);
  const result = await rig.runtime.admitPrompt(id, undefined, {
    inputId: id,
    intent: cuaIntent(id, "desktop"),
  });
  if (result.kind !== "started") throw new Error("desktop prompt did not start a real turn");
  await waitForActiveTurn(rig.runtime);
  const scope = rig.runtime.createCuaSubmissionTurnScope();
  if (!scope) throw new Error("runtime did not issue a CUA turn scope");
  return { scope, completion: result.completion, gate };
}

describe("real runtime turn scope with the control-only launcher", () => {
  let adapterMcp!: AdapterMcpModule;
  let directory = "";

  beforeAll(async () => {
    adapterMcp = await import((await resolveAdapterMcpEntry()).href);
    directory = await mkdtemp(join(tmpdir(), "zcode-cua-runtime-scope-"));
  });

  afterAll(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  function launchFor(
    scope: CuaSubmissionTurnScope,
    mode: string,
    logPath: string,
  ): { command: string; args: string[] } {
    return {
      command: process.execPath,
      args: [
        childPath,
        mode,
        logPath,
        scope.ref.submissionLineageId,
        String(scope.ref.authorizationRevision),
      ],
    };
  }

  it("binds the actual bootstrap producer and normal scope close never revokes the lineage", async () => {
    const rig = createRig("normal-close");
    const first = await startDesktopTurn(rig, "first-lineage");
    const logPath = join(directory, "normal-close.log");
    const session = adapterMcp.createRuntimeCuaSubmissionControlSession(first.scope, {
      launch: launchFor(first.scope, "normal", logPath),
    });

    try {
      await withTimeout(session.start(), "runtime-bound control session did not start");
      const ready = await waitForEvent(logPath, "ready");
      const producerIncarnation = ready.producerIncarnation;
      expect(typeof producerIncarnation).toBe("string");
      // 只有 launcher 实际 bootstrap 的同一 producer incarnation 才能幂等绑定成功；
      // 若 adapter 另造 UUID，这里会因 producer_mismatch 返回 false。
      expect(first.scope.bindProducer(producerIncarnation as string)).toBe(true);

      first.gate.resolve(undefined);
      await withTimeout(first.completion, "first desktop turn did not finish");
      await waitFor(
        () => session.diagnostics().control === "closed",
        "normal scope close did not close the control consumer",
      );
      await withTimeout(session.cleanup(), "normal scope close cleanup did not settle");

      expect(rig.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
        ref: { submissionLineageId: first.scope.ref.submissionLineageId },
      });
      const events = await readEvents(logPath);
      expect(events.some((event) => event.event === "request")).toBe(false);
    } finally {
      await session.cleanup().catch(() => undefined);
      first.gate.resolve(undefined);
      rig.gates.forEach((gate) => gate.resolve(undefined));
      rig.runtime.beginShutdown();
    }
  });

  it("owner revocation closes the consumer without manufacturing a control-lost revoke", async () => {
    const rig = createRig("owner-revoked");
    const turn = await startDesktopTurn(rig, "owner-lineage");
    const logPath = join(directory, "owner-revoked.log");
    const session = adapterMcp.createRuntimeCuaSubmissionControlSession(turn.scope, {
      launch: launchFor(turn.scope, "normal", logPath),
    });

    try {
      await withTimeout(session.start(), "runtime-bound control session did not start");
      await waitForEvent(logPath, "ready");

      const activeTurnId = rig.runtime.getActiveTurnInfo()?.turnId;
      if (!activeTurnId) throw new Error("expected active turn");
      const steered = await rig.runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: activeTurnId,
        input: "mobile steer",
        intent: cuaIntent("mobile-owner-revoke", "mobile", "guide"),
      });
      expect(steered.kind).toBe("queued");

      expect(rig.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "mobile-steer",
        ref: { submissionLineageId: turn.scope.ref.submissionLineageId },
      });
      await waitFor(
        () => session.diagnostics().control === "closed",
        "owner revocation did not close the control consumer",
      );
      await withTimeout(session.cleanup(), "owner revocation cleanup did not settle");
      expect(session.diagnostics()).toMatchObject({
        invalidated: true,
        lastFailure: "owner_revoked",
        nativeFence: "unknown",
        machineLease: "unavailable",
        stopComplete: false,
      });
      const events = await readEvents(logPath);
      const requests = events.filter((event) => event.event === "request");
      expect(requests).toEqual([
        expect.objectContaining({
          operation: "revoke_submission",
          authorizationRevision: turn.scope.ref.authorizationRevision + 1,
          submissionLineageId: turn.scope.ref.submissionLineageId,
        }),
      ]);
    } finally {
      await session.cleanup().catch(() => undefined);
      turn.gate.resolve(undefined);
      rig.gates.forEach((gate) => gate.resolve(undefined));
      rig.runtime.beginShutdown();
    }
  });

  it("stop forwards through the real scope owner revocation and still sends control stop", async () => {
    const rig = createRig("stop-positive");
    const turn = await startDesktopTurn(rig, "stop-lineage");
    const logPath = join(directory, "stop-positive.log");
    const session = adapterMcp.createRuntimeCuaSubmissionControlSession(turn.scope, {
      launch: launchFor(turn.scope, "normal", logPath),
    });

    try {
      await withTimeout(session.start(), "runtime-bound control session did not start");
      await waitForEvent(logPath, "ready");
      const stopped = await withTimeout(session.stop(), "real scope stop did not settle");
      expect(stopped).toMatchObject({
        authorityRevoked: true,
        controlForwarded: true,
        nativeFence: "unknown",
        machineLease: "unavailable",
        stopComplete: false,
      });
      const events = await readEvents(logPath);
      const requests = events.filter((event) => event.event === "request");
      expect(requests.map((event) => event.operation)).toEqual(["revoke_submission", "stop"]);
      expect(requests[0]).toMatchObject({
        authorizationRevision: turn.scope.ref.authorizationRevision + 1,
      });
      expect(requests[1]).toMatchObject({
        authorizationRevision: turn.scope.ref.authorizationRevision + 1,
      });
      await withTimeout(session.cleanup(), "stop cleanup did not settle");
      expect(rig.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "user-stop",
      });
    } finally {
      await session.cleanup().catch(() => undefined);
      turn.gate.resolve(undefined);
      await withTimeout(turn.completion, "stop turn did not finish").catch(() => undefined);
      rig.runtime.beginShutdown();
    }
  });

  it("inbound revoke through the real scope returns a revoked ACK before cleanup", async () => {
    const rig = createRig("inbound-positive");
    const turn = await startDesktopTurn(rig, "inbound-lineage");
    const logPath = join(directory, "inbound-positive.log");
    const session = adapterMcp.createRuntimeCuaSubmissionControlSession(turn.scope, {
      launch: launchFor(turn.scope, "reverse-on-ready", logPath),
    });

    try {
      await withTimeout(session.start(), "runtime-bound control session did not start");
      const ack = await waitForEvent(logPath, "reverse-ack");
      expect(ack.phase).toBe("revoked");
      expect(rig.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "control-lost",
      });
      await withTimeout(session.cleanup(), "inbound cleanup did not settle");
    } finally {
      await session.cleanup().catch(() => undefined);
      turn.gate.resolve(undefined);
      await withTimeout(turn.completion, "inbound turn did not finish").catch(() => undefined);
      rig.runtime.beginShutdown();
    }
  });

  it("never forwards a fake revoked ref when runtime disposal clears the authority", async () => {
    const rig = createRig("dispose-unknown");
    const turn = await startDesktopTurn(rig, "dispose-lineage");
    const logPath = join(directory, "dispose-unknown.log");
    const session = adapterMcp.createRuntimeCuaSubmissionControlSession(turn.scope, {
      launch: launchFor(turn.scope, "normal", logPath),
    });

    try {
      await withTimeout(session.start(), "runtime-bound control session did not start");
      await waitForEvent(logPath, "ready");
      // runtime.shutdown 先 owner 撤销 scope，再清空 authority；此时幂等 revoke 只能得到 unknown，
      // 不能把旧 candidate ref 冒充成 revoked 转发给 producer。
      rig.runtime.beginShutdown();
      await waitFor(
        () => session.diagnostics().control === "closed",
        "disposed runtime did not close the consumer",
      );
      await session.cleanup().catch(() => undefined);
      const events = await readEvents(logPath);
      expect(events.some((event) => event.event === "request")).toBe(false);
    } finally {
      await session.cleanup().catch(() => undefined);
      turn.gate.resolve(undefined);
      await withTimeout(turn.completion, "disposed turn did not finish").catch(() => undefined);
      rig.runtime.beginShutdown();
    }
  });

  it("refuses a closed scope before spawn and leaves a later lineage startable", async () => {
    const rig = createRig("scope-closed-before-start");
    const first = await startDesktopTurn(rig, "closed-before-start");
    const logPath = join(directory, "closed-before-start.log");
    first.scope.close();

    const refused = adapterMcp.createRuntimeCuaSubmissionControlSession(first.scope, {
      launch: launchFor(first.scope, "normal", logPath),
    });
    try {
      await expect(withTimeout(refused.start(), "closed scope start did not reject")).rejects.toMatchObject({
        code: "control_lost",
      });
      await withTimeout(refused.cleanup(), "closed scope cleanup did not settle");
      expect(await readEvents(logPath)).toEqual([]);
    } finally {
      await refused.cleanup().catch(() => undefined);
      first.gate.resolve(undefined);
      await withTimeout(first.completion, "first turn did not finish").catch(() => undefined);
    }

    const second = await startDesktopTurn(rig, "later-lineage");
    const secondLogPath = join(directory, "later-lineage.log");
    const next = adapterMcp.createRuntimeCuaSubmissionControlSession(second.scope, {
      launch: launchFor(second.scope, "normal", secondLogPath),
    });
    try {
      await withTimeout(next.start(), "later lineage control session did not start");
      expect(second.scope.ref.submissionLineageId).not.toBe(first.scope.ref.submissionLineageId);
    } finally {
      await withTimeout(next.cleanup(), "later lineage cleanup did not settle");
      second.gate.resolve(undefined);
      rig.gates.forEach((gate) => gate.resolve(undefined));
      rig.runtime.beginShutdown();
    }
  });
});
