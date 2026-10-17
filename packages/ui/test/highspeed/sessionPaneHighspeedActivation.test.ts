import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { HighspeedCardSnapshot } from "@zcode/shared";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// fork（F4.1b）：加速卡在输入框的入口（卡片动效、模型锁定、倒计时）已从 SessionPane →
// Composer 的 props 转发中摘除（specs/fork-official-deps-removal-tasks.md F4.1b「UI 单测
// 断言上述入口不存在」）。本文件原 §9.2 激活动效用例全部经 composer props 观察入口行为，
// 随入口摘除改写为：① 入口 props 不存在；② 保留至 F4.2 的 turn 链路仍按发送起点抽卡。

const { composerProps, layerMock, sendCommandMock, timelineProps } = vi.hoisted(
  () => ({
    composerProps: [] as Array<{
      highspeedCard?: HighspeedCardSnapshot | null;
      highspeedActivationCardId?: string | null;
      onHighspeedActivationApplied?: (cardId: string) => void;
      onSendText?: (
        text: string,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
    }>,
    layerMock: {
      acquire: vi.fn(() => ({
        store: {
          markCommandPending: vi.fn(),
          expectAcceptedInputProjection: vi.fn(),
          recoverFromStaleAuthority: vi.fn(),
          onOnlineModelTransition: vi.fn(() => () => {}),
          refreshPlans: vi.fn(async () => {}),
          settleCommand: vi.fn(),
        },
        release: vi.fn(),
      })),
    },
    sendCommandMock: vi.fn(
      async (envelope: CommandEnvelope): Promise<CommandAck> => ({
        commandId: envelope.commandId,
        revisionAtDecision: envelope.baseRevision ?? 0,
        status: "accepted",
      }),
    ),
    timelineProps: [] as Array<{
      bottomDock?: ReactNode;
      onEdit?: (
        target: ConversationRowTarget,
        newText: string,
        attachments?: readonly AttachmentRef[],
      ) => Promise<boolean | void> | boolean | void;
    }>,
  }),
);

// 永不 resolve：本用例不测 run 发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live";
    snapshot: ConversationSnapshot;
    subscriptionId: string;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

const servicesMock = vi.hoisted(() => ({
  // 普通任务也会读取 Bot 绑定并订阅广播，补齐依赖以保持本文件原有的渲染范围。
  botsService: {
    getBotStates: vi.fn(async () => []),
  },
  broadcastService: {
    onMessage: vi.fn(() => ({ dispose: vi.fn() })),
  },
  highspeedCardService: {
    getSnapshot: vi.fn(
      async (): Promise<{
        card: HighspeedCardSnapshot | null;
        nextDrawAt: number | null;
        drawing: boolean;
      }> => ({ card: null, nextDrawAt: null, drawing: false }),
    ),
    prepareTurn: vi.fn(),
    healthy: vi.fn(async () => ({
      cardId: "card",
      promptTokens: 0,
      completionTokens: 0,
      durationSeconds: 0,
    })),
    share: vi.fn(),
  },
  // readiness hook 将 service 作为 effect 依赖；每次 render 重建会导致无限重渲染。
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

// Start 套餐推荐是 sendText 在 prepare 之前的真实 await；用例据此把发送挂在 prepare 之前，
// 模拟配置屏障 / 推荐 / 建会话期间用户切换 Task。桩必须是稳定引用（发送回调以其为依赖）。
const startPlanRecommendation = vi.hoisted(() => {
  const state = { hold: null as Promise<void> | null };
  return {
    state,
    recommend: vi.fn(async <T>(selection: T): Promise<T> => {
      await state.hold;
      return selection;
    }),
  };
});

vi.mock("@/hooks/useStartPlanRecommendation.js", () => ({
  useStartPlanRecommendation: () => startPlanRecommendation.recommend,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    settings: { zcodeInteractionBehavior: "queue" },
    update: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
    layer: layerMock,
    sendCommand: sendCommandMock,
    // 桩必须是稳定引用：effect 以 workflowRuns 为依赖，每次渲染换新函数会死循环。
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: {} },
    draftConfigSeedSignal: 0,
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    resolveInitialDraftConfig: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: Record<string, unknown>) => {
      composerProps.push(props as (typeof composerProps)[number]);
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: () =>
      React.createElement("div", { "data-testid": "mock-header" }),
  };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: (props: Record<string, unknown>) => {
      timelineProps.push(props as (typeof timelineProps)[number]);
      return React.createElement(
        Fragment,
        null,
        React.createElement("div", { "data-testid": "mock-timeline" }),
        props.bottomDock as ReactNode,
      );
    },
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: () =>
      React.createElement("div", { "data-testid": "mock-status" }),
  };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return {
    ConversationQueuePanel: () =>
      React.createElement("div", { "data-testid": "mock-queue" }),
  };
});

vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return {
    V4InteractionDialogs: () =>
      React.createElement("div", { "data-testid": "mock-interactions" }),
  };
});

