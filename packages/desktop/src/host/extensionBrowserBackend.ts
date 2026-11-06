/* eslint-disable max-lines -- backend 是 tab/claim/attachment 的唯一 owner；拆分会把同一状态机的校验分散到多个文件。 */
import { randomUUID } from "node:crypto";
import type {
  ExtensionBridgeClientMessage,
  ExtensionClaimDecisionMessage,
  ExtensionNativeTab,
} from "@zody/shared/browser-extension-transport";
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserUserTabInfo,
} from "@zody/shared";
import type { ExtensionCdpTransport } from "../browser-core/extensionCdpTransport.js";
import { ExtensionClaimManager } from "./extensionBrowserClaims.js";
import { ExtensionBrowserCommandRunner } from "./extensionBrowserCommandRunner.js";
import { ExtensionDialogManager } from "./extensionBrowserDialogs.js";
import { ExtensionBrowserTabManager, sameOwner } from "./extensionBrowserTabManager.js";
import { ExtensionRequestTracker } from "./extensionRequestTracker.js";
import {
  ExtensionOperationError,
  type ExtensionBackendExecuteContext,
  type ExtensionBrowserBackendDeps,
  type ExtensionCommandContext,
  type ExtensionExecutionContext,
  type ExtensionManagedTab,
} from "./extensionBrowserBackendTypes.js";
import type {
  ExtensionHostConnection,
  ExtensionTransportClient,
} from "./extensionTransportClient.js";

const USER_TAB_ID_PREFIX = "extuser:";

const EXTENSION_PREFIX = "extension:";

/**
 * Chrome 扩展 browser backend 的业务 owner。
 *
 * 只依赖无 Electron 的 CDP transport 与 Host 扩展传输客户端；Main 不接收 session/workspace，
 * 扩展 wire 不接收 CDP sessionId。
 */
