// App 内确认弹窗（spec 2026-10-31）在真实 App 中必须进入 v4 pending interaction：
// 通用 requestPermission 只做反向 RPC + v4Interactions 登记，不发 v4 PermissionRequested，
// PermissionDialog 因此永远不渲染。本用例锁定 cua_screenshot_confirm 的专门分支：
// 请求发起前 ingest 合成 PermissionRequested，结束/中止时 ingest PermissionResolved。
import { describe, expect, it, vi } from "vitest";
import { SessionEventType, type SessionEvent } from "@zody/contracts";
import { createProtocolInteractionBroker } from "../src/zody-protocol/interaction-broker.js";
import { buildProtocolPermissionOptions } from "../src/permission-options.js";
import { V4InteractionRegistry } from "../src/zody-protocol-v4/interaction-registry.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zody-protocol/server-types.js";

const TARGET = {
  pid: 40077,
  windowId: 89384,
  ownerName: "TextEdit",
  windowName: "未命名.txt",
};

function cuaConfirmRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "cua-confirm-7",
    sessionId: "session-cua",
    turnId: "turn-cua",
    traceId: "trace-cua",
    toolCallId: "run-cua",
    toolName: "cua_screenshot_confirm",
    input: { target: TARGET },
    mode: "build",
    ruleId: "cua-confirm",
    reason: 'Screen capture target: TextEdit — "未命名.txt" (pid 40077, window 89384)',
    riskLevel: "high" as const,
    // core 的确认请求携带项目规则建议（allow_always 选项的来源）。
    suggestedPermissionUpdates: [
      {
        behavior: "allow" as const,
        rules: [{ toolName: "cua_screenshot_confirm" }],
        type: "addRules" as const,
      },
    ],
    requestedAt: new Date(),
    ...overrides,
  } as never;
}

