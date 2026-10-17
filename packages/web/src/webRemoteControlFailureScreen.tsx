import type { WebRemoteControlFailure, WebRemoteControlFailureReason } from "@zcode/shared";

type WebRemoteControlScreenLocale = "zh-CN" | "en-US";

interface WebRemoteControlScreenCopy {
  tone: "danger" | "warning" | "neutral";
  badge: string;
  title: string;
  description: string;
  detailLabel: string;
  nextStepsTitle: string;
  nextSteps: string[];
  action: string;
}

const WEB_REMOTE_CONTROL_SCREEN_COPY = {
  "zh-CN": {
    "gateway-unreachable": {
      tone: "danger",
      badge: "连接失败",
      title: "无法连接 gateway",
      description: "手机端无法稳定连接远程访问 gateway，电脑端可能暂时离线或网络不可达。",
      detailLabel: "连接详情",
      nextStepsTitle: "下一步",
      nextSteps: ["检查手机网络和 gateway 地址。", "gateway 和电脑端恢复后会自动重连。"],
      action: "重试",
    },
    "gateway-credential-invalid": {
      tone: "danger",
      badge: "凭证无效",
      title: "设备凭证已失效",
      description: "gateway 拒绝了当前的设备凭证，可能已被吊销或填写有误。",
      detailLabel: "鉴权详情",
      nextStepsTitle: "下一步",
      nextSteps: ["在电脑端的 gateway 管理员处确认设备凭证。", "回到设置页重新填写凭证。"],
      action: "重新连接",
    },
    "session-conflict": {
      tone: "warning",
      badge: "设备接管",
      title: "已被其他设备接管",
      description: "另一台远程控制设备已经接入，同一时间只能保留一个手机控制端。",
      detailLabel: "连接详情",
      nextStepsTitle: "下一步",
      nextSteps: ["继续使用新接入的设备。", "如果要用本设备控制，请点击「重新连接」。"],
      action: "重新连接",
    },
    "workspace-closed": {
      tone: "neutral",
      badge: "工作区关闭",
      title: "当前工作区已关闭",
      description: "桌面端已经关闭了共享工作区，手机端无法继续访问这个 workspace。",
      detailLabel: "桌面端返回",
      nextStepsTitle: "下一步",
      nextSteps: ["在桌面端重新打开目标工作区。", "重新发起 Web 远程控制。"],
      action: "重新加载",
    },
    "desktop-disconnected": {
      tone: "danger",
      badge: "电脑端离线",
      title: "桌面端已离线",
      description: "电脑端已经断开连接，当前手机页面不能继续控制桌面工作区。",
      detailLabel: "连接详情",
      nextStepsTitle: "下一步",
      nextSteps: ["确认电脑端 ZCode 仍在运行并联网。", "在电脑端重新开启 Web 远程控制后再连接。"],
      action: "重新连接",
    },
    "incompatible-version": {
      tone: "warning",
      badge: "版本不兼容",
      title: "手机与电脑端版本不兼容",
      description: "手机 App 与电脑端的应用协议版本没有交集，需要升级其中一端。",
      detailLabel: "版本详情",
      nextStepsTitle: "下一步",
      nextSteps: ["按提示升级手机 App 或电脑端 ZCode。", "升级完成后重新连接。"],
      action: "重新连接",
    },
    "desktop-bootstrap-timeout": {
      tone: "warning",
      badge: "响应超时",
      title: "桌面端响应超时",
      description: "手机端已经连上电脑端，但桌面端没有及时返回工作区数据。",
      detailLabel: "超时详情",
      nextStepsTitle: "下一步",
      nextSteps: ["确认桌面端没有休眠或卡在确认弹窗。", "保持电脑和手机网络可用后重试。"],
      action: "重试",
    },
    "connection-recovery-timeout": {
      tone: "warning",
      badge: "恢复超时",
      title: "连接恢复超时",
      description: "手机端连接没有及时恢复，当前页面暂时无法继续同步远程控制。",
      detailLabel: "恢复详情",
      nextStepsTitle: "下一步",
      nextSteps: ["保持手机网络可用后重试。", "如果仍无法恢复，再回到桌面端重新开启 Web 远程控制。"],
      action: "重试",
    },
    "backend-unsupported": {
      tone: "warning",
      badge: "电脑不支持",
      title: "这台电脑不支持 ZCode 远控",
      description: "选中的电脑在线，但没有提供 ZCode 远程控制能力。",
      detailLabel: "电脑信息",
      nextStepsTitle: "下一步",
      nextSteps: ["在电脑端确认使用支持远控的 ZCode 版本。", "返回选电脑页选择另一台电脑。"],
      action: "重新选择",
    },
    "unsupported-action": {
      tone: "neutral",
      badge: "暂不支持",
      title: "当前动作暂不支持",
      description: "Web 远程控制只支持访问桌面端已经打开的工作区。",
      detailLabel: "限制说明",
      nextStepsTitle: "下一步",
      nextSteps: ["先在桌面端打开目标工作区。", "再从手机端选择这个工作区。"],
      action: "重新加载",
    },
    "unexpected-error": {
      tone: "danger",
      badge: "未知异常",
      title: "Web 远程控制失败",
      description: "打开远程控制页面时发生了未预期错误。",
      detailLabel: "错误详情",
      nextStepsTitle: "下一步",
      nextSteps: ["刷新页面再试一次。", "如果仍然失败，请确认电脑端已开启远程访问。"],
      action: "重试",
    },
  },
  "en-US": {
    "gateway-unreachable": {
      tone: "danger",
      badge: "Connection failed",
      title: "Gateway Unreachable",
      description:
        "This phone cannot maintain a connection to the remote access gateway. Desktop may be offline or the network unreachable.",
      detailLabel: "Connection detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Check the phone network and the gateway address.", "Reconnect automatically once the gateway and desktop are back."],
      action: "Retry",
    },
    "gateway-credential-invalid": {
      tone: "danger",
      badge: "Invalid credential",
      title: "Device Credential Invalid",
      description:
        "The gateway rejected this device credential. It may have been revoked or entered incorrectly.",
      detailLabel: "Authentication detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Confirm the device credential with the gateway admin on desktop.", "Enter the credential again in settings."],
      action: "Try Again",
    },
    "session-conflict": {
      tone: "warning",
      badge: "Device takeover",
      title: "Taken Over By Another Device",
      description:
        "Another remote control device connected and replaced this phone. Only one mobile controller can stay active at a time.",
      detailLabel: "Connection detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Continue on the newer device.", "Select Try Again to take control back with this phone."],
      action: "Try Again",
    },
    "workspace-closed": {
      tone: "neutral",
      badge: "Workspace closed",
      title: "Workspace Closed",
      description: "The shared workspace was closed on desktop, so this phone can no longer access it.",
      detailLabel: "Desktop detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Reopen the target workspace on desktop.", "Start Web remote control again."],
      action: "Reload",
    },
    "desktop-disconnected": {
      tone: "danger",
      badge: "Desktop offline",
      title: "Desktop Offline",
      description:
        "The desktop side disconnected. This phone can no longer control the desktop workspace.",
      detailLabel: "Connection detail",
      nextStepsTitle: "What happened",
      nextSteps: ["Make sure ZCode is still running and online on desktop.", "Start Web remote control again from desktop."],
      action: "Try Again",
    },
    "incompatible-version": {
      tone: "warning",
      badge: "Incompatible version",
      title: "Phone and Desktop Versions Incompatible",
      description:
        "The phone and desktop application protocol ranges do not overlap. One side must be upgraded.",
      detailLabel: "Version detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Upgrade the phone app or desktop ZCode as indicated.", "Reconnect after the upgrade."],
      action: "Try Again",
    },
    "desktop-bootstrap-timeout": {
      tone: "warning",
      badge: "Timed out",
      title: "Desktop Timed Out",
      description:
        "This phone reached desktop, but desktop did not return workspace data in time.",
      detailLabel: "Timeout detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Check that desktop is not asleep or waiting for confirmation.", "Keep both devices online and retry."],
      action: "Retry",
    },
    "connection-recovery-timeout": {
      tone: "warning",
      badge: "Recovery timed out",
      title: "Connection Recovery Timed Out",
      description:
        "This phone did not recover its remote control connection in time, so the current page cannot keep syncing yet.",
      detailLabel: "Recovery detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Keep the phone network available and retry.", "If it still cannot recover, start Web remote control again from desktop."],
      action: "Retry",
    },
    "backend-unsupported": {
      tone: "warning",
      badge: "Desktop unsupported",
      title: "This Desktop Does Not Support ZCode Remote",
      description:
        "The selected desktop is online but does not advertise the ZCode remote-control capability.",
      detailLabel: "Desktop detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Confirm desktop runs a ZCode version that supports remote control.", "Go back and select another desktop."],
      action: "Choose Again",
    },
    "unsupported-action": {
      tone: "neutral",
      badge: "Unsupported",
      title: "Action Not Supported",
      description: "Web remote control can only access workspaces already open on desktop.",
      detailLabel: "Limitation",
      nextStepsTitle: "Next steps",
      nextSteps: ["Open the target workspace on desktop first.", "Select it from this phone afterward."],
      action: "Reload",
    },
    "unexpected-error": {
      tone: "danger",
      badge: "Unexpected error",
      title: "Web Remote Control Failed",
      description: "An unexpected error occurred while opening Web remote control.",
      detailLabel: "Error detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Refresh this page once.", "If it still fails, confirm remote access is enabled on desktop."],
      action: "Retry",
    },
  },
} satisfies Record<
  WebRemoteControlScreenLocale,
  Record<WebRemoteControlFailureReason, WebRemoteControlScreenCopy>
