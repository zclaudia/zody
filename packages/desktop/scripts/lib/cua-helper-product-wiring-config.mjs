// 原生组合候选的固定路径/常量。与 R11 final-build 同一 SDK/架构/最低系统与 rpath，
// 只把 sealed JS 入口换成真实 create-app fixture，并在 output 派生原生源码。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
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
export const SOURCE_BASELINE = join(PRODUCT_WIRING_ROOT, "source-baseline.json");
export const KOFFI_PLATFORM_TRIM = join(PRODUCT_WIRING_ROOT, "koffi-unavailable-darwin.mjs");
export const BOOTSTRAP_ENTRY = join(
  REPO_ROOT,
  "apps",
  "zcode-cli",
  "packages",
  "bootstrap",
  "tests",
  "fixtures",
  "cua-native-owner-entry.ts",
);
export const DEFAULT_OUTPUT_ROOT = join(
  REPO_ROOT,
  "output",
  "cua-helper-product-integration",
  "native-candidate",
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
export const APP_NAME = "Zody CUA Helper Round11.app";
export const APP_BINARY_NAME = "macos-cua-helper-round11";

// R11 原生入口原为 8MiB；真实 create-app fixture 的 sealed ESM 约 26.5MiB，
// 有界提升到 32MiB，仍拒绝无上限快照。wire frame 16KiB 合同不变。
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

// CJS 依赖（debug/typescript 等）在 ESM 里需要 require/__filename/__dirname。
// 这不是认证，只是让 sealed ESM 能加载已打包的 CJS 闭包与 builtin。
export const ESM_BANNER =
  'import { createRequire as __cuaCreateRequire } from "node:module"; ' +
  'import { fileURLToPath as __cuaFileURLToPath } from "node:url"; ' +
  'import { dirname as __cuaDirname } from "node:path"; ' +
  "const require = __cuaCreateRequire(import.meta.url); " +
  "const __filename = __cuaFileURLToPath(import.meta.url); " +
  "const __dirname = __cuaDirname(__filename);";

export const R11_SOURCES = [
  "authority_client.mm",
  "bundle_paths.mm",
  "capture_owner.mm",
  "machine_lease.mm",
  "main.mm",
  "node_process.mm",
  "orchestrator.mm",
  "peer_auth.mm",
  "r11_pins.mm",
  "r11_self_identity.mm",
];
export const R10_SOURCES = [
  "peer_socket.mm",
  "peer_frame.mm",
  "security_identity.mm",
  "profile.mm",
];

export class ProductWiringBuildError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ProductWiringBuildError";
    this.code = code;
    this.details = details;
  }
}