function makeBrokerContext(options?: {
  respond?: () => Promise<unknown>;
}) {
  const registry = new V4InteractionRegistry();
  const ingest = vi.fn<(sessionId: string, event: SessionEvent) => void>();
  const requestClient = vi.fn(
    (
      _method: string,
      _params: unknown,
      _schema: unknown,
      reqOptions?: { signal?: AbortSignal },
    ) => {
      if (options?.respond) {
        return options.respond();
      }
      return new Promise((_resolve, reject) => {
        reqOptions?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    },
  );
  const context = {
    deps: {},
    requestClient,
    v4Interactions: registry,
    v4Gateway: { ingest },
  } as unknown as ZCodeProtocolAgentServerContext;
  return {
    broker: createProtocolInteractionBroker(context),
    registry,
    requestClient,
    ingest,
  };
}

function ingestedTypes(ingest: ReturnType<typeof vi.fn>): SessionEvent[] {
  return ingest.mock.calls.map((call) => (call as unknown as [string, SessionEvent])[1]);
}

function findEvent(events: SessionEvent[], type: SessionEventType): SessionEvent | undefined {
  return events.find((event) => event.type === type);
}

describe("cua_screenshot_confirm v4 pending interaction", () => {
  it("请求发起前 ingest PermissionRequested，结束（allow）时 ingest PermissionResolved", async () => {
    const { broker, ingest, requestClient } = makeBrokerContext({
      respond: async () => ({ decision: "allow", reason: "Approved once" }),
    });

    const pending = broker.requestPermission(cuaConfirmRequest());
    await expect(pending).resolves.toMatchObject({ decision: "allow" });

    const events = ingestedTypes(ingest);
    const requested = findEvent(events, SessionEventType.PermissionRequested);
    expect(requested).toBeDefined();
    expect(requested).toMatchObject({
      sessionId: "session-cua",
      turnId: "turn-cua",
      traceId: "trace-cua",
      // raw seq 置 0：只进 live 投影，由 v4 gateway 分配 transport 序号。
      sequenceNumber: 0,
      payload: {
        requestId: "cua-confirm-7",
        toolCallId: "run-cua",
        toolName: "cua_screenshot_confirm",
        riskLevel: "high",
        reason: 'Screen capture target: TextEdit — "未命名.txt" (pid 40077, window 89384)',
        input: { target: TARGET },
        // 2026-10-31 用户修订：确认遵循既有权限策略，不设 user-once；
        // 项目规则建议随合成事件进入 v4 投影，投影出 allow_once + allow_always + deny。
        suggestedPermissionUpdates: [
          {
            behavior: "allow",
            rules: [{ toolName: "cua_screenshot_confirm" }],
            type: "addRules",
          },
        ],
      },
    });
    expect(requested!.payload).not.toHaveProperty("approvalMode");
    expect(
      buildProtocolPermissionOptions({
        input: (requested!.payload as { input: unknown }).input,
        suggestedPermissionUpdates: (
          requested!.payload as {
            suggestedPermissionUpdates: Array<{
              behavior: "allow";
              rules: Array<{ toolName: string }>;
              type: "addRules";
            }>;
          }
        ).suggestedPermissionUpdates,
        toolName: "cua_screenshot_confirm",
      }).map((option) => option.kind),
    ).toEqual(["allow_once", "allow_always", "deny"]);

    const resolved = findEvent(events, SessionEventType.PermissionResolved);
    expect(resolved).toMatchObject({
      sessionId: "session-cua",
      payload: {
        requestId: "cua-confirm-7",
        toolCallId: "run-cua",
        decision: "allow",
      },
    });

    // 合成 PermissionRequested 必须先于真实用户请求，否则首帧 UI 仍是空 pending。
    expect(ingest.mock.invocationCallOrder[0]).toBeLessThan(
      requestClient.mock.invocationCallOrder[0]!,
    );
  });

  it("用户拒绝时 PermissionResolved 记 deny", async () => {
    const { broker, ingest } = makeBrokerContext({
      respond: async () => ({ decision: "deny", reason: "user denied" }),
    });

    const pending = broker.requestPermission(cuaConfirmRequest());
    await expect(pending).resolves.toMatchObject({ decision: "deny" });

    const resolved = findEvent(ingestedTypes(ingest), SessionEventType.PermissionResolved);
    expect(resolved).toMatchObject({ payload: { decision: "deny" } });
  });

  it("abort/异常结束也必须 ingest PermissionResolved（deny），保证弹窗关闭", async () => {
    const { broker, ingest } = makeBrokerContext();
    const controller = new AbortController();

    const pending = broker.requestPermission(cuaConfirmRequest(), {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toThrow();

    const resolved = findEvent(ingestedTypes(ingest), SessionEventType.PermissionResolved);
    expect(resolved).toMatchObject({
      payload: {
        requestId: "cua-confirm-7",
        toolCallId: "run-cua",
        decision: "deny",
      },
    });
  });

  it("普通工具不 ingest 合成 permission 事件", async () => {
    const { broker, ingest } = makeBrokerContext({
      respond: async () => ({ decision: "allow" }),
    });

    await broker.requestPermission(cuaConfirmRequest({ toolName: "Bash" }));

    expect(
      ingestedTypes(ingest).filter(
        (event) =>
          event.type === SessionEventType.PermissionRequested ||
          event.type === SessionEventType.PermissionResolved,
      ),
    ).toHaveLength(0);
  });

  it("会话支持 full access 时合成事件透传 fullAccessSupported 并收到 Full access 应答", async () => {
    const registry = new V4InteractionRegistry();
    const ingest = vi.fn<(sessionId: string, event: SessionEvent) => void>();
    const grantPermissionFullAccess = vi.fn(async () => "event-full-access");
    const waitForPermissionGrantCommit = vi.fn(async () => {});
    const requestClient = vi.fn(
      (
        _method: string,
        _params: unknown,
        _schema: unknown,
        reqOptions?: { signal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          reqOptions?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const context = {
      deps: { sessionStore: { commitPermissionFullAccess: vi.fn() } },
      requestClient,
      sessions: new Map([
        [
          "session-cua",
          {
            app: { runtime: { grantPermissionFullAccess } },
            traceContext: { traceId: "trace-cua", turnId: "turn-cua" },
          },
        ],
      ]),
      v4Interactions: registry,
      v4Gateway: { ingest, waitForPermissionGrantCommit },
    } as unknown as ZCodeProtocolAgentServerContext;
    const broker = createProtocolInteractionBroker(context);

    const pending = broker.requestPermission(cuaConfirmRequest(), {
      claimResponse: () => true,
    });
    await pending.registered;
    const requested = findEvent(ingestedTypes(ingest), SessionEventType.PermissionRequested);
    expect(requested).toMatchObject({ payload: { fullAccessSupported: true } });

    await expect(registry.resolveFullAccess("cua-confirm-7", "session-cua")).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({ decision: "allow" });
    expect(grantPermissionFullAccess).toHaveBeenCalledWith("cua-confirm-7", undefined);
    expect(waitForPermissionGrantCommit).toHaveBeenCalledWith("session-cua", "event-full-access");

    const resolved = findEvent(ingestedTypes(ingest), SessionEventType.PermissionResolved);
    expect(resolved).toMatchObject({ payload: { decision: "allow" } });
  });

  it("会话不支持 full access 时不透传，Full access 应答被拒绝", async () => {
    const { broker, registry, ingest } = makeBrokerContext();
    const controller = new AbortController();

    const pending = broker.requestPermission(cuaConfirmRequest(), {
      signal: controller.signal,
      claimResponse: () => true,
    });
    await pending.registered;
    const requested = findEvent(ingestedTypes(ingest), SessionEventType.PermissionRequested);
    expect(requested?.payload).not.toHaveProperty("fullAccessSupported");
    await expect(registry.resolveFullAccess("cua-confirm-7", "session-cua")).rejects.toThrow(
      /Full access is not supported/,
    );

    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("没有 v4 gateway 时合成失败不阻塞主链路", async () => {
    const registry = new V4InteractionRegistry();
    const requestClient = vi.fn(async () => ({ decision: "allow" }));
    const context = {
      deps: {},
      requestClient,
      v4Interactions: registry,
      v4Gateway: {
        ingest: () => {
          throw new Error("gateway unavailable");
        },
      },
    } as unknown as ZCodeProtocolAgentServerContext;
    const broker = createProtocolInteractionBroker(context);

    await expect(broker.requestPermission(cuaConfirmRequest())).resolves.toMatchObject({
      decision: "allow",
    });
  });
});
