import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { DESKTOP_MAIN_ENTRYPOINTS } from "./scripts/desktop-main-entrypoints.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
const { copyGenUiRuntimeAssets } = await import(
  pathToFileURL(resolve(import.meta.dirname, "scripts/gen-ui-runtime-assets.mjs")).href
);
// tsup 会先打包配置文件；动态加载构建工具，避免其 import.meta.dirname 被重定位到 desktop。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
// tsup 会打包配置文件本身；静态 import 会把 defaults/constants 搬进 config bundle，令其
// import.meta.dirname 从 scripts 目录重定位，REPO_ROOT 随之错误。保持与上面构建工具一致的
// 动态 absolute URL 加载，让 defaults 作为独立模块按真实文件位置解析。
const { resolveMacosCuaDemoBuildSelection } = await import(
  pathToFileURL(resolve(import.meta.dirname, "scripts/macos-cua-demo-defaults.mjs")).href
);
const { resolveBuildTimeConfig, createBuildTimeConfigDefines } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/build-time-config.mjs")).href
);
// 构建期可选能力（ARMS、事件上报、自动更新），见 docs/desktop/build-time-optional-capabilities.md
const buildTimeConfigDefines = createBuildTimeConfigDefines(
  await resolveBuildTimeConfig(process.env),
);
// Self-use CUA default: darwin/arm64 builds select the pinned tested profile unless an
// explicit profile/manifest selection is present. Unsupported targets keep the existing
// undefined define and normal Host path.
const cuaDemoBuildSelection = await resolveMacosCuaDemoBuildSelection({
  env: process.env,
  targetOs: process.env.ZODY_TARGET_OS ?? process.platform,
  targetArch: process.env.ZODY_TARGET_ARCH ?? process.arch,
});
const cuaNarrowAgentDefine = resolveCuaNarrowAgentDefine(cuaDemoBuildSelection?.profileJson);

const buildMetadata = getBuildMetadata();

// 手动加载 .env 文件，tsup 不像 Vite 会自动读取 .env.*；这些文件只提供链接常量。
function loadEnvFiles(): Record<string, string> {
  const vars: Record<string, string> = {};
  const files = ["../../.env"];
  if (process.env.NODE_ENV === "production") {
    files.push("../../.env.production");
  } else {
    files.push("../../.env.development", "../../.env.development.local");
  }
  for (const file of files) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  // 真实环境变量优先级最高
  if (process.env.ZODY_ENV) vars.ZODY_ENV = process.env.ZODY_ENV;
  if (process.env.ZODY_BASE_URL) vars.ZODY_BASE_URL = process.env.ZODY_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id 由 host runtime 读取；这里保留覆盖入口，方便开发构建时观察统一 env 来源。
  if (process.env.ZAI_OAUTH_CLIENT_ID) vars.ZAI_OAUTH_CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID;
  if (process.env.ZAI_OAUTH_ORIGIN) vars.ZAI_OAUTH_ORIGIN = process.env.ZAI_OAUTH_ORIGIN;
  if (process.env.ZAI_BUSINESS_BASE_URL) {
    vars.ZAI_BUSINESS_BASE_URL = process.env.ZAI_BUSINESS_BASE_URL;
  }
  if (process.env.ZAI_BUSINESS_LOGIN_URL) {
    vars.ZAI_BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL;
  }
  if (process.env.CDN_DOMAIN) vars.CDN_DOMAIN = process.env.CDN_DOMAIN;
  if (process.env.OSS_PATH_PREFIX) vars.OSS_PATH_PREFIX = process.env.OSS_PATH_PREFIX;
  if (process.env.VITE_ZAI_OAUTH_CLIENT_ID) {
    vars.VITE_ZAI_OAUTH_CLIENT_ID = process.env.VITE_ZAI_OAUTH_CLIENT_ID;
  }
  if (process.env.VITE_ZAI_OAUTH_ORIGIN) {
    vars.VITE_ZAI_OAUTH_ORIGIN = process.env.VITE_ZAI_OAUTH_ORIGIN;
  }
  return vars;
}

