/* eslint-disable max-lines -- logical tab owner 的 attach/claim/串行队列/detach 必须共享同一状态机。 */
import { randomUUID } from "node:crypto";
import type { BrowserTabSummary, BrowserViewportSize } from "@zody/shared";
import type {
  ExtensionAttachResultMessage,
  ExtensionTabsCreateResultMessage,
  ExtensionTargetRef,
} from "@zody/shared/browser-extension-transport";
import { CdpTargetSessionMap } from "../browser-core/cdpTargetSessionMap.js";
import type { ExtensionCdpTransport } from "../browser-core/extensionCdpTransport.js";
import type { ExtensionHostConnection } from "./extensionTransportClient.js";
import {
  ExtensionOperationError,
  type ExtensionBrowserBackendDeps,
  type ExtensionExecutionContext,
  type ExtensionManagedTab,
  type ExtensionTabOwner,
} from "./extensionBrowserBackendTypes.js";

const DEFAULT_VIEWPORT: BrowserViewportSize = { width: 1280, height: 720 };

export interface ExtensionTabManagerDeps extends ExtensionBrowserBackendDeps {
  cdp: ExtensionCdpTransport;
}

/**
 * Host 的 logical tab 所有者。
 *
 * - logical tabId 由 Host 生成；nativeTabId 只用于扩展 transport。
 * - attachment 建立成功后才进入 tabs.list。
 * - 每 tab 一条串行链；不同 tab 不共享队列。
 */
export class ExtensionBrowserTabManager {
  private readonly tabs = new Map<string, ExtensionManagedTab>();
  private readonly queues = new Map<string, Promise<unknown>>();
  readonly sessionMap = new CdpTargetSessionMap();
  private readonly createTabId: () => string;
  private readonly logger: ExtensionBrowserBackendDeps["logger"];

  constructor(private readonly deps: ExtensionTabManagerDeps) {
    this.createTabId = deps.createTabId ?? (() => `extab:${randomUUID()}`);
    this.logger = deps.logger;
  }

  list(): ExtensionManagedTab[] {
    return [...this.tabs.values()].filter((tab) => !tab.closed);
  }

  get(tabId: string): ExtensionManagedTab | undefined {
    return this.tabs.get(tabId);
  }

  ownedTabs(context: ExtensionExecutionContext): ExtensionManagedTab[] {
    return this.list().filter((tab) => sameOwner(tab.owner, context));
  }

  resolveOwned(
    context: ExtensionExecutionContext,
    tabId?: string,
  ): ExtensionManagedTab | undefined {
    if (tabId) {
      const tab = this.tabs.get(tabId);
      return tab && !tab.closed && sameOwner(tab.owner, context) ? tab : undefined;
    }
    const owned = this.ownedTabs(context);
    return owned.find((tab) => tab.active) ?? owned.at(-1);
  }

  activate(context: ExtensionExecutionContext, tabId: string): ExtensionManagedTab | undefined {
    const tab = this.resolveOwned(context, tabId);
    if (!tab) return undefined;
    for (const candidate of this.ownedTabs(context)) {
      candidate.active = candidate.tabId === tab.tabId;
    }
    return tab;
  }

  summary(tab: ExtensionManagedTab): BrowserTabSummary {
    return {
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      viewport: { ...tab.viewport },
      ...(tab.active ? { active: true } : {}),
      ...(tab.lifecycle ? { lifecycle: tab.lifecycle } : {}),
    };
  }

  /** finalize 只改变 lifecycle，不关闭也不 detach；与 IAB 契约一致。 */
  markLifecycle(
    context: ExtensionExecutionContext,
    tabId: string | undefined,
    lifecycle: "active" | "deliverable" | "handoff",
  ): ExtensionManagedTab | undefined {
    const tab = this.resolveOwned(context, tabId);
    if (!tab) return undefined;
    tab.lifecycle = lifecycle;
    return tab;
  }

