import { describe, expect, it } from "vitest";
import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  SessionStorePort,
} from "@zody/contracts";
import { createManualPermissionBroker, type AgentRuntime } from "../src/index.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import {
  createCuaPermissionRuleStore,
  createCuaTestRuntime,
  createDeferred,
  cuaIntent,
} from "./fixtures/cua-runtime-fixture.js";

function registerDesktop(runtime: AgentRuntime, id: string) {
  const registrar = runtime.getCuaSubmissionRegistrar();
  if (!registrar) throw new Error("missing CUA registrar");
  return registrar.register({
    origin: "desktop",
    inputKind: "new-submission",
    sourceCommandId: id,
    queueItemId: `queue_${id}`,
  });
}

async function waitForActiveTurn(runtime: AgentRuntime): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runtime.getActiveTurnInfo()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("active turn did not start");
}

async function waitForIdle(runtime: AgentRuntime): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!runtime.hasActiveOrQueuedTurnWork()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("runtime did not become idle");
}

interface HeldTurn {
  readonly runtime: AgentRuntime;
  readonly gate: ReturnType<typeof createDeferred<unknown>>;
  readonly completion: Promise<unknown>;
}

async function startHeldTurn(options: {
  key: string;
  id: string;
  permissionBroker?: PermissionBrokerPort;
  sessionStore?: SessionStorePort;
  config?: Partial<AgentRuntimeConfig>;
}): Promise<HeldTurn> {
  const gate = createDeferred<unknown>();
  const runtime = createCuaTestRuntime({
    key: options.key,
    ...(options.permissionBroker ? { permissionBroker: options.permissionBroker } : {}),
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.config ? { config: options.config } : {}),
    generateText: async () => {
      await gate.promise;
      return { finishReason: "stop", model: "test", text: "done" } as never;
    },
  });
  const registration = registerDesktop(runtime, options.id);
  if (!registration.accepted) throw new Error(registration.reason);
  const receipt = await runtime.admitPrompt(options.id, undefined, {
    inputId: options.id,
    intent: cuaIntent(options.id, "desktop"),
  });
  if (receipt.kind !== "started") throw new Error("prompt did not start");
  await waitForActiveTurn(runtime);
  return { runtime, gate, completion: receipt.completion };
}

async function finishHeldTurn(held: HeldTurn): Promise<void> {
  held.gate.resolve(undefined);
  await held.completion.catch(() => undefined);
  await waitForIdle(held.runtime);
}

/** 从被测 runtime 的真实 turn scope 构造确认输入；调用与校验都在同一个 runtime 上。 */
function confirmationInput(held: HeldTurn, generation = 1) {
  const scope = held.runtime.createCuaSubmissionTurnScope();
  if (!scope) throw new Error("scope was not issued");
  return {
    scope,
    input: {
      generation,
      target: { pid: 40077, windowId: 89384, ownerName: "Safari", windowName: "Zody Spec" },
      sessionId: scope.ref.sessionId,
      workspaceKey: scope.ref.workspaceKey,
      traceId: scope.traceId,
      runId: scope.runId,
      turnId: scope.turnId,
    },
  };
}

