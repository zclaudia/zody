import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MobileHistorySearchOutcome,
  MobileHistorySearchRequest,
  MobileHistorySearchItem,
} from "@zody/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zody/shared";

export interface MobileHistorySearchWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspacePurpose?: "project" | "conversation";
}

export interface MobileHistorySearchConnection {
  backendId: string;
  connectionGeneration: number;
}

export type MobileHistorySearchSender = (
  request: MobileHistorySearchRequest,
) => Promise<MobileHistorySearchOutcome>;

// localeCompare 的顺序依赖运行环境 locale（大小写、重音字符等排序规则不同），
// 同一份 outcomes 在不同手机上可能得到不同顺序。tie-break 统一改用 UTF-16
// 码点比较，保证任意环境下的排序结果确定、可复现。
function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function signatureFor(workspaces: readonly MobileHistorySearchWorkspace[]): string {
  return JSON.stringify([...new Set(workspaces.map(resolveWebRemoteControlWorkspaceKey))].sort());
}

function uniqueWorkspaces(workspaces: readonly MobileHistorySearchWorkspace[]) {
  const byKey = new Map<string, MobileHistorySearchWorkspace>();
  for (const workspace of workspaces) {
    byKey.set(resolveWebRemoteControlWorkspaceKey(workspace), workspace);
  }
  return [...byKey.values()];
}

// MS09：搜索 overlay 在 Shell 中按条件渲染，关闭即卸载 hook，React 内存状态随之丢失，
// 用户返回再进入时 query/outcomes 全部被清空。overlay 的挂载点不在本模块职责内，
// 因此把「已提交搜索会话」提升到模块级 store：同一 scopeKey 重新挂载时恢复
// query/submittedQuery/includeArchived/limit/outcomes，关闭再打开不丢状态。
interface PersistedMobileHistorySearchSession {
  scopeKey: string;
  query: string;
  submittedQuery: string;
  includeArchived: boolean;
  limit: 50 | 100 | 200;
  outcomes: MobileHistorySearchOutcome[];
}

let persistedMobileHistorySearchSession: PersistedMobileHistorySearchSession | null = null;

function readPersistedMobileHistorySearchSession(
  scopeKey: string,
): PersistedMobileHistorySearchSession | null {
  return persistedMobileHistorySearchSession &&
    persistedMobileHistorySearchSession.scopeKey === scopeKey
    ? persistedMobileHistorySearchSession
    : null;
}

/** 仅供测试隔离使用：清空模块级搜索会话 store，避免用例间互相恢复状态。 */
export function clearMobileHistorySearchSessionForTest(): void {
  persistedMobileHistorySearchSession = null;
}

