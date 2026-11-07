import { useCallback, useLayoutEffect, useRef } from "react";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

export function useConfirmDialog() {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}

/**
 * F26 完全访问（yolo）模式风险确认门（docs/yolo-mode-risk-confirmation.md，上游 a60ba6a7）。
 *
 * 只包装显式入口；scope 必须稳定，并随原状态 owner 的目标换代而改变
 * （菜单/快捷键 = 模式切换回调 + 当前草稿模式；审批框 = workspace/task/request 应答身份）。
 * nextMode 不是 yolo、或当前已在 yolo（不重复弹以「当前模式事实」为准）时直接 apply；
 * 确认结果不持久化，切回后再进 yolo 必须重新确认。
 */
export function useYoloModeConfirmation(scope: unknown, currentMode: string | undefined) {
  const { intl } = useZodyIntl();
  const requestConfirmation = useConfirmDialog();
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      // 不能只在弹窗关闭时检查 mounted：确认结算与微任务提交之间也可能发生导航
      // （scope 换代），旧确认不能把 yolo 写进后来选中的目标。
      pending.current?.abort();
      pending.current = null;
    },
    [scope, currentMode],
  );

  return useCallback(
    (nextMode: string, apply: () => void) => {
      // 单例守卫：确认进行中重复触发（含快捷键连按）直接丢弃，不排队、不替换。
      if (
        pending.current ||
        useConfirmDialogStore.getState().pendingRequest?.presentation === "yolo-confirmation"
      )
        return;
      if (nextMode !== "yolo" || currentMode === "yolo") {
        apply();
        return;
      }
      const controller = new AbortController();
      pending.current = controller;
      void requestConfirmation(
        {
          title: intl.formatMessage({ id: "mode.yoloConfirmation.title" }),
          presentation: "yolo-confirmation",
        },
        controller.signal,
      ).then((confirmed) => {
        if (pending.current === controller) pending.current = null;
        // apply 至多一次：abort 之后即使 confirm 竞态到达也不应用。
        if (confirmed && !controller.signal.aborted) apply();
      });
    },
    [currentMode, intl, requestConfirmation, scope],
  );
}
