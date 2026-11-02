import { useEffect } from "react";
import { ZCODE_DATA_ROOT_DIR_NAME } from "@zody/shared";
import type { IFileWatcherService } from "@zody/services";
import { logger } from "@/logger.js";

const WATCH_DEBOUNCE_MS = 300;

/** Preserve the workspace's Windows or POSIX path separator. */
function projectDirectories(workspacePath: string): string[] {
  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  return [ZCODE_DATA_ROOT_DIR_NAME, ".zcode"].map(
    (root) => `${trimmed}${separator}${root}${separator}workflows`,
  );
}

/** The Agent owns the merged list; directory events only invalidate that projection. */
export function useSavedWorkflowsDirectoryWatch({
  fileWatcherService,
  workspacePath,
  directory,
  enabled,
  refresh,
}: {
  fileWatcherService: IFileWatcherService;
  workspacePath?: string | null | undefined;
  directory?: string | null | undefined;
  enabled: boolean;
  refresh: (options: { bypassCache?: boolean }) => Promise<void>;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const directories = directory
      ? [directory]
      : workspacePath
        ? projectDirectories(workspacePath)
        : [];
    let disposed = false;
    const watchers: Array<{ id: string; subscription: { dispose: () => void } }> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    for (const path of directories) {
      void fileWatcherService
        .watch({ path })
        .then(({ id }) => {
          // 修复依据：双目录监听或远程重连的 watch 可在 effect 清理之后返回，必须释放迟到结果。
          if (disposed) {
            void fileWatcherService.unwatch({ id });
            return;
          }
          const subscription = fileWatcherService.onDynamicChange(id)(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              timer = null;
              void refresh({ bypassCache: true });
            }, WATCH_DEBOUNCE_MS);
          });
          watchers.push({ id, subscription });
        })
        .catch((error: unknown) => {
          logger.debug("[SavedWorkflows] 监听工作流目录失败（目录可能尚不存在）", {
            path,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const { id, subscription } of watchers) {
        subscription.dispose();
        void fileWatcherService.unwatch({ id });
      }
    };
  }, [enabled, fileWatcherService, refresh, workspacePath, directory]);
}