describe("requestCuaNativeCaptureConfirmation", () => {
  it("fail-closes without touching the broker when turn or run mismatch", async () => {
    const requests: PermissionBrokerRequest[] = [];
    const broker = createManualPermissionBroker({
      onRequest: (request) => {
        requests.push(request);
      },
    });
    const held = await startHeldTurn({
      key: "cua-confirm-mismatch",
      id: "cua-confirm-mismatch-a",
      permissionBroker: broker,
    });
    try {
      const { input } = confirmationInput(held);
      const wrongTurn = await held.runtime.requestCuaNativeCaptureConfirmation({
        ...input,
        turnId: "turn-other" as never,
      });
      expect(wrongTurn).toEqual({ allowed: false, failureReason: "confirmation-invalid" });
      const wrongRun = await held.runtime.requestCuaNativeCaptureConfirmation({
        ...input,
        runId: "run-other",
      });
      expect(wrongRun).toEqual({ allowed: false, failureReason: "confirmation-invalid" });
      // turn 结束后的迟到确认同样 fail-closed，不发起用户请求。
      held.gate.resolve(undefined);
      await held.completion.catch(() => undefined);
      await waitForIdle(held.runtime);
      const late = await held.runtime.requestCuaNativeCaptureConfirmation(input);
      expect(late).toEqual({ allowed: false, failureReason: "confirmation-invalid" });
      expect(requests).toEqual([]);
    } finally {
      await finishHeldTurn(held).catch(() => undefined);
    }
  });

  it("asks the broker with the standard permission shape and maps allow", async () => {
    const requests: PermissionBrokerRequest[] = [];
    const broker = createManualPermissionBroker();
    const held = await startHeldTurn({
      key: "cua-confirm-allow",
      id: "cua-confirm-allow-a",
      permissionBroker: {
        requestPermission(request, options) {
          const response = broker.requestPermission(request, options);
          requests.push(request);
          return response;
        },
      },
    });
    try {
      const { input } = confirmationInput(held, 5);
      const pending = held.runtime.requestCuaNativeCaptureConfirmation(input);
      await expect.poll(() => broker.listPendingRequests().length === 1).toBe(true);
      broker.resolvePermission(broker.listPendingRequests()[0].requestId, {
        decision: "allow",
        reason: "ok",
      });
      const outcome = await pending;
      expect(outcome).toEqual({ allowed: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        requestId: "cua-confirm-5",
        toolCallId: input.runId,
        toolName: "cua_screenshot_confirm",
        riskLevel: "high",
        sessionId: input.sessionId,
        traceId: input.traceId,
        turnId: input.turnId,
        input: {
          target: { pid: 40077, windowId: 89384, ownerName: "Safari", windowName: "Zody Spec" },
        },
      });
      // 2026-10-31 用户修订：确认弹窗遵循既有权限策略，不再限定 user-once；
      // 项目规则建议让 broker 投影出 allow_once + allow_always + deny。
      expect(requests[0].approvalMode).toBeUndefined();
      expect(requests[0].suggestedPermissionUpdates).toEqual([
        {
          behavior: "allow",
          rules: [{ toolName: "cua_screenshot_confirm" }],
          type: "addRules",
        },
      ]);
      expect(requests[0].optionsPolicy).toBeUndefined();
      expect(requests[0].reason).toContain("Safari");
      expect(requests[0].reason).toContain("Zody Spec");
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("skips the broker when a project allow rule matches", async () => {
    const requests: PermissionBrokerRequest[] = [];
    const sessionStore = createCuaPermissionRuleStore({
      version: 1,
      allow: [{ toolName: "cua_screenshot_confirm" }],
    });
    const held = await startHeldTurn({
      key: "cua-confirm-project-allow",
      id: "cua-confirm-project-allow-a",
      permissionBroker: {
        requestPermission(request, options) {
          requests.push(request);
          return createManualPermissionBroker().requestPermission(request, options);
        },
      },
      sessionStore: sessionStore.store,
    });
    try {
      const { input } = confirmationInput(held);
      await expect(held.runtime.requestCuaNativeCaptureConfirmation(input)).resolves.toEqual({
        allowed: true,
      });
      expect(requests).toEqual([]);
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("skips the broker when the session is in full access (yolo)", async () => {
    const requests: PermissionBrokerRequest[] = [];
    const sessionStore = createCuaPermissionRuleStore();
    const held = await startHeldTurn({
      key: "cua-confirm-full-access",
      id: "cua-confirm-full-access-a",
      permissionBroker: {
        requestPermission(request, options) {
          requests.push(request);
          return createManualPermissionBroker().requestPermission(request, options);
        },
      },
      sessionStore: sessionStore.store,
      config: { mode: "yolo" },
    });
    try {
      const { input } = confirmationInput(held);
      await expect(held.runtime.requestCuaNativeCaptureConfirmation(input)).resolves.toEqual({
        allowed: true,
      });
      expect(requests).toEqual([]);
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("falls back to user interaction when the rule lookup fails", async () => {
    const marker = "rule store unavailable";
    const sessionStore = createCuaPermissionRuleStore();
    sessionStore.failReads(new Error(marker));
    const broker = createManualPermissionBroker();
    const held = await startHeldTurn({
      key: "cua-confirm-rule-error",
      id: "cua-confirm-rule-error-a",
      permissionBroker: broker,
      sessionStore: sessionStore.store,
    });
    try {
      const { input } = confirmationInput(held);
      const pending = held.runtime.requestCuaNativeCaptureConfirmation(input);
      await expect.poll(() => broker.listPendingRequests().length === 1).toBe(true);
      broker.resolvePermission(broker.listPendingRequests()[0].requestId, {
        decision: "allow",
        reason: "ok",
      });
      await expect(pending).resolves.toEqual({ allowed: true });
      expect(broker.listPendingRequests()).toEqual([]);
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("persists an allow_always project rule and short-circuits the next confirm", async () => {
    const broker = createManualPermissionBroker();
    const requests: PermissionBrokerRequest[] = [];
    const sessionStore = createCuaPermissionRuleStore();
    const held = await startHeldTurn({
      key: "cua-confirm-allow-always",
      id: "cua-confirm-allow-always-a",
      permissionBroker: {
        requestPermission(request, options) {
          requests.push(request);
          return broker.requestPermission(request, options);
        },
      },
      sessionStore: sessionStore.store,
    });
    try {
      const first = confirmationInput(held, 3);
      const pending = held.runtime.requestCuaNativeCaptureConfirmation(first.input);
      await expect.poll(() => broker.listPendingRequests().length === 1).toBe(true);
      broker.resolvePermission(broker.listPendingRequests()[0].requestId, {
        decision: "allow",
        permissionUpdates: [
          {
            behavior: "allow",
            rules: [{ toolName: "cua_screenshot_confirm" }],
            type: "addRules",
          },
        ],
        reason: "Approved for this project",
      });
      await expect(pending).resolves.toEqual({ allowed: true });
      expect(sessionStore.saves).toHaveLength(1);
      expect(sessionStore.saves[0].permission.allow).toEqual([
        { toolName: "cua_screenshot_confirm" },
      ]);

      const second = confirmationInput(held, 4);
      await expect(held.runtime.requestCuaNativeCaptureConfirmation(second.input)).resolves.toEqual(
        { allowed: true },
      );
      expect(requests).toHaveLength(1);
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("maps deny and modify decisions to allowed:false", async () => {
    const broker = createManualPermissionBroker();
    const held = await startHeldTurn({
      key: "cua-confirm-deny",
      id: "cua-confirm-deny-a",
      permissionBroker: broker,
    });
    try {
      const outcomes = [];
      for (const decision of ["deny", "modify"] as const) {
        const { input } = confirmationInput(held, outcomes.length + 1);
        const pending = held.runtime.requestCuaNativeCaptureConfirmation(input);
        await expect.poll(() => broker.listPendingRequests().length === 1).toBe(true);
        broker.resolvePermission(broker.listPendingRequests()[0].requestId, {
          decision,
          reason: "no",
        });
        outcomes.push(await pending);
      }
      expect(outcomes).toEqual([{ allowed: false }, { allowed: false }]);
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("returns confirmation-unavailable when the broker itself fails", async () => {
    const broker = createManualPermissionBroker();
    const held = await startHeldTurn({
      key: "cua-confirm-broken",
      id: "cua-confirm-broken-a",
      permissionBroker: broker,
    });
    try {
      const { input } = confirmationInput(held);
      const pending = held.runtime.requestCuaNativeCaptureConfirmation(input);
      await expect.poll(() => broker.listPendingRequests().length === 1).toBe(true);
      broker.rejectPermission(broker.listPendingRequests()[0].requestId, new Error("client_gone"));
      await expect(pending).resolves.toEqual({
        allowed: false,
        failureReason: "confirmation-unavailable",
      });
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("propagates abort as an AbortError without reporting a decision", async () => {
    const broker = createManualPermissionBroker();
    const held = await startHeldTurn({
      key: "cua-confirm-abort",
      id: "cua-confirm-abort-a",
      permissionBroker: broker,
    });
    const controller = new AbortController();
    try {
      const { input } = confirmationInput(held);
      const pending = held.runtime.requestCuaNativeCaptureConfirmation({
        ...input,
        signal: controller.signal,
      });
      await expect.poll(() => broker.listPendingRequests().length === 1).toBe(true);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(broker.listPendingRequests()).toEqual([]);
    } finally {
      await finishHeldTurn(held);
    }
  });
});

describe("requestCuaNativeReadConfirmation", () => {
  it("always asks once without persistent screenshot rules, and rejects mismatched turns", async () => {
    const requests: PermissionBrokerRequest[] = [];
    const broker = {
      requestPermission: async (request: PermissionBrokerRequest) => {
        requests.push(request);
        return { decision: "allow" as const };
      },
    } as PermissionBrokerPort;
    const held = await startHeldTurn({
      key: "cua-read-confirm",
      id: "cua-read-confirm",
      permissionBroker: broker,
      config: { mode: "yolo" },
    });
    try {
      const { input } = confirmationInput(held);
      expect(await held.runtime.requestCuaNativeReadConfirmation(input)).toEqual({ allowed: true });
      expect(requests[0]).toMatchObject({
        toolName: "cua_ax_read_confirm",
        approvalMode: "user-once",
        optionsPolicy: "no-always-allow",
      });
      expect(requests[0]?.suggestedPermissionUpdates).toBeUndefined();
      expect(
        await held.runtime.requestCuaNativeReadConfirmation({ ...input, runId: "other" }),
      ).toMatchObject({ allowed: false, failureReason: "confirmation-invalid" });
      for (const invalid of [
        { generation: 0 },
        { target: { ...input.target, pid: -1 } },
        { target: { ...input.target, windowId: 1.5 } },
        { target: { ...input.target, ownerName: "x".repeat(129) } },
        { workspaceKey: "other" },
      ]) {
        expect(
          await held.runtime.requestCuaNativeReadConfirmation({ ...input, ...invalid }),
        ).toMatchObject({ allowed: false, failureReason: "confirmation-invalid" });
      }
      expect(requests).toHaveLength(1);
    } finally {
      await finishHeldTurn(held);
    }
  });
});

it("control confirmation is independent and always single-use", async () => {
  const requests: PermissionBrokerRequest[] = [];
  const permissionBroker = {
    requestPermission: async (request: PermissionBrokerRequest) => {
      requests.push(request);
      return { decision: "allow" as const };
    },
  } as PermissionBrokerPort;
  const held = await startHeldTurn({
    key: "control",
    id: "control",
    permissionBroker,
    config: { mode: "yolo" },
  });
  try {
    const { input } = confirmationInput(held);
    expect(await held.runtime.requestCuaNativeControlConfirmation(input)).toEqual({
      allowed: true,
    });
    expect(requests[0]).toMatchObject({
      toolName: "cua_ax_control_confirm",
      approvalMode: "user-once",
      optionsPolicy: "no-always-allow",
    });
    expect(requests[0]?.suggestedPermissionUpdates).toBeUndefined();
  } finally {
    await finishHeldTurn(held);
  }
});
