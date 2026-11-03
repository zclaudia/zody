import { useEffect, useState, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { IServiceAccessor } from "@zody/services";
import type { FileEntry } from "@zody/shared";
import { FolderIcon, FolderSymlinkIcon } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { useZodyIntl } from "./i18n/IntlProvider.js";
import { logger } from "./logger.js";
import { isCoarseTouchDevice } from "./lib/pickerFocus.js";
import { getContainingDirectoryPath } from "./lib/path.js";

/**
 * 触屏态（(hover:none) and (pointer:coarse)）命中区下限的 media 前缀。
 * 与 docs/web-remote-control/mobile-viewport-input-and-touch.md D1、lib/mobileTextInput.ts:3
 * 使用同一 media 内核；不带该前缀的样式保持桌面密度不变。
 */
const TOUCH_TARGET_MEDIA = "[@media(hover:none)_and_(pointer:coarse)]";

export function createDirectoryBrowserReadParams(
  path: string,
  showHiddenDirectories: boolean,
): { path: string; includeHidden?: boolean } {
  return showHiddenDirectories ? { path, includeHidden: true } : { path };
}

/**
 * searchfile-1：返回上级目录的父路径，同时支持 POSIX 与 Windows 分隔符（含盘根处理）。
 * 旧实现 `currentPath.replace(/\/[^/]+\/?$/, "")` 只认 "/"：Windows 远控路径
 * （如 `C:\repo\sub`）匹配不到，父路径等于原路径，「..」按钮点了没有任何反应。
 * 这里抽成纯函数并复用 lib/path.ts 既有实现（盘根 `C:\repo` → `C:\`、根路径返回 null），
 * 单测覆盖 POSIX 与 Windows 两种路径形态。
 */
export function getDirectoryBrowserParentPath(path: string): string | null {
  return getContainingDirectoryPath(path);
}

export function filterDirectoryBrowserEntries(entries: FileEntry[]): FileEntry[] {
  return entries.filter((e) => e.type === "directory");
}

// 修复原因：远程目录条目已经携带 isSymbolicLink，这里只替换展示图标，不改变进入和选择目录的路径语义。
export function getDirectoryBrowserEntryIconKind(
  entry: Pick<FileEntry, "isSymbolicLink" | "type">,
): "folder" | "folder-symlink" {
  return entry.type === "directory" && entry.isSymbolicLink === true ? "folder-symlink" : "folder";
}

export function createDirectoryBrowserRequestGuard(): {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
} {
  let latestRequestId = 0;

  return {
    begin: () => {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent: (requestId: number) => requestId === latestRequestId,
  };
}

/**
 * 服务端目录浏览对话框。
 * 通过 fileService.readdir 浏览远程/本地服务器的目录结构，
 * 适用于 web 端无法调用系统原生文件选择器的场景。
 *
 * 第二批 E1：`readdir`/`initialPath` 注入供手机远控「打开其他项目」复用同一交互
 * （app 级目录列表 payload，无 workspace services 可用）；桌面路径不传时行为不变。
 */
export function DirectoryBrowser({
  services,
  onSelect,
  onCancel,
  onPathChange,
  embedded = false,
  readdir,
  initialPath,
  embeddedFooter,
}: {
  services?: IServiceAccessor;
  onSelect: (path: string) => void;
  onCancel: () => void;
  onPathChange?: (path: string) => void;
  embedded?: boolean;
  /**
   * 注入式目录读取（返回全部条目，含文件；调用方自行保持与桌面一致的语义）。
   * 提供时不再使用 `services.fileService.readdir`。
   */
  readdir?: (path: string, includeHidden: boolean) => Promise<FileEntry[]>;
  /** 提供时以该路径为起点，不查询 `services.systemService`（手机侧无 systemService）。 */
  initialPath?: string;
  /** embedded 模式的 footer 区（宿主放「确认选择」等触控操作）。 */
  embeddedFooter?: ReactNode;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [inputPath, setInputPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const showHiddenDirectoriesRef = useRef(false);
  const requestGuardRef = useRef(createDirectoryBrowserRequestGuard());
  const { intl } = useZodyIntl();
  // home-4/keyboard-3：手机端打开选择器的主流程是浏览目录而非输入路径，
  // autoFocus 会立即拉起软键盘遮住目录列表（同 GitBranchSwitcher 分支列表的既有处置）；
  // 且 iOS Safari 聚焦 <16px 输入框会触发焦点缩放。触屏态不自动聚焦、改用 16px 兼容 token；
  // 桌面端（含桌面 Web）保持 autoFocus 与 text-ui-base 不变。
  const coarseTouch = isCoarseTouchDevice();
  // perf-7：与 MobileWorkspaceFileBrowser 一致用 useVirtualizer 虚拟化目录列表；
  // 触屏态行高抬到 44px 命中区下限（D1），虚拟器行高与行内 style 必须同源，避免行间重叠。
  const directoryRowSize = coarseTouch ? 44 : 40;
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => directoryRowSize,
    overscan: 8,
  });

  // 初始化：注入式起点直接进入；桌面路径仍取 homedir。
  useEffect(() => {
    if (initialPath) {
      navigateTo(initialPath);
      return;
    }
    if (!services) {
      setLoading(false);
      return;
    }
    services.systemService
      .info()
      .then((info) => {
        navigateTo(info.homedir);
      })
      .catch((err) => {
        logger.error("[DirectoryBrowser] 获取系统信息失败:", err);
        setError(intl.formatMessage({ id: "directoryBrowser.errorSystem" }));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateTo = async (
    path: string,
    nextShowHiddenDirectories = showHiddenDirectoriesRef.current,
  ) => {
    const requestId = requestGuardRef.current.begin();
    setLoading(true);
    setError("");
    try {
      const result = readdir
        ? await readdir(path, nextShowHiddenDirectories)
        : await services!.fileService.readdir(
            createDirectoryBrowserReadParams(path, nextShowHiddenDirectories),
          );
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      const dirs = filterDirectoryBrowserEntries(result);
      setEntries(dirs);
      setCurrentPath(path);
      setInputPath(path);
      onPathChange?.(path);
      // 滚动到顶部；jsdom 不实现 scrollTo，可选调用避免测试环境把导航误判为读取失败。
      listRef.current?.scrollTo?.(0, 0);
    } catch (err) {
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      // 用户快速切换目录或隐藏目录时，较早 readdir 可能后返回；
      // 过期错误不能覆盖最新导航状态，否则 UI 会展示和当前按钮状态不一致的目录/错误。
      logger.error("[DirectoryBrowser] readdir 失败:", err);
      setError(intl.formatMessage({ id: "directoryBrowser.errorReadDir" }, { error: String(err) }));
    } finally {
      if (requestGuardRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  };

  const parentPath = getDirectoryBrowserParentPath(currentPath);

  const handleGoUp = () => {
    // searchfile-1：父目录提取走 getDirectoryBrowserParentPath（POSIX/Windows 双支持）。
    if (parentPath) navigateTo(parentPath);
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputPath.trim();
    if (trimmed) navigateTo(trimmed);
  };

  const handleToggleHiddenDirectories = () => {
    const nextShowHiddenDirectories = !showHiddenDirectoriesRef.current;
    showHiddenDirectoriesRef.current = nextShowHiddenDirectories;
    setShowHiddenDirectories(nextShowHiddenDirectories);

    if (currentPath) {
      void navigateTo(currentPath, nextShowHiddenDirectories);
    }
  };

  const handleSelectCurrentPath = () => {
    const selectedPath = currentPath.trim();
    if (!selectedPath || loading) {
      return;
    }

    onSelect(selectedPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  const browserContent = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div>
        <div className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "directoryBrowser.title" })}
        </div>

        {/* 路径输入 */}
        <form onSubmit={handleInputSubmit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="text"
            size="lg"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder={intl.formatMessage({
              id: "directoryBrowser.pathPlaceholder",
            })}
            className={`h-9 min-w-0 flex-1 ${TOUCH_TARGET_MEDIA}:h-11 ${
              // searchfile-5/home-4：触屏态用固定 16px token，避免 iOS Safari 聚焦缩放；桌面保持 text-ui-base。
              coarseTouch ? "text-mobile-input-safe leading-6" : "text-ui-base"
            }`}
            autoFocus={!coarseTouch}
          />
          <div className="flex gap-2 sm:shrink-0">
            <Button
              type="submit"
              size="lg"
              className={`h-9 min-w-0 flex-1 px-4 text-ui-base sm:flex-none ${TOUCH_TARGET_MEDIA}:h-11`}
            >
              {intl.formatMessage({ id: "directoryBrowser.go" })}
            </Button>
            <Button
              type="button"
              variant={showHiddenDirectories ? "secondary" : "outline"}
              size="lg"
              aria-pressed={showHiddenDirectories}
              className={`h-9 min-w-0 flex-1 px-3 text-ui-base sm:flex-none ${TOUCH_TARGET_MEDIA}:h-11`}
              onClick={handleToggleHiddenDirectories}
            >
              {intl.formatMessage({
                id: showHiddenDirectories
                  ? "directoryBrowser.hideHidden"
                  : "directoryBrowser.showHidden",
              })}
            </Button>
          </div>
        </form>
      </div>

      {/* 错误提示 */}
      {error ? <div className="text-ui-base text-destructive">{error}</div> : null}

      {/* 目录列表 */}
      <div
        ref={listRef}
        className="relative flex-1 flex flex-col overflow-y-auto rounded-lg border border-border bg-background"
      >
        {/* 上级目录：searchfile-1 修复后按「存在父目录」判定，Windows 路径也能显示「..」 */}
        {parentPath ? (
          <button
            onClick={handleGoUp}
            // 滚动容器是纵向 flex 布局，子项默认允许 shrink；
            // 当目录很多触发滚动时，首行“返回上级”会被压缩导致高度变化。
            className={`flex h-10 w-full shrink-0 cursor-pointer items-center gap-2 border-b border-border px-3 text-left text-ui-base transition hover:bg-hover/50 ${TOUCH_TARGET_MEDIA}:h-11`}
          >
            <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="text-foreground">..</span>
          </button>
        ) : null}

        {loading ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "directoryBrowser.noSubdirs" })}
          </div>
        ) : (
          // perf-7：node_modules 等大目录一次性渲染上千行 DOM 会造成手机明显停顿，
          // 与 MobileWorkspaceFileBrowser 一致改为 useVirtualizer 虚拟化，只渲染可视行。
          <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = entries[virtualRow.index];
              if (!entry) return null;
              const EntryIcon =
                getDirectoryBrowserEntryIconKind(entry) === "folder-symlink"
                  ? FolderSymlinkIcon
                  : FolderIcon;

              return (
                <button
                  key={entry.path}
                  onClick={() => navigateTo(entry.path)}
                  className="absolute left-0 top-0 flex w-full cursor-pointer items-center gap-2 px-3 text-left text-ui-base transition hover:bg-hover/50"
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <EntryIcon className="size-4 shrink-0 text-foreground-subtle" />
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {browserContent}
        {embeddedFooter ? (
          // searchfile-6：footer 贴近屏幕底部，消费底部安全区，避免 iOS 手势条遮挡主操作；
          // 桌面 env(safe-area-inset-bottom)=0，渲染不变。
          <div className="zcode-safe-area-bottom mt-3 flex shrink-0 justify-end gap-2">
            {embeddedFooter}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-[min(36rem,calc(100vh-4rem))] w-[min(44rem,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-popover p-4 shadow-xl">
        {browserContent}
        {/* Bugfix: 非嵌入模式之前只能继续进入子目录，没有确认当前目录的路径。
            Web 目录浏览器作为独立选择器使用时因此永远拿不到 onSelect 结果。
            这里把确认动作收口到弹窗 footer，选择当前浏览路径并交回上层。 */}
        {/* searchfile-6：footer 消费底部安全区（桌面 env=0 不变），触屏态主按钮抬到 ≥44px 命中区。 */}
        <div className="zcode-safe-area-bottom mt-3 flex shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className={`h-10 min-w-0 px-5 text-ui-base ${TOUCH_TARGET_MEDIA}:h-11`}
            onClick={onCancel}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            size="lg"
            className={`h-10 min-w-0 px-5 text-ui-base ${TOUCH_TARGET_MEDIA}:h-11`}
            disabled={!currentPath.trim() || loading}
            onClick={handleSelectCurrentPath}
          >
            {intl.formatMessage({ id: "directoryBrowser.selectDir" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
