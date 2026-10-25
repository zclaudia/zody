import { createRoot } from "react-dom/client";
import { resolveWebRemoteControlScreenLocale } from "../webRemoteControlFailureScreen.js";

/**
 * 第二批 E4：通知按钮提交结果的轻量反馈条。
 * `resolved`：提交被接受（含 duplicate/noop 幂等成功——请求可能已被桌面处理，对用户等价）。
 * `rejected`：提交被拒绝（stale/failed），不自动重试。
 * 自动消失，不承载操作；失败重试走 notice（与通知点击失败同一交互）。
 */
export function showMobileNotificationActionResult(
  kind: "resolved" | "rejected",
): () => void {
  const zh = resolveWebRemoteControlScreenLocale(navigator.language) === "zh-CN";
  const container = document.createElement("div");
  container.className =
    "pointer-events-none fixed inset-x-0 top-3 z-[70] flex justify-center px-3";
  container.setAttribute("data-mobile-notification-action-result", kind);
  container.setAttribute("role", "status");
  document.body.append(container);
  const root = createRoot(container);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.unmount();
    container.remove();
  };
  root.render(
    <div
      className={[
        "rounded-lg border px-3 py-2 text-ui-base shadow-lg",
        kind === "resolved"
          ? "border-border bg-toast text-foreground"
          : "border-destructive/40 bg-toast text-destructive",
      ].join(" ")}
    >
      {kind === "resolved"
        ? zh
          ? "已提交处理结果。"
          : "Response submitted."
        : zh
          ? "无法提交处理结果，请打开任务后重试。"
          : "Could not submit the response. Open the task and retry."}
    </div>,
  );
  const timer = window.setTimeout(dispose, 5_000);
  return () => {
    window.clearTimeout(timer);
    dispose();
  };
}
