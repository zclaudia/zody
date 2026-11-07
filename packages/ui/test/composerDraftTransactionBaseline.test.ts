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
import {
  createTextContentSyncController,
  resolveTextContentPublication,
} from "@/LexicalChatInput.js";

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

  // ── 步③ createSession 信封幂等（2026-11-08 落地，由 it.fails 翻转为 it）──
  it("F28-B4 护栏：createSession 信封首次构造分配幂等 sess_ 会话 ID，重试沿用同一 ID", () => {
    const payload = { workspaceId: "/workspace" };
    const envelope = createCommandEnvelope({
      type: "createSession",
      sessionId: null,
      payload,
    });
    // 上游 commandFactory（a60ba6a7）：sessionId 在信封首次构造时分配（`sess_` + UUID），
    // 同一提交的重试沿用同一 ID，避免 transport 重试重复预留另一条任务。
    // 基线（2026-11-07，it.fails）：payload.sessionId 为 undefined。
    // 跨进程消费需 shared schema + CLI 扩展（卡外，spec 步③「跨进程缺口」登记）。
    const assigned = (envelope.payload as { sessionId?: string }).sessionId;
    expect(assigned).toMatch(
      /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // 重试/重放把已分配 ID 回传 payload 时必须沿用（pendingCommandRegistry 重放路径）。
    const retried = createCommandEnvelope({
      type: "createSession",
      sessionId: null,
      payload: { ...payload, sessionId: assigned },
    });
    expect((retried.payload as { sessionId?: string }).sessionId).toBe(assigned);
    // 非 createSession 信封不携带该键（sendText 等 payload 语义不变）。
    const sendText = createCommandEnvelope({
      type: "sendText",
      sessionId: "session-a",
      payload: { text: "hi" },
    });
    expect((sendText.payload as { sessionId?: string }).sessionId).toBeUndefined();
  });

  // ── 步④ IME composition 抑制发布（2026-11-08 落地，由 it.fails 翻转为 it）──
  it("F28-B5 护栏：IME 组合期间不发布；compositionend 后按终态发布一次并去重", async () => {
    const onChange = vi.fn();
    let composing = true;
    const controller = createTextContentSyncController({
      onChange,
      taskId: null,
      getIsComposing: () => composing,
    });
    controller.handleEditorUpdate({ isDirty: true, nextText: "组合候选中间态" });
    controller.handleEditorUpdate({ isDirty: true, nextText: "组合最终正文" });
    // 冲刷走 queueMicrotask（见 createTextContentSyncController.schedule）。
    await Promise.resolve();
    await Promise.resolve();
    // 上游语义（a60ba6a7）：composing 期间 publish=null——组合候选留在 Lexical，不逐候选
    // 触发父级热路径。基线（2026-11-07，it.fails）：组合期间照常发布
    //（`expected "vi.fn()" to not be called at all, but actually been called 1 times`）。
    expect(onChange).not.toHaveBeenCalled();
    // compositionend：组合结束兜底冲刷按编辑器终态发布一次。
    composing = false;
    controller.handleCompositionEnd("组合最终正文");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("组合最终正文");
    // 组合结束后常规输入恢复微任务发布；重复终态（净回退到已发布值）不重复发布。
    controller.handleCompositionEnd("组合最终正文");
    expect(onChange).toHaveBeenCalledTimes(1);
    controller.handleEditorUpdate({ isDirty: true, nextText: "后续输入" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("后续输入");
    controller.dispose();
  });

  it("F28-B5 纯函数：resolveTextContentPublication 组合抑制与组合后去重状态机", () => {
    const initial = { lastPublishedText: "旧正文", pendingComposition: false };
    // 组合期间：不发布，置 pendingComposition。
    const duringComposition = resolveTextContentPublication({
      composing: true,
      nextText: "组合中",
      state: initial,
    });
    expect(duringComposition.publish).toBeNull();
    expect(duringComposition.state.pendingComposition).toBe(true);
    // 组合结束、终态与已发布文本相同：清标记不发布。
    const sameAsPublished = resolveTextContentPublication({
      composing: false,
      nextText: "旧正文",
      state: duringComposition.state,
    });
    expect(sameAsPublished.publish).toBeNull();
    expect(sameAsPublished.state.pendingComposition).toBe(false);
    // 组合结束、终态不同：发布一次并更新 lastPublishedText。
    const committed = resolveTextContentPublication({
      composing: false,
      nextText: "组合最终正文",
      state: duringComposition.state,
    });
    expect(committed.publish).toBe("组合最终正文");
    expect(committed.state).toEqual({
      lastPublishedText: "组合最终正文",
      pendingComposition: false,
    });
  });

  // ── 步② scope incarnation token（2026-11-08 落地，由 it.fails 翻转为 it）──
  it("F28-B2 护栏：A₁→B→A₂ 后旧世代闭包回调（全量写/staged 暂存）不写入复用的 scope", async () => {
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
    // 捕获 A₁ 挂载期的旧回调（对应迟到的编辑器/生命周期回调与 staged 热路径）。
    const staleWrite = control!.updateComposerContent;
    const staleStage = control!.stageComposerContent;
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "b" }));
    });
    act(() => control!.updateComposerContent({ text: "B 正文" }));
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "a" }));
    });
    act(() => control!.updateComposerContent({ text: "A₂ 新正文" }));
    // 旧世代回调必须被 incarnation token 拒绝（基线 2026-11-07：scopeKey 相同即放行，
    // 旧回调覆盖 A₂，it.fails 记录 `expected 'A₁ 旧回调' to be 'A₂ 新正文'`）。
    act(() => staleWrite({ text: "A₁ 旧回调" }));
    act(() => staleStage({ text: "A₁ 旧暂存" }));
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.text).toBe("A₂ 新正文");
    // 同世代（A₂）写入不受影响：staged 暂存后冲刷仍正常落盘。
    act(() => control!.stageComposerContent({ text: "A₂ 暂存" }));
    act(() => control!.persistComposerContent({ text: "A₂ 暂存" }));
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.text).toBe("A₂ 暂存");
    act(() => root.unmount());
  });

  // ── 步① staged 暂存热路径（2026-11-08 落地后的 staged 语义断言）──
  it("F28-G1 staged 热路径：击键暂存 0 父级 render、0 写盘；防抖冲刷一次合并落盘", async () => {
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
    // 等待与输入无关的一次性 settle（useModelSelectionServiceView 空服务读取落定），
    // 让后续 render 计数只反映热路径本身。
    await act(async () => {
      root.render(createElement(Probe));
    });
    const rendersBeforeTyping = renders;
    const writesBeforeTyping = setItemCalls;
    const updates = 5;
    for (let index = 0; index < updates; index += 1) {
      act(() => control!.stageComposerContent({ text: `第 ${index + 1} 次输入` }));
    }
    // 步①核心断言（a60ba6a7）：击键热路径只写 staged ref——owner 0 次 re-render、
    // 草稿键 0 次写盘（基线为 5 次更新 = 7 次 render + 5 次写盘，见 spec 指标表）。
    expect(renders).toBe(rendersBeforeTyping);
    expect(setItemCalls).toBe(writesBeforeTyping);
    // 防抖冲刷（persistComposerContent）把 staged 正文与 editorStateJson 合并落盘一次。
    act(() => control!.persistComposerContent({ text: "第 5 次输入", editorStateJson: "{}" }));
    expect(setItemCalls).toBe(writesBeforeTyping + 1);
    expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")).toMatchObject({
      text: "第 5 次输入",
      editorStateJson: "{}",
    });
    act(() => root.unmount());
  });

  // ── 步① staged 合并：配置变更落盘不丢 staged 正文 ──
  it("F28-G3 staged 合并：暂存正文后配置变更（mode）落盘包含最新正文", async () => {
    const { container } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-staged-merge";
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
    act(() => control!.updateComposerContent({ text: "旧正文" }));
    act(() => control!.stageComposerContent({ text: "未落盘的新正文" }));
    act(() => control!.handleDraftSwitchMode("yolo"));
    // staged 正文必须在配置变更落盘时被合并吸收（等价旧的「正文先进入内存 Draft」），
    // 否则暂存通道会把击键正文从持久草稿里丢掉。
    expect(readV4ComposerDraft(workspacePath, undefined, "session")).toMatchObject({
      text: "未落盘的新正文",
      mode: "yolo",
    });
    act(() => root.unmount());
  });

  // ── 步① 切换 flush：staged 正文与生命周期提交都写回旧 scope ──
  it("F28-G4 切换 flush：切 scope 时 staged 正文与生命周期快照写回旧 scope，不写新 scope", async () => {
    const { container } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-scope-flush";
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
    act(() => control!.updateComposerContent({ text: "已落盘" }));
    act(() => control!.stageComposerContent({ text: "防抖窗内正文" }));
    // 捕获 A 挂载期的一次性生命周期提交（对应 ConversationComposer persist effect setup）。
    const commitForA = control!.captureComposerContentLifecycleCommit();
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "b" }));
    });
    // scope 切换 cleanup 必须把 staged 正文写回旧 scope a（防抖窗内不丢稿）。
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.text).toBe("防抖窗内正文");
    // 迟到的生命周期快照也只写回捕获时 scope a，不得污染当前 scope b。
    act(() => commitForA({ text: "编辑器快照" }));
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.text).toBe("编辑器快照");
    expect(readV4ComposerDraft(workspacePath, undefined, "b")).toBeNull();
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

  // ── 步③ 提交事务：跨 scope 失败恢复（B3 的单元层修复证明）──
  it("F28-G5 事务：claim 后切走任务，失败 restore 仍写回提交 scope 且不写新 scope", async () => {
    const { container } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-transaction-restore";
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
    act(() => control!.updateComposerContent({ text: "提交正文" }));
    // 提交前捕获事务（对应 ConversationComposer.submit 的 capture 调用）。
    const token = control!.composerDraftScopeToken;
    const transaction = control!.captureComposerSubmissionDraftTransaction({
      text: "提交正文",
    });
    expect(transaction.matchesTarget(token)).toBe(true);
    expect(transaction.claim()).toBe(true);
    // claim 置空提交 scope 草稿（等待期间其他视图不得把已发送正文当草稿恢复）。
    // 无 mode/modelSelection 的纯正文草稿在置空后记录被删除（persist 语义）。
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.text ?? "").toBe("");
    // 等待期间切走任务：事务的身份不再匹配当前世代。
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "b" }));
    });
    expect(transaction.matchesTarget(control!.composerDraftScopeToken)).toBe(false);
    // 失败回包：restore 经事务自己的 persistence target 写回提交 scope a
    // （基线 B3：旧闭包 updateComposerContent 被守卫拒绝 → 草稿永久丢失）。
    const restored = transaction.restore();
    expect(restored).toEqual({ current: false, applied: true });
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.text).toBe("提交正文");
    // 事务永不写入后来切换到的 scope b。
    expect(readV4ComposerDraft(workspacePath, undefined, "b")).toBeNull();
    act(() => root.unmount());
  });

  // ── 步③ 提交事务：revision 门禁与幂等 ──
  it("F28-G6 事务：捕获后产生新输入（revision 变化）时 claim 被拒绝，新输入获胜", async () => {
    const { container } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-transaction-revision";
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
    act(() => control!.updateComposerContent({ text: "提交正文" }));
    const transaction = control!.captureComposerSubmissionDraftTransaction({
      text: "提交正文",
    });
    // 发送准备期间（prepareForSend 等 await）用户继续输入 → revision 已变化。
    act(() => control!.stageComposerContent({ text: "等待期间新输入" }));
    expect(transaction.claim()).toBe(false);
    // claim 未生效：草稿保持提交前状态，等待期间的新输入不被旧提交隐藏。
    const failedRestore = transaction.restore();
    expect(failedRestore.applied).toBe(false);
    act(() => root.unmount());
  });

  it("F28-G7 事务：finalize 只结算一次（重复调用返回 null），成功清空提交 scope", async () => {
    const { container } = installMinimalDom();
    const root = createRoot(container);
    const workspacePath = "/f28-transaction-finalize";
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
    act(() => control!.handleDraftSwitchMode("yolo"));
    act(() => control!.updateComposerContent({ text: "已接纳正文" }));
    const transaction = control!.captureComposerSubmissionDraftTransaction({
      text: "已接纳正文",
    });
    expect(transaction.claim()).toBe(true);
    // ACK、投影和发送 Promise 可先后到达；副作用只执行一次，重复 finalize 幂等。
    const finalized = transaction.finalize();
    expect(finalized).toEqual({ current: true, applied: true });
    expect(transaction.finalize()).toBeNull();
    expect(transaction.restore().applied).toBe(false);
    // 成功结算清空正文但保留配置（claim 语义延续）。
    expect(readV4ComposerDraft(workspacePath, undefined, "session")).toMatchObject({
      text: "",
      mode: "yolo",
    });
    act(() => root.unmount());
  });
});