export function useMobileHistorySearch(params: {
  workspaces: readonly MobileHistorySearchWorkspace[];
  connection: MobileHistorySearchConnection;
  send: MobileHistorySearchSender;
  createRequestId: () => string;
}) {
  const initialSessionRef = useRef<PersistedMobileHistorySearchSession | null | undefined>(
    undefined,
  );
  if (initialSessionRef.current === undefined) {
    // 只在首次挂载读取一次（undefined=未读，null=无匹配会话）：
    // 模块级 store 在单实例生命周期内只由本 hook 写入，首次读取后不再重复读。
    initialSessionRef.current = readPersistedMobileHistorySearchSession(
      `${params.connection.backendId}\0${params.connection.connectionGeneration}\0${signatureFor(params.workspaces)}`,
    );
  }
  const [query, setQuery] = useState(() => initialSessionRef.current?.query ?? "");
  const [includeArchived, setIncludeArchived] = useState(
    () => initialSessionRef.current?.includeArchived ?? false,
  );
  const [limit, setLimit] = useState<50 | 100 | 200>(() => initialSessionRef.current?.limit ?? 50);
  const [outcomes, setOutcomes] = useState<MobileHistorySearchOutcome[]>(
    () => initialSessionRef.current?.outcomes ?? [],
  );
  const [isSearching, setIsSearching] = useState(false);
  const [submittedQuery, setSubmittedQuery] = useState(
    () => initialSessionRef.current?.submittedQuery ?? "",
  );
  const [retryingScopes, setRetryingScopes] = useState<string[]>([]);
  const generationRef = useRef(0);
  const signature = signatureFor(params.workspaces);
  const scopeKey = `${params.connection.backendId}\0${params.connection.connectionGeneration}\0${signature}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const lastScopeKeyRef = useRef(scopeKey);
  const submittedQueryRef = useRef(initialSessionRef.current?.submittedQuery ?? "");
  const includeArchivedRef = useRef(includeArchived);
  const retryingScopesRef = useRef<Set<string>>(new Set());

  const runSearch = useCallback(
    async (
      nextLimit: 50 | 100 | 200 = 50,
      nextIncludeArchived = includeArchived,
      queryOverride = query,
    ) => {
      const trimmed = queryOverride.trim();
      if (!trimmed || trimmed.length > 256) {
        generationRef.current += 1;
        setOutcomes([]);
        setSubmittedQuery("");
        // 清空提交态，避免项目目录更新后意外恢复用户已清除的旧查询。
        submittedQueryRef.current = "";
        setIsSearching(false);
        return;
      }
      const generation = ++generationRef.current;
      const frozenWorkspaces = uniqueWorkspaces(params.workspaces);
      const frozenSignature = signatureFor(frozenWorkspaces);
      const frozenScopeKey = `${params.connection.backendId}\0${params.connection.connectionGeneration}\0${frozenSignature}`;
      setLimit(nextLimit);
      setSubmittedQuery(trimmed);
      submittedQueryRef.current = trimmed;
      setOutcomes([]);
      setIsSearching(frozenWorkspaces.length > 0);

      let next = 0;
      const collected: MobileHistorySearchOutcome[] = [];
      const worker = async () => {
        for (;;) {
          // 修复：每轮迭代发放新请求前先检查 generation/scopeKey。此前旧轮次只会在
          // 结果回来后被丢弃，仍会把剩余 scope 的请求全部发出；被新查询或目录变化
          // 取代的旧轮必须在这里立即停止，避免占用并发窗口和后端配额。
          if (generationRef.current !== generation || scopeKeyRef.current !== frozenScopeKey) {
            return;
          }
          const index = next++;
          const workspace = frozenWorkspaces[index];
          if (!workspace) return;
          const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
          const requestId = params.createRequestId();
          const request: MobileHistorySearchRequest = {
            zcode_type: "mobile-history-search-request",
            requestId,
            context: {
              backendId: params.connection.backendId,
              connectionGeneration: params.connection.connectionGeneration,
              workspaceKey,
              requestId,
            },
            queryGeneration: generation,
            scopeSignature: frozenSignature,
            query: trimmed,
            includeArchived: nextIncludeArchived,
            limit: nextLimit,
          };
          try {
            const outcome = await params.send(request);
            if (
              generationRef.current === generation &&
              scopeKeyRef.current === frozenScopeKey &&
              outcome.queryGeneration === generation &&
              outcome.scopeSignature === frozenSignature &&
              outcome.context.backendId === request.context.backendId &&
              outcome.context.connectionGeneration === request.context.connectionGeneration &&
              outcome.context.requestId === request.context.requestId &&
              outcome.context.workspaceKey === workspaceKey
            ) {
              collected.push(outcome);
              setOutcomes([...collected]);
            }
          } catch {
            const outcome: MobileHistorySearchOutcome = {
              zcode_type: "mobile-history-search-outcome",
              requestId: request.requestId,
              context: request.context,
              queryGeneration: generation,
              scopeSignature: frozenSignature,
              status: "error",
              errorCode: "search-request-failed",
            };
            if (generationRef.current === generation && scopeKeyRef.current === frozenScopeKey) {
              collected.push(outcome);
              setOutcomes([...collected]);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, frozenWorkspaces.length) }, worker));
      if (generationRef.current === generation && scopeKeyRef.current === frozenScopeKey) {
        setIsSearching(false);
      }
    },
    [includeArchived, params, query],
  );

  // MS03：单 scope 重试入口。只针对失败 source 补发一次请求，沿用当前提交的
  // query/limit/includeArchived，并且不递增 generation——递增会让仍在途的主轮请求
  // 结果被整体判定过期；retry 与主轮共享 generation，靠 requestId 上下文校验落位。
  const retryScope = useCallback(
    async (workspaceKey: string) => {
      const trimmed = submittedQueryRef.current.trim();
      if (!trimmed || trimmed.length > 256) return;
      const workspace = uniqueWorkspaces(params.workspaces).find(
        (candidate) => resolveWebRemoteControlWorkspaceKey(candidate) === workspaceKey,
      );
      if (!workspace) return;
      const frozenSignature = signatureFor(uniqueWorkspaces(params.workspaces));
      const frozenScopeKey = `${params.connection.backendId}\0${params.connection.connectionGeneration}\0${frozenSignature}`;
      const generation = generationRef.current;
      const requestId = params.createRequestId();
      const request: MobileHistorySearchRequest = {
        zcode_type: "mobile-history-search-request",
        requestId,
        context: {
          backendId: params.connection.backendId,
          connectionGeneration: params.connection.connectionGeneration,
          workspaceKey,
          requestId,
        },
        queryGeneration: generation,
        scopeSignature: frozenSignature,
        query: trimmed,
        includeArchived: includeArchivedRef.current,
        limit,
      };
      retryingScopesRef.current.add(workspaceKey);
      setRetryingScopes([...retryingScopesRef.current]);
      const replaceOutcome = (outcome: MobileHistorySearchOutcome) => {
        setOutcomes((previous) =>
          previous.map((candidate) =>
            candidate.context.workspaceKey === workspaceKey ? outcome : candidate,
          ),
        );
      };
      try {
        const outcome = await params.send(request);
        if (
          generationRef.current === generation &&
          scopeKeyRef.current === frozenScopeKey &&
          outcome.queryGeneration === generation &&
          outcome.scopeSignature === frozenSignature &&
          outcome.context.requestId === requestId &&
          outcome.context.workspaceKey === workspaceKey
        ) {
          replaceOutcome(outcome);
        }
      } catch {
        const outcome: MobileHistorySearchOutcome = {
          zcode_type: "mobile-history-search-outcome",
          requestId,
          context: request.context,
          queryGeneration: generation,
          scopeSignature: frozenSignature,
          status: "error",
          errorCode: "search-request-failed",
        };
        if (generationRef.current === generation && scopeKeyRef.current === frozenScopeKey) {
          replaceOutcome(outcome);
        }
      } finally {
        retryingScopesRef.current.delete(workspaceKey);
        setRetryingScopes([...retryingScopesRef.current]);
      }
    },
    [limit, params],
  );

  useEffect(() => {
    if (lastScopeKeyRef.current === scopeKey) return;
    lastScopeKeyRef.current = scopeKey;
    generationRef.current += 1;
    setOutcomes([]);
    setIsSearching(false);
    const submittedQuery = submittedQueryRef.current;
    if (submittedQuery) {
      void runSearch(50, includeArchivedRef.current, submittedQuery);
    }
  }, [runSearch, scopeKey]);

  // MS09：挂载时如果恢复了上一轮会话，但 outcomes 没有覆盖当前全部 scope
  //（关闭 overlay 时搜索尚未完成），这些 scope 会永远停留在 pending 提示。
  // 这里补发一轮，让恢复的会话收敛到完整结果。
  const mountSessionConvergedRef = useRef(false);
  useEffect(() => {
    if (mountSessionConvergedRef.current) return;
    mountSessionConvergedRef.current = true;
    const session = initialSessionRef.current;
    if (!session?.submittedQuery) return;
    const covered = new Set(session.outcomes.map((outcome) => outcome.context.workspaceKey));
    const missingScope = uniqueWorkspaces(params.workspaces).some(
      (workspace) => !covered.has(resolveWebRemoteControlWorkspaceKey(workspace)),
    );
    if (missingScope) {
      void runSearch(session.limit, session.includeArchived, session.submittedQuery);
    }
  }, [params.workspaces, runSearch]);

  // MS09：会话状态持续写入模块级 store；scopeKey 变化后旧目录的会话自然被替换，
  // 不同 scopeKey 重新挂载时不恢复（目录/连接已变，旧结果不可信）。
  useEffect(() => {
    persistedMobileHistorySearchSession = {
      scopeKey,
      query,
      submittedQuery,
      includeArchived,
      limit,
      outcomes,
    };
  });

  const items: MobileHistorySearchItem[] = outcomes
    .flatMap((outcome) => (outcome.status === "ok" ? (outcome.items ?? []) : []))
    .sort(
      (left, right) =>
        right.task.updatedAt - left.task.updatedAt ||
        right.task.createdAt - left.task.createdAt ||
        // tie-break 使用码点比较（compareCodePoints），不再依赖 localeCompare。
        compareCodePoints(left.workspaceKey, right.workspaceKey) ||
        compareCodePoints(right.task.taskId, left.task.taskId),
    )
    .slice(0, limit);
  const rawOkItemCount = outcomes.reduce(
    (count, outcome) => count + (outcome.status === "ok" ? (outcome.items?.length ?? 0) : 0),
    0,
  );
  // 修复：只有上一轮结果打满当前 limit 时才提示继续扩容；3 条结果时提示
  // "Show up to 100" 会对用户撒谎（更大概率根本没有更多结果）。
  const canShowMore = limit < 200 && submittedQuery.length > 0 && rawOkItemCount >= limit;

  return {
    query,
    setQuery,
    includeArchived,
    setIncludeArchived(next: boolean) {
      includeArchivedRef.current = next;
      setIncludeArchived(next);
      if (submittedQueryRef.current) void runSearch(50, next, submittedQueryRef.current);
    },
    limit,
    outcomes,
    items,
    isSearching,
    submittedQuery,
    retryingScopes,
    runSearch,
    retryScope,
    showMore() {
      // 扩容沿用已提交查询，不能把输入框中尚未提交的草稿作为新搜索。
      if (canShowMore)
        void runSearch(
          limit === 50 ? 100 : 200,
          includeArchivedRef.current,
          submittedQueryRef.current,
        );
    },
    canShowMore,
  };
}
