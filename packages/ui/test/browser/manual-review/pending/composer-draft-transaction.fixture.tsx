/**
 * F28 基线夹具（manual-review/pending；注册于 docs/conversation-session-case-catalog.md
 * PA162，产品规格 docs/ui/composer-draft-transaction.md）。
 * 挂载真实 ConversationComposer + 真实 useDraftConfigControl（SessionPane 同款接线：
 * 草稿 owner 在父级持有，composer 只消费），可在草稿（__draft__ root scope）与
 * task scope 之间切换、控制 onSendText 挂起/失败、读取持久草稿与草稿写盘计数。
 * Platform/Services 以 fake provider 注入（与 image-annotate-to-draft.fixture 同款手法）。
 */
import { createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zody/services";
import type { IPlatformService } from "@zody/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { getV4ComposerDraftStorageKey } from "@/v4/composer/composerDraftStore.js";
import { captureImageComposerTarget } from "@/image-preview-editor/index.js";
import { useComposerAttachmentUploadStore } from "@/store/composerAttachmentUploadStore.js";
import "@/styles.css";

const WORKSPACE_PATH = "/workspace";

// 服务 fake：settingService 同 yolo 夹具；clientConfigService.getSnapshot 供
// usePluginStoreOrder 读取（缺失时该 hook 的双 undefined 判等会读到 snapshot.order 崩溃）。
const services = {
  settingService: { get: async () => ({}) },
  clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
} as unknown as IServiceAccessor;
const platform = {} as IPlatformService;

const draftKey = getV4ComposerDraftStorageKey(WORKSPACE_PATH);

interface HungSendGate {
  resolve: (value: "sent") => void;
  reject: (error: unknown) => void;
}

const fixture = window as unknown as {
  sentCount: number;
  sendStartedCount: number;
  draftWriteCount: number;
  hangNextSend: () => void;
  settleHungSend: (outcome: "resolve" | "reject") => void;
  switchScope: (next: "draft" | "task") => void;
  readPersistedDrafts: () => Record<string, { text: string; mode?: string }>;
  resetDraftWriteCount: () => void;
  seedDraftImage: () => boolean;
  draftAttachmentFilenames: () => string[];
};
fixture.sentCount = 0;
fixture.sendStartedCount = 0;
fixture.draftWriteCount = 0;

// 热路径指标（步①基线）：统计草稿存储键的 setItem 次数（每击键写盘 vs staged 暂存）。
const originalSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = (key: string, value: string) => {
  if (key === draftKey) fixture.draftWriteCount += 1;
  originalSetItem(key, value);
};
fixture.resetDraftWriteCount = () => {
  fixture.draftWriteCount = 0;
};

// 读取真实草稿存储（去 editorStateJson 降噪），供 E2E 断言各 scope 的持久事实。
fixture.readPersistedDrafts = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(draftKey) ?? "{}") as {
      scopes?: Record<string, { text?: string; mode?: string; editorStateJson?: string }>;
    };
    return Object.fromEntries(
      Object.entries(parsed.scopes ?? {}).map(([scopeId, draft]) => [
        scopeId,
        { text: draft.text ?? "", ...(draft.mode ? { mode: draft.mode } : {}) },
      ]),
    );
  } catch {
    return {};
  }
};

// 发送门控：默认立即成功；hangNextSend 后下一次 onSendText 挂起，由测试端 resolve/reject。
let hangNext = false;
let hungSend: HungSendGate | null = null;
fixture.hangNextSend = () => {
  hangNext = true;
};
fixture.settleHungSend = (outcome) => {
  const gate = hungSend;
  hungSend = null;
  if (!gate) return;
  if (outcome === "resolve") gate.resolve("sent");
  else gate.reject(new Error("E2E simulated transport error"));
};

// PA162-05（F15 附件路径）：经真实捕获通道播种草稿图片（与 image-annotate 夹具同款），
// 并直接读真实附件 store 断言失败恢复后附件仍保留。
async function makeDraftPng() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "white";
  context.fillRect(0, 0, 96, 64);
  context.fillStyle = "skyblue";
  context.fillRect(8, 8, 80, 48);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("no blob"))), "image/png"),
  );
  return new File([blob], "shot.png", { type: "image/png" });
}
fixture.seedDraftImage = () => {
  void makeDraftPng().then((file) => {
    captureImageComposerTarget()?.append(file);
  });
  return true;
};
fixture.draftAttachmentFilenames = () =>
  Object.values(useComposerAttachmentUploadStore.getState().scopes).flatMap((items) =>
    items.map((item) => item.filename),
  );

// scope 切换：模拟侧栏切换任务（SessionPane 固定 key 复用同一 composer 实例）。
let switchScopeExternal: ((next: "draft" | "task") => void) | null = null;
fixture.switchScope = (next) => switchScopeExternal?.(next);

// 真实草稿 owner：与 SessionPane 相同的挂载方式（scope 切换只换 sessionId prop）。
// 必须渲染在 ServiceProvider/TabStore 内（useDraftConfigControl 经 useZodySessionService
// 读 workspace services），因此独立成 providers 内层组件。
function ComposerHost({ scope }: { scope: "draft" | "task" }) {
  const sessionId = scope === "draft" ? null : "task-b";
  const control = useDraftConfigControl({
    workspacePath: WORKSPACE_PATH,
    sessionId,
    agentStartupAllowed: false,
    modelSelectionService: null,
  });
  return createElement(ConversationComposer, {
    draftMode: scope === "draft",
    listenAddToChatEvents: true,
    onSendText: async () => {
      fixture.sendStartedCount += 1;
      if (!hangNext) {
        fixture.sentCount += 1;
        return "sent" as const;
      }
      hangNext = false;
      return new Promise<"sent">((resolve, reject) => {
        hungSend = { resolve, reject };
      });
    },
    onStop: () => {},
    onSwitchMode: () => {},
    onSelectModel: () => {},
    onSelectThought: () => {},
    sessionId,
    snapshot: null,
    // PA162-05：草稿附件需要上传载体 session 才能从 waitingSession 进入 queued→ready；
    // 上传本身由上面的 attachmentPut fake 承担。
    attachmentSessionId: "fixture-attachment-session",
    workspacePath: WORKSPACE_PATH,
    composerDraft: control.composerDraft,
    updateComposerContent: control.updateComposerContent,
    replaceComposerDraft: control.replaceComposerDraft,
    stageComposerContent: control.stageComposerContent,
    persistComposerContent: control.persistComposerContent,
    captureComposerContentLifecycleCommit: control.captureComposerContentLifecycleCommit,
    composerDraftScopeToken: control.composerDraftScopeToken,
    captureComposerSubmissionDraftTransaction: control.captureComposerSubmissionDraftTransaction,
    // PA162-05：附件上传走最小 fake（ref 即就绪），避免夹具拉起真实上传。
    attachmentPut: async () => ({ ref: "fixture-attachment-ref" }),
  });
}

function Fixture() {
  const [scope, setScope] = useState<"draft" | "task">("draft");
  useEffect(() => {
    switchScopeExternal = setScope;
    return () => {
      switchScopeExternal = null;
    };
  }, [setScope]);
  return createElement(
    ZodyIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(
      ServiceProvider,
      { services },
      createElement(
        PlatformProvider,
        { platform },
        createElement(
          TabStoreProvider,
          null,
          createElement(
            TooltipProvider,
            null,
            createElement(
              "div",
              { className: "flex h-screen items-end p-4" },
              createElement(ComposerHost, { scope }),
            ),
          ),
        ),
      ),
    ),
  );
}

createRoot(document.getElementById("root")!).render(createElement(Fixture));
