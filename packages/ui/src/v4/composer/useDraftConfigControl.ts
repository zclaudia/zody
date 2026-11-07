import { applyComposerPermissionGrant } from "@/v4/composer/composerPermissionGrant.js";
/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// Composer 的模式/模型选择与正文使用同一 scope 草稿；Session 只提供一次初始化种子。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZODY_AGENT_PROVIDER, resolveExecutionState } from "@zody/shared";
import { applyComposerPlanTransition } from "@/v4/composer/composerPlanTransition.js";
import type {
  ZodyConfigOption,
  ModelSelection,
  ZodyProvider,
  ZodySlashCommand,
} from "@zody/shared";
import type { SessionConfigState } from "@zody/shared/zody-protocol-v4";
import type { IModelSelectionService } from "@zody/services";
import { completeNewModelSelection } from "@zody/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zody/shared/zody-protocol-v4";
import { prepareWorkspaceWithZodySessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZodySessionService } from "@/hooks/useZodySessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zodySessionProjection.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZodySessionStore } from "@/store/zodySessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

export function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  delete next.thought;
  return next;
}

export function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZodyConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZodySlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

/** 正文类字段：staged 暂存与生命周期提交只携带这些键，永不覆盖配置/授权标记。 */
export type ComposerDraftContent = Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">;

export interface ComposerSubmissionDraftTransactionResult {
  current: boolean;
  applied: boolean;
}

/** F28 步③（来源 a60ba6a7）：提交事务——claim 置空、失败 restore、成功 finalize。 */
export interface ComposerSubmissionDraftTransaction {
  claim: () => boolean;
  restore: () => ComposerSubmissionDraftTransactionResult;
  finalize: () => ComposerSubmissionDraftTransactionResult | null;
  release: () => void;
  matchesTarget: (scopeToken: symbol) => boolean;
}

export interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；Session 只在 scope 首次初始化时提供种子。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  /** 当前 scope 世代 token（F28 步②/③）：提交事务经 matchesTarget 匹配提交时挂载身份。 */
  composerDraftScopeToken: symbol;
  /**
   * 输入热路径唯一入口（F28 步①，来源 a60ba6a7）：只写 staged ref，
   * 不触发父级 re-render、不写 localStorage；落盘由防抖/配置变更/生命周期提交合并完成。
   */
  stageComposerContent: (content: ComposerDraftContent) => void;
  /** 防抖/失焦冲刷：先暂存再合并落盘（每个 350ms 空闲窗至多一次写盘）。 */
  persistComposerContent: (content: ComposerDraftContent) => void;
  /** effect setup 捕获的一次性生命周期提交；scope 切换/卸载后仍只写回捕获时 scope。 */
  captureComposerContentLifecycleCommit: () => (content: ComposerDraftContent) => void;
  /**
   * F28 步③（来源 a60ba6a7）：提交前捕获的事务。claim 置空提交 scope 草稿；失败
   * restore / 成功 finalize 只写事务自己的 scope persistence target——即使等待期间
   * 已切走任务，原 scope 仍可恢复（修复 B3），且不写入后来切换到的 scope。
   */
  captureComposerSubmissionDraftTransaction: (
    content: ComposerDraftContent,
  ) => ComposerSubmissionDraftTransaction;
  updateComposerContent: (content: ComposerDraftContent) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

function hasSameComposerDraftContent(left: V4ComposerDraft, right: V4ComposerDraft): boolean {
  return (
    left.text === right.text &&
    left.editorStateJson === right.editorStateJson &&
    left.mention === right.mention
  );
}

