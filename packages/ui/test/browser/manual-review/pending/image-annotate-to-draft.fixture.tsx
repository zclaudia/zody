/**
 * F15④ PA161-05 真实 Composer 保真夹具（manual-review/pending；与 image-preview-editor.fixture
 * 同族，注册于 docs/conversation-session-case-catalog.md PA161）。
 * 挂载真实 ConversationComposer（真实 useComposerAttachments 捕获注册与 addAttachmentFiles
 * 入队；Platform/Services 以 fake provider 注入，与 yolo-confirmation.fixture 同款手法）。
 * seedDraftImage 经真实捕获通道 append 一张 320×240 PNG 建立草稿图片附件——
 * 不 mock 附件 hook，验证「chip 标注入口 → 编辑器 → 保存 → 草稿新增 -edited.png」全链路。
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zody/services";
import type { IPlatformService } from "@zody/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { captureImageComposerTarget } from "@/image-preview-editor/index.js";
import { useComposerAttachmentUploadStore } from "@/store/composerAttachmentUploadStore.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
localStorage.setItem("zody-locale-preference", locale);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";

// 服务 fake：settingService 同 yolo 夹具；clientConfigService.getSnapshot 供
// usePluginStoreOrder 读取（缺失时该 hook 的 `snapshot?.service === service` 双 undefined
// 判等会走到 snapshot.order 崩溃，必须提供）。
const services = {
  settingService: { get: async () => ({}) },
  clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
} as unknown as IServiceAccessor;
const platform = {} as IPlatformService;

const fixture = window as unknown as {
  sentCount: number;
  seedDraftImage: () => boolean;
  draftFilenames: () => string[];
};
fixture.sentCount = 0;
// 直接读真实附件 store（scopeKey 由 hook 内部构造），供 E2E 断言草稿文件名列表。
fixture.draftFilenames = () =>
  Object.values(useComposerAttachmentUploadStore.getState().scopes).flatMap((items) =>
    items.map((item) => item.filename),
  );

/** 与画布导出同构的 320×240 PNG（白底 + 天蓝圆），保证 chip 缩略图与编辑器都能真实解码。 */
async function makeDraftPng() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "white";
  context.fillRect(0, 0, 320, 240);
  context.fillStyle = "skyblue";
  context.beginPath();
  context.arc(160, 120, 48, 0, Math.PI * 2);
  context.fill();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("no blob"))), "image/png"),
  );
  return new File([blob], "shot.png", { type: "image/png" });
}

function Fixture() {
  // 经真实捕获通道播种草稿图片：等价于「另一处图片编辑器保存到本 Composer」的合同路径，
  // 同时证明真实 useComposerAttachments 已按 listenAddToChatEvents 注册接收方。
  fixture.seedDraftImage = () => {
    void makeDraftPng().then((file) => {
      const target = captureImageComposerTarget();
      target?.append(file);
    });
    return true;
  };
  return createElement(
    ZodyIntlProvider,
    { initialLocale: locale },
    createElement(
      ServiceProvider,
      { services },
      createElement(
        PlatformProvider,
        { platform },
        // 真实 Composer 的输入链路（LexicalChatInput → activeTaskProvider）需要 TabStore。
        createElement(
          TabStoreProvider,
          null,
          createElement(
            TooltipProvider,
            null,
            createElement(
              "div",
              { className: "flex h-screen items-end p-4" },
              createElement(
                ConversationComposer as unknown as React.ComponentType<Record<string, unknown>>,
                {
                  draftMode: true,
                  listenAddToChatEvents: true,
                  onSendText: async () => {
                    fixture.sentCount += 1;
                  },
                  onStop: () => {},
                  onSwitchMode: () => {},
                  onSelectModel: () => {},
                  onSelectThought: () => {},
                  // F28 步①（a60ba6a7）起 staged 暂存三 props 在挂载即被消费
                  //（persist effect setup 捕获生命周期提交）；本夹具不挂草稿 owner、
                  // 只断言附件链路，按最小 no-op 注入避免挂载崩溃。
                  stageComposerContent: () => {},
                  persistComposerContent: () => {},
                  captureComposerContentLifecycleCommit: () => () => {},
                  // F28 步③：提交事务与世代 token（本夹具断言零发送，最小 no-op）。
                  composerDraftScopeToken: Symbol("image-annotate-fixture"),
                  captureComposerSubmissionDraftTransaction: () => ({
                    claim: () => false,
                    restore: () => ({ current: false, applied: false }),
                    finalize: () => null,
                    release: () => {},
                    matchesTarget: () => false,
                  }),
                  sessionId: null,
                  snapshot: null,
                  workspacePath: "/workspace",
                },
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

createRoot(document.getElementById("root")!).render(createElement(Fixture));
