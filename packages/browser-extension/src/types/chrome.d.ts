/**
 * P0 只声明扩展实际使用的 Chrome API 子集，避免为构建引入额外 @types 依赖。
 * `debugger` 是 TS 关键字，不能作为 namespace 名，因此用接口 + `declare const chrome` 描述。
 */

interface ChromeRuntimeMessageSender {
  id?: string;
  url?: string;
}

interface ChromeRuntimeApi {
  readonly id?: string;
  readonly onMessage: {
    addListener(
      callback: (
        message: unknown,
        sender: ChromeRuntimeMessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void,
    ): void;
  };
  readonly onInstalled: { addListener(callback: (details: { reason: string }) => void): void };
  readonly onStartup: { addListener(callback: () => void): void };
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  getContexts(filter: {
    contextTypes: string[];
    documentUrls?: string[];
  }): Promise<Array<{ contextType: string; documentUrl?: string }>>;
}

interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeOffscreenApi {
  readonly Reason: {
    WORKERS: string;
    DOM_PARSER: string;
    BLOBS: string;
    TESTING: string;
  };
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
}

interface ChromeTab {
  id?: number;
  windowId?: number;
  active: boolean;
  url?: string;
  title?: string;
}

interface ChromeTabChangeInfo {
  url?: string;
  title?: string;
  status?: string;
}

interface ChromeTabsApi {
  query(queryInfo: {
    active?: boolean;
    currentWindow?: boolean;
    lastFocusedWindow?: boolean;
  }): Promise<ChromeTab[]>;
  get(tabId: number): Promise<ChromeTab>;
  create(createProperties: {
    url?: string;
    active?: boolean;
    windowId?: number;
  }): Promise<ChromeTab>;
  remove(tabId: number): Promise<void>;
  readonly onRemoved: {
    addListener(
      callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void,
    ): void;
  };
  readonly onUpdated: {
    addListener(
      callback: (tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => void,
    ): void;
  };
}

interface ChromeDebuggee {
  tabId?: number;
  targetId?: string;
}

interface ChromeDebuggerApi {
  attach(target: ChromeDebuggee, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggee): Promise<void>;
  sendCommand(
    target: ChromeDebuggee,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  getTargets(): Promise<
    Array<{
      id: string;
      tabId?: number;
      type: string;
      title: string;
      url: string;
      attached: boolean;
    }>
  >;
  readonly onEvent: {
    addListener(
      callback: (source: ChromeDebuggee, method: string, params?: Record<string, unknown>) => void,
    ): void;
  };
  readonly onDetach: {
    addListener(callback: (source: ChromeDebuggee, reason: string) => void): void;
  };
}

interface ChromeActionApi {
  setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
}

interface ChromeApi {
  readonly runtime: ChromeRuntimeApi;
  readonly storage: {
    readonly local: ChromeStorageArea;
    readonly session: ChromeStorageArea;
  };
  readonly offscreen: ChromeOffscreenApi;
  readonly tabs: ChromeTabsApi;
  readonly debugger: ChromeDebuggerApi;
  readonly action: ChromeActionApi;
}

declare const chrome: ChromeApi;
