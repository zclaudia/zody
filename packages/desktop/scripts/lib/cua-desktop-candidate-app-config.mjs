import { isAbsolute, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_APP_NAME } from "@zody/zody-cua/broker/helperConstants";

export const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO_ROOT = resolve(DESKTOP_ROOT, "../..");
export const APP_NAME = "Zody CUA Launchservices Candidate.app";
export const APP_DISPLAY_NAME = "Zody CUA Launchservices Candidate";
export const APP_EXECUTABLE_NAME = "ZodyCUACandidate";
export const APP_EXECUTABLE_RELATIVE = `Contents/MacOS/${APP_EXECUTABLE_NAME}`;
export const APP_BUNDLE_ID = "io.github.zclaudia.zody.cua-launchservices-candidate";
export const DEFAULT_OUTPUT = join(REPO_ROOT, "output/cua-launchservices/host-worker");
export const DEFAULT_ELECTRON_APP = join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
export const DEFAULT_RENDERER = join(DESKTOP_ROOT, "out/renderer");
export const DEFAULT_PRELOAD = join(DESKTOP_ROOT, "out/preload");
export const DEFAULT_PLUGIN_SANDBOX = join(DESKTOP_ROOT, "out/plugin-sandbox");
export const RUNTIME_EXTERNALS = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "yaml",
  "node-forge",
  "yauzl",
];
export const RUNTIME_MODULE_LOOKUP_ROOTS = [
  DESKTOP_ROOT,
  REPO_ROOT,
  join(DESKTOP_ROOT, "node_modules", ".pnpm", "node_modules"),
  join(REPO_ROOT, "node_modules", ".pnpm", "node_modules"),
];
export const DESKTOP_SCHEDULER_ENTRYPOINTS = Object.freeze({
  "scheduler/index": "src/scheduler/index.ts",
});
export const ESM_CJS_INTEROP_BANNER =
  'import { createRequire as __zcodeCreateRequire } from "node:module"; ' +
  'import { fileURLToPath as __zcodeFileURLToPath } from "node:url"; ' +
  'import { dirname as __zcodeDirname } from "node:path"; ' +
  "const require = __zcodeCreateRequire(import.meta.url); " +
  "const __filename = __zcodeFileURLToPath(import.meta.url); " +
  "const __dirname = __zcodeDirname(__filename);";
export const HELPER_RELATIVE_APP = `cua-helper/${HELPER_APP_NAME}`;
export const HELPER_RELATIVE_LAUNCHER = `${HELPER_RELATIVE_APP}/Contents/MacOS/macos-cua-desktop-session`;
export const HELPER_RELATIVE_CWD = `${HELPER_RELATIVE_APP}/Contents/MacOS`;
export const candidateNativeHostLaunch = Object.freeze({
  kind: "packaged-resources",
  launcherPathRelativeToResources: HELPER_RELATIVE_LAUNCHER,
  cwdRelativeToResources: HELPER_RELATIVE_CWD,
  entryName: "host-entry.mjs",
  bridgeFd: 5,
  launchMode: "workspace-relay",
  applicationName: APP_DISPLAY_NAME,
});

export function usage() {
  return `Usage: node packages/desktop/scripts/build-cua-desktop-candidate-app.mjs \\
  --helper-app <absolute signed Helper .app> [--output <absolute output root>] \\
  [--electron-app <absolute Electron.app>] [--renderer <absolute dir>] \\
  [--preload <absolute dir>] [--plugin-sandbox <absolute dir>] \\
  [--no-minify] [--replace]`;
}

export function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--replace" || name === "--no-minify" || name === "--help" || name === "-h") {
      flags.add(name);
      continue;
    }
    if (!name?.startsWith("--")) throw new Error(`Unknown argument: ${name ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("--help") || flags.has("-h")) return { help: true };
  const absolute = (name, fallback) => {
    const value = values.get(name)?.trim() ?? fallback;
    if (!value) throw new Error(`${name} is required`);
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return resolve(value);
  };
  return {
    help: false,
    helperApp: absolute("--helper-app"),
    output: absolute("--output", DEFAULT_OUTPUT),
    electronApp: absolute("--electron-app", DEFAULT_ELECTRON_APP),
    renderer: absolute("--renderer", DEFAULT_RENDERER),
    preload: absolute("--preload", DEFAULT_PRELOAD),
    pluginSandbox: absolute("--plugin-sandbox", DEFAULT_PLUGIN_SANDBOX),
    replace: flags.has("--replace"),
    minify: !flags.has("--no-minify"),
  };
}
