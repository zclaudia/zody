// 固定路径/常量：真实 arm64/macOS14.2 native desktop-session 候选。
// 源、视觉静态库、签名 Node 和身份 pins 都来自 controller 冻结材料，只读引用。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const NATIVE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-desktop-session",
);
export const R11_NATIVE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-helper-round11",
);
export const R10_NATIVE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-peer-diagnostic",
);
export const PRODUCT_WIRING_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-helper-product-wiring",
);
export const PRODUCT_BASELINE = join(PRODUCT_WIRING_ROOT, "source-baseline.json");
export const SESSION_BASELINE = join(NATIVE_ROOT, "source-baseline.json");
export const KOFFI_PLATFORM_TRIM = join(PRODUCT_WIRING_ROOT, "koffi-unavailable-darwin.mjs");

export const DEFAULT_OUTPUT_ROOT = join(
  REPO_ROOT,
  "output",
  "cua-desktop-session",
  "native-worker",
);
export const DEFAULT_VISUAL_ROOT = join(
  REPO_ROOT,
  "output",
  "cua-helper-round11",
  "controller-visual-final",
);
export const DEFAULT_NODE_PATH = join(
  REPO_ROOT,
  "output",
  "cua-helper-round11",
  "controller-signed",
  "candidate",
  "helper",
  "Zody CUA Helper Round11.app",
  "Contents",
  "Resources",
  "node",
);
export const DEFAULT_IDENTITY_PINS = join(
  REPO_ROOT,
  "output",
  "cua-helper-round11",
  "controller-signed",
  "identity-pins.json",
);

export const FIXED_SDK = "macosx27.0";
export const FIXED_SDK_VERSION = "27.0";
export const FIXED_ARCH = "arm64";
export const FIXED_DEPLOYMENT_TARGET = "14.2";
export const BUNDLE_ID = "io.github.zclaudia.zody.cua-helper";
export const APP_NAME = "Zody CUA Desktop Session.app";
export const APP_BINARY_NAME = "macos-cua-desktop-session";
// 图标只是 Finder/LaunchServices 展示资源：复制主应用图标，不参与身份 pin 或授权边界。
export const APP_ICON_FILE = "AppIcon.icns";
export const APP_ICON_SOURCE = join(REPO_ROOT, "packages", "desktop", "build", "icon.icns");

// 单个 sealed entry 的上限；CLI 实测约 30.2MiB，保留 64MiB 有界上限。
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const ENTRY_NAMES = ["host-entry.mjs", "cli-entry.mjs", "session-entry.mjs"];

// 真实 Host/CLI composition 需要、但必须由 native 固定资源目录提供的 sealed 字节。
// 入口只能按固定名从 process.execPath 推导路径，不读取 UI/env。
export const AUXILIARY_RESOURCES = [
  {
    name: "node-repl-server.mjs",
    source: "apps/zody-cli/packages/node-repl-host/src/server.ts",
    capability: "node-repl-mcp-and-cell-server; cell owns only per-call broker capability",
  },
];

// Hostworker 合同：这两份 worker 的 source 直接以 define 嵌入 host-entry，最终
// host-entry hash 覆盖它们；不再另造 fd 传输或可替换文件。
export const EMBEDDED_RESOURCES = [
  {
    key: "tasksStorageWorker",
    name: "tasks-storage-worker.mjs",
    source: "packages/desktop/src/host/tasksStorageWorker.ts",
    definePrefix: "TASKS_STORAGE_WORKER",
  },
  {
    key: "sessionStorageEntry",
    name: "session-storage-entry.mjs",
    source: "packages/desktop/native/macos-cua-desktop-session/entries/session-storage-entry.ts",
    definePrefix: "SESSION_STORAGE_ENTRY",
  },
];

// 纯 JS 依赖（undici/yaml/node-forge/yauzl 等）必须全部内联。仅本轮不支持的
// 原生能力可由 resolve 插件绑定到固定来源的 throw-only shim；禁止运行时按 cwd 解析。
export const UNSUPPORTED_NATIVE_PINS = join(NATIVE_ROOT, "runtime", "unsupported-native-pins.json");

export const SESSION_SOURCES = [
  "confirmation_state.mm",
  "confirmation.mm",
  "session_binding.mm",
  "window_identity.mm",
  "session_node_process.mm",
  "session_capture_file.mm",
  "session_control.mm",
  "session_authority_fd.mm",
  "session_launcher.mm",
  "session_cell_protocol.mm",
  "session_cell_relay.mm",
  "session_cell_transport.mm",
  "session_transport_auth.mm",
  "session_workspace_handoff.mm",
  "session_workspace_runtime.mm",
  "session_supervisor.mm",
  "session_main.mm",
];

export const R11_COMPILE_SOURCES = [
  "authority_client.mm",
  "bundle_paths.mm",
  "capture_owner.mm",
  "machine_lease.mm",
  "peer_auth.mm",
  "r11_self_identity.mm",
];
export const R10_COMPILE_SOURCES = [
  "peer_socket.mm",
  "peer_frame.mm",
  "security_identity.mm",
  "profile.mm",
];

// stdin ESM 的 import.meta.url 取决于调用方式，不能让 require 以 cwd 为基址。
// 固定到实际签名 Node 可执行文件；未内联的包不会从 workspace/node_modules 成功加载。
export const ESM_BANNER =
  'import { createRequire as __cuaCreateRequire } from "node:module"; ' +
  'import { dirname as __cuaDirname } from "node:path"; ' +
  "const require = __cuaCreateRequire(process.execPath); " +
  "const __filename = process.execPath; " +
  "const __dirname = __cuaDirname(__filename);";

export class DesktopSessionBuildError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DesktopSessionBuildError";
    this.code = code;
    this.details = details;
  }
}
