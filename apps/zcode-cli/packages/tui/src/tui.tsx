import { CliRenderEvents, createCliRenderer, type CliRenderer } from "@mbears/opentui-core";
import type { UiThemeMode } from "@zcode/contracts";
import { createRoot } from "@mbears/opentui-react";
import { getZCodeCopy } from "@zcode/i18n";
import React from "react";
import { TuiApp } from "./app.js";
import { TuiStartupScreen } from "./app-startup.js";
import { createSelectionCopyHandler, hasCopyableSelectionText } from "./app-copy.js";
import { activeTuiTheme, resolveTuiThemeMode, setActiveTuiThemeMode } from "./theme/index.js";
import { resolveInitialTerminalThemeMode } from "./theme/terminal.js";
import type { TuiOptions } from "./types.js";

export const runTui = async (options: TuiOptions): Promise<number> => {
  if (!options.stdin.isTTY || !options.stdout.isTTY) {
    const copy = getZCodeCopy(options.locale);
    options.stderr.write(`${copy.tui.terminal.requiresInteractive}\n`);
    return 1;
  }

  const startupThemeMode = resolveTuiThemeMode(options.theme, null);
  setActiveTuiThemeMode(startupThemeMode);

  const renderer = await createCliRenderer({
    backgroundColor: activeTuiTheme(startupThemeMode).background,
    autoFocus: false,
    consoleMode: "disabled",
    enableMouseMovement: true,
    exitOnCtrlC: false,
    // Session replacement can raise SIGPIPE while closing MCP pipes. OpenTUI's
    // default exit signals include it and would destroy the entire TUI.
    exitSignals: ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGBREAK", "SIGBUS"],
    consoleOptions: {
      keyBindings: [
        {
          action: "copy-selection",
          ctrl: true,
          name: "y",
        },
      ],
      onCopySelection: (text) => {
        if (!hasCopyableSelectionText(text) || !options.writeClipboardText) return;
        void Promise.resolve(options.writeClipboardText(text)).finally(() =>
          renderer.clearSelection(),
        );
      },
    },
    stdin: options.stdin,
    stdout: options.stdout,
    targetFps: 30,
    useMouse: true,
  });
  return runTuiWithRenderer(options, renderer);
};

type TuiScreen = { kind: "startup" } | { kind: "app"; options: TuiOptions };

type TuiScreenStore = {
  getSnapshot: () => TuiScreen;
  setScreen: (screen: TuiScreen) => void;
  subscribe: (listener: () => void) => () => void;
};

function createTuiScreenStore(initial: TuiScreen): TuiScreenStore {
  let screen = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => screen,
    setScreen: (next) => {
      if (screen === next) return;
      screen = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * 启动页与主应用共处同一棵 React 树：换页由 store 触发 React 卸载旧屏幕，
 * 而不是对同一个 root 二次 render（后者会新建 container 并残留启动页订阅）。
 */
function TuiLifecycleScreen({
  copySelection,
  hasCopyableSelection,
  onExit,
  options,
  store,
}: {
  copySelection: ReturnType<typeof createSelectionCopyHandler>;
  hasCopyableSelection: () => boolean;
  onExit: (code: number) => void;
  options: TuiOptions;
  store: TuiScreenStore;
}): React.ReactElement {
  const screen = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (screen.kind === "app") {
    return React.createElement(TuiApp, {
      onExit,
      options: screen.options,
      copySelection,
      hasCopyableSelection,
    });
  }
  return React.createElement(TuiStartupScreen, { options, onExit });
}

/** Renderer lifecycle shared by the interactive entrypoint and native terminal tests. */
export async function runTuiWithRenderer(
  options: TuiOptions,
  renderer: CliRenderer,
): Promise<number> {
  let exitCode = 0;
  let startupError: unknown;
  let destroyed = false;
  let appMounted = false;
  let terminalThemeMode: UiThemeMode | null = null;
  const themeModeListeners = new Set<(mode: UiThemeMode) => void>();
  const root = createRoot(renderer);
  const onExit = (code: number) => {
    exitCode = code;
    renderer.destroy();
  };
  const handleThemeMode = (mode: UiThemeMode) => {
    if (destroyed) return;
    terminalThemeMode = mode;
    if (!appMounted) {
      const resolved = resolveTuiThemeMode(options.theme, mode);
      setActiveTuiThemeMode(resolved);
      renderer.setBackgroundColor(activeTuiTheme(resolved).background);
    }
    for (const listener of themeModeListeners) listener(mode);
  };
  renderer.on(CliRenderEvents.THEME_MODE, handleThemeMode);

  const copySelection = createSelectionCopyHandler({
    clearSelection: () => renderer.clearSelection(),
    getSelectionText: () => renderer.getSelection()?.getSelectedText(),
    writeClipboardText: options.writeClipboardText,
  });

  const createAppOptions = (readyOptions: TuiOptions): TuiOptions => {
    const initialThemeMode = resolveTuiThemeMode(readyOptions.theme, terminalThemeMode);
    setActiveTuiThemeMode(initialThemeMode);
    renderer.setBackgroundColor(activeTuiTheme(initialThemeMode).background);
    appMounted = true;
    return {
      ...readyOptions,
      initialThemeMode,
      setTerminalBackgroundColor: (color) => renderer.setBackgroundColor(color),
      subscribeThemeMode: (listener) => {
        themeModeListeners.add(listener);
        if (terminalThemeMode) listener(terminalThemeMode);
        return () => {
          themeModeListeners.delete(listener);
        };
      },
    };
  };
  const screenStore = createTuiScreenStore(
    options.loadStartupOptions
      ? { kind: "startup" }
      : { kind: "app", options: createAppOptions(options) },
  );
  const renderApp = (readyOptions: TuiOptions) => {
    if (destroyed) return;
    // 同一棵树内的 store 切换让 React 卸载 TuiStartupScreen，释放其 useKeyboard 订阅。
    screenStore.setScreen({ kind: "app", options: createAppOptions(readyOptions) });
  };
  const initialize = () => {
    // FRAME is emitted after native output. No runtime work can block the first paint.
    void Promise.resolve()
      .then(() => (destroyed ? undefined : options.loadStartupOptions?.()))
      .then((startup) => renderApp({ ...options, ...startup }))
      .catch((error: unknown) => {
        if (destroyed) return;
        startupError = error;
        onExit(1);
      });
  };
  const closed = new Promise<number>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => {
      destroyed = true;
      renderer.off(CliRenderEvents.FRAME, initialize);
      renderer.off(CliRenderEvents.THEME_MODE, handleThemeMode);
      themeModeListeners.clear();
      root.unmount();
      resolve(exitCode);
    });
  });

  if (options.loadStartupOptions) renderer.once(CliRenderEvents.FRAME, initialize);
  root.render(
    React.createElement(TuiLifecycleScreen, {
      store: screenStore,
      options,
      onExit,
      copySelection,
      hasCopyableSelection: () =>
        hasCopyableSelectionText(renderer.getSelection()?.getSelectedText()),
    }),
  );
  // Terminal replies may take up to 600 ms. Detect concurrently and update the theme
  // through the existing subscription, rather than holding the first screen hostage.
  void resolveInitialTerminalThemeMode(renderer).then((mode) => {
    if (mode) handleThemeMode(mode);
  });

  const result = await closed;
  if (startupError) throw startupError;
  return result;
}
