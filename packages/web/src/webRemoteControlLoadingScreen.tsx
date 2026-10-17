import type { WebRemoteControlTerminalTransportState } from "@zcode/ui";

/**
 * 手机远控启动壳（T1.2）：桌面 Web 客户端的 `/remote*` 路由与手机入口（mobile.html）
 * 共用同一份加载页，避免两条入口各自维护一套启动文案。
 */

function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function resolveWebRemoteControlLoadingCopy(state: WebRemoteControlTerminalTransportState): {
  title: string;
  description: string;
  steps: string[];
} {
  const zh = isZhLocale();
  const steps = zh
    ? ["连接中转服务", "设备鉴权", "等待桌面端配对", "同步工作区"]
    : [
        "Connect to relay service",
        "Authenticate device",
        "Wait for desktop pairing",
        "Sync workspace",
      ];

  switch (state) {
    case "connecting":
      return {
        title: zh ? "正在连接中转服务…" : "Connecting relay service…",
        description: zh
          ? "正在建立手机与远控中转服务的连接。"
          : "Establishing a connection between your phone and the relay.",
        steps,
      };
    case "authenticating":
      return {
        title: zh ? "正在认证设备…" : "Authenticating device…",
        description: zh
          ? "已连接中转服务，正在完成远控身份校验。"
          : "Relay connected. Verifying your remote-control identity.",
        steps,
      };
    case "waiting":
      return {
        title: zh ? "等待桌面端确认配对…" : "Waiting for desktop pairing…",
        description: zh
          ? "手机端已就绪，等待桌面端会话匹配当前连接。"
          : "Phone is ready. Waiting for desktop to match this connection.",
        steps,
      };
    case "reconnecting":
      return {
        title: zh ? "连接中断，正在重连…" : "Connection interrupted, reconnecting…",
        description: zh
          ? "网络或休眠恢复后会自动重连，请稍候。"
          : "Auto-reconnecting after network or wake-up changes.",
        steps,
      };
    case "paired":
      return {
        title: zh ? "已配对，正在加载工作区…" : "Paired. Loading workspace…",
        description: zh
          ? "连接已建立，正在同步桌面端工作区和任务。"
          : "Connection established. Syncing workspace and tasks.",
        steps,
      };
    case "suspended":
      return {
        title: zh ? "页面在后台，等待恢复…" : "Page is in background, waiting to recover…",
        description: zh
          ? "回到前台后会自动恢复连接。"
          : "Connection will recover automatically when back in foreground.",
        steps,
      };
    default:
      return {
        title: zh ? "正在准备远程控制…" : "Preparing remote control…",
        description: zh
          ? "正在初始化手机端远程控制会话。"
          : "Initializing mobile remote-control session.",
        steps,
      };
  }
}

export function WebRemoteControlLoadingScreen({
  state,
}: {
  state: WebRemoteControlTerminalTransportState;
}) {
  const copy = resolveWebRemoteControlLoadingCopy(state);
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-warning animate-pulse" />
            <h1 className="text-ui-xs font-medium">{copy.title}</h1>
          </div>
          <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{copy.description}</p>
          <div className="mt-4 grid gap-2">
            {copy.steps.map((step, index) => (
              <div
                key={step}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle"
              >
                {`${index + 1}. ${step}`}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
