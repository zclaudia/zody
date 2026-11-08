import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zody/adapters/storage";
import {
  InMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
  type ToolPart,
} from "@zody/contracts";
import { AgentRuntime, createToolRegistry } from "@zody/core";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";

// F20②（e25dd50c，来源上游 a60ba6a7 provider-tool-rounds）：NativeSearch 是 providerExecuted 调用，
// 现在会在流中被切成独立轮次并提前落盘（tool part 带 metadata.providerExecuted:true）；
// 本 fixture 流不携带 provider_tool_result，因此各场景里它都由 settleUnfinishedProviderToolCards
// 按中断收口为 error 态结果（PROVIDER_TOOL_INTERRUPTED_RESULT），并按流顺序出现在 live 与持久化
// 历史中（stream-failure 除外：首个 attempt 被断流恢复作废，其 native 轮次不进入 live 回放，
// 但持久化 part 仍在）。下列期望随该行为更新：native 结果排在本地 write/read 结果之前；
// 持久化 part 序列在 read 与 write 之间插入 native；native 不占本地声明序号（declarationIndex 缺省）。
const scenarios = [
  "success",
  "tool-error",
  "stream-failure",
  "slow-pending",
  "failed-pending",
  "stop",
] as const;

describe("tool order through runtime and SQLite", () => {
  it.each(scenarios)(
    "preserves history and streaming behavior: %s",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-tool-order-"));
      const dbPath = join(root, "session.sqlite");
      const sessionId = createSessionId("tool-order");
      let store = createSqliteSessionStore({ dbPath });
      const writes: ToolPart[] = [];
      const pendingStarted = Promise.withResolvers<void>();
      const pendingRelease = Promise.withResolvers<void>();
      const readStarted = Promise.withResolvers<void>();
      const executionOrder: string[] = [];
      const requests: ModelRequest[] = [];
      let pendingAttempts = 0;
      let firstStreamFinished = false;
      let readStartedBeforeFinish = false;
      let laterStreamEventConsumed = false;
      const originalSavePart = store.savePart.bind(store);
      store.savePart = async (part) => {
        if (part.type === "tool") {
          if (
            part.callID === "read" &&
            part.state.status === "pending" &&
            pendingAttempts++ === 0
          ) {
            pendingStarted.resolve();
            if (scenario === "slow-pending" || scenario === "stop") await pendingRelease.promise;
            if (scenario === "failed-pending") throw new Error("injected pending write failure");
          }
          writes.push(structuredClone(part));
        }
        await originalSavePart(part);
      };
      const createRegistry = () => {
        const registry = createToolRegistry();
        for (const name of ["DeferredWrite", "EarlyRead"]) {
          registry.register({
            capability: "Return a fixed result for tool-history regression",
            inputSchema: {},
            outputSchema: { type: "string" },
            permission: {
              permission: "test",
              reason: "In-process fixture",
              riskLevel: "low",
              sideEffectScope: name === "EarlyRead" ? "none" : "workspace",
              needsApproval: false,
              patternSources: ["none"],
              denyPriority: "beforeAsk",
            },
            resultBudget: { strategy: "inline", maxInlineBytes: 1024, maxModelBytes: 1024 },
            timeout: { kind: "none" },
            cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Cancelled" },
            trace: {
              required: true,
              propagateToAdapters: false,
              recordInput: "none",
              recordOutput: "none",
            },
            metadata: {
              name,
              concurrentSafe: true,
              destructive: false,
              needsApproval: false,
              readOnly: name === "EarlyRead",
              riskLevel: "low",
              sideEffectScope: name === "EarlyRead" ? "none" : "workspace",
            },
            handler: async () => {
              executionOrder.push(name);
              if (name === "EarlyRead") {
                readStartedBeforeFinish = !firstStreamFinished;
                readStarted.resolve();
              }
              if (name === "DeferredWrite" && scenario === "tool-error")
                throw new Error("tool error");
              return `${name} result`;
            },
          });
        }
        return registry;
      };
      const abort = new AbortController();
      const modelFactory = createTestModelFactory({
        async *streamText(request) {
          requests.push(structuredClone(request));
          if (requests.length === 1) {
            yield {
              type: "tool_call",
              toolCall: { id: "write", name: "DeferredWrite", input: {} },
            };
            yield {
              type: "tool_call",
              toolCall: { id: "native", name: "NativeSearch", input: {}, providerExecuted: true },
            };
            yield { type: "tool_call", toolCall: { id: "read", name: "EarlyRead", input: {} } };
            // 同一声明重复到达不应占用第二个位置，provider 执行的调用也不占本地序号。
            yield { type: "tool_call", toolCall: { id: "read", name: "EarlyRead", input: {} } };
            if (scenario === "slow-pending" || scenario === "stop") {
              await pendingStarted.promise;
              yield { type: "text_delta", text: "tail while pending is blocked" };
              laterStreamEventConsumed = true;
              if (scenario === "stop") abort.abort();
              pendingRelease.resolve();
            } else if (scenario !== "failed-pending") {
              await readStarted.promise;
            }
            firstStreamFinished = true;
            if (scenario === "stream-failure") throw new Error("Model request timed out.");
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          yield { type: "text_delta", text: "done" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        },
      });
      const createRuntime = () =>
        new AgentRuntime(
          sessionId,
          {
            mode: "yolo",
            modelStreaming: "on",
            workingDirectory: root,
            modelSelection: { providerId: "test", modelId: "tool-order" },
          },
          {
            modelFactory,
            sessionStore: store,
            toolRegistry: createRegistry(),
            eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
          },
        );
      let runtime = createRuntime();
      try {
        const turn = runtime.executeTurn("declare write then read", [], {
          abortSignal: abort.signal,
        });
        if (scenario === "stop") {
          await expect(turn).rejects.toThrow("Turn was cancelled");
          expect(laterStreamEventConsumed).toBe(true);
          expect(executionOrder).toEqual([]);
          // 原 streaming 路径先写 running 再由 executor 检查取消；本修复保持这一记录集合。
          // F20②：取消路径同样会先由 settleUnfinishedProviderToolCards 把无结果的 provider 内置
          // 工具轮按中断收口（error 态 tool part，流顺序插在 read 的 pending 与 running 之间）。
          expect(writes.map((part) => [part.callID, part.state.status])).toEqual([
            ["read", "pending"],
            ["native", "error"],
            ["read", "running"],
          ]);
          expect(
            writes
              .filter((part) => part.callID === "read")
              .every((part) => part.declarationIndex === 1),
          ).toBe(true);
          expect(writes.find((part) => part.callID === "native")).toMatchObject({
            metadata: { providerExecuted: true },
            state: {
              status: "error",
              error: "[Server-side tool execution was interrupted before its result arrived]",
            },
          });
          return;
        }
        await turn;
        expect(requests).toHaveLength(2);
        expect(pendingAttempts).toBe(scenario === "failed-pending" ? 2 : 1);
        const live = toolHistory(requests[1]!);
        expect(live.calls.map((call) => call.id)).toEqual(["write", "read"]);
        // F20②：native 轮次在回放里是独立的 assistant(tool_use) + tool(result)，结果排在本地工具之前；
        // 流中没有 provider_tool_result，按中断收口为错误结果。stream-failure 例外：本地工具已被接纳，
        // 断流恢复走 settlement 分支（recoverFromModelFailure），作废 attempt 不标
        // StreamRecoveryDiscarded，native 轮次不进入 live 回放（见下方冷恢复差异说明）。
        expect(live.results.map((result) => result.toolCallId)).toEqual(
          scenario === "stream-failure" ? ["write", "read"] : ["native", "write", "read"],
        );
        if (scenario === "stream-failure") {
          expect(live.results.some((result) => result.toolCallId === "native")).toBe(false);
        } else {
          expect(live.results[0]).toMatchObject({
            toolCallId: "native",
            isError: true,
            content: "[Server-side tool execution was interrupted before its result arrived]",
          });
        }
        const nativeInterruptedResult = {
          toolCallId: "native",
          isError: true,
          content: "[Server-side tool execution was interrupted before its result arrived]",
        };
        expect(executionOrder.filter((name) => name === "EarlyRead")).toHaveLength(1);
        expect(executionOrder.filter((name) => name === "DeferredWrite")).toHaveLength(
          scenario === "stream-failure" ? 0 : 1,
        );
        if (scenario === "slow-pending") expect(laterStreamEventConsumed).toBe(true);
        if (["success", "tool-error", "stream-failure"].includes(scenario)) {
          expect(readStartedBeforeFinish).toBe(true);
          const parts = (await store.messages({ sessionID: sessionId }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool");
          // F20②：服务端轮次按流顺序落盘（read pending → native 中断收口 → write），
          // 冷恢复据此重切轮，与 live 回放一致。
          expect(parts.map((part) => part.callID)).toEqual(["read", "native", "write"]);
          expect(parts.find((part) => part.callID === "native")).toMatchObject({
            metadata: { providerExecuted: true },
          });
        }
        expect(writes.length).toBeGreaterThan(0);

        // 冷恢复确实关闭并重开数据库，再观察新的 ModelFactory 请求。
        // F20② 已知差异（如实断言，不在测试债卡内修 core）：stream-failure 走本地工具 settlement
        // 恢复，作废 attempt 的消息不标 StreamRecoveryDiscarded；native 轮次 part 已在流中提前
        // 落盘并留在最终成功的消息上，冷恢复按 part 序列重切轮会带回 native 中断结果，
        // 因此该场景冷恢复历史比 live 多出一个前序 native 轮（其余场景 live 与冷恢复一致）。
        const coldExpected =
          scenario === "stream-failure"
            ? { calls: live.calls, results: [nativeInterruptedResult, ...live.results] }
            : live;
        runtime.beginShutdown();
        store.close();
        store = createSqliteSessionStore({ dbPath });
        runtime = createRuntime();
        await runtime.resumeFromStore();
        await runtime.executeTurn("later user query");
        expect(toolHistory(requests.at(-1)!)).toEqual(coldExpected);
        const laterUser = (await store.messages({ sessionID: sessionId })).findLast(
          (message) => message.info.role === "user",
        );
        expect(laterUser).toBeDefined();
        await runtime.rewindConversationToMessage({
          events: [],
          targetMessageId: laterUser!.info.id,
          traceContext: createRootTraceContext({ sessionId }),
        });
        await runtime.executeTurn("edited later user query");
        expect(toolHistory(requests.at(-1)!)).toEqual(coldExpected);
        // F20②：native 是 provider 内置工具轮次，不占本地声明序号（declarationIndex 缺省）；
        // 本地 write/read 的序号分配不受影响（write=0、read=1）。
        expect(
          writes
            .filter((part) => part.callID !== "native")
            .every((part) => part.declarationIndex === (part.callID === "write" ? 0 : 1)),
        ).toBe(true);
        expect(
          writes
            .filter((part) => part.callID === "native")
            .every((part) => part.declarationIndex === undefined),
        ).toBe(true);
      } finally {
        pendingRelease.resolve();
        runtime.beginShutdown();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

function toolHistory(request: ModelRequest) {
  return {
    calls: request.messages
      .flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.id === "write" || call.id === "read"),
    results: request.messages
      .filter((message) => message.role === "tool")
      .map(({ toolCallId, content, isError }) => ({ toolCallId, content, isError })),
  };
}
