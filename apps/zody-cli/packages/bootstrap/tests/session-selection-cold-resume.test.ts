import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zody/adapters/storage";
import { describe, expect, it } from "vitest";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("Session 完整选择的实际保存与冷恢复", () => {
  it.each(["guarded", "yolo"] as const)(
    "%s 与完整选择落 SQLite；新 App 冷恢复不降级",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-selection-resume-"));
      const dbPath = join(root, "sessions.sqlite");
      const initial = {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      };
      const selected = {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      };
      const registry = createTestProviderRegistry([initial, selected]);
      const executions: Array<{ providerId: string; modelId: string; reasoningLevel: unknown }> =
        [];
      const common = {
        env: { ZCODE_HOME: root },
        skipUserConfig: true,
        providerRegistry: registry,
        runtimeConfig: { workingDirectory: root, mcp: { enabled: false }, modelSelection: initial },
        modelExecutor: {
          async generateText(
            request: import("@zody/contracts").ModelRequest,
            execution: { providerId: string; modelId: string },
          ) {
            executions.push({ ...execution, reasoningLevel: request.options?.reasoningLevel });
            return {
              finishReason: "stop" as const,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        },
      };
      let store = createSqliteSessionStore({ dbPath });
      let app = await createRegistryBackedTestApp({ ...common, sessionStore: store });
      try {
        const sessionId = app.sessionId;
        // Bot /model 操作的是已创建的 Session，不是尚未 materialize 的草稿 App。
        await app.runtime.executeTurn("Create the bound Session.");
        executions.length = 0;
        await app.setModel(selected);
        await app.setMode(mode);
        expect(app.getMode()).toBe(mode);
        expect(app.runtime.getSessionModelSelection()).toEqual(selected);
        await expect(
          app.setModel({ ...initial, options: { reasoningLevel: "invalid" } }),
        ).rejects.toThrow();
        expect(app.runtime.getSessionModelSelection()).toEqual(selected);
        await app.close?.();
        store.close();
        store = createSqliteSessionStore({ dbPath });
        app = await createRegistryBackedTestApp({
          ...common,
          sessionStore: store,
          sessionId,
          resume: true,
        });
        await app.resume();
        expect(app.getMode()).toBe(mode);
        expect(app.runtime.getSessionModelSelection()).toEqual(selected);
        await app.runtime.executeTurn("E2E_W99_SAVED_SELECTION_REQUEST");
        expect(executions).toEqual([
          { providerId: selected.providerId, modelId: selected.modelId, reasoningLevel: "high" },
        ]);
      } finally {
        await app.close?.();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  // I19 守卫：冷历史先展示后激活时，被取消/模型不可用的那次 activation 不能把持久化
  // 选择降级成运行时默认值，也不能影响随后的重连冷恢复。
  it("I19 守卫：取消/不可用的冷恢复不降级持久选择，重连后仍用完整选择", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-selection-cold-"));
    const dbPath = join(root, "sessions.sqlite");
    const initial = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "low" },
    };
    const selected = {
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    };
    const fullRegistry = createTestProviderRegistry([initial, selected]);
    // 只认识默认模型：模拟重连时模型暂不可用。
    const limitedRegistry = createTestProviderRegistry([initial]);
    const executions: Array<{ providerId: string; modelId: string; reasoningLevel: unknown }> =
      [];
    const makeCommon = (providerRegistry: ReturnType<typeof createTestProviderRegistry>) => ({
      env: { ZCODE_HOME: root },
      skipUserConfig: true,
      providerRegistry,
      runtimeConfig: { workingDirectory: root, mcp: { enabled: false }, modelSelection: initial },
      modelExecutor: {
        async generateText(
          request: import("@zody/contracts").ModelRequest,
          execution: { providerId: string; modelId: string },
        ) {
          executions.push({ ...execution, reasoningLevel: request.options?.reasoningLevel });
          return {
            finishReason: "stop" as const,
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
    });

    let store = createSqliteSessionStore({ dbPath });
    let app = await createRegistryBackedTestApp({
      ...makeCommon(fullRegistry),
      sessionStore: store,
    });
    let cancelled: import("../src/app/types.js").ZodyApp | undefined;
    let reconnected: import("../src/app/types.js").ZodyApp | undefined;
    try {
      const sessionId = app.sessionId;
      await app.runtime.executeTurn("Create the bound Session.");
      executions.length = 0;
      await app.setModel(selected);
      await app.setMode("guarded");
      await app.close?.();
      store.close();

      // 第一次重连只恢复 mode；模型不可用时不能把保存意图改写成默认选择。
      const limitedStore = createSqliteSessionStore({ dbPath });
      try {
        cancelled = await createRegistryBackedTestApp({
          ...makeCommon(limitedRegistry),
          sessionStore: limitedStore,
          sessionId,
          resume: true,
        });
        await cancelled.resume();
        expect(cancelled.runtime.getSessionModelSelection()).toBeUndefined();
        expect(cancelled.getMode()).toBe("guarded");
      } finally {
        await cancelled?.close?.();
        limitedStore.close();
      }

      // 取消之后的新冷恢复仍按持久化完整选择恢复并执行。
      store = createSqliteSessionStore({ dbPath });
      reconnected = await createRegistryBackedTestApp({
        ...makeCommon(fullRegistry),
        sessionStore: store,
        sessionId,
        resume: true,
      });
      await reconnected.resume();
      expect(reconnected.getMode()).toBe("guarded");
      expect(reconnected.runtime.getSessionModelSelection()).toEqual(selected);
      await reconnected.runtime.executeTurn("E2E_I19_SELECTION_AFTER_CANCELLED_RESUME");
      expect(executions).toEqual([
        { providerId: selected.providerId, modelId: selected.modelId, reasoningLevel: "high" },
      ]);
    } finally {
      await cancelled?.close?.();
      await reconnected?.close?.();
      await app.close?.();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
