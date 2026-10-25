import { createRoot } from "react-dom/client";
import { Button } from "@zcode/ui";
import { resolveWebRemoteControlScreenLocale } from "../webRemoteControlFailureScreen.js";

/** A failed deep link keeps the active page and its unsent draft mounted. */
export function showMobileNotificationNotice(options: {
  retry(): void;
  dismiss(): void;
  onBackPressed?(listener: () => boolean): () => void;
}): () => void {
  const dialog = document.createElement("dialog");
  dialog.className =
    "m-auto max-w-md rounded-2xl border border-popover-border bg-popover p-6 text-foreground shadow-lg";
  dialog.style.width = "calc(100% - 2rem)";
  dialog.style.pointerEvents = "auto";
  dialog.setAttribute("aria-labelledby", "mobile-notification-error-title");
  document.body.append(dialog);
  const root = createRoot(dialog);
  const zh = resolveWebRemoteControlScreenLocale(navigator.language) === "zh-CN";
  let disposed = false;
  let disposeBack: (() => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeBack?.();
    root.unmount();
    dialog.close();
    dialog.remove();
  };
  const dismiss = () => {
    dispose();
    options.dismiss();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  root.render(
    <div className="flex flex-col gap-4">
      <h2 id="mobile-notification-error-title" className="text-ui-lg font-medium">
        {zh ? "暂时无法打开通知" : "Could not open notification"}
      </h2>
      <p>
        {zh
          ? "请确认电脑和项目已连接。任务可能已删除，或通知已过期；通知仍保持未读。"
          : "Check that the computer and project are connected. The task may have been deleted or the notification expired. It remains unread."}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={dismiss}>
          {zh ? "关闭" : "Close"}
        </Button>
        <Button
          autoFocus
          onClick={() => {
            dispose();
            options.retry();
          }}
        >
          {zh ? "重试" : "Retry"}
        </Button>
      </div>
    </div>,
  );
  dialog.showModal();
  disposeBack = options.onBackPressed?.(() => {
    dismiss();
    return true;
  });
  for (const event of ["keydown", "keyup", "keypress", "click", "pointerdown"] as const)
    dialog.addEventListener(event, (value) => value.stopPropagation());
  return dispose;
}
