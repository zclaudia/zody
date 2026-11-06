import { logger } from "@/logger.js";
import { readPluginUiStyleVariables } from "@/plugin-ui/adapters/readPluginUiStyleVariables.js";
import { buildPluginUiControllerDeps } from "@/plugin-ui/adapters/pluginUiControllerDeps.js";
import {
  createPluginUiHostController,
  type PluginUiHostController,
  type PluginUiHostPhase,
} from "@/plugin-ui/app/pluginUiHostController.js";
import { clearPluginUiWidgetState } from "@/plugin-ui/app/pluginUiWidgetStateStore.js";
import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle } from "@zody/shared/mcp-apps";
import { buildPluginSandboxScopeId } from "@zody/shared/mcp-apps";
import { clearPluginUiSurfaceFeed } from "../app/pluginUiSurfaceFeedStore.js";
import {
  PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
  PLUGIN_UI_CARD_MAX_HEIGHT_PX,
  PLUGIN_UI_CARD_MIN_HEIGHT_PX,
} from "../contract.js";
import { buildPluginUiHostContext } from "../domain/buildPluginUiHostContext.js";

import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { IServiceAccessor } from "@zody/services";
import type { IPlatformService } from "@zody/shared";
import { buildPluginUiSessionKey } from "../contract.js";
import type { Page, UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";
import { createPluginUiPagePlane } from "./pluginUiPagePlane.js";
import { pluginUiPages } from "./pluginUiPageRegistry.js";
import { attachPluginUiResourceDeltaFeed } from "./pluginUiResourceDeltaFeed.js";
type Platform = IPlatformService;
type Services = IServiceAccessor;
export function createPage(
  key: string,
  input: UsePluginUiHostInput,
  platform: Platform,
  services: Services,
): Page {
  const bridge = services.pluginUiBridgeService!;
  const sandboxPlatform = platform.pluginSandbox!;
  const surfaceKey = key;
  const latest = { current: input };
  const listeners = new Set<() => void>();
  let controller: PluginUiHostController | null = null;
  let releaseFeed: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let disposed = false;
  let starting = false;
  let incarnation = 0;
  // F18（上游 a60ba6a7）：回收裁决去重（并发触发合并为一次）与保留策略的活动去重键。
  let recycling: Promise<boolean> | undefined;
  let activityFeed = "";
  let releasing: Promise<unknown> = Promise.resolve();
  let contextInputs = "";
  let lastFeed = "";
  let lastContext = "";
  let appIdentity: string | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let snapshot: UsePluginUiHostResult = {
    pageKey: key,
    supported: true,
    phase: "idle",
    handle: null,
    height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
    error: null,
    appCapabilities: undefined,
    reload: () => {
      clearPluginUiWidgetState(key);
      void page.suspend(true).then(ensure);
    },
  };
  const patch = (value: Partial<UsePluginUiHostResult>) => {
    snapshot = { ...snapshot, ...value };
    notify();
  };
  const setPhase = (phase: PluginUiHostPhase) => patch({ phase });
  const setHandle = (handle: PluginSandboxHandle) => {
    if (appIdentity && appIdentity !== handle.instance.appIdentity) clearPluginUiWidgetState(key);
    appIdentity = handle.instance.appIdentity;
    // F18（上游 a60ba6a7）：句换代际变化才重报保留资格；声明只来自资源 resourceMeta，
    // 经沙箱登记与句柄回传，无第二写入路径（docs/plugin-ui-background-execution.md §12.4）。
    const fresh =
      snapshot.handle?.sandboxId !== handle.sandboxId || snapshot.handle?.initId !== handle.initId;
    patch({ handle });
    if (fresh) pluginUiPages.prepared(page, handle.resourceMeta?.backgroundRetention === true);
    plane.mount(handle);
    syncExecution();
  };
  const setHeight = (height: number) => patch({ height });
  const setError = (error: string) => patch({ error });
  const setAppCapabilities = (appCapabilities: McpUiAppCapabilities | undefined) =>
    patch({ appCapabilities });
  const plane = createPluginUiPagePlane({
    onVisibility(visible) {
      if (page.visible !== visible) pluginUiPages.visibility(page, visible);
      if (visible) ensure();
      syncExecution();
    },
    onCrash() {
      void page.suspend(true);
      patch({ phase: "error", error: "MCP App page stopped" });
    },
  });
  /**
   * F18（上游 a60ba6a7）：声明保留且运行中的页面隐藏时保持执行表面；启动阶段
   * （尚未 running）也需要表面完成首次挂载。本仓不移植上游 Main 侧 guest 节流
   * 通道（依赖上游 browserView activity 框架），执行表面由 renderer plane 承担。
   */
  function syncExecution() {
    const active =
      controller !== null && snapshot.handle?.resourceMeta?.backgroundRetention === true;
    plane.setExecutionActive(active || (controller !== null && snapshot.phase !== "running"));
  }
  // F18：窗口恢复可见且有锚点时重建被回收页面；可见性切换同步执行表面。
  const onWindowVisibility = () => {
    if (!document.hidden && plane.hasVisibleAnchor()) void ensure();
    syncExecution();
  };
  document.addEventListener("visibilitychange", onWindowVisibility);
  async function ensure() {
    if (disposed || controller || starting || snapshot.phase === "error") return;
    starting = true;
    const epoch = ++incarnation;
    try {
      await releasing;
      if (disposed || epoch !== incarnation) return;
      await pluginUiPages.reserve(page);
    } catch (error) {
      starting = false;
      patch({ phase: "error", error: String(error) });
      return;
    }
    if (disposed || epoch !== incarnation) {
      pluginUiPages.released(page);
      return;
    }
    starting = false;
    try {
      // 页面独立持有已有 workspace 连接租约；卡片或 pane 退出不会让后台页面失联。
      const connection = acquireWorkspaceConnection(
        latest.current.scope,
        services.zodyAgentService,
        platform.createLocalMediaPreviewUrl,
      );
      releaseLease = () => connection.release();
      const lease = connection.layer.acquire(latest.current.scope.sessionId);
      const runtimeStopped = () => {
        void page.suspend(true);
        patch({ phase: "error", error: "MCP App runtime is no longer available" });
      };
      const offRestart = connection.transport.onRuntimeRestart(runtimeStopped);
      const offLifecycle = connection.transport.onRuntimeLifecycle?.((state) => {
        if (state === "unavailable") runtimeStopped();
      });
      releaseLease = () => {
        offRestart();
        offLifecycle?.();
        lease.release();
        connection.release();
      };
      releaseFeed = attachPluginUiResourceDeltaFeed(lease.store, latest.current.scope);
      patch({ phase: "preparing", error: null, handle: null });
      createController();
    } catch (error) {
      void page.suspend(true);
      patch({ phase: "error", error: String(error) });
    }
  }
  function createController() {
    // F18：静态 deps（hostContext / 平台交互 / 能力声明 / 回调转发）拆至
    // pluginUiControllerDeps 以满足架构文件行数上限；行为与拆出前一致。
    const nextController = createPluginUiHostController({
      ...buildPluginUiControllerDeps({
        bridge,
        services,
        platform,
        sandboxPlatform,
        latest,
        surfaceKey,
        getInstance: () => {
          if (!snapshot.handle) throw new Error("MCP App is not prepared");
          return snapshot.handle.instance;
        },
      }),
      onPhase: (next, detail) => {
        if (controller !== nextController) return;
        // 生命周期事件每个沙箱只有几条，走 lifecycle 才能进主日志（排查用户现场用）。
        logger.lifecycle.info("[plugin-ui] lifecycle", {
          phase: next,
          sessionId: latest.current.scope.sessionId,
          pluginId: latest.current.presentation.pluginId,
          scopeId: buildPluginSandboxScopeId(latest.current.scope.scope),
          ...(detail?.error ? { error: detail.error } : {}),
        });
        if (next === "error") {
          void page.suspend(true);
          patch({ phase: "error", error: detail?.error ?? "MCP App failed" });
          return;
        }
        setPhase(next);
        if (detail?.handle) {
          setHandle(detail.handle);
          // 资源声明的初始高度替代固定 240；仍受 min / max clamp。
          const hint = detail.handle.resourceMeta?.heightHint;
          if (hint !== undefined) setHeight(clampCardHeight(hint, detail.handle));
          // 资源声明的浏览器权限随句柄到达（早于端口），进 hostContext 让页面 feature detect（规范草案 `permissions`）。
          const permissions = detail.handle.resourceMeta?.permissions;
          if (permissions?.length) {
            nextController.updateHostContext({
              permissions: Object.fromEntries(permissions.map((item) => [item, {}])),
            });
          }
        }
        if (detail?.error) setError(detail.error);
      },
      onInstanceClosed: () => {
        void page.suspend(true);
        clearPluginUiWidgetState(key);
        patch({ phase: "error", error: "MCP App connection is no longer available" });
      },
      onBusyChange: () => {
        if (controller === nextController) pluginUiPages.settled(page);
      },
      onAppCapabilities: setAppCapabilities,
      onHeight: (next) => setHeight(clampCardHeight(next, snapshot.handle)),
      onDisplayModeRequest: (mode) => latest.current.onDisplayModeRequest?.(mode) ?? mode,
      onOpenExternal: (url) => latest.current.onOpenExternal?.(url),
      log: (message, detail) => logger.warn(message, detail),
    });

    controller = nextController;
    controller.start();
  }
  const task = buildPluginUiSessionKey(input.scope);
  const workspaceEvents = services.zodyTaskService.onDynamicWorkspaceEvent({
    workspacePath: input.scope.workspacePath,
    workspaceIdentity: input.scope.workspaceIdentity,
  })((event) => {
    if (
      event.type === "workspace_task_list_changed" &&
      event.reason === "task_deleted" &&
      event.taskId === input.scope.sessionId
    )
      pluginUiPages.removeTask(task);
  });
  const page: Page = {
    kind: "mcp",
    key,
    task,
    visible: false,
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    busy: () => controller?.isBusy() ?? false,
    running: () => controller !== null || starting,
    bind(node, sidebar) {
      const off = plane.bind({
        node,
        kind: sidebar ? "sidebar" : "inline",
        container: node.closest<HTMLElement>("[data-sandbox-page-container]") ?? undefined,
      });
      ensure();
      return off;
    },
    update(next) {
      // 背景内联锚点不能覆盖侧栏当前的交互上下文。
      if (next.enabled === false) return;
      latest.current = next;
      const nextContextInputs = JSON.stringify([
        next.theme,
        next.locale,
        next.displayMode,
        next.width,
        next.titleBar,
        next.availableDisplayModes,
      ]);
      if (nextContextInputs !== contextInputs) {
        contextInputs = nextContextInputs;
        const context = buildPluginUiHostContext({
          theme: next.theme,
          locale: next.locale,
          displayMode: next.displayMode,
          width: next.width,
          titleBar: next.titleBar,
          availableDisplayModes: next.availableDisplayModes,
          styleVariables: readPluginUiStyleVariables(),
        });
        const contextKey = JSON.stringify(context);
        if (contextKey !== lastContext) {
          lastContext = contextKey;
          controller?.updateHostContext(context);
        }
      }
      const feed = JSON.stringify([
        next.toolCallId,
        next.toolInput,
        next.toolResult,
        next.toolCancelled,
      ]);
      if (feed !== lastFeed) {
        lastFeed = feed;
        if (next.toolInput) controller?.notifyToolInput({ arguments: next.toolInput });
        if (next.toolResult) controller?.notifyToolResult(next.toolResult);
        if (next.toolCancelled) controller?.notifyToolCancelled();
      }
      // F18（上游 a60ba6a7）：带工具调用的 feed 变化视为页面活动，刷新保留策略的闲置计时。
      const activityKey = JSON.stringify([
        next.toolCallId,
        next.toolInput,
        next.toolResult,
        next.toolCancelled,
      ]);
      if (next.toolCallId && activityKey !== activityFeed) {
        activityFeed = activityKey;
        pluginUiPages.activity(page);
      }
    },
    async suspend(force = false) {
      if (!force) {
        // F18（上游 a60ba6a7）：回收前先经保留策略 claim 预占（默认页直接放行，声明页在
        // 4/30 边界内被拒绝）；裁决完成或被拒后 finally 释放预占，不另建第二条裁决路径。
        if (recycling) return recycling;
        if (starting || !pluginUiPages.claimRecycle(page)) return false;
        const candidate = controller;
        const attempt = (async () => {
          if (candidate && !(await candidate.tryRecycle().catch(() => false))) return false;
          // Agent 原子裁决 busy/审批；等待期间被重载或删除的旧 controller 不得释放新实例。
          if (candidate !== controller || disposed) return false;
          await page.suspend(true);
          // 裁决期间用户可能重新打开；旧凭证已撤销，必须从同一 owner 重建（§12.2.8）。
          if (!document.hidden && !disposed && plane.hasVisibleAnchor()) void ensure();
          return true;
        })();
        recycling = attempt;
        try {
          return await attempt;
        } finally {
          if (recycling === attempt) recycling = undefined;
          pluginUiPages.finishRecycle(page);
        }
      }
      incarnation++;
      starting = false;
      const previous = controller;
      controller = null;
      // F18：隐藏执行表面随代际撤销，不跨代继承。
      plane.setExecutionActive(false);
      const previousHandle = snapshot.handle;
      const offFeed = releaseFeed,
        offLease = releaseLease;
      releaseFeed = undefined;
      releaseLease = undefined;
      patch({ phase: "idle", handle: null, appCapabilities: undefined });
      // 先前释放未完成时不能重新预备；反复重试也只等待同一个释放链。
      // Main 主动导航到 about:blank 会触发 navigation；先解除旧代际观察，避免回收被误报为崩溃。
      if (previousHandle) plane.prepareUnmount(previousHandle.sandboxId);
      const closing = previous?.dispose();
      releasing = Promise.all([releasing, closing]).then(() => {
        if (previousHandle) plane.unmount(previousHandle.sandboxId);
        offFeed?.();
        offLease?.();
        pluginUiPages.released(page);
      });
      await releasing;
      return true;
    },
    destroy() {
      document.removeEventListener("visibilitychange", onWindowVisibility);
      workspaceEvents.dispose();
      clearPluginUiSurfaceFeed(key);
      disposed = true;
      void page.suspend(true).finally(() => plane.dispose());
      clearPluginUiWidgetState(key);
      listeners.clear();
    },
  };
  return page;
}

/** 卡片高度 clamp：下限取资源 `minFrameHeight` 与宿主最小值的较大者，上限固定。 */
function clampCardHeight(next: number, handle: PluginSandboxHandle | null): number {
  const min = Math.max(PLUGIN_UI_CARD_MIN_HEIGHT_PX, handle?.resourceMeta?.minFrameHeight ?? 0);
  return Math.min(PLUGIN_UI_CARD_MAX_HEIGHT_PX, Math.max(min, next));
}