>;

export function resolveWebRemoteControlScreenLocale(
  language: string,
): WebRemoteControlScreenLocale {
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function resolveWebRemoteControlScreenCopy(
  failure: WebRemoteControlFailure,
  locale: WebRemoteControlScreenLocale,
): WebRemoteControlScreenCopy {
  return WEB_REMOTE_CONTROL_SCREEN_COPY[locale][failure.reason];
}

function resolveToneClassName(tone: WebRemoteControlScreenCopy["tone"]): {
  badge: string;
  icon: string;
} {
  switch (tone) {
    case "danger":
      return {
        badge: "border-destructive/30 bg-destructive/10 text-destructive",
        icon: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    case "warning":
      return {
        badge: "border-warning/30 bg-warning/10 text-warning-foreground",
        icon: "border-warning/30 bg-warning/10 text-warning-foreground",
      };
    default:
      return {
        badge: "border-border bg-surface text-foreground-subtle",
        icon: "border-border bg-surface text-foreground-subtle",
      };
  }
}

interface WebRemoteControlFailureScreenProps {
  failure: WebRemoteControlFailure;
  locale: WebRemoteControlScreenLocale;
  onReload(): void;
}

export function WebRemoteControlFailureScreen({
  failure,
  locale,
  onReload,
}: WebRemoteControlFailureScreenProps) {
  const copy = resolveWebRemoteControlScreenCopy(failure, locale);
  const toneClassName = resolveToneClassName(copy.tone);

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground"
      style={{ minHeight: "100dvh" }}
    >
      <main className="w-full max-w-md rounded-xl border border-card-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg border text-ui-lg font-semibold ${toneClassName.icon}`}
            aria-hidden="true"
          >
            !
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={`mb-2 inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-ui-xs font-medium ${toneClassName.badge}`}
            >
              <span className="min-w-0 truncate">{copy.badge}</span>
            </div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.title}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
              {copy.description}
            </p>
          </div>
        </div>

        <section className="mt-5 border-t border-border pt-4">
          <h2 className="text-ui-xs font-medium text-foreground">{copy.nextStepsTitle}</h2>
          <ol className="mt-2 space-y-2 text-ui-xs leading-6 text-foreground-subtle">
            {copy.nextSteps.map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface text-ui-xs text-foreground-subtle">
                  {index + 1}
                </span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {failure.message ? (
          <section className="mt-4 rounded-lg border border-border bg-surface px-3 py-2.5">
            <div className="text-ui-xs font-medium text-foreground">{copy.detailLabel}</div>
            <div className="mt-1 break-words font-mono text-ui-xs leading-5 text-foreground-subtle">
              {failure.message}
            </div>
          </section>
        ) : null}

        <button
          type="button"
          className="mt-5 inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 text-ui-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={onReload}
        >
          {copy.action}
        </button>
      </main>
    </div>
  );
}
