import type { WebRemoteControlMobileNavigationIntent } from "@zody/shared";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

export type WebRemoteControlMobilePage = "home" | "chat";

/**
 * 浮层类 history 标识（走查 shell-1）：搜索/文件/通知功能浮层与目录选择器打开时压入的
 * history state 标识。iOS Safari 等没有 Android 原生返回桥的环境里，系统返回手势只能靠
 * history 条目决定“先关浮层还是退出远控页”；没有该条目时首页返回会直接退出整个页面，
 * 聊天页返回会落回首页但浮层仍盖在最上层。
 */
export type WebRemoteControlMobileOverlayHistoryEntry =
  | "search"
  | "files"
  | "notifications"
  | "workspacePicker";

const WEB_REMOTE_CONTROL_MOBILE_OVERLAY_HISTORY_ENTRIES: readonly WebRemoteControlMobileOverlayHistoryEntry[] =
  ["search", "files", "notifications", "workspacePicker"];

export type WebRemoteControlMobileSettingsHistoryEntry =
  | { view: "index" }
  | { view: "section"; section: SettingsSectionId };

interface WebRemoteControlMobileHistoryState {
  zcodeMobilePage?: WebRemoteControlMobilePage;
  zcodeMobileOverlay?: WebRemoteControlMobileOverlayHistoryEntry;
  zcodeMobileSettings?: WebRemoteControlMobileSettingsHistoryEntry;
  zcodeMobileConnectionSettings?: boolean;
}

export function isWebRemoteControlMobileChatHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).zcodeMobilePage === "chat"
  );
}

export function isWebRemoteControlMobileOverlayHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState & {
  zcodeMobileOverlay: WebRemoteControlMobileOverlayHistoryEntry;
} {
  return (
    typeof state === "object" &&
    state !== null &&
    (WEB_REMOTE_CONTROL_MOBILE_OVERLAY_HISTORY_ENTRIES as readonly unknown[]).includes(
      (state as WebRemoteControlMobileHistoryState).zcodeMobileOverlay,
    )
  );
}

export function isWebRemoteControlMobileSettingsHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState & {
  zcodeMobileSettings: WebRemoteControlMobileSettingsHistoryEntry;
} {
  if (typeof state !== "object" || state === null) return false;
  const entry = (state as WebRemoteControlMobileHistoryState).zcodeMobileSettings;
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry.view === "index" ||
      (entry.view === "section" && typeof entry.section === "string" && entry.section.length > 0))
  );
}

export function isWebRemoteControlMobileConnectionSettingsHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState & { zcodeMobileConnectionSettings: true } {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).zcodeMobileConnectionSettings === true
  );
}

/**
 * 应用设置和连接设置条目由各自表面处理，MobileShell 只能识别并忽略，
 * 不能把它们当作普通 overlay 或 home/chat 切换，避免一次返回触发两层导航。
 */
export function isWebRemoteControlMobileExternalNavigationHistoryState(state: unknown): boolean {
  return (
    isWebRemoteControlMobileSettingsHistoryState(state) ||
    isWebRemoteControlMobileConnectionSettingsHistoryState(state)
  );
}

/**
 * 浮层打开时压入一条 overlay 条目（走查 shell-1）。
 * 条目同时记录宿主页面（home/chat），刷新后 resolveInitialWebRemoteControlMobilePage 仍能恢复页面。
 * 当前已位于浮层条目上时不重复叠加，避免 history 深度虚增。
 */
export function pushWebRemoteControlMobileOverlayHistory(
  overlay: WebRemoteControlMobileOverlayHistoryEntry,
): void {
  if (typeof window === "undefined") {
    return;
  }

  if (isWebRemoteControlMobileOverlayHistoryState(window.history.state)) {
    return;
  }

  window.history.pushState(
    {
      zcodeMobilePage: isWebRemoteControlMobileChatHistoryState(window.history.state)
        ? "chat"
        : "home",
      zcodeMobileOverlay: overlay,
    },
    "",
  );
}

