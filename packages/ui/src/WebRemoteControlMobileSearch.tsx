import { useMemo } from "react";
import type { MobileHistorySearchSender } from "@/hooks/useMobileHistorySearch.js";
import {
  useMobileHistorySearch,
  type MobileHistorySearchConnection,
  type MobileHistorySearchWorkspace,
} from "@/hooks/useMobileHistorySearch.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface WebRemoteControlMobileSearchProps {
  workspaces: readonly MobileHistorySearchWorkspace[];
  connection: MobileHistorySearchConnection;
  send: MobileHistorySearchSender;
  createRequestId: () => string;
  onSelectTask: (target: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    taskId: string;
    search: { query: string; snippet: string; snippetIndex: number };
  }) => void;
  onBack: () => void;
}

/**
 * 触屏态命中区下限 44×44px 的 media 前缀（docs/web-remote-control/mobile-viewport-input-and-touch.md D1），
 * 与 lib/mobileTextInput.ts:3 同一 media 内核；不带该前缀的样式保持桌面基线不变。
 */
const TOUCH_TARGET_MEDIA = "[@media(hover:none)_and_(pointer:coarse)]";

function highlight(text: string, query: string) {
  const normalized = query.toLocaleLowerCase();
  const index = text.toLocaleLowerCase().indexOf(normalized);
  if (index < 0 || !query) return text;
  return (
    <>
      {text.slice(0, index)}
      {/* searchfile-10：裸 <mark> 落到浏览器默认亮黄底黑字，Zai Dark 下非常刺眼；
          改用设计系统预留的 find-highlight 语义 token（styles.css --color-find-highlight，随主题切换）。 */}
      <mark className="bg-find-highlight text-foreground">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  );
}

