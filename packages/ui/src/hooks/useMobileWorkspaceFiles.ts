import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileTargetRef } from "@zody/shared";
import type { FileEntry } from "@zody/shared";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { getPathLeaf } from "@/lib/path.js";
import { isWorkspaceFilePathInside } from "@/workspace-file-tree/model.js";
import { getMobileFileBrowserParentDirectory } from "@/mobileFileBrowserModel.js";
import { saveMobileOriginalFile } from "@/mobileFileBrowserSave.js";

export interface MobileFileBrowserOpenRequest {
  id: number;
  target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
    revealPath?: string;
    temporaryExternalDirectory?: boolean;
  };
}

const MOBILE_DIRECTORY_BUDGET = { maxEntries: 5_000, maxResponseBytes: 1024 * 1024 } as const;

// MF05 后错误判定统一收敛在 mobileFileBrowserModel；这里保留原导出以免既有引用入口失效。
export {
  createMobileFileDirectoryTooLargeError,
  isMobileFileDirectoryTooLargeError,
  isMobileFileExternalDirectoryUnsupported,
} from "@/mobileFileBrowserModel.js";

export function useMobileWorkspaceFiles({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  target,
  openRequest,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  target?: MobileTargetRef;
  openRequest?: MobileFileBrowserOpenRequest | null;
}) {
  const platform = useOptionalPlatform();
  const { fileService, fileWatcherService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const [viewDirectory, setViewDirectory] = useState(workspacePath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const targetGenerationRef = useRef(0);
  const directoryReadGenerationRef = useRef(0);
  const lastNavigationRequestIdRef = useRef<number | null>(null);
  // MF08: 保存（远端分块读取 + 原生写入）同一时间只允许一个；ref 指向当前有效的取消控制器。
  const saveAbortControllerRef = useRef<AbortController | null>(null);
  const targetKey = target
    ? `${target.backendId}:${target.workspaceKey}:${target.remoteSessionId ?? ""}`
    : `${workspaceIdentity?.trim() || workspacePath}:${workspaceRemoteSessionId ?? ""}`;
  const targetIsConsistent =
    !target ||
    (target.workspacePath === workspacePath &&
      target.workspaceIdentity === workspaceIdentity &&
      target.remoteSessionId === workspaceRemoteSessionId);
  const openRequestWorkspaceMatches =
    openRequest?.target.workspacePath === workspacePath &&
    openRequest.target.workspaceIdentity === workspaceIdentity &&
    openRequest.target.workspaceRemoteSessionId === workspaceRemoteSessionId;

  const loadDirectory = useCallback(
    async (path: string) => {
      const targetGeneration = targetGenerationRef.current;
      const directoryReadGeneration = ++directoryReadGenerationRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await fileService.readdir({
          path,
          includeHidden: true,
          mobileBudget: MOBILE_DIRECTORY_BUDGET,
        });
        if (
          targetGeneration !== targetGenerationRef.current ||
          directoryReadGeneration !== directoryReadGenerationRef.current
        )
          return;
        setEntries(result);
      } catch (nextError) {
        if (
          targetGeneration !== targetGenerationRef.current ||
          directoryReadGeneration !== directoryReadGenerationRef.current
        )
          return;
        setError(nextError);
      } finally {
        if (
          targetGeneration === targetGenerationRef.current &&
          directoryReadGeneration === directoryReadGenerationRef.current
        )
          setLoading(false);
      }
    },
    [fileService],
  );

  useEffect(() => {
    targetGenerationRef.current += 1;
    directoryReadGenerationRef.current += 1;
    lastNavigationRequestIdRef.current = null;
    // MF08: 切换目标/根路径时旧目标的分块读取没有意义，取消后不会再把旧文件交给保存通道。
    saveAbortControllerRef.current?.abort();
    saveAbortControllerRef.current = null;
    setPreviewPath(null);
    setViewDirectory(workspacePath);
    setEntries([]);
    setError(null);
    setLoading(false);
    setSaving(false);
  }, [targetKey, workspacePath]);

  useEffect(() => {
    if (!targetIsConsistent) {
      setError(new Error("UNSUPPORTED_EXTERNAL_DIRECTORY"));
      return;
    }
    void loadDirectory(viewDirectory);
  }, [loadDirectory, targetIsConsistent, viewDirectory]);

  useEffect(() => {
    if (!targetIsConsistent) return;
    let disposed = false;
    let watcherId: string | null = null;
    let subscription: { dispose(): void } | null = null;
    void fileWatcherService
      .watch({ path: viewDirectory })
      .then(({ id }) => {
        if (disposed) {
          void fileWatcherService.unwatch({ id }).catch(() => {});
          return;
        }
        watcherId = id;
        subscription = fileWatcherService.onDynamicChange(id)((event) => {
          if (event.dirPath === viewDirectory) void loadDirectory(viewDirectory);
        });
      })
      .catch(() => {
        // Explicit refresh remains available on filesystems that do not support watching.
      });
    return () => {
      disposed = true;
      subscription?.dispose();
      if (watcherId) void fileWatcherService.unwatch({ id: watcherId }).catch(() => {});
    };
  }, [fileWatcherService, loadDirectory, targetIsConsistent, viewDirectory]);

  useEffect(() => {
    if (
      !targetIsConsistent ||
      !openRequest ||
      openRequest.id === lastNavigationRequestIdRef.current ||
      openRequest.target.workspacePath !== workspacePath
    )
      return;
    lastNavigationRequestIdRef.current = openRequest.id;
    if (!openRequestWorkspaceMatches) {
      setError(new Error("UNSUPPORTED_EXTERNAL_DIRECTORY"));
      return;
    }
    const revealPath = openRequest.target.revealPath;
    if (!revealPath) return;
    if (
      openRequest.target.temporaryExternalDirectory ||
      !isWorkspaceFilePathInside(workspacePath, revealPath)
    ) {
      setError(new Error("UNSUPPORTED_EXTERNAL_DIRECTORY"));
      return;
    }
    let cancelled = false;
    void fileService
      .stat({ path: revealPath })
      .then((stat) => {
        if (cancelled) return;
        if (stat.type === "directory") {
          setPreviewPath(null);
          setViewDirectory(revealPath);
        } else {
          setPreviewPath(revealPath);
          setViewDirectory(
            getMobileFileBrowserParentDirectory(revealPath, workspacePath) ?? workspacePath,
          );
        }
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError);
      });
    return () => {
      cancelled = true;
    };
  }, [
    fileService,
    openRequest,
    openRequestWorkspaceMatches,
    targetIsConsistent,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);

  const navigateToDirectory = useCallback((path: string) => {
    setPreviewPath(null);
    setViewDirectory(path);
  }, []);

  const saveOriginal = useCallback(async () => {
    if (!previewPath || !platform?.saveFile || saving) return;
    // MF08: 两次调用落在同一渲染闭包（saving 闭包值仍是 false）时，新保存开始前先取消旧读取，
    // 避免两个分块读取并发占用远端 range 通道并互相覆盖保存结果。
    saveAbortControllerRef.current?.abort();
    const controller = new AbortController();
    saveAbortControllerRef.current = controller;
    setSaving(true);
    try {
      return await saveMobileOriginalFile({
        fileService,
        platform,
        path: previewPath,
        suggestedName: getPathLeaf(previewPath),
        signal: controller.signal,
      });
    } finally {
      // 只有当前保存（未被新保存取代）才恢复可保存状态；被取代的旧保存由新保存负责收尾。
      if (saveAbortControllerRef.current === controller) {
        saveAbortControllerRef.current = null;
        setSaving(false);
      }
    }
  }, [fileService, platform, previewPath, saving]);

  const cancelSave = useCallback(() => {
    // MF08: spec 要求保存进行中必须提供取消入口；读取阶段取消后不会调用 platform.saveFile，
    // 原生侧因此不会建立下载会话，Downloads 不会留下半成品。
    saveAbortControllerRef.current?.abort();
  }, []);

  const refresh = useCallback(() => loadDirectory(viewDirectory), [loadDirectory, viewDirectory]);

  return {
    cancelSave,
    entries,
    error,
    isTargetConsistent: targetIsConsistent,
    loading,
    navigateToDirectory,
    previewPath,
    refresh,
    saveOriginal,
    saving,
    setPreviewPath,
    viewDirectory,
    canSaveOriginal: Boolean(platform?.saveFile),
  };
}