const env = loadEnvFiles();
const { environment: zcodeEnv } = await loadBuiltinProviderConfig();
// 安装包身份与后端环境分轴：ZODY_PREVIEW_IDENTITY=1 让生产后端的构建仍以 Zody Preview 身份打包运行。
const zodyProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZODY_ENV: zcodeEnv });
console.log(`[tsup] ZODY_ENV=${zcodeEnv} ZODY_PRODUCT_FLAVOR=${zodyProductFlavor}`);

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveBuildRemoteCdnReleaseRoots(runtimeEnv: Record<string, string | undefined>) {
  const domains = parseCsvEnv(runtimeEnv.CDN_DOMAIN);
  if (domains.length === 0) {
    return [];
  }
  // 修复原因：上游在未设置 OSS_PATH_PREFIX 时默认拼 `zcode/electron/releases`，那是上游 CDN 的
  // 目录布局，Zody 发布没有这套路径。配置 CDN_DOMAIN 时必须同时显式给出路径前缀。
  const pathPrefixes = parseCsvEnv(runtimeEnv.OSS_PATH_PREFIX);
  if (pathPrefixes.length === 0) {
    throw new Error("OSS_PATH_PREFIX is required when CDN_DOMAIN is set");
  }
  if (pathPrefixes.length !== 1 && pathPrefixes.length !== domains.length) {
    throw new Error(
      `OSS_PATH_PREFIX must contain one value or match CDN_DOMAIN count (${domains.length}), got ${pathPrefixes.length}`,
    );
  }

  return domains.map((domain, index) => {
    const pathPrefix = pathPrefixes.length === 1 ? pathPrefixes[0] : pathPrefixes[index];
    return `https://${domain}/${pathPrefix}`.replace(/\/+$/, "");
  });
}

export function resolveBuildPackagedAgentTelemetryEnv(
  runtimeEnv: Record<string, string | undefined>,
): Record<string, string> {
  const configuredKey = [
    "ZODY_PACKAGED_AGENT_OTEL_ENDPOINT",
    "ZODY_PACKAGED_AGENT_OTEL_HEADERS",
    "ZODY_PACKAGED_AGENT_OTEL_SERVICE_NAME",
  ].find((key) => runtimeEnv[key]?.trim());
  if (configuredKey) {
    throw new Error(
      `${configuredKey} is disabled for Zody release builds; remove Agent OTLP configuration`,
    );
  }

  return {};
}

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZODY_E2E_COVERAGE === "1";
  return {
    // 发布包的 main/host/preload 之前没有随 NODE_ENV=production 压缩，
    // 产物保留大量源码注释与格式化换行，增加逆向和内部实现暴露风险。
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // 生产包不随包发布 sourcemap，继续生成 sourceMappingURL 会暴露无效映射路径。
    // E2E coverage build 只会进入隔离 app cache，需要保留 map 才能把 V8 bundle range
    // 还原到 TypeScript 源码；正常发布构建仍保持无 sourcemap。
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // 生产压缩时 esbuild 默认可能保留 license/legal 注释，
  // 发布包不应在 main/host/preload 里留下源码注释或 sourcemap 入口注释。
  options.legalComments = "none";
}

const desktopTsupBundleSecurityOptions = resolveDesktopTsupBundleSecurityOptions();

function createSharedDefines() {
  return {
    __ZODY_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZODY_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZODY_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZODY_ENV__: JSON.stringify(zcodeEnv),
    __ZODY_PRODUCT_FLAVOR__: JSON.stringify(zodyProductFlavor),
    ...buildTimeConfigDefines,
    // Computer Use Helper build identity — helperInstaller 读它决定下载哪个 Helper bundle。
    // 缺失时 installer 抛 "Packaged ZCode is missing its embedded Computer Use Helper build identity"。
    // CI 构建时通过 ZODY_CUA_HELPER_BUILD_ID env 注入；dev 为空串走兜底（dev helper 不走下载）。
    __ZODY_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZODY_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    // Bugfix: remote runtime CDN 根之前硬编码在 main bundle 里，OSS/CDN 切换必须改代码。
    // 这里改成构建期从 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 注入；没有配置时注入空列表，remote runtime 只走随包本地制品。
    __ZODY_REMOTE_CDN_RELEASE_ROOTS__: JSON.stringify(resolveBuildRemoteCdnReleaseRoots(env)),
  };
}

function createMainDefines() {
  return {
    ...createSharedDefines(),
    // 正式安装包无法继承 GitLab Runner 或开发终端环境。这里只把 CI 提供的低权限写入配置
    // 编译进 Desktop Main，再由既有 Main -> Host -> Agent 安全边界定向传递。
    __ZODY_PACKAGED_AGENT_TELEMETRY_ENV__: JSON.stringify(
      resolveBuildPackagedAgentTelemetryEnv(process.env),
    ),
    // 独立 candidate UI 构建可在构建期注入固定 native launcher 配置。这里只接受
    // 构建机提供的 JSON；它不是运行时环境开关，也不是签名/TCC 验证结果。普通构建
    // 编译为 undefined，保持既有 Electron utilityProcess Host 路径。
    __ZODY_CANDIDATE_NATIVE_HOST_LAUNCH__: resolveCandidateNativeHostLaunchDefine(
      process.env.ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON,
    ),
    // Normal CUA candidate UI identity is injected only by its dedicated assembly builder.
    // The regular desktop main build never selects this identity at runtime.
    __ZODY_NORMAL_CUA_CANDIDATE_UI_NAME__: "undefined",
  };
}