/**
 * UI 返回按钮 / Android 返回桥关闭浮层时回退 history，回收 overlay 条目。
 * 不回条目会留下“React 已关、history 仍在浮层上”的错位：下一次返回会落空，
 * 或在下次开浮层叠加后经系统返回错误地“复活”已关闭的浮层。
 */
export function backOutOfWebRemoteControlMobileOverlayHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!isWebRemoteControlMobileOverlayHistoryState(window.history.state)) {
    return;
  }

  window.history.back();
}

/**
 * 页面加载时清理残留的 overlay 标识：刷新会保留 history state，但浮层的 React 状态已丢。
 * 不清理的话，下一次开浮层会叠加在废条目上，系统返回时 popstate 落在废条目上会错误地
 * 重新打开旧浮层。用 replaceState 剥掉 overlay 字段、保留宿主页面标识。
 */
export function clearWebRemoteControlMobileOverlayHistoryState(): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!isWebRemoteControlMobileOverlayHistoryState(window.history.state)) {
    return;
  }

  const state = window.history.state as WebRemoteControlMobileHistoryState;
  window.history.replaceState({ zcodeMobilePage: state.zcodeMobilePage }, "");
}

export function pushWebRemoteControlMobileSettingsIndexHistory(): void {
  if (
    typeof window === "undefined" ||
    isWebRemoteControlMobileSettingsHistoryState(window.history.state)
  ) {
    return;
  }

  window.history.pushState(
    {
      zcodeMobilePage: isWebRemoteControlMobileChatHistoryState(window.history.state)
        ? "chat"
        : "home",
      zcodeMobileSettings: { view: "index" },
    },
    "",
  );
}

export function pushWebRemoteControlMobileSettingsSectionHistory(section: SettingsSectionId): void {
  if (typeof window === "undefined") return;

  const currentState = window.history.state;
  if (!isWebRemoteControlMobileSettingsHistoryState(currentState)) {
    // 显式深链也先补设置首页，保证第一次返回不是直接退出应用设置。
    pushWebRemoteControlMobileSettingsIndexHistory();
  } else if (
    currentState.zcodeMobileSettings.view === "section" &&
    currentState.zcodeMobileSettings.section === section
  ) {
    return;
  }

  const nextState = {
    zcodeMobilePage: isWebRemoteControlMobileChatHistoryState(window.history.state)
      ? ("chat" as const)
      : ("home" as const),
    zcodeMobileSettings: { view: "section" as const, section },
  };
  if (
    isWebRemoteControlMobileSettingsHistoryState(window.history.state) &&
    window.history.state.zcodeMobileSettings.view === "section"
  ) {
    // 已位于分区页时收到新的深链，替换当前分区而不是制造多层分区返回。
    window.history.replaceState(nextState, "");
    return;
  }
  window.history.pushState(nextState, "");
}

export function backOutOfWebRemoteControlMobileSettingsHistory(): void {
  if (
    typeof window === "undefined" ||
    !isWebRemoteControlMobileSettingsHistoryState(window.history.state)
  ) {
    return;
  }
  window.history.back();
}

/**
 * 旧版已连接会话内连接设置浮层的 history 标识。
 *
 * 连接设置已并入 SettingsPage 的“连接”分区，不再压入该条目；这里保留识别能力，
 * 用于升级后浏览器仍残留旧条目时不把它当作 home/chat 切换或普通浮层处理。
 */
export function pushWebRemoteControlMobileConnectionSettingsHistory(): void {
  if (
    typeof window === "undefined" ||
    isWebRemoteControlMobileConnectionSettingsHistoryState(window.history.state)
  ) {
    return;
  }

  window.history.pushState(
    {
      zcodeMobilePage: isWebRemoteControlMobileChatHistoryState(window.history.state)
        ? "chat"
        : "home",
      zcodeMobileConnectionSettings: true,
    },
    "",
  );
}

/**
 * UI 取消/保存成功/Android 返回关闭浮层时回收连接设置条目。
 * 只回退当前条目，不新增历史；popstate 只回写 React 状态，不能再调用这里（防回环）。
 */
