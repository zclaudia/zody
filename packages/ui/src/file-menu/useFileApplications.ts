import { useCallback, useEffect, useRef, useState } from "react";
import type { FileApplicationInfo, FileApplicationTarget } from "@zody/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/**
 * 系统关联应用的 renderer 查询/打开状态唯一所有者
 * （upstream v3.17.1 file-menu/useFileApplications，来源 SHA a60ba6a7；
 * 产品规则见 docs/ui/file-open-apps.md）。
 *
 * - 应用列表属于当前目标和当次查询：切换 path/workspaceIdentity 后旧结果失效；
 *   请求序号保证只有最新请求的响应能落进状态（卡片虚拟行重用防串台）。
 * - UI 只维护查询与忙碌状态，不持有 task/session/stream 状态。
 * - 与上游差异：本仓 platform 无 canOpenLocalFiles 能力位，可用性判断改为
 *   两个可选方法（getFileApplications/openFileWithApplication）的存在性。
 */
export function useFileApplications(target: FileApplicationTarget | null, isRemote = false) {
  const platform = usePlatform();
  const { intl } = useZodyIntl();
  const key = target ? `${target.path}\u0000${target.workspaceIdentity ?? ""}` : "";
  const targetRef = useRef(target);
  targetRef.current = target;
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const getFileApplications = platform.getFileApplications;
  const currentKey = useRef(key);
  currentKey.current = key;
  const request = useRef(0);
  const [state, setState] = useState<{
    key: string;
    apps: FileApplicationInfo[];
    loading: boolean;
  }>({
    key: "",
    apps: [],
    loading: false,
  });
  const available = Boolean(
    target?.pathKind === "file" &&
    !isRemote &&
    platform.getFileApplications &&
    platform.openFileWithApplication,
  );
  useEffect(
    () => () => {
      request.current += 1;
    },
    [key, available],
  );
  const load = useCallback(async () => {
    const currentTarget = targetRef.current;
    if (!available || !currentTarget || !getFileApplications) return;
    const id = ++request.current;
    setState({ key, apps: [], loading: true });
    try {
      const apps = await getFileApplications(currentTarget);
      if (request.current !== id || currentKey.current !== key) return;
      setState({
        key,
        apps: [...apps].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
        loading: false,
      });
    } catch (error) {
      if (request.current !== id || currentKey.current !== key) return;
      setState({ key, apps: [], loading: false });
      logger.warn("[FileApplications] 获取系统关联应用失败", {
        path: currentTarget.path,
        error: String(error),
      });
    }
  }, [available, key, getFileApplications]);
  const apps = state.key === key && available ? state.apps : [];
  const defaultApplication = apps.find((app) => app.isDefault) ?? null;
  const open = useCallback(
    async (app: FileApplicationInfo) => {
      const currentTarget = targetRef.current;
      const currentPlatform = platformRef.current;
      if (!available || !currentTarget || !currentPlatform.openFileWithApplication) return;
      try {
        const result = await currentPlatform.openFileWithApplication(app.id, currentTarget);
        if (!result.success) throw new Error(result.error || "open_failed");
      } catch (error) {
        logger.warn("[FileApplications] 打开文件失败", {
          path: currentTarget.path,
          applicationId: app.id,
          error: String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      }
    },
    [available, intl],
  );

  return {
    available,
    apps,
    defaultApplication,
    loading: state.key === key && available && state.loading,
    load,
    open,
  };
}
