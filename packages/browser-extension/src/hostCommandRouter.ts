import type {
  ExtensionBridgeClientMessage,
  ExtensionBridgeFailure,
  ExtensionBridgeServerMessage,
} from "@zcode/shared/browser-extension-transport";
import type { TabsListPayload, WorkerRequest, WorkerResponse } from "./workerProtocol.js";

export interface HostCommandRouterDeps {
  callWorker: (message: WorkerRequest) => Promise<WorkerResponse>;
  sendClient: (message: ExtensionBridgeClientMessage) => void;
}

function failureFromResponse(
  response: WorkerResponse,
  fallbackCode: ExtensionBridgeFailure["code"],
): ExtensionBridgeFailure | undefined {
  if (response.ok) return undefined;
  return {
    code: response.error?.failureCode ?? fallbackCode,
    message: response.error?.message ?? "extension worker failed",
  };
}

/**
 * Host → 扩展命令的传输适配。所有结果都带回 requestId；
 * 错误码在 worker 侧区分 CDP 错误与 attachment 失效。
 */
export async function routeHostCommand(
  deps: HostCommandRouterDeps,
  message: ExtensionBridgeServerMessage,
): Promise<void> {
  switch (message.type) {
    case "tabs.list": {
      const response = await deps.callWorker({ target: "worker", op: "tabs.list" });
      deps.sendClient({
        type: "tabs.list.result",
        requestId: message.requestId,
        ok: response.ok,
        tabs: response.ok ? (response.data as TabsListPayload | undefined)?.tabs : undefined,
        failure: failureFromResponse(response, "internal_error"),
      });
      return;
    }
    case "tabs.create": {
      const response = await deps.callWorker({
        target: "worker",
        op: "tabs.create",
        payload: {
          active: false,
          ...(message.url ? { url: message.url } : {}),
        },
      });
      const data = response.data as { tab?: TabsListPayload["tabs"][number] } | undefined;
      deps.sendClient({
        type: "tabs.create.result",
        requestId: message.requestId,
        ok: response.ok,
        ...(response.ok && data?.tab ? { tab: data.tab } : {}),
        failure: failureFromResponse(response, "target_unavailable"),
      });
      return;
    }
    case "tabs.close": {
      const response = await deps.callWorker({
        target: "worker",
        op: "tabs.close",
        payload: { nativeTabId: message.nativeTabId },
      });
      deps.sendClient({
        type: "tabs.close.result",
        requestId: message.requestId,
        ok: response.ok,
        failure: failureFromResponse(response, "target_unavailable"),
      });
      return;
    }
    case "debugger.attach": {
      const response = await deps.callWorker({
        target: "worker",
        op: "debugger.attach",
        payload: { target: message.target },
      });
      const data = response.data as
        | {
            attachmentId: string;
            nativeTabId: number;
            targetId?: string;
            url?: string;
            title?: string;
          }
        | undefined;
      deps.sendClient({
        type: "debugger.attach.result",
        requestId: message.requestId,
        ok: response.ok,
        ...(response.ok && data
          ? {
              attachmentId: data.attachmentId,
              nativeTabId: data.nativeTabId,
              ...(data.targetId ? { targetId: data.targetId } : {}),
              ...(data.url !== undefined ? { url: data.url } : {}),
              ...(data.title !== undefined ? { title: data.title } : {}),
            }
          : {}),
        failure: failureFromResponse(response, "target_unavailable"),
      });
      return;
    }
    case "debugger.detach": {
      const response = await deps.callWorker({
        target: "worker",
        op: "debugger.detach",
        payload: { targetRef: message.targetRef },
      });
      deps.sendClient({
        type: "debugger.detach.result",
        requestId: message.requestId,
        ok: response.ok,
        failure: failureFromResponse(response, "target_unavailable"),
      });
      return;
    }
    case "cdp.request": {
      const response = await deps.callWorker({
        target: "worker",
        op: "cdp.request",
        payload: {
          requestId: message.requestId,
          targetRef: message.targetRef,
          method: message.method,
          params: message.params,
          ...(message.targetId ? { targetId: message.targetId } : {}),
        },
      });
      const data = response.data as
        | { result?: unknown; error?: { code?: number; message: string } }
        | undefined;
      // failureCode 只在 worker 判定 transport 失败（attachment/参数）时存在；
      // 纯 CDP 错误没有 failureCode，必须保留 method/code/message，不能包装成 target_unavailable。
      const transportFailure = response.error?.failureCode
        ? failureFromResponse(response, "target_unavailable")
        : undefined;
      deps.sendClient({
        type: "cdp.result",
        requestId: message.requestId,
        attachmentId: message.targetRef.attachmentId,
        nativeTabId: message.targetRef.nativeTabId,
        ...(message.targetId ? { targetId: message.targetId } : {}),
        ok: response.ok,
        ...(response.ok
          ? { result: data?.result }
          : transportFailure
            ? { failure: transportFailure }
            : {
                error: data?.error
                  ? {
                      method: message.method,
                      ...(data.error.code !== undefined ? { code: data.error.code } : {}),
                      message: data.error.message,
                    }
                  : {
                      method: message.method,
                      message: response.error?.message ?? "CDP command failed",
                    },
              }),
      });
      return;
    }
    case "request.cancel": {
      void deps.callWorker({
        target: "worker",
        op: "request.cancel",
        payload: { targetRequestId: message.targetRequestId },
      });
      return;
    }
    case "session.detachAll": {
      // 必须 await：offscreen 依赖该 Promise 把后续 welcome/create 排到清理之后。
      // 普通 CDP/取消仍由 default 分支并发转发，不能因清理屏障重新阻塞 dialog 解阻塞命令。
      await deps.callWorker({
        target: "worker",
        op: "detachAll",
        payload: { reason: message.reason },
      });
      return;
    }
    case "claim.request": {
      // 只登记待授权并在 badge/Popup 展示；不 attach，也不向 Host 回执。
      void deps.callWorker({
        target: "worker",
        op: "claim.request",
        payload: {
          claimId: message.claimId,
          nativeTabId: message.nativeTabId,
          expiresAt: message.expiresAt,
        },
      });
      return;
    }
    case "claim.cancel": {
      void deps.callWorker({
        target: "worker",
        op: "claim.cancel",
        payload: { claimId: message.claimId },
      });
      return;
    }
    default:
      return;
  }
}