export function backOutOfWebRemoteControlMobileConnectionSettingsHistory(): void {
  if (
    typeof window === "undefined" ||
    !isWebRemoteControlMobileConnectionSettingsHistoryState(window.history.state)
  ) {
    return;
  }
  window.history.back();
}

/**
 * 浮层宿主挂载/卸载时回收残留条目：刷新后 React 浮层状态已丢，
 * 直接 onBack 或会话重建也不应留下后续返回能“复活”旧浮层的废条目。
 * 仅改写当前条目标识，不前进/后退。
 */
export function clearWebRemoteControlMobileConnectionSettingsHistoryState(): void {
  if (
    typeof window === "undefined" ||
    !isWebRemoteControlMobileConnectionSettingsHistoryState(window.history.state)
  ) {
    return;
  }

  const state = window.history.state as WebRemoteControlMobileHistoryState;
  window.history.replaceState({ zcodeMobilePage: state.zcodeMobilePage }, "");
}

/**
 * 设置层卸载（直接 onBack、切换 tab/workspace 或离开手机视口）时回收 settings 条目。
 * 直接 onBack 不会经过 popstate，若不回收，下一次普通打开会被旧 section 条目恢复，
 * 违背“普通打开落在设置首页”。这里只把当前条目改写回宿主页面，不再前进/后退。
 */
export function clearWebRemoteControlMobileSettingsHistoryState(): void {
  if (
    typeof window === "undefined" ||
    !isWebRemoteControlMobileSettingsHistoryState(window.history.state)
  ) {
    return;
  }

  const state = window.history.state as WebRemoteControlMobileHistoryState;
  window.history.replaceState({ zcodeMobilePage: state.zcodeMobilePage }, "");
}

export type WebRemoteControlMobileSettingsHistoryPlan =
  | { kind: "restore"; view: "index" }
  | { kind: "restore"; view: "section"; section: SettingsSectionId }
  | { kind: "push-index" }
  | { kind: "push-section"; section: SettingsSectionId }
  | { kind: "none" };

/**
 * 设置页挂载时的 history 投影：
 * - 当前条目已是 settings（刷新/重挂载/前进）→ 只恢复 React 视图，绝不再次 push；
 * - 首次挂载 → 普通打开 push 设置首页，显式 intent 再压目标分区；
 * - 已初始化过但当前条目不是 settings（外部导航已回收）→ 不补条目，避免 effect 反复 push。
 * popstate 路径不调用此函数，也不写 history。
 */
export function planInitialWebRemoteControlMobileSettingsHistory(args: {
  state: unknown;
  explicitSection: boolean;
  section: SettingsSectionId;
  initialized: boolean;
}): WebRemoteControlMobileSettingsHistoryPlan {
  if (isWebRemoteControlMobileSettingsHistoryState(args.state)) {
    const entry = args.state.zcodeMobileSettings;
    return entry.view === "section"
      ? { kind: "restore", view: "section", section: entry.section }
      : { kind: "restore", view: "index" };
  }

  if (args.initialized) {
    return { kind: "none" };
  }

  return args.explicitSection
    ? { kind: "push-section", section: args.section }
    : { kind: "push-index" };
}

/** 进入聊天页时压入 chat 页面条目；已在 chat 条目（含其上的浮层条目）时不重复叠加。 */
export function pushWebRemoteControlMobileChatHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  if (isWebRemoteControlMobileChatHistoryState(window.history.state)) {
    return;
  }

  window.history.pushState({ zcodeMobilePage: "chat" }, "");
}

/**
 * 初始化页面：优先用导航意图，其次复用浏览器保留的 history state。
 * Bugfix: 手机端在聊天页刷新时，React 内存状态会丢失，但浏览器会保留当前 history.state。
 * 这里复用点击进入聊天页时写入的 history state，避免刷新后只恢复 task 选中态却回到任务首页。
 */
export function resolveInitialWebRemoteControlMobilePage(
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
): WebRemoteControlMobilePage {
  if (initialNavigationIntent === "chat") {
    return "chat";
  }

  if (
    typeof window !== "undefined" &&
    isWebRemoteControlMobileChatHistoryState(window.history.state)
  ) {
    return "chat";
  }

  return "home";
}