/** staged 暂存与生命周期提交的落盘目标：绑定捕获时 scope 的 baseDraft 与 persist 闭包。 */
interface ComposerDraftPersistenceTarget {
  scopeKey: string;
  /** 事务身份（步②世代 token）：matchesTarget 与 claim 的挂载身份比对基准。 */
  incarnation: symbol;
  /** 内容版本（步③）：每次正文变化 +1；revision 不匹配时 restore/finalize 不落盘。 */
  contentRevision: { current: number };
  baseDraft: V4ComposerDraft;
  persist: (draft: V4ComposerDraft) => boolean;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZodyProvider;
  /** 会话切换读取对应 scope；已有空选择也必须保留。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZODY_AGENT_PROVIDER;
  const zodySessionService = useZodySessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const scopeKey = JSON.stringify([workspaceKey, scopeId]);
  const loadedScope = useMemo(
    () => ({
      scopeKey,
      // F28 步②（来源 a60ba6a7）：scope 世代 token。scopeKey 在 A₁→B→A₂ 后复用，仅按
      // scopeKey 判定会把 A₁ 挂载期的迟到回调放进 A₂；Symbol 随每次 scope 重载新生成
      // （离开再返回即换代），与 stateRef.current 的世代一起参与写入门禁。
      incarnation: Symbol(scopeKey),
      draft: readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId) ?? {
        text: "",
        updatedAt: 0,
      },
    }),
    [scopeKey],
  );
  const [storedState, setStoredState] = useState(loadedScope);
  let currentState = storedState.scopeKey === scopeKey ? storedState : loadedScope;
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const initializeAsNewTask = sessionId === null || draft.initializeFromNewTask === true;
  if (!draft.mode && (initializeAsNewTask ? modelSelectionView !== null : sessionConfig != null)) {
    const mode = submissionModeSchema.safeParse(sessionConfig?.mode);
    // Recent 是初始化原意图，不先按旧 Provider 是否仍在候选中删掉；下一次输入读取
    // 由同一解析入口对应当前账号，或暂时留空。否则冷启动会绕过统一账号对应规则。
    // mode 是已初始化标记：历史恢复给出的空选择也是确定结果，后续 Snapshot 不得填满。
    draft =
      initializeAsNewTask && modelSelectionView
        ? initializeNewTaskDraft(draft, workspacePath, workspaceIdentity, modelSelectionView)
        : {
            ...draft,
            mode: mode.success && mode.data !== "plan" ? mode.data : "build",
            planEnabled: resolveExecutionState(sessionConfig ?? {}).planEnabled,
            modelSelection: sessionConfig?.modelSelection,
          };
  }
  if (sessionConfig) {
    draft = applyComposerPlanTransition(draft, sessionConfig.planTransition);
    draft = applyComposerPermissionGrant(draft, sessionConfig.permissionGrant);
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 原因：按 revision 清草稿会把短暂不可用永久写成空选择。这里只派生当前结果，
  // 正文/模式自动保存继续保存 draft 中的原意图；读取未就绪时保留展示，提交由 View 门禁阻断。
  const effectiveSelection = modelSelectionView
    ? (modelSelectionView.effectiveSelection ?? undefined)
    : draft.modelSelection;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode: draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [draft.mode, draft.planEnabled, effectiveSelection],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  // ── staged 暂存热路径（F28 步①，来源 a60ba6a7）──
  // Bug 根因：击键热路径走 updateComposerContent 的配置 setState，导致 SessionPane 级
  // 整页 re-render（上游注释：「350ms 自动保存走配置 setState，导致整页、Logo 和
  // Timeline 一起刷新」）并逐击键同步写 localStorage。正文改由 staged ref 持有；
  // 防抖冲刷、配置变更与生命周期提交统一合并 staged 后落盘，输入不再丢稿。
  const persistDraft = useCallback(
    (value: V4ComposerDraft) =>
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, value),
    [workspacePath, workspaceIdentity, scopeId],
  );
  const draftPersistenceRef = useRef(persistDraft);
  draftPersistenceRef.current = persistDraft;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // F28 步②（来源 a60ba6a7）：三重身份校验 mounted + scopeKey + incarnation。
  // scopeKey 会在 A₁→B→A₂ 后复用；旧世代挂载闭包（编辑器/生命周期迟到回调、staged
  // 暂存、全量写）必须被世代 token 拒绝，不得写入新世代草稿；同世代写入不受影响。
  const incarnation = currentState.incarnation;
  const isCurrentScope = useCallback(
    () =>
      mountedRef.current &&
      stateRef.current.scopeKey === scopeKey &&
      stateRef.current.incarnation === incarnation,
    [scopeKey, incarnation],
  );
  const stagedContentRef = useRef<
    | (ComposerDraftPersistenceTarget & {
        content: ComposerDraftContent;
      })
    | null
  >(null);
  // 当前 scope 世代的落盘目标：生命周期提交（captureComposerContentLifecycleCommit）与
  // 提交事务（步③）即使无 staged 内容也要写事实，因此独立于 stagedContentRef 存在；
  // incarnation 入 deps 使 A₂ 世代拿到全新 target（A₁ 闭包持有旧对象互不串写）。
  // contentRevision（步③）：per scopeKey 的内容版本，事务用它判定「等待期间是否有新输入」。
  const scopeContentRevisionRef = useRef(new Map<string, { current: number }>());
  const scopePersistenceTarget = useMemo<ComposerDraftPersistenceTarget>(() => {
    const contentRevision = scopeContentRevisionRef.current.get(scopeKey) ?? { current: 0 };
    scopeContentRevisionRef.current.set(scopeKey, contentRevision);
    return {
      scopeKey,
      incarnation,
      contentRevision,
      baseDraft: stateRef.current.draft,
      persist: draftPersistenceRef.current,
    };
  }, [scopeKey, incarnation]);
  const bumpScopeContentRevision = useCallback((target: ComposerDraftPersistenceTarget) => {
    target.contentRevision.current += 1;
  }, []);
  // baseDraft/persist 随配置演进同步，避免生命周期提交把陈旧 mode/model 写回旧 scope。
  // 配置演进改正文（如 replaceComposerDraft）时 bump revision——事务在等待期间发现的
  // 任何内容变化都属于下一次提交。
  useEffect(() => {
    if (!hasSameComposerDraftContent(scopePersistenceTarget.baseDraft, currentState.draft)) {
      bumpScopeContentRevision(scopePersistenceTarget);
    }
    scopePersistenceTarget.baseDraft = currentState.draft;
    scopePersistenceTarget.persist = draftPersistenceRef.current;
    const pending = stagedContentRef.current;
    if (pending?.scopeKey === scopeKey) {
      pending.baseDraft = currentState.draft;
      pending.persist = draftPersistenceRef.current;
    }
  }, [currentState.draft, scopeKey, scopePersistenceTarget, bumpScopeContentRevision]);
  // scope 切换/卸载时把未落盘的 staged 正文写回旧 scope（修复防抖窗口内的丢失）。
  // 子组件（ConversationComposer）的生命周期提交先执行并清 staged，这里兜底剩余 staged。
  useEffect(
    () => () => {
      const pending = stagedContentRef.current;
      if (!pending || pending.scopeKey !== scopeKey) return;
      pending.persist({
        ...pending.baseDraft,
        editorStateJson: undefined,
        mention: undefined,
        ...pending.content,
      });
      stagedContentRef.current = null;
    },
    [scopeKey],
  );
  const mergeStagedContent = useCallback(
    (current: V4ComposerDraft): V4ComposerDraft => {
      const staged = stagedContentRef.current;
      if (!staged || staged.scopeKey !== scopeKey) return current;
      return {
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...staged.content,
      };
    },
    [scopeKey],
  );
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      (draft.mode || draft.initializeFromNewTask) &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      // 配置初始化/变更落盘必须合并 staged 正文（等价旧的「正文先进入内存 Draft」）。
      persistDraft(mergeStagedContent(draft));
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey, persistDraft, mergeStagedContent]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (!isCurrentScope()) return;
      // 全量写路径先吸收 staged 正文再应用更新；staged 被合并消费后清除。
      const previous = mergeStagedContent(stateRef.current.draft);
      const next = update(previous);
      if (!hasSameComposerDraftContent(previous, next)) {
        bumpScopeContentRevision(scopePersistenceTarget);
      }
      const staged = stagedContentRef.current;
      if (staged?.scopeKey === scopeKey) stagedContentRef.current = null;
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      scopePersistenceTarget.baseDraft = next;
      scopePersistenceTarget.persist = draftPersistenceRef.current;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistDraft(next);
      lastPersistedDraftRef.current = next;
    },
    [isCurrentScope, mergeStagedContent, persistDraft, scopeKey, scopePersistenceTarget],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // 用户已经显式改选，不能再由导入时等待的默认初始化覆盖。
        ...(current.initializeFromNewTask
          ? { mode: mode.success ? mode.data : "build", initializeFromNewTask: undefined }
          : {}),
      }));
    },
    [updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const updateComposerContent = useCallback(
    (content: ComposerDraftContent) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const stageComposerContent = useCallback(
    (content: ComposerDraftContent) => {
      // 热路径只更新 staged ref：不 setStoredState、不写 localStorage（F28 步①）。
      // scopeKey 会在 A₁→B→A₂ 后复用；旧世代回调由步② incarnation 门禁拒绝。
      if (!isCurrentScope()) return;
      stagedContentRef.current = {
        scopeKey,
        incarnation,
        contentRevision: scopePersistenceTarget.contentRevision,
        content,
        baseDraft: stateRef.current.draft,
        persist: draftPersistenceRef.current,
      };
      bumpScopeContentRevision(scopePersistenceTarget);
    },
    [bumpScopeContentRevision, incarnation, isCurrentScope, scopeKey, scopePersistenceTarget],
  );
  const persistComposerContent = useCallback(
    (content: ComposerDraftContent) => {
      if (!isCurrentScope()) return;
      // Bug 根因：350ms 自动保存曾走配置 setState，导致整页、Logo 和 Timeline 一起刷新
      // （a60ba6a7）。冲刷只落盘合并后的完整草稿（每空闲窗至多一次），不改配置状态。
      stageComposerContent(content);
      persistDraft(mergeStagedContent(stateRef.current.draft));
    },
    [isCurrentScope, mergeStagedContent, persistDraft, stageComposerContent],
  );
  const captureComposerContentLifecycleCommit = useCallback(() => {
    const target = scopePersistenceTarget;
    let active = true;
    return (content: ComposerDraftContent) => {
      if (!active) return;
      active = false;
      // 一次性生命周期提交：scope 切换/卸载后仍写回捕获时 scope，不用可变 ref 定位目标。
      const draft = {
        ...target.baseDraft,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      };
      target.baseDraft = draft;
      bumpScopeContentRevision(target);
      target.persist(draft);
      const pending = stagedContentRef.current;
      if (pending?.scopeKey === target.scopeKey) stagedContentRef.current = null;
    };
  }, [bumpScopeContentRevision, scopePersistenceTarget]);
  const captureComposerSubmissionDraftTransaction = useCallback(
    (content: ComposerDraftContent): ComposerSubmissionDraftTransaction => {
      const target = scopePersistenceTarget;
      const submittedContent = {
        text: content.text,
        editorStateJson: content.editorStateJson,
        mention: content.mention,
      };
      const capturedRevision = target.contentRevision.current;
      let state: "captured" | "claimed" | "restored" | "finalized" = "captured";
      let claimedRevision: number | null = null;
      let restoredRevision: number | null = null;
      // 事务身份只认捕获时的世代与正文：等待期间切走任务（incarnation 不匹配）或
      // 产生新输入（正文变化）都不再是「当前」，但落盘仍走事务自己的 target。
      const isCurrent = () =>
        mountedRef.current &&
        stateRef.current.incarnation === target.incarnation &&
        stateRef.current.draft.text === target.baseDraft.text;
      const clearPending = () => {
        const pending = stagedContentRef.current;
        if (pending?.scopeKey === target.scopeKey && pending.incarnation === target.incarnation) {
          stagedContentRef.current = null;
        }
      };
      return {
        matchesTarget: (candidateScopeToken) => candidateScopeToken === target.incarnation,
        claim: () => {
          if (
            state !== "captured" ||
            !isCurrent() ||
            target.contentRevision.current !== capturedRevision
          ) {
            return false;
          }
          const claimedDraft = {
            ...target.baseDraft,
            text: "",
            editorStateJson: undefined,
            mention: undefined,
          };
          target.baseDraft = claimedDraft;
          bumpScopeContentRevision(target);
          claimedRevision = target.contentRevision.current;
          state = "claimed";
          target.persist(claimedDraft);
          const nextState = { ...stateRef.current, draft: claimedDraft };
          stateRef.current = nextState;
          setStoredState(nextState);
          clearPending();
          return true;
        },
        restore: () => {
          if (state !== "claimed" || claimedRevision === null) {
            return { current: isCurrent(), applied: state === "restored" };
          }
          const current = isCurrent();
          const restored = target.contentRevision.current === claimedRevision;
          if (restored) {
            const restoredDraft = {
              ...target.baseDraft,
              ...submittedContent,
            };
            target.baseDraft = restoredDraft;
            bumpScopeContentRevision(target);
            restoredRevision = target.contentRevision.current;
            target.persist(restoredDraft);
            if (current) {
              const nextState = { ...stateRef.current, draft: restoredDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
            state = "restored";
          }
          clearPending();
          return { current, applied: restored };
        },
        release: () => {
          state = "finalized";
        },
        finalize: () => {
          // ACK、投影和发送 Promise 可先后到达；事务唯一持有结算状态，副作用只执行一次。
          if (state === "finalized") return null;
          const current = isCurrent();
          const pending = stagedContentRef.current;
          if (pending?.scopeKey === target.scopeKey && pending.incarnation === target.incarnation) {
            target.baseDraft = {
              ...pending.baseDraft,
              editorStateJson: undefined,
              mention: undefined,
              ...pending.content,
            };
            bumpScopeContentRevision(target);
            target.persist(target.baseDraft);
            stagedContentRef.current = null;
            if (current) {
              const nextState = { ...stateRef.current, draft: target.baseDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
          }
          const expectedRevision =
            state === "claimed" ? claimedRevision : state === "restored" ? restoredRevision : null;
          const finalized =
            expectedRevision !== null && target.contentRevision.current === expectedRevision;
          if (finalized) {
            const finalizedDraft = {
              ...target.baseDraft,
              text: "",
              editorStateJson: undefined,
              mention: undefined,
            };
            target.baseDraft = finalizedDraft;
            bumpScopeContentRevision(target);
            target.persist(finalizedDraft);
            if (current) {
              const nextState = { ...stateRef.current, draft: finalizedDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
          }
          state = "finalized";
          clearPending();
          return { current, applied: finalized };
        },
      };
    },
    [bumpScopeContentRevision, scopePersistenceTarget],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      // 撤回编辑替换正文/配置，但不能忘记已经消费的授权，否则旧快照会再次覆盖新选择。
      updateComposerDraft((current) => ({
        ...replacement,
        lastPermissionGrantId: current.lastPermissionGrantId,
        updatedAt: Date.now(),
      }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (stateRef.current.scopeKey !== scopeKey || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // 首发成功曾直接删除 Root scope，真实 Session 没有 Composer Draft，
      // 重挂载后又从 Snapshot 初始化。先写目标、再删来源，保留完整正文/模式/选择。
      // staged 正文必须并入提升草稿（F28 步①）：防抖未到期时 store 里还是旧正文。
      const draftForPromotion = mergeStagedContent(stateRef.current.draft);
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        draftForPromotion,
      );
      if (!written) return;
      const staged = stagedContentRef.current;
      if (staged?.scopeKey === scopeKey) stagedContentRef.current = null;
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
    },
    [mergeStagedContent, scopeId, scopeKey, workspaceIdentity, workspacePath],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZodySessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZodySessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zodySessionService: zodySessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZodySessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZodySessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zodySessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // 用户点击模型只确定模型身份；Reasoning 没有默认值，保持为空并等待用户选择。
      const modelSelection = modelSelectionView
        ? (completeNewModelSelection(modelSelectionView, parsedSelection) ?? parsedSelection)
        : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [modelSelectionView, updateDraftConfig, workspaceIdentity, workspacePath],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        updateComposerDraft((current) => ({
          ...current,
          mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
          planEnabled: mode === "plan",
          initializeFromNewTask: undefined,
        }));
        return;
      }
      // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
          initializeFromNewTask: undefined,
        }));
    },
    [updateComposerDraft],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    composerDraftScopeToken: incarnation,
    stageComposerContent,
    persistComposerContent,
    captureComposerContentLifecycleCommit,
    captureComposerSubmissionDraftTransaction,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
