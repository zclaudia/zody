import { createRoot } from "react-dom/client";
import { Button } from "@zcode/ui";
import type { MobileUiReleaseControllerStatus } from "./mobileUiReleaseControllerContracts.js";
import type { MobileUiRefreshBlockReason } from "./mobileUiRefreshGuards.js";
import { resolveWebRemoteControlScreenLocale } from "../webRemoteControlFailureScreen.js";

/**
 * “新版已就绪”提示（spec 第 9.3 节；M3-T2）。
 *
 * 设计约束：
 * - 非模态浮层，不能用 `showModal`/全屏遮罩：草稿和设置正是阻塞刷新时用户需要继续操作的对象；
 * - 只展示 controller 的 ready/confirming/incompatible 状态；检查失败保留当前文档，不打扰用户；
 * - “安全刷新”调用 controller.requestSafeReload()，与自动刷新共用 guard、5 秒确认和原生 veto，
 *   不存在绕过入口；
 * - 样式遵守 DESIGN.md：语义 token、text-ui-*、popover 表面、紧凑密度。
 */

interface ReleaseNoticeController {
  getStatus(): MobileUiReleaseControllerStatus;
  subscribe(listener: (status: MobileUiReleaseControllerStatus) => void): () => void;
  requestSafeReload(): Promise<unknown>;
}

type Locale = "zh-CN" | "en-US";

const BLOCK_REASON_COPY: Record<MobileUiRefreshBlockReason, [string, string]> = {
  "composer-draft": ["未发送的输入草稿", "an unsent message draft"],
  "pending-optimistic-overlay": ["待同步的任务列表更改", "pending task list changes"],
  "unsaved-settings": ["未保存的设置", "unsaved settings"],
  "file-operation": ["文件保存或下载进行中", "a file save or download is running"],
  "active-overlay": ["有打开的弹层或待确认操作", "an open dialog or unconfirmed action"],
  "native-operation": [
    "系统文件选择、拍照或权限操作进行中",
    "a system file, camera, or permission dialog is open",
  ],
  "background-task": ["后台任务运行中", "a background task is running"],
  "unknown-guard-state": ["当前页面状态未知", "the current page state is unknown"],
};

function resolveNativeVetoCopy(
  veto: NonNullable<Extract<MobileUiReleaseControllerStatus, { kind: "ready" }>["nativeVeto"]>,
  locale: Locale,
): string {
  const zh = locale === "zh-CN";
  switch (veto) {
    case "native-busy":
      return zh
        ? "系统文件选择、拍照或权限操作进行中"
        : "a system file, camera, or permission dialog is open";
    case "stale-session":
      return zh ? "当前远程会话已失效" : "the remote session is no longer active";
    case "unsupported":
      return zh ? "当前 App 不支持安全刷新" : "this app version cannot reload safely";
    default:
      return zh ? "原生侧暂不允许刷新" : "the native app cannot reload right now";
  }
}

function ReleaseNotice({
  status,
  locale,
  onReload,
}: {
  status: MobileUiReleaseControllerStatus;
  locale: Locale;
  onReload: () => void;
}) {
  const zh = locale === "zh-CN";
  if (status.kind === "pending-confirmation") {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-ui-base font-medium">
          {zh ? "正在确认新版本…" : "Confirming the new version…"}
        </p>
        <p className="text-ui-sm text-foreground-subtle">
          {zh
            ? "确认完成后会在所有未完成操作结束后安全刷新。"
            : "The page reloads safely after confirmation once no unfinished work remains."}
        </p>
      </div>
    );
  }

  if (status.kind === "incompatible") {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-ui-base font-medium">
          {zh ? "需要更新 Zody App" : "Update the Zody app"}
        </p>
        <p className="text-ui-sm text-foreground-subtle">
          {zh
            ? `桌面新版需要 App 桥版本 ${status.supportedBridgeVersions.join("、") || "1"}。请升级 APK 后重新打开。`
            : `The desktop release requires app bridge version ${status.supportedBridgeVersions.join(", ") || "1"}. Update the APK and reopen.`}
        </p>
      </div>
    );
  }

  if (status.kind !== "ready") {
    return null;
  }

  const blocked = [...status.blockedReasons];
  const hasBlockers = blocked.length > 0 || status.nativeVeto !== undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-ui-base font-medium">{zh ? "新版已就绪" : "New version ready"}</p>
        <p className="text-ui-sm text-foreground-subtle break-words">
          {hasBlockers
            ? zh
              ? "完成以下操作后即可安全刷新；当前页面会继续保留。"
              : "Finish the items below to reload safely; the current page stays open."
            : zh
              ? `桌面 ${status.desktopVersion} 已发布。`
              : `Desktop ${status.desktopVersion} is available.`}
        </p>
      </div>
      {hasBlockers ? (
        <ul className="flex min-w-0 flex-col gap-1" data-mobile-release-blockers="true">
          {blocked.map((reason) => (
            <li
              key={reason}
              className="text-ui-sm text-foreground-subtle"
              data-mobile-release-blocked-reason={reason}
            >
              • {BLOCK_REASON_COPY[reason][zh ? 0 : 1]}
            </li>
          ))}
          {status.nativeVeto ? (
            <li
              className="text-ui-sm text-foreground-subtle"
              data-mobile-release-native-veto={status.nativeVeto}
            >
              • {resolveNativeVetoCopy(status.nativeVeto, locale)}
            </li>
          ) : null}
        </ul>
      ) : null}
      <Button
        type="button"
        className="h-11 w-full"
        data-mobile-release-reload="true"
        onClick={onReload}
      >
        {zh ? "安全刷新" : "Reload safely"}
      </Button>
    </div>
  );
}

function statusNeedsNotice(status: MobileUiReleaseControllerStatus): boolean {
  return (
    status.kind === "ready" ||
    status.kind === "pending-confirmation" ||
    status.kind === "incompatible"
  );
}

export function showMobileUiReleaseNotice(controller: ReleaseNoticeController): () => void {
  if (typeof document === "undefined" || !document.body) {
    return () => {};
  }
  const locale: Locale = resolveWebRemoteControlScreenLocale(navigator.language);
  let status = controller.getStatus();
  let disposed = false;

  const host = document.createElement("div");
  host.className = "fixed inset-x-4 bottom-4 z-[90] mx-auto flex max-w-md justify-center";
  host.style.pointerEvents = "auto";
  host.setAttribute("data-mobile-release-notice", "true");
  document.body.append(host);
  const root = createRoot(host);

  const render = () => {
    const visible = !disposed && statusNeedsNotice(status);
    host.hidden = !visible;
    if (!visible) {
      root.render(null);
      return;
    }
    root.render(
      <div
        role="status"
        aria-live="polite"
        className="min-w-0 rounded-xl border border-popover-border bg-popover p-4 text-foreground shadow-lg"
      >
        <ReleaseNotice
          status={status}
          locale={locale}
          onReload={() => {
            void controller.requestSafeReload();
          }}
        />
      </div>,
    );
  };

  const unsubscribe = controller.subscribe((next) => {
    status = next;
    render();
  });
  render();

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe();
    root.unmount();
    host.remove();
  };
}