vi.mock(
  "@/request-security-edition/V4ProviderRuntimeHeadersController.js",
  async () => {
    const React = await import("react");
    return {
      V4ProviderRuntimeHeadersController: () =>
        React.createElement("div", { "data-testid": "mock-runtime-headers" }),
    };
  },
);

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftEmptyState: () =>
      React.createElement("div", { "data-testid": "mock-draft-empty" }),
  };
});

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
    visibilityState: "visible",
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function makeSnapshot(sessionId: string): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: {
        allowed: false,
        reasonCode: "sendQueuedNowRequiresRunning",
      },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: {
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function makeCard(cardId: string, taskId = "session-a"): HighspeedCardSnapshot {
  return {
    cardId,
    taskId,
    provider: "builtin:bigmodel-coding-plan",
    model: "GLM-5.3",
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
}

function mockDrawHit(card: HighspeedCardSnapshot): void {
  servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
    kind: "accelerated",
    card,
    nextDrawAt: card.expiresAt,
  });
}

function latestComposer() {
  const props = composerProps.at(-1);
  if (!props) throw new Error("composer 尚未渲染");
  return props;
}

async function renderPane(root: Root, sessionId: string): Promise<void> {
  projectionState.current = {
    status: "live",
    snapshot: makeSnapshot(sessionId),
    subscriptionId: `sub-${sessionId}`,
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
  await act(async () => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId,
          workspacePath: "/workspace",
        }),
      ),
    );
    await flushMicrotasks();
  });
}

/** 走行内编辑重发路径：与 sendText 共用 prepareHighspeedTurnForSend 的发送前抽卡。 */
async function sendThroughEdit(): Promise<void> {
  await act(async () => {
    await timelineProps
      .at(-1)
      ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "再加速一轮", []);
    await flushMicrotasks();
  });
}

/**
 * 走 Composer sendText 路径，并让发送停在 prepare 之前的 Start 套餐推荐 await；
 * 返回的 release 放行后才会进入 Highspeed prepare。
 */
async function sendTextHeldBeforePrepare(): Promise<{
  release: () => void;
  sending: Promise<unknown>;
}> {
  let release: () => void = () => {};
  startPlanRecommendation.state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    sending =
      latestComposer().onSendText?.("加速一轮", {
        submission: {
          mode: "build",
          planEnabled: false,
          modelSelection: {
            providerId: "builtin:bigmodel-coding-plan",
            modelId: "GLM-5.3",
          },
        },
      }) ?? Promise.reject(new Error("composer 未提供 onSendText"));
    await flushMicrotasks();
  });
  expect(startPlanRecommendation.recommend).toHaveBeenCalledTimes(1);
  expect(servicesMock.highspeedCardService.prepareTurn).not.toHaveBeenCalled();
  return { release, sending };
}

