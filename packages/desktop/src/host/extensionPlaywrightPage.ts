import { randomUUID } from "node:crypto";
import type {
  ExtensionAttachResultMessage,
  ExtensionTargetRef,
} from "@zcode/shared/browser-extension-transport";
import type { PlaywrightPage } from "../browser-core/playwright/types.js";
import type { ExtensionCdpTransport } from "../browser-core/extensionCdpTransport.js";
import type { ExtensionTransportClient } from "./extensionTransportClient.js";
import {
  ExtensionOperationError,
  type ExtensionBrowserBackendLogger,
} from "./extensionBrowserBackendTypes.js";

interface ChildSession {
  targetRef: ExtensionTargetRef;
  targetId: string;
}

export interface ExtensionPlaywrightPageOptions {
  transport: ExtensionTransportClient;
  cdp: ExtensionCdpTransport;
  profileInstanceId: string;
  browserId: string;
  generation: number;
  connectionId: string;
  attachmentId: string;
  nativeTabId: number;
  tabClass: "agent" | "user";
  pageUrl: () => string;
  logger?: ExtensionBrowserBackendLogger;
  /** Host 命令 requestId 与 abort signal；子 target 请求也继承同一取消边界。 */
  commandRequestId?: string;
  signal?: AbortSignal;
}

/**
 * 扩展 backend 的 backend-neutral Playwright page。
 *
 * - 主页面命令使用 Host 的 main attachmentId。
 * - 跨域 iframe 先 `debugger.attach({targetId})` 建立子 attachment，再以子 attachment
 *   发送命令；扩展 wire 只出现 targetId，不出现 CDP sessionId。
 * - Host 内部仍返回 opaque sessionId，供共用 Playwright 算法使用。
 */
export class ExtensionPlaywrightPage implements PlaywrightPage {
  readonly platform = process.platform;
  private readonly childSessions = new Map<string, ChildSession>();

  constructor(private readonly options: ExtensionPlaywrightPageOptions) {}

  async send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    if (sessionId) {
      const child = this.childSessions.get(sessionId);
      if (!child) throw new Error(`unknown extension Playwright session '${sessionId}'`);
      return this.options.cdp.send(
        method,
        asParams(params),
        {
          attachmentId: child.targetRef.attachmentId,
          nativeTabId: child.targetRef.nativeTabId,
          targetId: child.targetId,
        },
        this.sendOptions(),
      );
    }
    return this.options.cdp.send(
      method,
      asParams(params),
      {
        attachmentId: this.options.attachmentId,
        nativeTabId: this.options.nativeTabId,
      },
      this.sendOptions(),
    );
  }

  private sendOptions(): { commandRequestId?: string; signal?: AbortSignal } {
    return {
      ...(this.options.commandRequestId ? { commandRequestId: this.options.commandRequestId } : {}),
      ...(this.options.signal ? { signal: this.options.signal } : {}),
    };
  }

  async attachToTarget(targetId: string): Promise<string | undefined> {
    const { transport, nativeTabId, profileInstanceId } = this.options;
    let response;
    try {
      response = await transport.request(
        profileInstanceId,
        {
          type: "debugger.attach",
          requestId: randomUUID(),
          target: {
            browserId: this.options.browserId,
            browserGeneration: this.options.generation,
            connectionId: this.options.connectionId,
            nativeTabId,
            targetId,
            tabClass: this.options.tabClass,
          },
        },
        undefined,
        this.options.signal,
      );
    } catch {
      return undefined;
    }
    if (response.type !== "debugger.attach.result") return undefined;
    const attached = response as ExtensionAttachResultMessage;
    if (!attached.ok || !attached.attachmentId) return undefined;
    const targetRef: ExtensionTargetRef = {
      browserId: this.options.browserId,
      browserGeneration: this.options.generation,
      connectionId: this.options.connectionId,
      nativeTabId,
      attachmentId: attached.attachmentId,
    };
    this.options.cdp.registerTarget(targetRef);
    const sessionId = `exttarget:${randomUUID()}`;
    this.childSessions.set(sessionId, { targetRef, targetId });
    this.options.logger?.debug("[extension-browser] attached child target", {
      targetId,
      attachmentId: attached.attachmentId,
      sessionId,
    });
    return sessionId;
  }

  async detachFromTarget(sessionId: string): Promise<void> {
    const child = this.childSessions.get(sessionId);
    if (!child) return;
    this.childSessions.delete(sessionId);
    this.options.cdp.unregisterAttachment(child.targetRef.attachmentId);
    this.options.logger?.debug("[extension-browser] detaching child target", {
      targetId: child.targetId,
      attachmentId: child.targetRef.attachmentId,
      sessionId,
    });
    try {
      await this.options.transport.request(this.options.profileInstanceId, {
        type: "debugger.detach",
        requestId: randomUUID(),
        targetRef: child.targetRef,
      });
    } catch {
      // detach 幂等；attachment 已被 Chrome/user 清理时保持本地映射已删除。
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.childSessions.keys()].map((sessionId) => this.detachFromTarget(sessionId)),
    );
  }

  pageUrl(): string {
    return this.options.pageUrl();
  }
}

function asParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ExtensionOperationError("execution_error", "CDP params must be a JSON object");
}