  /** 新 tab 串行创建：创建/attach/初始化失败时关闭 Chrome tab，不登记 logical id。 */
  async create(
    context: ExtensionExecutionContext,
    connection: ExtensionHostConnection,
    url?: string,
    signal?: AbortSignal,
  ): Promise<ExtensionManagedTab> {
    const createResponse = await this.deps.transport.request(
      connection.profileInstanceId,
      {
        type: "tabs.create",
        requestId: randomUUID(),
        active: false,
        url: url ?? "about:blank",
      },
      undefined,
      signal,
    );
    if (createResponse.type !== "tabs.create.result") {
      throw new ExtensionOperationError(
        "execution_error",
        `unexpected tabs.create result: ${createResponse.type}`,
      );
    }
    const created = createResponse as ExtensionTabsCreateResultMessage;
    if (!created.ok || !created.tab) {
      throw new ExtensionOperationError(
        mapFailureCode(created.failure?.code),
        created.failure?.message ?? "Chrome could not create a background tab",
      );
    }
    const nativeTabId = created.tab.nativeTabId;
    let attachmentId: string | undefined;

    try {
      const attachResponse = await this.deps.transport.request(
        connection.profileInstanceId,
        {
          type: "debugger.attach",
          requestId: randomUUID(),
          target: {
            browserId: connection.browserId,
            browserGeneration: connection.generation,
            connectionId: connection.connectionId,
            nativeTabId,
            tabClass: "agent",
          },
        },
        undefined,
        signal,
      );
      if (attachResponse.type !== "debugger.attach.result") {
        throw new ExtensionOperationError(
          "execution_error",
          `unexpected debugger.attach result: ${attachResponse.type}`,
        );
      }
      const attached = attachResponse as ExtensionAttachResultMessage;
      if (!attached.ok || !attached.attachmentId) {
        throw new ExtensionOperationError(
          "target_unavailable",
          attached.failure?.message ?? "Chrome could not attach the new tab",
        );
      }
      attachmentId = attached.attachmentId;
      if (signal?.aborted) throw signal.reason;
      const targetRef: ExtensionTargetRef = {
        browserId: connection.browserId,
        browserGeneration: connection.generation,
        connectionId: connection.connectionId,
        nativeTabId,
        attachmentId,
      };
      this.deps.cdp.registerTarget(targetRef);
      // P2：显式启用 Page 域，才能收到 Page.javascriptDialogOpening/Closed。
      await this.deps.cdp
        .send("Page.enable", {}, { attachmentId, nativeTabId })
        .catch(() => undefined);
      const viewport = await this.readViewport(targetRef).catch(() => ({ ...DEFAULT_VIEWPORT }));
      if (signal?.aborted) throw signal.reason;
      const tab: ExtensionManagedTab = {
        tabId: this.createTabId(),
        profileInstanceId: connection.profileInstanceId,
        browserId: connection.browserId,
        browserGeneration: connection.generation,
        connectionId: connection.connectionId,
        nativeTabId,
        attachmentId,
        targetRef,
        owner: ownerFromContext(context),
        tabClass: "agent",
        active: false,
        url: created.tab.url || url || "about:blank",
        title: created.tab.title ?? "",
        viewport,
        closed: false,
      };
      this.tabs.set(tab.tabId, tab);
      this.logger?.debug("[extension-browser] tab created", {
        tabId: tab.tabId,
        nativeTabId,
        attachmentId,
      });
      return tab;
    } catch (error) {
      if (attachmentId) {
        await this.deps.transport
          .request(connection.profileInstanceId, {
            type: "debugger.detach",
            requestId: randomUUID(),
            targetRef: {
              browserId: connection.browserId,
              browserGeneration: connection.generation,
              connectionId: connection.connectionId,
              nativeTabId,
              attachmentId,
            },
          })
          .catch(() => undefined);
        this.deps.cdp.unregisterAttachment(attachmentId);
      }
      await this.deps.transport
        .request(connection.profileInstanceId, {
          type: "tabs.close",
          requestId: randomUUID(),
          nativeTabId,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * 接管用户已有 tab：只 attach，不创建/不关闭原生 tab。
   * attach 失败（含 DevTools 占用）必须向上抛 target_unavailable，由 backend 原样返回且同轮不重试。
   */
  async createUserTab(
    context: ExtensionExecutionContext,
    connection: ExtensionHostConnection,
    input: { nativeTabId: number; url: string; title: string; active: boolean },
  ): Promise<ExtensionManagedTab> {
    const attachResponse = await this.deps.transport.request(connection.profileInstanceId, {
      type: "debugger.attach",
      requestId: randomUUID(),
      target: {
        browserId: connection.browserId,
        browserGeneration: connection.generation,
        connectionId: connection.connectionId,
        nativeTabId: input.nativeTabId,
        tabClass: "user",
      },
    });
    if (attachResponse.type !== "debugger.attach.result") {
      throw new ExtensionOperationError(
        "execution_error",
        `unexpected debugger.attach result: ${attachResponse.type}`,
      );
    }
    const attached = attachResponse as ExtensionAttachResultMessage;
    if (!attached.ok || !attached.attachmentId) {
      throw new ExtensionOperationError(
        "target_unavailable",
        attached.failure?.message ?? "Chrome could not attach the user tab",
      );
    }
    const targetRef: ExtensionTargetRef = {
      browserId: connection.browserId,
      browserGeneration: connection.generation,
      connectionId: connection.connectionId,
      nativeTabId: input.nativeTabId,
      attachmentId: attached.attachmentId,
    };
    try {
      this.deps.cdp.registerTarget(targetRef);
      await this.deps.cdp
        .send(
          "Page.enable",
          {},
          { attachmentId: attached.attachmentId, nativeTabId: input.nativeTabId },
        )
        .catch(() => undefined);
      const viewport = await this.readViewport(targetRef).catch(() => ({ ...DEFAULT_VIEWPORT }));
      const tab: ExtensionManagedTab = {
        tabId: this.createTabId(),
        profileInstanceId: connection.profileInstanceId,
        browserId: connection.browserId,
        browserGeneration: connection.generation,
        connectionId: connection.connectionId,
        nativeTabId: input.nativeTabId,
        attachmentId: attached.attachmentId,
        targetRef,
        owner: ownerFromContext(context),
        tabClass: "user",
        active: input.active,
        url: attached.url ?? input.url,
        title: attached.title ?? input.title,
        viewport,
        closed: false,
      };
      // 同一 session 只保留一个 active tab；claim 不把 Chrome 拉到前台。
      if (input.active) {
        for (const candidate of this.ownedTabs(context)) candidate.active = false;
      }
      this.tabs.set(tab.tabId, tab);
      this.logger?.info("[extension-browser] user tab claimed", {
        tabId: tab.tabId,
        nativeTabId: input.nativeTabId,
        attachmentId: attached.attachmentId,
      });
      return tab;
    } catch (error) {
      await this.deps.transport
        .request(connection.profileInstanceId, {
          type: "debugger.detach",
          requestId: randomUUID(),
          targetRef,
        })
        .catch(() => undefined);
      this.deps.cdp.unregisterAttachment(attached.attachmentId);
      throw error;
    }
  }

  /** 用户 tab 只解除调试，页面留在 Chrome；不关闭原生 tab。 */
  async detach(tab: ExtensionManagedTab): Promise<void> {
    try {
      await this.deps.transport.request(tab.profileInstanceId, {
        type: "debugger.detach",
        requestId: randomUUID(),
        targetRef: tab.targetRef,
      });
    } catch (error) {
      if (!isTargetUnavailable(error)) throw error;
    }
    this.forget(tab);
  }

  async close(tab: ExtensionManagedTab): Promise<void> {
    try {
      await this.deps.transport.request(tab.profileInstanceId, {
        type: "debugger.detach",
        requestId: randomUUID(),
        targetRef: tab.targetRef,
      });
    } catch (error) {
      if (!isTargetUnavailable(error)) throw error;
    }
    try {
      const response = await this.deps.transport.request(tab.profileInstanceId, {
        type: "tabs.close",
        requestId: randomUUID(),
        nativeTabId: tab.nativeTabId,
      });
      if (response.type === "tabs.close.result" && !response.ok) {
        throw new ExtensionOperationError(
          mapFailureCode(response.failure?.code),
          response.failure?.message ?? "Chrome could not close the tab",
        );
      }
    } catch (error) {
      if (!isTargetUnavailable(error)) throw error;
    }
    this.forget(tab);
  }

  forget(tab: ExtensionManagedTab): void {
    tab.closed = true;
    this.tabs.delete(tab.tabId);
    this.deps.cdp.unregisterAttachment(tab.attachmentId);
    this.sessionMap.removeAttachment(tab.attachmentId);
  }

  invalidateProfile(profileInstanceId: string): void {
    for (const tab of this.list()) {
      if (tab.profileInstanceId === profileInstanceId) this.forget(tab);
    }
  }

  /** Host 退出：只清理本地投影；实际 debugger 由 Main 的 session.detachAll 收口。 */
  dispose(): void {
    for (const tab of this.list()) this.forget(tab);
    this.queues.clear();
  }

  invalidateAttachment(targetRef: ExtensionTargetRef): void {
    const tab = this.list().find((candidate) => candidate.attachmentId === targetRef.attachmentId);
    if (tab) this.forget(tab);
    this.deps.cdp.unregisterAttachment(targetRef.attachmentId);
    this.sessionMap.removeAttachment(targetRef.attachmentId);
  }

  /** 同 tab 串行，不同 tab 并行；队列失败不阻塞后续命令。 */
  enqueue<T>(tabId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 队列尾只用于排序，不让前一个命令的失败污染后一个命令。
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(tabId, tail);
    void tail.finally(() => {
      if (this.queues.get(tabId) === tail) this.queues.delete(tabId);
    });
    return next;
  }

  private async readViewport(targetRef: ExtensionTargetRef): Promise<BrowserViewportSize> {
    const value = await this.deps.cdp.send(
      "Runtime.evaluate",
      {
        expression: "({ width: window.innerWidth, height: window.innerHeight })",
        returnByValue: true,
      },
      { attachmentId: targetRef.attachmentId, nativeTabId: targetRef.nativeTabId },
    );
    const result = (value as { result?: { value?: { width?: unknown; height?: unknown } } })?.result
      ?.value;
    const width = Number(result?.width);
    const height = Number(result?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width: Math.round(width), height: Math.round(height) };
    }
    return { ...DEFAULT_VIEWPORT };
  }
}

export function sameOwner(owner: ExtensionTabOwner, context: ExtensionExecutionContext): boolean {
  return (
    owner.sessionId === context.sessionId &&
    owner.workspaceKey === context.workspaceKey &&
    (owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "")
  );
}

function ownerFromContext(context: ExtensionExecutionContext): ExtensionTabOwner {
  return {
    sessionId: context.sessionId,
    workspaceKey: context.workspaceKey,
    ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
  };
}

function mapFailureCode(code: string | undefined): "target_unavailable" | "execution_error" {
  return code === "target_unavailable" ? "target_unavailable" : "execution_error";
}

function isTargetUnavailable(error: unknown): boolean {
  return (
    (error instanceof ExtensionOperationError && error.code === "target_unavailable") ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "target_unavailable")
  );
}
