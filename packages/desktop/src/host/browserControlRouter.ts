import type { BrowserBackendDescriptor, BrowserCommand, BrowserCommandResult } from "@zcode/shared";

export interface BrowserRouterContext {
  requestId: string;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  sessionContext: "live" | "cached";
}

export interface BrowserRouterExecuteContext extends BrowserRouterContext {
  browserId?: string;
  browserGeneration?: number;
}

export interface BrowserControlBackend {
  /** identity 精确匹配；router 不按 type 猜测。 */
  owns(browserId: string): boolean;
  list(context: BrowserRouterContext): Promise<BrowserBackendDescriptor[]>;
  execute(
    context: BrowserRouterExecuteContext & {
      browserId: string;
      browserGeneration?: number;
    },
    command: BrowserCommand,
  ): Promise<BrowserCommandResult>;
}

/**
 * IAB + extension 的统一 discovery/execute 聚合。
 *
 * - 未显式 browserId 的旧调用只走 IAB，不因 extension 在线改变默认行为。
 * - 显式 browserId 必须由唯一 backend owns；backend 消失返回 backend_unavailable，
 *   绝不改投 IAB。
 * - mobile replay discovery 不返回 extension。
 */
export function createBrowserControlRouter(input: {
  iab: BrowserControlBackend;
  extension: BrowserControlBackend;
}): {
  list(context: BrowserRouterContext): Promise<BrowserBackendDescriptor[]>;
  execute(
    context: BrowserRouterExecuteContext,
    command: BrowserCommand,
  ): Promise<BrowserCommandResult>;
} {
  const backends = [input.iab, input.extension];
  return {
    async list(context) {
      const descriptors: BrowserBackendDescriptor[] = [];
      for (const backend of backends) {
        const available = await backend.list(context);
        descriptors.push(
          ...(context.clientMode === "web-remote-replayable"
            ? available.filter((descriptor) => descriptor.type !== "extension")
            : available),
        );
      }
      return descriptors;
    },

    async execute(context, command) {
      if (!context.browserId) {
        // 迁移兼容：未携带 browserId/generation 的旧调用保持原样，不能被 router 伪造成 stale。
        return input.iab.execute({ ...context, browserId: "" }, command);
      }
      const backend = backends.find((candidate) => candidate.owns(context.browserId!));
      if (!backend) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${context.browserId}' is unavailable`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        };
      }
      return backend.execute({ ...context, browserId: context.browserId }, command);
    },
  };
}
