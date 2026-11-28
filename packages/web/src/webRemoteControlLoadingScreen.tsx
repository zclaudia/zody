import type { WebRemoteControlTerminalTransportState } from "@zody/ui";

/**
 * 手机远控启动壳（T1.2）的连接加载页。当前全仓唯一消费方是手机入口的
 * mobile-remote/bootstrap.tsx（import :87，渲染 :211/:1674/:1784）；
 * 原注释「与桌面 Web 客户端 /remote* 路由共用」已过时（2026-10 复核 grep 无桌面引用），
 * 本组件的字号/布局调整不影响桌面渲染。
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
    ? ["连接 gateway", "设备鉴权", "等待电脑建立连接", "同步工作区"]
    : [
        "Connect to gateway",
        "Authenticate device",
        "Wait for desktop connection",
        "Sync workspace",
      ];

  switch (state) {
    case "connecting":
      return {
        title: zh ? "正在连接 gateway…" : "Connecting to gateway…",
        description: zh
          ? "正在建立手机与 gateway 的连接。"
          : "Establishing a connection between your phone and the gateway.",
        steps,
      };
    case "authenticating":
      return {
        title: zh ? "正在认证设备…" : "Authenticating device…",
        description: zh
          ? "gateway 已连接，正在完成远控身份校验。"
          : "Gateway connected. Verifying your remote-control identity.",
        steps,
      };
    case "waiting":
      return {
        title: zh ? "等待电脑端建立连接…" : "Waiting for desktop connection…",
        description: zh
          ? "手机端已就绪，等待电脑端接受当前连接。"
          : "Phone is ready. Waiting for the desktop to accept this connection.",
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
        title: zh ? "已连接，正在加载工作区…" : "Connected. Loading workspace…",
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
    <div className="h-dvh min-h-dvh w-screen bg-background zody-window-atmosphere text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-2xl border border-popover-border bg-popover backdrop-blur-xl p-5 shadow-md">
          {/* settings-4：弱网等待时这是全屏唯一内容，原先整卡 text-ui-xs（10px）手机上辨识吃力；
              按角色提到 title=text-ui-base、描述/步骤=text-ui-sm（DESIGN.md 字号语义表）。 */}
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-warning animate-pulse" />
            <h1 className="text-ui-base font-semibold">{copy.title}</h1>
          </div>
          <p className="mt-2 text-ui-sm/relaxed text-foreground-subtle">{copy.description}</p>
          <div className="mt-4 grid gap-2">
            {copy.steps.map((step, index) => (
              <div
                key={step}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle"
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
