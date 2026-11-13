// Normal utility Host candidate assembly constants and argument parsing.
// The app shell is an existing electron-builder --dir output; this builder only
// replaces main/host/scheduler from workspace source and keeps the shell runtime.
import { isAbsolute, join, resolve } from "node:path";
import {
  DESKTOP_ROOT,
  ESM_CJS_INTEROP_BANNER,
  REPO_ROOT,
  RUNTIME_EXTERNALS,
} from "./cua-desktop-candidate-app-config.mjs";
import { DESKTOP_MAIN_ENTRYPOINTS } from "../desktop-main-entrypoints.mjs";

export { DESKTOP_ROOT, ESM_CJS_INTEROP_BANNER, REPO_ROOT, RUNTIME_EXTERNALS };

export const DEFAULT_APP_SHELL = join(
  REPO_ROOT,
  "output/cua-phase1-closeout/normal-app/mac-arm64/Zody Preview.app",
);
export const DEFAULT_OUTPUT = join(
  REPO_ROOT,
  "output/cua-arm64-screenshot/host-worker/normal-host-candidate",
);

export const DESKTOP_HOST_ENTRYPOINTS = Object.freeze({
  "host/index": "src/host/index.ts",
  "host/hostEntry": "src/host/hostEntry.ts",
  "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
});
export const DESKTOP_SCHEDULER_ENTRYPOINTS = Object.freeze({
  "scheduler/index": "src/scheduler/index.ts",
});

export { DESKTOP_MAIN_ENTRYPOINTS };

export function usage() {
  return `Usage: node packages/desktop/scripts/build-cua-normal-host-candidate.mjs \\
  --narrow-manifest <absolute prepared cua-narrow manifest.json> \\
  [--app-shell <absolute normal electron-builder --dir .app>] \\
  [--output <absolute output root>] \\
  [--no-minify] [--replace]

Profile schemaVersion 2 (2026-11-09 分发轮次)：profile 只含内容 pin 与 darwin/arm64/14.2
最低目标；v1 的 --workspace-allowlist/--startup-snapshot/--provider-profile/--network-profile/
--tested-macos-version 机器绑定输入已删除。`;
}

function parseFlag(value, flag) {
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

// v2 起未知 flag 显式报错：v1 的机器绑定参数已删除，静默吞掉会让调用方
// 误以为 allowlist/snapshot 等 pin 仍然生效。
const VALUE_FLAGS = new Set(["--app-shell", "--narrow-manifest", "--output"]);

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
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown argument: ${name}`);
    const value = parseFlag(argv[index + 1], name);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("--help") || flags.has("-h")) return { help: true };

  const absolute = (name, fallback) => {
    const raw = values.get(name)?.trim() ?? fallback;
    if (!raw) throw new Error(`${name} is required`);
    if (!isAbsolute(raw)) throw new Error(`${name} must be an absolute path`);
    return resolve(raw);
  };

  return {
    help: false,
    appShell: absolute("--app-shell", DEFAULT_APP_SHELL),
    narrowManifest: values.get("--narrow-manifest") ? absolute("--narrow-manifest") : undefined,
    output: absolute("--output", DEFAULT_OUTPUT),
    replace: flags.has("--replace"),
    minify: !flags.has("--no-minify"),
  };
}

export function requirePreparedNarrowManifestPath(manifestPath) {
  if (typeof manifestPath !== "string" || !manifestPath.trim()) {
    throw new Error(
      "a prepared cua-narrow manifest is required; the candidate builder will not mint a pass manifest or treat a diagnostic route file as formal eligibility",
    );
  }
  return manifestPath;
}
