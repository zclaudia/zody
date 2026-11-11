import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  createCuaPermissionRuleStore,
  createCuaTestRuntime,
  createDeferred,
  cuaIntent,
  modelText,
} from "./fixtures/cua-runtime-fixture.js";

/**
 * specs/computer-use-macos-phase1.md「2026-11-10 mobile-origin 授权轮次」：
 * 持久授权命中的 mobile 新提交获 live ticket + candidate；未授权 mobile 维持
 * mobile-steer 撤销；授权 mobile steer 仍撤销（observeSteer 先丢弃其 ticket）。
 */
describe("CUA mobile-origin granted submission", () => {
  function registerSubmission(
    runtime: AgentRuntime,
    id: string,
    origin: "desktop" | "mobile",
    queueItemId = `queue_${id}`,
  ) {
    const registrar = runtime.getCuaSubmissionRegistrar();
    if (!registrar) throw new Error("missing CUA registrar");
    return registrar.register({
      origin,
      inputKind: "new-submission",
      sourceCommandId: id,
      queueItemId,
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

  function internal(runtime: AgentRuntime): AgentRuntimeInternal {
    return runtime as unknown as AgentRuntimeInternal;
  }

  async function startHeldDesktopCandidate(options: { key: string; id: string }) {
    const gate = createDeferred<unknown>();
    const runtime = createCuaTestRuntime({
      key: options.key,
      generateText: async () => {
        await gate.promise;
        return modelText("done");
      },
    });
    const registration = registerSubmission(runtime, options.id, "desktop");
    if (!registration.accepted) throw new Error(registration.reason);
    const receipt = await runtime.admitPrompt(options.id, undefined, {
      inputId: options.id,
      intent: cuaIntent(options.id, "desktop"),
    });
    if (receipt.kind !== "started") throw new Error("prompt did not start");
    await waitForActiveTurn(runtime);
    return { runtime, gate, completion: receipt.completion };
  }

  it("builds a mobile candidate when a granted mobile ticket is admitted", async () => {
    const runtime = createCuaTestRuntime({ key: "cua-mobile-granted" });
    const registration = registerSubmission(runtime, "mobile-granted-a", "mobile");
    if (!registration.accepted) throw new Error(registration.reason);

    const receipt = await runtime.admitPrompt("mobile-granted-a", undefined, {
      inputId: "mobile-granted-a",
      intent: cuaIntent("mobile-granted-a", "mobile"),
    });
    if (receipt.kind !== "started") throw new Error("mobile prompt did not start");
    await receipt.completion;

    const projection = runtime.getCuaSubmissionProjection();
    expect(projection.status).toBe("candidate");
  });

  it("keeps mobile-steer revocation for a mobile input without a ticket", async () => {
    const held = await startHeldDesktopCandidate({ key: "cua-mobile-ungranted", id: "desktop-a" });
    try {
      const before = held.runtime.getCuaSubmissionProjection();
      expect(before.status).toBe("candidate");

      const receipt = await held.runtime.admitPrompt("mobile-no-ticket", undefined, {
        inputId: "mobile-no-ticket",
        intent: cuaIntent("mobile-no-ticket", "mobile"),
      });
      if (receipt.kind === "started") await receipt.completion;

      expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "mobile-steer",
      });
    } finally {
      held.gate.resolve(undefined);
      await held.completion.catch(() => undefined);
      await waitForIdle(held.runtime);
    }
  });

  it("still revokes on mobile steer even when a granted ticket exists, and drops the ticket", async () => {
    const held = await startHeldDesktopCandidate({ key: "cua-mobile-steer", id: "desktop-b" });
    try {
      const coordinator = internal(held.runtime).cuaSubmissionCoordinator;
      if (!coordinator) throw new Error("missing coordinator");
      const before = held.runtime.getCuaSubmissionProjection();
      if (before.status !== "candidate") throw new Error("desktop candidate missing");

      const registration = registerSubmission(held.runtime, "steer-mobile", "mobile");
      if (!registration.accepted) throw new Error(registration.reason);

      // 授权 mobile steer：即便有 ticket 也必须撤销 current（决策 2：仅放开新 turn 提交），
      // 且 ticket 在观察中被丢弃，不能在后续 promotion 复活。
      coordinator.observeSteer({
        sourceCommandId: "steer-mobile",
        queueItemId: "queue_steer-mobile",
        inputOrigin: "mobile",
      });
      const revoked = held.runtime.getCuaSubmissionProjection();
      expect(revoked).toMatchObject({ status: "revoked", revocationReason: "mobile-steer" });

      const revived = coordinator.onTurnStarting({
        sourceCommandId: "steer-mobile",
        queueItemId: "queue_steer-mobile",
        inputOrigin: "mobile",
      });
      expect(revived).toBeUndefined();
      expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "mobile-steer",
      });
    } finally {
      held.gate.resolve(undefined);
      await held.completion.catch(() => undefined);
      await waitForIdle(held.runtime);
    }
  });

  it("keeps the current candidate when a granted mobile input queues, then promotes it", async () => {
    const held = await startHeldDesktopCandidate({ key: "cua-mobile-queued", id: "desktop-c" });
    try {
      const coordinator = internal(held.runtime).cuaSubmissionCoordinator;
      if (!coordinator) throw new Error("missing coordinator");
      const before = held.runtime.getCuaSubmissionProjection();
      if (before.status !== "candidate") throw new Error("desktop candidate missing");

      const registration = registerSubmission(held.runtime, "queued-mobile", "mobile");
      if (!registration.accepted) throw new Error(registration.reason);

      // 带授权凭证的 mobile 排队输入不撤销 current（与 desktop 排队一致）；凭证保留到提升消费。
      coordinator.observeAdmission({
        sourceCommandId: "queued-mobile",
        queueItemId: "queue_queued-mobile",
        inputOrigin: "mobile",
      });
      expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
        ref: { submissionLineageId: before.ref.submissionLineageId },
      });

      held.gate.resolve(undefined);
      await held.completion.catch(() => undefined);
      await waitForIdle(held.runtime);

      // 队列提升边界：消费 mobile 凭证建立新 candidate。
      const promoted = coordinator.onTurnStarting({
        sourceCommandId: "queued-mobile",
        queueItemId: "queue_queued-mobile",
        inputOrigin: "mobile",
      });
      expect(promoted).toBeDefined();
      const after = held.runtime.getCuaSubmissionProjection();
      expect(after.status).toBe("candidate");
      expect(after.ref.submissionLineageId).not.toBe(before.ref.submissionLineageId);
    } finally {
      held.gate.resolve(undefined);
      await held.completion.catch(() => undefined);
      await waitForIdle(held.runtime);
    }
  });

  describe("isCuaLiveSubmissionGrantActive", () => {
    it("reports no grant without rules and grants for project allow rules or full access", async () => {
      const noRules = createCuaTestRuntime({ key: "cua-grant-none" });
      await expect(noRules.isCuaLiveSubmissionGrantActive()).resolves.toBe(false);

      const projectAllow = createCuaTestRuntime({
        key: "cua-grant-project",
        sessionStore: createCuaPermissionRuleStore({
          version: 1,
          allow: [{ toolName: "cua_screenshot_confirm" }],
        }).store,
      });
      await expect(projectAllow.isCuaLiveSubmissionGrantActive()).resolves.toBe(true);

      const fullAccess = createCuaTestRuntime({
        key: "cua-grant-yolo",
        sessionStore: createCuaPermissionRuleStore().store,
        config: { mode: "yolo" },
      });
      await expect(fullAccess.isCuaLiveSubmissionGrantActive()).resolves.toBe(true);

      const failingStore = createCuaPermissionRuleStore();
      failingStore.failReads(new Error("rule store unavailable"));
      const grantLookupFailed = createCuaTestRuntime({
        key: "cua-grant-error",
        sessionStore: failingStore.store,
      });
      // 规则读取失败按未命中处理：mobile admission 不因此获得资格（fail-closed）。
      await expect(grantLookupFailed.isCuaLiveSubmissionGrantActive()).resolves.toBe(false);
    });
  });
});
