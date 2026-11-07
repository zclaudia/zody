import { create } from "zustand";
import { logger } from "@/logger.js";

export interface ConfirmDialogRequest {
  title: string;
  testId?: string;
  description?: string;
  /** 特定业务弹框的稳定视觉规范；默认确认框不受影响。 */
  presentation?:
    | "automation-confirmation"
    // F27（docs/task-restart-and-reload.md）：任务重启前「重启 Agent 进程」确认；
    // 渲染走通用确认框，该标记用于业务识别与 E2E 定位。
    | "workspace-restart-confirmation"
    // F26（docs/yolo-mode-risk-confirmation.md，上游 a60ba6a7）：进入完全访问
    // （yolo）模式前的风险确认；渲染走 ConfirmDialogHost 专用分支。
    | "yolo-confirmation";
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive";
  showCloseButton?: boolean;
  showKeyboardHints?: boolean;
  compact?: boolean;
  checkbox?: { label: string; onCheckedChange: (checked: boolean) => void };
}

export type ConfirmDialogChoice = "confirm" | "cancel" | "dismiss";

interface PendingConfirmDialogRequest extends ConfirmDialogRequest {
  resolve: (choice: ConfirmDialogChoice) => void;
}

interface ConfirmDialogState {
  pendingRequest?: PendingConfirmDialogRequest;
  requestConfirmation: (payload: ConfirmDialogRequest, signal?: AbortSignal) => Promise<boolean>;
  requestChoice: (
    payload: ConfirmDialogRequest,
    signal?: AbortSignal,
  ) => Promise<ConfirmDialogChoice>;
  settleConfirmation: (confirmed: boolean) => void;
  settleChoice: (choice: ConfirmDialogChoice) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestConfirmation: async (payload, signal) =>
    (await get().requestChoice(payload, signal)) === "confirm",
  requestChoice: (payload, signal) => {
    // F26（上游 a60ba6a7）：目标已失效（scope 换代、组件卸载）才发起的请求直接
    // dismiss，不再打开弹窗——否则会在新目标上闪现一个已经作废的确认。
    if (signal?.aborted) return Promise.resolve("dismiss");
    if (get().pendingRequest) {
      logger.warn("[ConfirmDialogStore] confirmation already in progress");
      return Promise.resolve("dismiss");
    }

    return new Promise<ConfirmDialogChoice>((resolve) => {
      const pendingRequest: PendingConfirmDialogRequest = {
        ...payload,
        resolve: (choice) => {
          signal?.removeEventListener("abort", abort);
          resolve(choice);
        },
      };
      // 目标失效只能关闭自己的请求，不能结算后来打开的其他确认框。
      const abort = () => {
        if (get().pendingRequest === pendingRequest) get().settleChoice("dismiss");
      };
      signal?.addEventListener("abort", abort, { once: true });
      set({ pendingRequest });
    });
  },
  settleConfirmation: (confirmed) => get().settleChoice(confirmed ? "confirm" : "cancel"),
  settleChoice: (choice) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest) {
      return;
    }

    set({ pendingRequest: undefined });
    pendingRequest.resolve(choice);
  },
}));
