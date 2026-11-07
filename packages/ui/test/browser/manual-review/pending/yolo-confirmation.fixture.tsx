/**
 * F26 YOLO（完全访问）模式风险确认组件夹具（manual-review/pending，未转正不计为正式
 * Desktop 通过；注册于 docs/conversation-session-case-catalog.md PA159，产品规格
 * docs/yolo-mode-risk-confirmation.md）。
 *
 * 三个模式切换入口中的两个在此可复现：
 * - composer：V4ComposerModeSwitch 菜单 + cycleSessionMode 快捷键（草稿模式）；
 * - approval：PermissionDialog 完全访问选项（会话权威模式 permissionMode）。
 * changeYoloTarget 模拟 scope 换代（回调/权限请求失效），syncYoloMode 模拟外部同步路径。
 */
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zody/services";
import type { IPlatformService, ZodyPermissionRequest } from "@zody/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const services = { settingService: { get: async () => ({}) } } as unknown as IServiceAccessor;
const platform = {} as IPlatformService;
const request: ZodyPermissionRequest = {
  type: "permission_request",
  taskId: "session-a",
  traceId: "trace",
  requestId: "permission-a",
  kind: "Bash",
  title: "Bash",
  description: "Run command",
  raw: { command: "echo example" },
  freeText: true,
  options: [
    { optionId: "allowOnce", kind: "allow_once", name: "Allow", response: { decision: "allow" } },
    { optionId: "fullAccess", kind: "custom", name: "Full access", response: { decision: "deny" } },
    { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
  ],
};

function Fixture() {
  const [mode, setMode] = useState(params.get("mode") ?? "build");
  const [planEnabled, setPlan] = useState(true);
  const [picker, setPicker] = useState<"mode" | null>(null);
  const [target, setTarget] = useState("a");
  const [response, setResponse] = useState("");
  const [commits, setCommits] = useState(0);
  const switchMode = useCallback(
    (next: string) => {
      setCommits((n) => n + 1);
      if (next === "plan" || next === "plan-off") setPlan(next === "plan");
      else setMode(next);
    },
    // target 变化 = 草稿回调换代（scope 失效边界），pending 确认必须随之作废。
    [target],
  );
  // 模拟外部导航/请求结束；产品组件自身负责取消确认，不由夹具处理。
  Object.assign(window, {
    changeYoloTarget: () => setTarget((v) => (v === "a" ? "b" : "a")),
    syncYoloMode: setMode,
  });
  const surface = params.get("surface") ?? "composer";
  return (
    <main className="min-h-dvh bg-background p-3 text-foreground">
      {surface === "composer" && (
        <V4ComposerModeSwitch
          workspacePath="/example"
          draftConfig={{ mode: mode as "build", planEnabled }}
          activeConfigPicker={picker}
          onConfigPickerOpenChange={(_picker, open) => setPicker(open ? "mode" : null)}
          onSwitchMode={switchMode}
        />
      )}
      {surface === "approval" && target === "a" && !response && (
        <PermissionDialog
          request={request}
          permissionMode={mode}
          workspacePath="/example"
          isWebRemoteControl={innerWidth < 600}
          onRespond={(_id, option) => setResponse(option.optionId)}
        />
      )}
      <output className="sr-only" data-testid="state">
        {JSON.stringify({ mode, planEnabled, commits, response })}
      </output>
      <ConfirmDialogHost />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <ZodyIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </ZodyIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
