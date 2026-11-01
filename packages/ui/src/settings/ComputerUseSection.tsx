// 设置页「电脑控制 (Computer Use)」分区（呈现规则见 specs/computer-use-settings-unification.md）：
//  - 构建能力（GetCuaCapability）驱动呈现：占位构建整卡说明「此构建不含」，narrow 构建渲染开关。
//  - 总开关：开/关 zcode-cua 插件（连带其 MCP server 与 skill 一起启用/禁用）。
//  - narrow 构建的权限区是说明性信息：单窗口截图的屏幕录制权限由 macOS 在首次使用时请求。
//    旧 Helper 状态行 / 授权引导 / 重启链随占位实现一并移除（其底层在 zody 恒 fail-closed，
//    只会制造「未知 + 点了没反应」的失真呈现）；接入窄链 Helper 的真实状态查询属 phase1 收尾。
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CuaOsSupport, RemoteTarget } from "@zcode/shared";
import {
  DesktopCommandIds,
  isRemoteWorkspaceIdentity,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { Switch } from "@/components/ui/switch.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCuaBuildCapability } from "@/hooks/useCuaBuildCapability.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { supportsLocalMacCuaPermissionOnboarding } from "@/lib/cuaPlatform.js";
import { runAfterSuccessfulPluginEnabledChange } from "@/settings/pluginEnabledChange.js";
import {
  isComputerUseRemoteOrLinux,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";

interface ComputerUseSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
}

export function ComputerUseSection({
  isDesktop = false,
  isMacDesktop,
  isWindowsDesktop = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
}: ComputerUseSectionProps) {
  const { intl } = useZCodeIntl();
  const pluginManagementService = useServices().pluginManagementService;
  const platform = usePlatform();
  const isLocalWorkspace =
    !remoteSessionId &&
    !remoteTarget &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));
  // Windows 只复用插件总开关；macOS 才具备 TCC 权限与附加说明能力。
  const supportsLocalMacWorkspace =
    !isWindowsDesktop &&
    (isMacDesktop ?? supportsLocalMacCuaPermissionOnboarding(platform)) &&
    isLocalWorkspace;
  const supportsLocalWindowsWorkspace = isWindowsDesktop && isLocalWorkspace;
  const supportsComputerUseSettings = supportsLocalMacWorkspace || supportsLocalWindowsWorkspace;
  const availability = resolveComputerUseAvailability({
    isDesktop: isDesktop || isWindowsDesktop || supportsLocalMacWorkspace,
    isMacDesktop: isMacDesktop || supportsLocalMacWorkspace,
    isWindowsDesktop,
    remoteSessionId,
    remoteTarget,
    workspaceIdentity,
  });
  // 构建能力事实的唯一来源是 desktop Main 的 GetCuaCapability；renderer 不自行推断，
  // 查询失败或形状不合法一律按占位呈现（fail-closed）。
  const capability = useCuaBuildCapability();
  const isNarrowBuild = capability?.kind === "narrow";

  // macOS 版本门槛：低于承诺地板时整卡替换为升级提示（Helper 无法在低版本系统上启动）。
  // 查询一次主进程判定（GetCuaOsSupport）；失败按无门槛处理，不阻塞设置页。
  const [osSupport, setOsSupport] = useState<CuaOsSupport | null>(null);
  useEffect(() => {
    if (
      !isNarrowBuild ||
      !supportsLocalMacWorkspace ||
      typeof platform.executeDesktopCommand !== "function"
    )
      return;
    let cancelled = false;
    void platform
      .executeDesktopCommand(DesktopCommandIds.GetCuaOsSupport)
      .then((result) => {
        if (!cancelled) setOsSupport(result as CuaOsSupport);
      })
      .catch(() => {
        /* 查询失败按无门槛处理，不阻塞设置页 */
      });
    return () => {
      cancelled = true;
    };
  }, [isNarrowBuild, supportsLocalMacWorkspace, platform]);

  const macOsBelowCuaFloor = osSupport?.kind === "macos-below-minimum";

  // 总开关 = zcode-cua 插件启用态（读自插件管理 store；切换即同步启用/禁用插件及其 MCP + skill）。
  const plugins = usePluginManagementStore((state) => state.plugins);
  const setPluginEnabled = usePluginManagementStore((state) => state.setEnabled);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const cuaEnabled = cuaPlugin?.enabled ?? false;
  const cuaToggling = togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID;

  const initRef = useRef(false);
  useEffect(() => {
    if (
      initRef.current ||
      !isNarrowBuild ||
      !supportsComputerUseSettings ||
      !workspacePath ||
      !pluginManagementService
    )
      return;
    initRef.current = true;
    // 复用 Plugins 分区同一条初始化路径，确保 store 已加载 zcode-cua 的 enabled 态。
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    isNarrowBuild,
    supportsComputerUseSettings,
    workspacePath,
    workspaceIdentity,
    pluginManagementService,
    initializePlugins,
  ]);

  // 卸载守卫：异步切换完成时若组件已卸载，跳过 setState 并作废在途操作代次。
  const mountedRef = useRef(true);
  const pluginToggleGenerationRef = useRef(0);
  const pluginToggleContextKey = [
    workspacePath ?? "",
    workspaceIdentity ?? "",
    remoteSessionId ?? "",
    remoteTarget ? "remote" : "local",
  ].join("\u0000");
  const pluginToggleContextKeyRef = useRef(pluginToggleContextKey);
  pluginToggleContextKeyRef.current = pluginToggleContextKey;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pluginToggleGenerationRef.current += 1;
    };
  }, []);

  const onTogglePlugin = useCallback(
    async (next: boolean) => {
      if (!pluginManagementService) return;
      const operationGeneration = ++pluginToggleGenerationRef.current;
      const operationContextKey = pluginToggleContextKey;
      // 切换 zcode-cua 插件 = 同步其 MCP server + skill 一起启用/禁用。
      const completed = await runAfterSuccessfulPluginEnabledChange({
        submit: () => setPluginEnabled(ZCODE_CUA_OFFICIAL_PLUGIN_ID, next, pluginManagementService),
        isCurrent: () =>
          mountedRef.current &&
          pluginToggleGenerationRef.current === operationGeneration &&
          pluginToggleContextKeyRef.current === operationContextKey,
        onSuccess: () => {
          if (!next) {
            toast(intl.formatMessage({ id: "settings.computerUse.disabledToast" }));
          }
        },
      });
      if (!completed && mountedRef.current) {
        const message = usePluginManagementStore.getState().error;
        if (message) {
          toast(message);
        }
      }
    },
    [pluginManagementService, pluginToggleContextKey, setPluginEnabled, intl],
  );

  // 输入框常驻入口的显隐。隐藏开关用 useSettings().update 写入
  // （直连 settingService 只落盘不刷新共享 snapshot，输入框按钮读不到新值）。
  // 乐观更新本地开关，失败回滚并提示。
  const { settings: appSettings, update: updateAppSettings } = useSettings();
  const [composerEntryHiddenOverride, setComposerEntryHiddenOverride] = useState<boolean | null>(
    null,
  );
  const [composerEntrySaving, setComposerEntrySaving] = useState(false);
  // 默认隐藏，与 useCuaComposerEntry 同口径：只有显式存过 false 才算展示。
  // 两处必须一致，否则设置页开关的显示状态会和输入框按钮的实际显隐对不上。
  const persistedComposerEntryHidden = appSettings?.computerUseComposerEntryHidden !== false;
  const composerEntryVisible = !(composerEntryHiddenOverride ?? persistedComposerEntryHidden);
  useEffect(() => {
    if (composerEntryHiddenOverride === null) return;
    if (persistedComposerEntryHidden === composerEntryHiddenOverride) {
      setComposerEntryHiddenOverride(null);
    }
  }, [composerEntryHiddenOverride, persistedComposerEntryHidden]);
  const onToggleComposerEntry = useCallback(
    async (visible: boolean) => {
      const nextHidden = !visible;
      setComposerEntryHiddenOverride(nextHidden);
      setComposerEntrySaving(true);
      try {
        await updateAppSettings({ computerUseComposerEntryHidden: nextHidden });
      } catch (error) {
        if (mountedRef.current) {
          setComposerEntryHiddenOverride(null);
          toast(
            intl.formatMessage(
              { id: "settings.computerUse.composerEntry.saveFailed" },
              { error: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      } finally {
        if (mountedRef.current) setComposerEntrySaving(false);
      }
    },
    [intl, updateAppSettings],
  );

  if (!supportsComputerUseSettings) {
    // 远端 / Linux 环境若直接 return null，设置页只剩标题，会让用户误以为页面加载失败。
    // 保留入口并明确能力边界，且不渲染任何会触发本地 CUA 写操作的控件。
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-ui-base text-warning">
        <p className="font-medium">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.title" })}
        </p>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: isComputerUseRemoteOrLinux(availability)
              ? availability.kind === "local-linux"
                ? "settings.computerUse.unsupported.linuxDescription"
                : "settings.computerUse.unsupported.remoteDescription"
              : "settings.computerUse.unsupported.remoteDescription",
          })}
        </p>
      </div>
    );
  }

  // 能力信号在途：宁空勿错——占位卡与开关之间闪跳会被当成界面坏了。
  if (!capability) return null;

  if (capability.kind === "placeholder") {
    // 占位构建（本构建不含 CUA runtime）：如实说明边界，不渲染开关与权限行。
    // 摆一个点了没反应的开关比没有开关更糟，这正是 0.1.0 隐藏入口的原因；
    // 现改为保留入口 + 如实告知，见 specs/computer-use-settings-unification.md。
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-ui-base text-warning">
        <p className="font-medium">
          {intl.formatMessage({ id: "settings.computerUse.buildUnavailable.title" })}
        </p>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.computerUse.buildUnavailable.description" })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 窄链能力边界：开关只管插件面（skill/输入框入口/node_repl CUA 文档面），
          不控制窄链 eligibility；条件不满足时会话自动回退普通 Agent，CUA 不可用。 */}
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.computerUse.narrowCapabilityDescription" })}
      </p>
      {/* 总开关：开/关 zcode-cua 插件（同步其 MCP + skill） */}
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
          description={intl.formatMessage({
            id: "settings.computerUse.toggleDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.toggleLabel",
              })}
              checked={cuaEnabled}
              disabled={cuaToggling || !workspacePath}
              onCheckedChange={(checked) => void onTogglePlugin(checked)}
            />
          }
        />
        {/* 输入框常驻入口的显隐开关：关闭是持久化 hidden 标记，
            重启与版本更新都不会自愈。只管按钮渲不渲染，不影响插件启用态与进行中任务。
            电脑控制关闭时按钮无论如何都不渲染（cuaComposerEntryState 的插件门），
            此时把开关置灰并改文案说明前置条件——留一个可点却看不到效果的开关会被当成坏了。 */}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
          description={intl.formatMessage({
            id: cuaEnabled
              ? "settings.computerUse.composerEntry.description"
              : "settings.computerUse.composerEntry.requiresEnabled",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.composerEntry.label",
              })}
              checked={composerEntryVisible}
              disabled={composerEntrySaving || !cuaEnabled}
              onCheckedChange={(checked) => void onToggleComposerEntry(checked)}
            />
          }
        />
      </SettingsGroupCard>

      {/* CUA 未启用时隐藏下方说明，只留总开关，避免一堆无意义配置项。 */}
      {cuaEnabled && supportsLocalMacWorkspace && macOsBelowCuaFloor ? (
        /* macOS 版本低于承诺地板：Helper 无法启动，整卡替换为升级提示。 */
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          <p className="font-medium">
            {intl.formatMessage(
              { id: "cuaPermission.osFloorTitle" },
              {
                minimum: osSupport?.minimumMacOs ?? "12.0",
                current: osSupport?.currentMacOs ?? "12 以下",
              },
            )}
          </p>
          <p>{intl.formatMessage({ id: "cuaPermission.osFloorDescription" })}</p>
        </div>
      ) : null}
      {cuaEnabled && supportsLocalMacWorkspace && !macOsBelowCuaFloor ? (
        <SettingsGroupCard>
          {/* 窄链只有单窗口截图一个工具面：屏幕录制权限由 macOS 在首次截图时按需请求，
              不存在预授权引导或状态查询（旧 Helper 的占位链已移除，见文件头注释）。 */}
            <SettingsRow
              controlLayout="wide"
              label={intl.formatMessage({ id: "cuaPermission.perm.screenRecording" })}
              description={intl.formatMessage({
                id: "settings.computerUse.narrowPermissionNote",
              })}
              /* 说明行：无控件（ReactNode 允许 null），右侧留白。 */
              control={null}
            />
        </SettingsGroupCard>
      ) : null}
    </div>
  );
}