export class ExtensionBrowserBackend {
  private readonly transport: ExtensionTransportClient;
  private readonly cdp: ExtensionCdpTransport;
  private readonly tabs: ExtensionBrowserTabManager;
  private readonly runner: ExtensionBrowserCommandRunner;
  private readonly claims: ExtensionClaimManager;
  private readonly dialogs: ExtensionDialogManager;
  private readonly tracker: ExtensionRequestTracker;
  private readonly logger: ExtensionBrowserBackendDeps["logger"];
  private readonly runningRequestIds = new Set<string>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(deps: ExtensionBrowserBackendDeps) {
    this.transport = deps.transport;
    this.cdp = deps.cdp;
    this.logger = deps.logger;
    this.tracker = new ExtensionRequestTracker({
      cancelWire: (requestIds) => this.cdp.cancelRequests(requestIds),
      ...(deps.commandTimeoutMs === undefined ? {} : { timeoutMs: deps.commandTimeoutMs }),
    });
    this.cdp.setHooks({
      onRequestStart: (commandRequestId, wireRequestId, method) =>
        this.tracker.markDispatched(commandRequestId, wireRequestId, method),
      onRequestSettled: (commandRequestId, wireRequestId) =>
        this.tracker.markSettled(commandRequestId, wireRequestId),
    });
    this.tabs = new ExtensionBrowserTabManager({ ...deps, cdp: deps.cdp });
    this.claims = new ExtensionClaimManager({
      transport: deps.transport,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.claimTtlMs === undefined ? {} : { ttlMs: deps.claimTtlMs }),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.dialogs = new ExtensionDialogManager(deps.dialogTimeoutMs);
    this.runner = new ExtensionBrowserCommandRunner({
      cdp: deps.cdp,
      transport: deps.transport,
      dialogs: this.dialogs,
      ...(deps.navigationTimeoutMs === undefined
        ? {}
        : { navigationTimeoutMs: deps.navigationTimeoutMs }),
      ...(deps.logger ? { logger: deps.logger } : {}),
      onDialogUnresolved: (tab) => this.revokeUnresponsiveUserTab(tab),
    });
    this.unsubscribe.push(
      this.transport.onEvent((event) =>
        this.handleExtensionEvent(event.profileInstanceId, event.message),
      ),
      this.transport.onConnectionChange((change) => this.handleConnectionChange(change)),
    );
  }

  owns(browserId: string): boolean {
    return browserId.startsWith(EXTENSION_PREFIX);
  }

  /** discovery：mobile replay 不返回 extension；连接列表以 Main 的窗口绑定为准。 */
  async list(context: ExtensionExecutionContext): Promise<BrowserBackendDescriptor[]> {
    if (context.clientMode === "web-remote-replayable") return [];
    let connections: ExtensionHostConnection[];
    try {
      connections = await this.transport.listConnections();
    } catch (error) {
      this.logger?.warn("[extension-browser] discovery failed", error);
      return [];
    }
    return connections.map((connection) => this.descriptor(connection));
  }

  async execute(
    context: ExtensionBackendExecuteContext,
    command: BrowserCommand,
  ): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (this.runningRequestIds.has(context.requestId)) {
      return {
        ok: false,
        error: {
          code: "duplicate_request_id",
          message: `browser requestId '${context.requestId}' is already running`,
          sideEffect: "none",
        },
        elapsedMs: 0,
      };
    }
    let connection: ExtensionHostConnection | undefined;
    this.runningRequestIds.add(context.requestId);
    try {
      connection = this.resolveConnection(context);
      return await this.dispatch(context, connection, command, startedAt);
    } catch (error) {
      return this.errorResult(connection, undefined, command, error, startedAt, context.requestId);
    } finally {
      this.runningRequestIds.delete(context.requestId);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.tracker.dispose();
    this.claims.dispose();
    this.dialogs.dispose();
    this.tabs.dispose();
    this.runningRequestIds.clear();
  }

  private async dispatch(
    context: ExtensionBackendExecuteContext,
    connection: ExtensionHostConnection,
    command: BrowserCommand,
    startedAt: number,
  ): Promise<BrowserCommandResult> {
    const scoped: ExtensionCommandContext = { ...context, connection };
    if (command.method === "list") {
      const owned = this.tabs.ownedTabs(scoped);
      return this.withMeta(connection, owned, undefined, {
        ok: true,
        tabs: owned.map((tab) => this.tabs.summary(tab)),
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (command.method === "cancelRequest") {
      // 只取消目标命令；不能清除后续同 key 或其它 tab 的 pending。
      const cancelled = this.tracker.cancel(command.requestId, scoped);
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), undefined, {
        ok: true,
        value: { cancelled },
        elapsedMs: 0,
      });
    }
    if (command.method === "turnEnded") {
      this.tracker.cancelScope(scoped, command.turnId);
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), undefined, {
        ok: true,
        elapsedMs: 0,
      });
    }
    if (command.method === "closeSession") {
      // 默认释放 session 名下 debugger：agent tab 关闭，user tab 只 detach。
      // 显式 closeTabs:true 按 BrowserCommand 契约关闭该 session 名下全部 tab。
      this.tracker.cancelScope(scoped);
      await this.releaseSessionTabs(scoped, command.closeTabs === true);
      return this.withMeta(connection, [], undefined, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (command.method === "finalize") {
      const lifecycle = command.deliverable === false ? "active" : "deliverable";
      const tab = this.tabs.markLifecycle(scoped, command.tabId, lifecycle);
      if (!tab) {
        throw new ExtensionOperationError("target_unavailable", "browser tab is unavailable");
      }
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), tab, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (command.method === "finalizeTabs") {
      // 与 IAB 对齐：keep 是状态标记集合，不是清理白名单；遗漏的 tab 保持原状态。
      // handoff 仅标记 lifecycle；deliverable 释放 debugger，用户/agent tab 都留在 Chrome。
      const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
      const owned = this.tabs.ownedTabs(scoped);
      const unknown = [...keep.keys()].filter((tabId) => !owned.some((tab) => tab.tabId === tabId));
      if (unknown.length > 0) {
        throw new ExtensionOperationError(
          "backend_unavailable",
          `cannot finalize unknown tab(s): ${unknown.join(", ")}`,
        );
      }
      for (const tab of owned) {
        const status = keep.get(tab.tabId);
        if (status === "handoff") {
          tab.lifecycle = "handoff";
          continue;
        }
        if (status !== "deliverable") continue;
        tab.lifecycle = "deliverable";
        await this.tabs
          .enqueue(tab.tabId, () => this.tabs.detach(tab))
          .catch((error: unknown) => {
            this.logger?.warn("[extension-browser] finalizeTabs deliverable release failed", {
              tabId: tab.tabId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), undefined, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (command.method === "markDeliverable" || command.method === "markHandoff") {
      const lifecycle = command.method === "markDeliverable" ? "deliverable" : "handoff";
      const tab = this.tabs.markLifecycle(scoped, command.tabId, lifecycle);
      if (!tab) {
        throw new ExtensionOperationError("target_unavailable", "browser tab is unavailable");
      }
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), tab, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (command.method === "newTab") {
      const tracked = this.beginTracked(scoped, command);
      try {
        const tab = await this.tabs.create(scoped, connection, undefined, tracked.signal);
        return this.withMeta(connection, this.tabs.ownedTabs(scoped), tab, {
          ok: true,
          tab: this.tabs.summary(tab),
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        return this.errorResult(
          connection,
          undefined,
          command,
          error,
          startedAt,
          context.requestId,
        );
      } finally {
        this.tracker.complete(context.requestId);
      }
    }
    if (command.method === "activateTab") {
      const tab = this.tabs.activate(scoped, command.tabId);
      if (!tab) {
        throw new ExtensionOperationError("target_unavailable", "browser tab is unavailable");
      }
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), tab, {
        ok: true,
        tab: this.tabs.summary(tab),
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (command.method === "listUserTabs") {
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), undefined, {
        ok: true,
        userTabs: await this.listUserTabs(connection),
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (command.method === "claimTab") {
      return this.claimTab(scoped, connection, command.tabId, startedAt);
    }
    if (!isPageCommand(command)) {
      throw new ExtensionOperationError(
        "capability_unsupported",
        `command ${command.method} is not supported by the Chrome extension backend`,
      );
    }
    const tab = this.tabs.resolveOwned(scoped, "tabId" in command ? command.tabId : undefined);
    if (!tab) {
      throw new ExtensionOperationError("target_unavailable", "browser tab is unavailable");
    }
    const tracked = this.beginTracked(scoped, command, tab.tabId);
    try {
      if (command.method === "close") {
        try {
          await raceAbort(
            this.tabs.enqueue(tab.tabId, () => this.tabs.close(tab)),
            tracked.signal,
          );
          return this.withMeta(connection, this.tabs.ownedTabs(scoped), undefined, {
            ok: true,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          return this.errorResult(connection, tab, command, error, startedAt, context.requestId);
        }
      }
      const result = await this.tabs
        .enqueue(tab.tabId, () =>
          this.runner.run(tab, command, startedAt, {
            requestId: context.requestId,
            ...(tracked.signal ? { signal: tracked.signal } : {}),
          }),
        )
        .catch((error: unknown) =>
          this.errorResult(connection, tab, command, error, startedAt, context.requestId),
        );
      return this.withMeta(connection, this.tabs.ownedTabs(scoped), tab, result);
    } finally {
      this.tracker.complete(context.requestId);
    }
  }

  private beginTracked(
    context: ExtensionCommandContext,
    command: BrowserCommand,
    tabId?: string,
  ): { signal: AbortSignal } {
    const entry = this.tracker.begin({
      requestId: context.requestId,
      command: command.method,
      browserId: context.browserId,
      context,
      ...(tabId ? { tabId } : {}),
    });
    if (!entry) {
      throw new ExtensionOperationError(
        "duplicate_request_id",
        `browser requestId '${context.requestId}' is already running`,
        "none",
      );
    }
    return { signal: entry.controller.signal };
  }

  /** session 释放：先 abort 在途命令，再按 tab class 释放 debugger。 */
  private async releaseSessionTabs(
    context: ExtensionCommandContext,
    closeUserTabs: boolean,
  ): Promise<void> {
    const tabs = this.tabs.ownedTabs(context);
    await Promise.all(
      tabs.map((tab) =>
        this.tabs
          .enqueue(tab.tabId, async () => {
            if (tab.tabClass === "agent" || closeUserTabs) {
              await this.tabs.close(tab);
            } else {
              await this.tabs.detach(tab);
            }
          })
          .catch((error: unknown) => {
            this.logger?.warn("[extension-browser] closeSession tab release failed", {
              tabId: tab.tabId,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      ),
    );
  }

  /** openTabs：只返回当前 Profile 未受控、可授权页面的标题与去 userinfo/query/hash 的 URL。 */
  private async listUserTabs(connection: ExtensionHostConnection): Promise<BrowserUserTabInfo[]> {
    const response = await this.transport.request(connection.profileInstanceId, {
      type: "tabs.list",
      requestId: randomUUID(),
    });
    if (response.type !== "tabs.list.result" || !response.ok || !response.tabs) {
      throw new ExtensionOperationError(
        response.type === "tabs.list.result" && response.failure?.code === "target_unavailable"
          ? "target_unavailable"
          : "execution_error",
        response.type === "tabs.list.result"
          ? (response.failure?.message ?? "Chrome could not list tabs")
          : `unexpected tabs.list result: ${response.type}`,
      );
    }
    const managedNativeTabIds = new Set(
      this.tabs
        .list()
        .filter((tab) => tab.profileInstanceId === connection.profileInstanceId)
        .map((tab) => tab.nativeTabId),
    );
    return (response.tabs as ExtensionNativeTab[])
      .filter(
        (tab) =>
          !managedNativeTabIds.has(tab.nativeTabId) &&
          tab.debuggerAttached !== true &&
          isClaimableUserTabUrl(tab.url),
      )
      .sort((left, right) => Number(right.active) - Number(left.active))
      .map((tab) => ({
        id: `${USER_TAB_ID_PREFIX}${tab.nativeTabId}`,
        title: tab.title,
        url: sanitizeUserTabUrl(tab.url),
      }));
  }

  /**
   * 两阶段 claim。
   *
   * 第一次调用只登记 pending 并立即返回 authorization_required；用户同意后由同一 session
   * 再次调用才 attach。重复 claim 合并到现有 pending，跨 session/tab 直接 permission_denied。
   */
  private async claimTab(
    context: ExtensionCommandContext,
    connection: ExtensionHostConnection,
    tabId: string,
    startedAt: number,
  ): Promise<BrowserCommandResult> {
    const nativeTabId = parseUserTabId(tabId);
    if (nativeTabId === undefined) {
      throw new ExtensionOperationError("target_unavailable", "user browser tab id is invalid");
    }
    const existing = this.tabs
      .list()
      .find(
        (tab) =>
          tab.profileInstanceId === connection.profileInstanceId && tab.nativeTabId === nativeTabId,
      );
    if (existing) {
      if (sameOwner(existing.owner, context)) {
        return this.withMeta(connection, this.tabs.ownedTabs(context), existing, {
          ok: true,
          tab: this.tabs.summary(existing),
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw new ExtensionOperationError(
        "permission_denied",
        "browser tab is already claimed by another session",
      );
    }

    const native = await this.findClaimableNativeTab(connection, nativeTabId);
    const outcome = await this.claims.request(context, connection, nativeTabId);
    if (outcome.kind === "unavailable") {
      throw new ExtensionOperationError(
        "backend_unavailable",
        "the Chrome extension is no longer connected",
      );
    }
    if (outcome.kind === "denied") {
      // 用户已拒绝/关闭 Popup：立即返回 permission_denied，不重新发送 claim.request。
      throw new ExtensionOperationError(
        "permission_denied",
        "the user denied control of this tab; do not retry automatically",
        "none",
      );
    }
    if (outcome.kind === "conflict") {
      throw new ExtensionOperationError(
        "permission_denied",
        "another browser tab authorization request is already pending",
      );
    }
    if (outcome.kind === "authorization_required") {
      return this.withMeta(connection, this.tabs.ownedTabs(context), undefined, {
        ok: false,
        error: {
          code: "authorization_required",
          message:
            "The tab needs user authorization. Ask the user to open the Zody Browser Bridge extension and click Allow, then call claimTab again once.",
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      });
    }
    const tab = await this.tabs.createUserTab(context, connection, {
      nativeTabId,
      url: native.url,
      title: native.title,
      active: native.active,
    });
    return this.withMeta(connection, this.tabs.ownedTabs(context), tab, {
      ok: true,
      tab: this.tabs.summary(tab),
      elapsedMs: Date.now() - startedAt,
    });
  }

  private async findClaimableNativeTab(
    connection: ExtensionHostConnection,
    nativeTabId: number,
  ): Promise<ExtensionNativeTab> {
    const response = await this.transport.request(connection.profileInstanceId, {
      type: "tabs.list",
      requestId: randomUUID(),
    });
    if (response.type !== "tabs.list.result" || !response.ok || !response.tabs) {
      throw new ExtensionOperationError(
        "target_unavailable",
        response.type === "tabs.list.result"
          ? (response.failure?.message ?? "Chrome could not list tabs")
          : `unexpected tabs.list result: ${response.type}`,
      );
    }
    const tab = (response.tabs as ExtensionNativeTab[]).find(
      (candidate) => candidate.nativeTabId === nativeTabId,
    );
    if (!tab || tab.debuggerAttached === true || !isClaimableUserTabUrl(tab.url)) {
      throw new ExtensionOperationError(
        "target_unavailable",
        "the tab is closed, restricted, or occupied by another debugger",
      );
    }
    return tab;
  }

  /** dialog accept:false 仍无法解除阻塞：detach 并撤销 lease，不用自动重试掩盖问题。 */
  private async revokeUnresponsiveUserTab(tab: ExtensionManagedTab): Promise<void> {
    try {
      await this.transport.request(tab.profileInstanceId, {
        type: "debugger.detach",
        requestId: randomUUID(),
        targetRef: tab.targetRef,
      });
    } catch {
      // 用户可能已取消调试；本地 lease 仍必须撤销。
    }
    this.tabs.forget(tab);
    this.logger?.warn("[extension-browser] revoked user tab after unresolved dialog", {
      tabId: tab.tabId,
      nativeTabId: tab.nativeTabId,
    });
  }

  private descriptor(connection: ExtensionHostConnection): BrowserBackendDescriptor {
    return {
      id: connection.browserId,
      generation: connection.generation,
      type: "extension",
      name: "Chrome Extension",
      capabilities: { browser: [], tab: [] },
      apiSupportOverrides: {
        "BrowserUser.history": false,
        "Tab.setViewportSize": false,
        "CUAAPI.click": false,
        "CUAAPI.double_click": false,
        "CUAAPI.drag": false,
        "CUAAPI.move": false,
        "CUAAPI.scroll": false,
        "CUAAPI.downloadMedia": false,
        "DomCUAAPI.downloadMedia": false,
      },
      metadata: { provider: "zody-chrome-extension" },
    };
  }

  private resolveConnection(context: ExtensionBackendExecuteContext): ExtensionHostConnection {
    if (context.clientMode === "web-remote-replayable") {
      throw new ExtensionOperationError(
        "backend_unavailable",
        "extension backend is not available for web-remote-replayable",
      );
    }
    if (!context.browserId.startsWith(EXTENSION_PREFIX)) {
      throw new ExtensionOperationError(
        "backend_unavailable",
        `browser backend '${context.browserId}' is not an extension backend`,
      );
    }
    const profileInstanceId = context.browserId.slice(EXTENSION_PREFIX.length);
    const connection = this.transport.getConnection(profileInstanceId);
    if (!connection) {
      throw new ExtensionOperationError(
        "backend_unavailable",
        `browser backend '${context.browserId}' is no longer connected`,
      );
    }
    if (
      context.browserGeneration === undefined ||
      connection.generation !== context.browserGeneration
    ) {
      throw new ExtensionOperationError(
        "backend_unavailable",
        `browser backend '${context.browserId}' generation ${context.browserGeneration ?? "<missing>"} is stale`,
      );
    }
    return connection;
  }

  private handleExtensionEvent(
    profileInstanceId: string,
    message: ExtensionBridgeClientMessage,
  ): void {
    if (message.type === "cdp.event") {
      // 旧 connection/attachment 的迟到事件不能命中新 binding。
      if (!this.cdp.isRegistered(message.attachmentId)) return;
      this.cdp.dispatchEvent({
        attachmentId: message.attachmentId,
        nativeTabId: message.nativeTabId,
        ...(message.targetId ? { targetId: message.targetId } : {}),
        method: message.method,
        params: message.params,
      });
      if (message.targetId) {
        this.tabs.sessionMap.resolveSessionId(message.attachmentId, message.targetId);
      }
      if (message.method.startsWith("Page.javascriptDialog")) {
        // 事件按事件自身的 targetId 归属到 nativeTabId 对应的 tab；跨域 iframe 的 dialog
        // 也必须回到发起它的 target，而不是默认主页面。
        const tab = this.tabs
          .list()
          .find(
            (candidate) =>
              candidate.profileInstanceId === profileInstanceId &&
              candidate.nativeTabId === message.nativeTabId,
          );
        if (tab) {
          this.logger?.debug("[extension-browser] dialog event", {
            tabId: tab.tabId,
            method: message.method,
            targetId: message.targetId,
          });
          this.dialogs.handleEvent(tab.tabId, message);
        }
      }
      return;
    }
    if (message.type === "claim.decision") {
      const outcome = this.claims.handleDecision(
        message as ExtensionClaimDecisionMessage,
        profileInstanceId,
      );
      this.logger?.debug("[extension-browser] claim decision", {
        claimId: message.claimId,
        decision: message.decision,
        outcome: outcome.kind,
      });
      if (outcome.kind === "stale" && message.decision === "granted") {
        // 晚到/过期同意：清掉扩展侧 badge，绝不在 Host 侧补 attach。
        void this.transport
          .send(profileInstanceId, { type: "claim.cancel", claimId: message.claimId })
          .catch(() => undefined);
      }
      return;
    }
    if (message.type === "target.detached" || message.type === "target.closed") {
      // 旧 attachment 的迟到 detach/closed 不能影响当前 binding。
      if (!this.cdp.isRegistered(message.targetRef.attachmentId)) {
        this.cdp.unregisterAttachment(message.targetRef.attachmentId);
        return;
      }
      const tab = this.tabs
        .list()
        .find((candidate) => candidate.attachmentId === message.targetRef.attachmentId);
      this.tabs.invalidateAttachment(message.targetRef);
      if (tab) {
        this.dialogs.clear(tab.tabId);
        this.tracker.cancelTab(tab.tabId);
      }
      this.logger?.debug("[extension-browser] attachment invalidated", {
        profileInstanceId,
        reason: message.type,
      });
    }
  }

  private handleConnectionChange(change: {
    connected: boolean;
    connection: ExtensionHostConnection;
  }): void {
    if (!change.connected) {
      // 连接代次变化后旧 backend/browser/tab binding 全部失效；在途命令立即 settle。
      this.tracker.cancelProfile(change.connection.profileInstanceId);
      this.claims.invalidateConnection(change.connection.profileInstanceId);
      for (const tab of this.tabs.list()) {
        if (tab.profileInstanceId === change.connection.profileInstanceId) {
          this.dialogs.clear(tab.tabId);
        }
      }
      this.tabs.invalidateProfile(change.connection.profileInstanceId);
      this.cdp.unregisterProfile(change.connection.profileInstanceId);
      return;
    }
    for (const tab of this.tabs.list()) {
      if (
        tab.profileInstanceId === change.connection.profileInstanceId &&
        (tab.browserGeneration !== change.connection.generation ||
          tab.connectionId !== change.connection.connectionId)
      ) {
        this.tracker.cancelTab(tab.tabId);
        this.dialogs.clear(tab.tabId);
        this.tabs.forget(tab);
      }
    }
    this.claims.invalidateConnection(change.connection.profileInstanceId);
  }

  private errorResult(
    connection: ExtensionHostConnection | undefined,
    tab: ExtensionManagedTab | undefined,
    command: BrowserCommand,
    error: unknown,
    startedAt: number,
    requestId: string,
  ): BrowserCommandResult {
    const structured = typeof error === "object" && error !== null ? error : undefined;
    const structuredCode = (structured as { code?: unknown } | undefined)?.code;
    const explicitSideEffect = (structured as { sideEffect?: unknown } | undefined)?.sideEffect;
    // 只有 transport 在 dispatch 后失联（timeout/socket/内部错误）才无法证明结果。
    // 校验失败、结构化 CDP 错误和未下发的 target_unavailable 都有确定副作用边界。
    const unknownDispatch =
      structuredCode === undefined ||
      structuredCode === "request_timeout" ||
      structuredCode === "socket_closed" ||
      structuredCode === "result_too_large" ||
      structuredCode === "internal_error";
    const dispatchedSideEffect = this.tracker.dispatchedSideEffectFor(requestId);
    const lostAfterDispatch =
      dispatchedSideEffect &&
      (unknownDispatch ||
        structuredCode === "backend_unavailable" ||
        structuredCode === "target_unavailable");
    const sideEffect =
      explicitSideEffect === "uncertain" || explicitSideEffect === "none"
        ? explicitSideEffect
        : commandMayHaveSideEffect(command) && lostAfterDispatch
          ? "uncertain"
          : "none";
    // 传输层用稳定 code 标记 attachment/target 失效；不能退化成 execution_error。
    const knownCode =
      structuredCode === "target_unavailable" ||
      structuredCode === "backend_unavailable" ||
      structuredCode === "capability_unsupported" ||
      structuredCode === "authorization_required" ||
      structuredCode === "permission_denied" ||
      structuredCode === "cancelled" ||
      structuredCode === "timeout"
        ? structuredCode
        : undefined;
    const operation =
      error instanceof ExtensionOperationError
        ? error
        : new ExtensionOperationError(
            knownCode ?? "execution_error",
            error instanceof Error ? error.message : String(error),
            sideEffect,
          );
    return this.withMeta(connection, [], tab, {
      ok: false,
      error: {
        code: operation.code,
        message: operation.message,
        sideEffect: operation.sideEffect,
      },
      elapsedMs: Date.now() - startedAt,
    });
  }

  private withMeta(
    connection: ExtensionHostConnection | undefined,
    openTabs: ExtensionManagedTab[],
    tab: ExtensionManagedTab | undefined,
    result: BrowserCommandResult,
  ): BrowserCommandResult {
    if (!connection) return result;
    return {
      ...result,
      meta: {
        browserUse: true,
        backendType: "extension",
        browserId: connection.browserId,
        browserGeneration: connection.generation,
        openTabIds: openTabs.map((candidate) => candidate.tabId),
        ...(tab ? { tabId: tab.tabId } : {}),
        ...(tab?.url ? { currentUrl: tab.url } : {}),
        ...(tab ? { lifecycle: tab.closed ? "closed" : (tab.lifecycle ?? "active") } : {}),
      },
    };
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("browser request aborted"), {
            code: "cancelled",
            sideEffect: "none",
          }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("browser request aborted"), {
              code: "cancelled",
              sideEffect: "none",
            }),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** 命令可能改变页面/浏览器状态；用于 transport 失联时的副作用判定。 */
function commandMayHaveSideEffect(command: BrowserCommand): boolean {
  if (command.method === "playwright") {
    if (command.action.name === "evaluate") return true;
    if (command.action.name === "locator") {
      return ["click", "dblclick", "fill", "press", "selectOption", "setChecked"].includes(
        command.action.operation,
      );
    }
    return false;
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "close",
    "newTab",
    "press",
    "type",
    "cuaKeypress",
    "evaluate",
    "handleDialog",
  ].includes(command.method);
}

function isPageCommand(command: BrowserCommand): boolean {
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "getState",
    "screenshot",
    "close",
    "playwright",
    "press",
    "type",
    "cuaKeypress",
    "evaluate",
    "getDialog",
    "handleDialog",
  ].includes(command.method);
}

/** openTabs 的公开 id 只在当前 backend scope 内解析，不能当作跨 Profile 身份。 */
export function parseUserTabId(raw: string): number | undefined {
  const match = raw.startsWith(USER_TAB_ID_PREFIX) ? raw.slice(USER_TAB_ID_PREFIX.length) : raw;
  if (!/^\d+$/u.test(match)) return undefined;
  const value = Number.parseInt(match, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 去掉 userinfo、query、hash；保留 scheme/host/port/path。 */
export function sanitizeUserTabUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

/** 只允许用户可授权的普通网页；chrome://、扩展页、DevTools 和 Web Store 均 fail closed。 */
export function isClaimableUserTabUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "chromewebstore.google.com") return false;
  if (host === "chrome.google.com" && url.pathname.startsWith("/webstore")) return false;
  return true;
}
