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

function highlight(text: string, query: string) {
  const normalized = query.toLocaleLowerCase();
  const index = text.toLocaleLowerCase().indexOf(normalized);
  if (index < 0 || !query) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
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
        <Button
          type="button"
          variant="ghost"
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
        />
        <Button type="submit" disabled={search.isSearching || search.query.trim().length === 0}>
          <span className="text-ui-base">{intl.formatMessage({ id: "mobileSearch.search" })}</span>
        </Button>
      </form>
      {search.query.trim().length > 256 ? (
        <p className="px-4 text-ui-sm text-destructive" role="alert">
          {intl.formatMessage({ id: "mobileSearch.queryTooLong" })}
        </p>
      ) : null}
      <label className="flex shrink-0 items-center gap-2 px-4 pb-3 text-ui-base">
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
            <span className="block text-ui-base font-medium">
              {highlight(item.task.title, search.submittedQuery)}
            </span>
            {item.snippets.map((snippet, index) => (
              <span
                className="mt-1 block text-ui-sm text-muted-foreground"
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
            className="mt-3 w-full"
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
