/**
 * F28 基线：Composer 草稿事务与 IME 安全（复现用例）。
 * 产品规格：docs/ui/composer-draft-transaction.md；E2E 场景登记：
 * docs/conversation-session-case-catalog.md PA162。
 *
 * 本文件是「草稿丢失复现基线」的可执行单元层用例，分两类：
 * - `it.fails`（基线复现）：断言移植后的期望行为，当前真实失败（复现 bug）。
 *   对应移植步（①～④）落地时必须翻转为普通 `it`（翻转即该步反例证据）；
 *   若某用例在移植前意外通过，套件变红——防止基线失真。
 * - `it`（基线护栏/刻画）：当前已成立的行为与量化指标，四步移植不得回退；
 *   步①落地后热路径刻画（G1）由该步改写为 staged 语义断言。
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useZodySessionStore } from "@/store/zodySessionStore.js";
import { useDraftConfigControl as useActualDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createTextContentSyncController } from "@/LexicalChatInput.js";

const { prepareWorkspaceMock } = vi.hoisted(() => ({
  prepareWorkspaceMock: vi.fn(),
}));

const { toastMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
}));

vi.mock("@/hooks/useWorkspacePrepare.js", () => ({
  prepareWorkspaceWithZodySessionService: prepareWorkspaceMock,
}));

vi.mock("@/hooks/useZodySessionService.js", () => ({
  useZodySessionService: () => ({ readWorkspacePresentation: vi.fn() }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: null }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: toastMock,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// 与 useDraftConfigControl.test.ts 同款最小 DOM：createRoot 挂载 Probe 组件驱动真实 hook。
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
  const storage = new Map<string, string>();
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return { container: createMinimalElement(documentMock), windowMock };
}

describe("F28 基线：Composer 草稿事务与 IME 安全", () => {
  beforeEach(() => {
    prepareWorkspaceMock.mockReset();
    toastMock.mockReset();
    useZodySessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  // ── 步③ createSession 信封幂等 ──
  it.fails("F28-B4 复现：createSession 信封未在首次构造时分配幂等 sess_ 会话 ID（a60ba6a7 上游语义）", () => {
    const envelope = createCommandEnvelope({
      type: "createSession",
      sessionId: null,
      payload: { workspaceId: "/workspace" },
    });
    // 上游 commandFactory：sessionId 在信封首次构造时分配（`sess_` + UUID），
    // 同一提交的重试沿用同一 ID，避免 transport 重试重复预留另一条任务。
    // 本仓 payload schema 尚无该字段（packages/shared 侧缺口，见 spec 步③风险登记）。
    const payload = envelope.payload as { sessionId?: string };
    expect(payload.sessionId).toMatch(/^sess_[0-9a-f-]{36}$/i);
  });

  // ── 步④ IME composition 抑制发布 ──
  it.fails("F28-B5 复现：IME 组合期间正文仍向 React 草稿 owner 发布", async () => {
    const onChange = vi.fn();
    const controller = createTextContentSyncController({
      onChange,
      taskId: null,
      getIsComposing: () => true,
    });
    controller.handleEditorUpdate({ isDirty: true, nextText: "候选中" });
    // 冲刷走 queueMicrotask（见 createTextContentSyncController.schedule）。
    await Promise.resolve();
    await Promise.resolve();
    // 上游 TextContentPlugin：composing 期间 publish=null，仅 presence 布尔量；
    // 组合正文留在 Lexical，compositionend 后的最终 update 才序列化发布。
    // 本仓组合期间照常发布（composingRef 只用于卡顿统计短路），热路径逐候选触发
    // 父级 re-render + 草稿写盘，且未来叠加发布抑制后必须改读编辑器事实防丢稿。
    expect(onChange).not.toHaveBeenCalled();
  });

  // ── 步② scope incarnation token ──
  it.fails("F28-B2 复现：A₁→B→A₂ 后旧 scope 闭包回调仍写入复用的 scope（scopeKey 无挂载身份）", async () => {
    const { container } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-incarnation";
    let control: ReturnType<typeof useActualDraftConfigControl>;
    function Probe({ sessionId }: { sessionId: string }) {
      control = useActualDraftConfigControl({
        workspacePath,
        sessionId,
        agentStartupAllowed: false,
        modelSelectionService: null,
      });
      return null;
    }
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "a" }));
    });
    act(() => control!.updateComposerContent({ text: "A₁ 正文" }));
    // 捕获 A₁ 挂载期的旧回调（对应迟到的编辑器/生命周期回调）。
    const staleWrite = control!.updateComposerContent;
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "b" }));
    });
    act(() => control!.updateComposerContent({ text: "B 正文" }));
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "a" }));
    });
    act(() => control!.updateComposerContent({ text: "A₂ 新正文" }));
    act(() => staleWrite({ text: "A₁ 旧回调" }));
    // 上游 isCurrentScope：scopeKey 会在 A₁→B→A₂ 后复用，旧回调必须同时校验
    // 本次挂载身份（incarnation symbol）。基线：scopeKey 相同即放行，旧回调覆盖 A₂。
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.text).toBe("A₂ 新正文");
    act(() => root.unmount());
  });

  // ── 步① staged 暂存热路径（基线量化刻画；移植步改写为 staged 断言）──
  it("F28-G1 基线刻画：每次正文更新即触发 owner re-render 与 localStorage 写盘（热路径成本）", async () => {
    const { container, windowMock } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-hotpath";
    let setItemCalls = 0;
    const originalSetItem = windowMock.localStorage.setItem.bind(windowMock.localStorage);
    windowMock.localStorage.setItem = (key: string, value: string) => {
      if (key.startsWith("zody-v4-composer-drafts:v1:")) setItemCalls += 1;
      originalSetItem(key, value);
    };
    let renders = 0;
    let control: ReturnType<typeof useActualDraftConfigControl>;
    function Probe() {
      renders += 1;
      control = useActualDraftConfigControl({
        workspacePath,
        sessionId: null,
        agentStartupAllowed: false,
        modelSelectionService: null,
      });
      return null;
    }
    await act(async () => {
      root.render(createElement(Probe));
    });
    const updates = 5;
    for (let index = 0; index < updates; index += 1) {
      act(() => control!.updateComposerContent({ text: `第 ${index + 1} 次输入` }));
    }
    // 现状（步①前）：每个击键的正文更新都走 setStoredState（父级整页 re-render）
    // 并同步 persistV4ComposerDraft 写 localStorage；额外 +1 渲染来自
    // useModelSelectionServiceView 空服务读取的异步落定（与输入无关的一次性 settle）。
    // 上游以 staged 暂存把热路径降为 ref 写入，本断言在步①落地时由该步改写为
    // staged 语义（0 父级 render、热路径 0 写盘）。
    expect(renders).toBe(updates + 2);
    expect(setItemCalls).toBe(updates);
    expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")?.text).toBe("第 5 次输入");
    act(() => root.unmount());
  });

  // ── 步③ claim 语义（既有防回退：claim 只清正文，不清配置）──
  it("F28-G2 护栏：发送 claim 清空正文时保留 mode/modelSelection 草稿配置", async () => {
    const { container } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-claim-keeps-config";
    let control: ReturnType<typeof useActualDraftConfigControl>;
    function Probe() {
      control = useActualDraftConfigControl({
        workspacePath,
        sessionId: "session",
        agentStartupAllowed: false,
        modelSelectionService: null,
      });
      return null;
    }
    await act(async () => {
      root.render(createElement(Probe));
    });
    act(() => control!.updateComposerContent({ text: "待发送" }));
    act(() => control!.handleDraftSwitchMode("yolo"));
    // 对应 ConversationComposer.claimSubmittedDraft 的 updateComposerContent({text:""})。
    act(() => control!.updateComposerContent({ text: "" }));
    const draft = readV4ComposerDraft(workspacePath, undefined, "session");
    // claim 只隐藏正文（失败可恢复）；mode/modelSelection 属于草稿配置事实，不得连带清除。
    expect(draft).toMatchObject({ text: "", mode: "yolo" });
    act(() => root.unmount());
  });
});