/** 入口摘除后 Composer 不应再收到任何一个加速卡入口 props（字段整体不存在，而非取值 null）。 */
function expectNoHighspeedEntryProps(): void {
  const props = latestComposer();
  expect(props.highspeedCard).toBeUndefined();
  expect(props.highspeedActivationCardId).toBeUndefined();
  expect(props.onHighspeedActivationApplied).toBeUndefined();
}

afterEach(() => {
  sendCommandMock.mockClear();
  composerProps.length = 0;
  timelineProps.length = 0;
  servicesMock.highspeedCardService.getSnapshot.mockReset();
  servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
    card: null,
    nextDrawAt: null,
    drawing: false,
  });
  servicesMock.highspeedCardService.prepareTurn.mockReset();
  startPlanRecommendation.state.hold = null;
  startPlanRecommendation.recommend.mockClear();
  projectionState.current = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane Highspeed 输入框入口摘除（fork F4.1b）", () => {
  it("Composer 不再接收加速卡入口 props：初始渲染、快照恢复与 draw 命中后都不传", async () => {
    // F4.1b 验收（specs/fork-official-deps-removal-tasks.md）：加速卡入口摘除后，即使
    // getSnapshot 仍有有效卡、发送路径抽中新卡，输入框也不再进入加速态。
    const card = makeCard("card-1");
    servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
      card,
      nextDrawAt: card.expiresAt,
      drawing: false,
    });
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      expectNoHighspeedEntryProps();

      mockDrawHit(card);
      await sendThroughEdit();
      expect(
        servicesMock.highspeedCardService.prepareTurn,
      ).toHaveBeenCalledTimes(1);
      expectNoHighspeedEntryProps();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("保留的 turn 链路仍按发送起点抽卡：prepare 返回前切走 Task 也不改归属（留给 F4.2 删除）", async () => {
    // 原 §9.2「卡片不属于当前 Task 时不呈现」用例的保留半边：composer 呈现已随入口摘除
    // 不可观察，但 prepareTurn / sendCommand 仍以发送起点归属，跨 Task 加速仍是真实缺陷。
    const card = makeCard("card-late", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      let resolvePrepare: (value: unknown) => void = () => {};
      servicesMock.highspeedCardService.prepareTurn.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
      );
      let sending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        sending = Promise.resolve(
          timelineProps
            .at(-1)
            ?.onEdit?.(
              { rowId: 42, entityId: "message-user-42" },
              "再加速一轮",
              [],
            ),
        );
        await flushMicrotasks();
      });
      expect(
        servicesMock.highspeedCardService.prepareTurn,
      ).toHaveBeenCalledTimes(1);

      await renderPane(root, "session-b");
      await act(async () => {
        resolvePrepare({
          kind: "accelerated",
          card,
          nextDrawAt: card.expiresAt,
        });
        await sending;
        await flushMicrotasks();
      });
      expect(
        servicesMock.highspeedCardService.prepareTurn,
      ).toHaveBeenCalledWith(expect.objectContaining({ taskId: "session-a" }));
      expectNoHighspeedEntryProps();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("保留的 turn 链路在 prepare 开始前切走 Task 时仍归属发送起点（留给 F4.2 删除）", async () => {
    // 原 CR-01 回归用例的保留半边：起点在发送同步阶段冻结，prepare 之前的切换不改变
    // prepareTurn 的 taskId 与 sendCommand 的 sessionId。
    const card = makeCard("card-pre-prepare", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      const { release, sending } = await sendTextHeldBeforePrepare();

      await renderPane(root, "session-b");
      mockDrawHit(card);
      await act(async () => {
        release();
        await sending;
        await flushMicrotasks();
      });
      expect(
        servicesMock.highspeedCardService.prepareTurn,
      ).toHaveBeenCalledWith(expect.objectContaining({ taskId: "session-a" }));
      expect(sendCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "sendText", sessionId: "session-a" }),
      );
      expectNoHighspeedEntryProps();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
