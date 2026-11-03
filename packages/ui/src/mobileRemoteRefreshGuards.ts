import { DEFAULT_REMOTE_ACCESS_NAMESPACE } from "@zcode/shared";
import { useEffect, useRef, useState } from "react";

/**
 * 手机 Remote 安全刷新的 UI guard 桥（spec 第 9.3、10、11 M3 节；M3-T1 契约）。
 *
 * 唯一所有者边界：
 * - guard 只查询既有 UI 状态（composer 草稿、pending optimistic overlay、设置草稿、
 *   弹层、未确认操作），不把状态复制到这里；
 * - 注册表实例由 `packages/web` 的 mobile bootstrap 创建并安装；普通桌面 Web 不安装，
 *   因此本模块的所有 hook 在桌面/普通 Web 上是安全的 no-op；
 * - reason 字符串必须与 M3-T1 `mobileUiRefreshGuards.ts` 的稳定集合一致。跨包不能
 *   直接引用 web 实现，故在此声明同值契约；控制器仍按自己的集合校验，未知值阻塞。
 */

export const MOBILE_REMOTE_REFRESH_GUARD_REASONS = [
  "composer-draft",
  "pending-optimistic-overlay",
  "unsaved-settings",
  "file-operation",
  "active-overlay",
  "native-operation",
  "background-task",
  "unknown-guard-state",
] as const;

export type MobileRemoteRefreshGuardReason = (typeof MOBILE_REMOTE_REFRESH_GUARD_REASONS)[number];

export interface MobileRemoteRefreshGuard {
  /** 稳定标识，仅用于诊断；允许重复注册，每个注册独立释放。 */
  id: string;
  getBlockReason(): MobileRemoteRefreshGuardReason | null;
}

export interface MobileRemoteRefreshGuardRegistryLike {
  register(guard: MobileRemoteRefreshGuard): () => void;
}

let installedRegistry: MobileRemoteRefreshGuardRegistryLike | undefined;
const registryListeners = new Set<() => void>();

function notifyRegistryListeners(): void {
  for (const listener of registryListeners) {
    try {
      listener();
    } catch {
      // 单个组件的订阅异常不能中断其它 root 的 guard 注册。
    }
  }
}

/**
 * 安装当前文档唯一的 refresh guard 注册表；返回卸载函数。
 *
 * bootstrap 在创建 `MobileUiReleaseController` 时安装一次，controller dispose 时卸载。
 * 安装/卸载都会通知已挂载的组件重新登记，因此启动界面先于业务 Root 渲染也不会漏注册。
 */
export function installMobileRemoteRefreshGuardRegistry(
  registry: MobileRemoteRefreshGuardRegistryLike | undefined,
): () => void {
  installedRegistry = registry;
  notifyRegistryListeners();
  return () => {
    if (installedRegistry !== registry) {
      return;
    }
    installedRegistry = undefined;
    notifyRegistryListeners();
  };
}

export function getMobileRemoteRefreshGuardRegistry():
  | MobileRemoteRefreshGuardRegistryLike
  | undefined {
  return installedRegistry;
}

/**
 * 把组件状态所有者登记为 refresh guard。组件卸载、id 变化或注册表被卸载时自动释放。
 * 回调通过 ref 读取最新状态，避免闭包持有过期值；升级后组件重新 render 即可反映解除。
 */
export function useMobileRemoteRefreshGuard(
  id: string,
  getBlockReason: () => MobileRemoteRefreshGuardReason | null,
): void {
  const getBlockReasonRef = useRef(getBlockReason);
  getBlockReasonRef.current = getBlockReason;
  const [registry, setRegistry] = useState<MobileRemoteRefreshGuardRegistryLike | undefined>(
    installedRegistry,
  );

  useEffect(() => {
    const sync = () => setRegistry(installedRegistry);
    sync();
    registryListeners.add(sync);
    return () => {
      registryListeners.delete(sync);
    };
  }, []);

  useEffect(() => {
    if (!registry) {
      return;
    }
    return registry.register({
      id,
      getBlockReason: () => getBlockReasonRef.current(),
    });
  }, [id, registry]);
}

/** composer 有未发送正文或附件时阻止刷新。 */
export function resolveComposerDraftBlockReason(input: {
  text: string;
  hasAttachments: boolean;
}): MobileRemoteRefreshGuardReason | null {
  return input.text.trim().length > 0 || input.hasAttachments ? "composer-draft" : null;
}

export interface MobileRemoteSettingsDraftSnapshot {
  gatewayUrl: string;
  namespace: string;
  credential: string;
}

export interface MobileRemoteSettingsInitialSnapshot {
  gatewayUrl?: string;
  namespace?: string;
  credentialConfigured: boolean;
}

/**
 * 连接设置表单与初始值不同（或重新输入了凭证）时阻止刷新。
 * 保存成功/取消后表单 reset，guard 自然解除。
 */
export function resolveUnsavedSettingsBlockReason(input: {
  current: MobileRemoteSettingsDraftSnapshot;
  initial: MobileRemoteSettingsInitialSnapshot;
}): MobileRemoteRefreshGuardReason | null {
  const currentGatewayUrl = input.current.gatewayUrl.trim();
  const initialGatewayUrl = (input.initial.gatewayUrl ?? "").trim();
  const currentNamespace = input.current.namespace.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE;
  const initialNamespace = input.initial.namespace ?? DEFAULT_REMOTE_ACCESS_NAMESPACE;
  const dirty =
    currentGatewayUrl !== initialGatewayUrl ||
    currentNamespace !== initialNamespace ||
    input.current.credential.trim().length > 0;
  return dirty ? "unsaved-settings" : null;
}

/**
 * task 列表 optimistic overlay 尚未被服务端结果收敛时阻止刷新。
 * 只读取 store 中既有的 overlay 记录，不创建副本。
 */
export function resolvePendingOptimisticOverlayBlockReason(
  workspaces: Record<string, { optimisticTaskListByTaskId: Record<string, unknown> }>,
): MobileRemoteRefreshGuardReason | null {
  for (const workspace of Object.values(workspaces)) {
    if (Object.keys(workspace.optimisticTaskListByTaskId).length > 0) {
      return "pending-optimistic-overlay";
    }
  }
  return null;
}