export function resolveCandidateNativeHostLaunchDefine(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "undefined";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON must be a JSON object");
  }
  const candidate = parsed as Record<string, unknown>;
  const launcherPath = candidate.launcherPath;
  const cwd = candidate.cwd;
  if (typeof launcherPath !== "string" || !isAbsolute(launcherPath)) {
    throw new Error("ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON.launcherPath must be absolute");
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error("ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON.cwd must be absolute");
  }
  if (candidate.entryName !== undefined && candidate.entryName !== "host-entry.mjs") {
    throw new Error("ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON.entryName must be host-entry.mjs");
  }
  if (
    candidate.bridgeFd !== undefined &&
    (!Number.isInteger(candidate.bridgeFd) ||
      (candidate.bridgeFd as number) < 3 ||
      (candidate.bridgeFd as number) > 1_024)
  ) {
    throw new Error("ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON.bridgeFd must be 3..1024");
  }
  if (candidate.env !== undefined) {
    if (
      typeof candidate.env !== "object" ||
      candidate.env === null ||
      Array.isArray(candidate.env)
    ) {
      throw new Error("ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON.env must be an object");
    }
    for (const [key, envValue] of Object.entries(candidate.env as Record<string, unknown>)) {
      if (typeof envValue !== "string") {
        throw new Error(`ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON.env.${key} must be a string`);
      }
      if (key === "ELECTRON_RUN_AS_NODE") {
        throw new Error(
          "ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON.env must not set ELECTRON_RUN_AS_NODE",
        );
      }
    }
  }
  const normalized = {
    launcherPath,
    cwd,
    ...(candidate.entryName !== undefined ? { entryName: candidate.entryName } : {}),
    ...(candidate.bridgeFd !== undefined ? { bridgeFd: candidate.bridgeFd } : {}),
    ...(candidate.env !== undefined ? { env: candidate.env } : {}),
  };
  return JSON.stringify(normalized);
}

/**
 * 普通 Host 的窄 Agent 构建期选择。
 *
 * darwin/arm64 默认由共享选择器提供已实测 profile；显式 JSON 覆盖仍按原 API 接受。
 * 编译为 `undefined` 时保持普通 Agent。它不是 runtime 开关：启动时 Host 仍会校验固定
 * 槽位、资源摘要、已测目标、workspace allowlist 与 storage 准备。
 */