export function WebRemoteControlMobileSearch({
  workspaces,
  connection,
  send,
  createRequestId,
  onSelectTask,
  onBack,
}: WebRemoteControlMobileSearchProps) {
  const { intl } = useZCodeIntl();
  const search = useMobileHistorySearch({ workspaces, connection, send, createRequestId });
  const knownScopes = useMemo(
    () => new Set(search.outcomes.map((outcome) => outcome.context.workspaceKey)),
    [search.outcomes],
  );
  const pendingScopes = workspaces.filter(
    (workspace) => !knownScopes.has(workspace.workspaceIdentity?.trim() || workspace.workspacePath),
  );
  const noResults =
    search.submittedQuery.length > 0 &&
    !search.isSearching &&
    pendingScopes.length === 0 &&
    search.items.length === 0 &&
    search.outcomes.every((outcome) => outcome.status === "ok");

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-mobile-page="search"
    >
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        {/* touch-8：返回按钮原默认 h-7（28px）低于触屏命中区下限，触屏态抬到 ≥44px。 */}
        <Button
          type="button"
          variant="ghost"
          className={`${TOUCH_TARGET_MEDIA}:h-11 ${TOUCH_TARGET_MEDIA}:min-w-11`}
          onClick={onBack}
          aria-label={intl.formatMessage({ id: "mobileSearch.back" })}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <h1 className="text-ui-lg font-semibold">
          {intl.formatMessage({ id: "mobileSearch.title" })}
        </h1>
      </header>
      <form
        className="flex shrink-0 gap-2 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void search.runSearch(50);
        }}
      >
        <Input
          className="text-mobile-input-safe"
          value={search.query}
          maxLength={257}
          onChange={(event) => search.setQuery(event.currentTarget.value)}
          placeholder={intl.formatMessage({ id: "mobileSearch.placeholder" })}
          aria-label={intl.formatMessage({ id: "mobileSearch.placeholder" })}
          // keyboard-5：声明搜索型输入，手机键盘动作键显示「搜索」而非通用「换行」。
          inputMode="search"
          enterKeyHint="search"
        />
        <Button
          type="submit"
          className={`${TOUCH_TARGET_MEDIA}:h-11`}
          disabled={search.isSearching || search.query.trim().length === 0}
        >
          <span className="text-ui-base">{intl.formatMessage({ id: "mobileSearch.search" })}</span>
        </Button>
      </form>
      {search.query.trim().length > 256 ? (
        <p className="px-4 text-ui-sm text-destructive" role="alert">
          {intl.formatMessage({ id: "mobileSearch.queryTooLong" })}
        </p>
      ) : null}
      {/* 整行 label 即点击目标；触屏态补足上下 padding 使命中区 ≥44px，桌面保持原密度。 */}
      <label className="flex shrink-0 items-center gap-2 px-4 pb-3 text-ui-base [@media(hover:none)_and_(pointer:coarse)]:pt-3">
        <input
          type="checkbox"
          checked={search.includeArchived}
          onChange={(event) => search.setIncludeArchived(event.currentTarget.checked)}
        />
        {intl.formatMessage({ id: "mobileSearch.includeArchived" })}
      </label>
      <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" aria-live="polite">
        {search.isSearching ? (
          <p className="py-3 text-ui-sm">{intl.formatMessage({ id: "mobileSearch.searching" })}</p>
        ) : null}
        {pendingScopes.length > 0 ? (
          <p className="py-2 text-ui-sm text-muted-foreground">
            {intl.formatMessage(
              { id: "mobileSearch.pendingScopes" },
              { count: String(pendingScopes.length) },
            )}
          </p>
        ) : null}
        {search.outcomes.some((outcome) => outcome.status !== "ok") ? (
          <div className="border-b py-3 text-ui-sm" role="status">
            {search.outcomes
              .filter((outcome) => outcome.status !== "ok")
              .map((outcome) => (
                // MS03：失败 source 行内提供单 scope 重试；只补发该 scope 的请求，
                // 不清空其余 source 已有结果。文案复用既有通用 key common.retry。
                <div
                  className="flex items-center justify-between gap-2 py-1"
                  key={outcome.context.workspaceKey}
                >
                  <p className="min-w-0 flex-1">
                    {intl.formatMessage({ id: `mobileSearch.source.${outcome.status}` })}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    className={`${TOUCH_TARGET_MEDIA}:min-h-11`}
                    disabled={
                      search.isSearching ||
                      search.retryingScopes.includes(outcome.context.workspaceKey)
                    }
                    onClick={() => void search.retryScope(outcome.context.workspaceKey)}
                  >
                    {intl.formatMessage({ id: "common.retry" })}
                  </Button>
                </div>
              ))}
          </div>
        ) : null}
        {search.items.map((item) => (
          <button
            className="block w-full border-b px-1 py-3 text-left"
            key={`${item.workspaceKey}:${item.task.taskId}`}
            type="button"
            onClick={() =>
              onSelectTask({
                workspaceKey: item.workspaceKey,
                workspacePath: item.task.workspacePath,
                ...(item.task.workspaceIdentity
                  ? { workspaceIdentity: item.task.workspaceIdentity }
                  : {}),
                ...(item.remoteSessionId ? { remoteSessionId: item.remoteSessionId } : {}),
                taskId: item.task.taskId,
                search: {
                  query: search.submittedQuery,
                  snippet: item.snippets[0] ?? item.task.title,
                  snippetIndex: item.snippets.length > 0 ? 0 : -1,
                },
              })
            }
          >
            {/* viewport-5：搜索命中内容里长无空格 token（URL、commit hash、代码片段）很常见，
                break-all 保证标题与 snippet 在结果列表内折行，不产生横向滚动/裁剪。 */}
            <span className="block break-all text-ui-base font-medium">
              {highlight(item.task.title, search.submittedQuery)}
            </span>
            {item.snippets.map((snippet, index) => (
              <span
                className="mt-1 block break-all text-ui-sm text-muted-foreground"
                key={`${index}:${snippet}`}
              >
                {highlight(snippet, search.submittedQuery)}
              </span>
            ))}
            <span className="mt-1 block truncate text-ui-xs text-muted-foreground">
              {item.workspaceKey}
            </span>
          </button>
        ))}
        {noResults ? (
          <p className="py-6 text-center text-ui-sm">
            {intl.formatMessage({ id: "mobileSearch.noResults" })}
          </p>
        ) : null}
        {search.canShowMore ? (
          <Button
            className={`mt-3 w-full ${TOUCH_TARGET_MEDIA}:h-11`}
            type="button"
            variant="outline"
            onClick={search.showMore}
            disabled={search.isSearching}
          >
            {intl.formatMessage(
              { id: "mobileSearch.showMore" },
              { count: String(search.limit === 50 ? 100 : 200) },
            )}
          </Button>
        ) : null}
        {search.limit === 200 && !search.isSearching ? (
          <p className="py-3 text-center text-ui-sm text-muted-foreground">
            {intl.formatMessage({ id: "mobileSearch.narrowQuery" })}
          </p>
        ) : null}
      </section>
    </main>
  );
}