export function resolveCuaNarrowAgentDefine(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "undefined";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `ZODY_CUA_NARROW_AGENT_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ZODY_CUA_NARROW_AGENT_JSON must be a JSON object");
  }
  return JSON.stringify(parsed);
}

const desktopNodeRuntimeExternals = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  // fork（bot channels 移除，specs/bot-channels-removal.md）：@larksuiteoapi/node-sdk
  // external 随第三方 IM bot（飞书）provider 删除。
  "yaml",
  // node-forge 内部用动态 require("crypto")，内联进 ESM main/host bundle 后 Electron 会报
  // Dynamic require of "crypto" is not supported。和 undici 同样保留为运行时外部依赖。
  "node-forge",
  // ZIP 解包器内部依赖 CommonJS require("fs")，不能内联到 ESM main/host 产物。
  "yauzl",
];

function createDevReadyMarkerHook(target: "main" | "host" | "preload"): string {
  // CLI 级 --onSuccess 在多 config watch 模式下会被每个子构建分别触发。
  // 之前 preload 先成功时就提前写入 ready 标记，Electron 仍会在 main/host 未完成时启动。
  // 这里改成每个 config 自己在成功后写独立 marker，让 dev 启动脚本能精确等待全部构建完成。
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "main",
    entry: { ...DESKTOP_MAIN_ENTRYPOINTS },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // undici 如果被 main ESM bundle 直接内联，运行时会落到它内部的 CommonJS require("assert")，
    // Electron 加载 main 产物时会报 Dynamic require of "assert" is not supported。
    // desktop 保持 undici 为外部依赖，remote 单文件 bundle 再单独内联。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zody/server",
      "@zody/shared",
      "@zody/rpc",
      "@zody/services",
      "@zody/client",
      // Provider Refactor 的 workspace 包导出 TypeScript 源码；Electron 生产运行时没有
      // TS loader，必须随 Desktop bundle 内联，不能留下指向 src/index.ts 的裸包引用。
      "@zody/provider",
      "@zody/provider-node",
      // services 已内联进 main，但其 producer import 曾被保留为裸包引用；
      // electron-builder 又会排除 node_modules/@zcode，导致安装包启动即 ERR_MODULE_NOT_FOUND。
      // producer 的 JS broker 必须跟随 services 一起内联，原生 addon 仍只存在于独立 Helper。
      "@zody/zody-cua",
      // 远程访问改走 zclaudia-gateway。@zclaudia/gateway-backend 运行时 import "@zclaudia/gateway-client"
      // （解析到它自己声明的 0.2.x），安装包不随包发布 node_modules，所以三个包都必须内联进 main bundle；
      // 漏掉 gateway-client 会让打包后的安装包在启动远程访问时报 ERR_MODULE_NOT_FOUND。
      "@zclaudia/gateway-backend",
      "@zclaudia/gateway-protocol",
      "@zclaudia/gateway-client",
    ],
    define: createMainDefines(),
    // 修复原因：main/host 同时 watch 且共享 out 根目录时，默认 chunk 命名会互相覆盖，
    // 可能让 main 的 import 指向被 host 刚重写的 chunk，触发“缺少命名导出”的偶发启动报错。
    // 这里按目标分目录输出 chunk，确保并发构建下产物隔离。
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "main/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("main"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "preload",
    entry: {
      "preload/embeddedBrowserJavaScriptDialog": "src/preload/embeddedBrowserJavaScriptDialog.ts",
      // fork（F4.4）：codingPlanWebview / rewardsWebview preload 入口随购买与 Rewards
      // webview 基础设施删除。
      "preload/browserVideoRecorder": "src/preload/browserVideoRecorder.ts",
      "preload/index": "src/preload/index.ts",
      "preload/resourceManager": "src/preload/resourceManager.ts",
      "preload/cuaPermissionPanel": "src/preload/cuaPermissionPanel.ts",
      "preload/pluginSandbox": "src/preload/pluginSandbox/index.ts",
    },
    outDir: "out",
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    noExternal: ["@zody/shared"],
    outExtension: () => ({ js: ".cjs" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    onSuccess: createDevReadyMarkerHook("preload"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    // 插件 iframe 内的 window.zcode / window.openai 别名脚本（官方 ext-apps `App` 上的薄封装）：IIFE、浏览器平台，
    // 由 zcode-sandbox:// protocol handler 同源服务。
    name: "plugin-sandbox-alias",
    loader: { ".css": "text" },
    entry: {
      "plugin-sandbox-alias": "src/renderer/src/plugin-sandbox/alias.ts",
      "gen-ui": "src/renderer/src/plugin-sandbox/genUi.ts",
    },
    // 不能放 out/renderer：vite renderer 构建 emptyOutDir 会把先落盘的别名脚本清掉。
    outDir: "out/plugin-sandbox",
    onSuccess: () => copyGenUiRuntimeAssets(resolve("out/plugin-sandbox")),
    format: "iife",
    platform: "browser",
    target: "es2022",
    // 沙箱页面没有 node_modules：SDK（ext-apps / client / core / zod）必须全部打进 IIFE。
    noExternal: [/.*/],
    outExtension: () => ({ js: ".js" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      // Native launcher's fixed sealed ESM entry (`--entry-name host-entry.mjs`).
      "host/hostEntry": "src/host/hostEntry.ts",
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // host 与 main 共用同一套 services 图，继续内联 undici 会在 Electron ESM runtime 里触发同样的 dynamic require 崩溃。
    // 这里同样保留为外部依赖，避免 desktop 开发态和打包态 host 进程启动失败。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zody/server",
      "@zody/shared",
      "@zody/rpc",
      "@zody/services",
      "@zody/client",
      "@zody/provider",
      "@zody/provider-node",
      "@zody/zody-cua",
    ],
    define: {
      ...createSharedDefines(),
      // darwin/arm64 self-use default, with explicit build-profile override preserved.
      __ZODY_CUA_NARROW_AGENT__: cuaNarrowAgentDefine,
    },
    // 与 main 保持一致的 chunk 隔离策略，避免 host/main 产物相互覆盖。
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("host"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "scheduler",
    entry: { "scheduler/index": "src/scheduler/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // 与 host 同构：常驻 cron scheduler 进程复用 @zcode/services（tasks-index + cron），
    // 同样保留 undici 等为外部依赖，避免 Electron ESM runtime 的 dynamic require 崩溃。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zody/server",
      "@zody/shared",
      "@zody/rpc",
      "@zody/services",
      "@zody/client",
      "@zody/provider",
      "@zody/provider-node",
      "@zody/zody-cua",
    ],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "scheduler/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("scheduler"),
    ...desktopTsupBundleSecurityOptions,
  },
]);
