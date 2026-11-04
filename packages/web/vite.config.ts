import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
import { resolveRemoteFrontendVersion } from "./vite/remoteFrontendVersion.mjs";
// Bugfix: Vite 配置在 Node 加载期执行，不能导入 @zcode/shared 根入口。
// 根入口包含 NodeNext 风格的源码 re-export，Node 会按真实文件查找 .js 并在 bootstrap 阶段失败。
import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared/zcodeEndpoint";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * Shell 源入口是 `mobile-shell.html`，但 Android WebViewAssetLoader 的固定入口是
 * `/assets/shell/index.html`（spec 第 6.1 节）。在 Rollup 产物里直接把 HTML 改名为
 * index.html，构建脚本无需再做一次文件搬运；Remote 的 `mobile.html → index.html`
 * 仍由 M1 的 `build-mobile-web-release.mjs` 负责，两条制品互不复用。
 */
function mobileShellHtmlEntryPlugin(enabled: boolean): Plugin {
  return {
    name: "zcode:mobile-shell-entry",
    apply: "build",
    writeBundle() {
      if (!enabled) {
        return;
      }
      const outDir = resolve(HERE, "dist-mobile-shell");
      const source = resolve(outDir, "mobile-shell.html");
      const target = resolve(outDir, "index.html");
      if (existsSync(source)) {
        renameSync(source, target);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // 手机入口（mobile.html）用独立 mode 打包：产物与普通 Web 客户端分开，入口也不复用 index.html。
  // 这样普通 Web 客户端构建产物里不会带上手机页面（T3.4 之后它才会引入 @zclaudia/gateway-client）。
  const mobileEntry = mode === "mobile";
  // Shell 轻壳独立 mode：只包含配对/设置/discovery，不打包 Remote 工作台。
  const mobileShellEntry = mode === "mobile-shell";
  // `.env*` 只提供链接常量；当前产品环境由启动脚本或 CI 注入 ZCODE_ENV。
  // 启动脚本通过 process.env 显式选择 test/production；它必须优先于 .env 文件，
  // 否则 mode 对应的旧配置可能被误解析到错误 endpoint。
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);

  return {
    plugins: [
      // PDF.js CMaps 属于 Remote 工作台的 PDF 预览能力；Shell 轻壳不包含文件预览，
      // 跳过该插件避免把数千个 cmap 资源复制进 APK。普通 Web 与 Remote 保持原行为。
      ...(mobileShellEntry ? [] : [pdfJsCMapsPlugin()]),
      react(),
      tailwindcss(),
      thirdPartyNoticesVitePlugin(),
      mobileShellHtmlEntryPlugin(mobileShellEntry),
    ],
    resolve: {
      alias: {
        // 修复 UI 组件库中的 @ 别名解析失败。
        // 问题原因：packages/ui 的源码直接被 web 应用交给 Vite 打包，但 web 自己没声明 @ -> packages/ui/src，
        // 所以像 "@/components/lib/utils" 这类导入会在运行时构建阶段报找不到模块。
        // 这里把别名补到消费方 Vite 配置里，保持现有组件源码不动，影响面最小。
        "@": resolve(__dirname, "../ui/src"),
        // Recharts 依赖 d3-shape@3.x，后者需要 d3-path 的 Path 导出。
        // hoisted node_modules 可能把 d3-shape 旁边的旧 d3-path@1.x 暴露给 Vite 预构建，
        // 导致桌面/Web dev 都在依赖优化阶段失败；显式指向根部 3.x 入口以固定解析边界。
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
        // Shell 轻壳没有终端和数学公式；复用同一份 styles.css 时把这两块 CSS 置空，
        // 避免把 xterm 样式和 KaTeX 字体（woff/ttf）复制进 APK。
        ...(mobileShellEntry
          ? {
              "katex/dist/katex.min.css": resolve(HERE, "src/mobile-shell/empty.css"),
              "@xterm/xterm/css/xterm.css": resolve(HERE, "src/mobile-shell/empty.css"),
            }
          : {}),
      },
    },
    // Shell 是轻壳，不复制普通 Web 的 material-icons 等 public 资源；Remote/普通 Web 保持原行为。
    publicDir: mobileShellEntry ? false : "public",
    server: {
      port: 5173,
      proxy: {
        // 将 /ws 和 /api 请求代理到 server（默认 3030 端口）
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // 修复：在依赖预构建阶段显式加入 react 相关入口，避免 rolldown 解析 `react/jsx-runtime`
      // / `react/jsx-dev-runtime` 时返回无后缀路径导致的加载失败（UNLOADABLE_DEPENDENCY）。
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
        // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
        // 只关闭 worker 构建的摇树，避免影响主包。
        treeshake: false,
      },
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(
        resolveRemoteFrontendVersion(version, process.env.WEB_REMOTE_FRONTEND_VERSION),
      ),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // 兼容旧 Web runtime 读取名；新代码统一读 VITE_ZCODE_BASE_URL。
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
    },
    build: {
      // 三个入口各自独立产物：普通 Web（dist）、Remote（dist-mobile-remote）、
      // Shell（dist-mobile-shell）。分开目录避免互相清空，也能独立核对 bundle 边界。
      outDir: mobileEntry
        ? "dist-mobile-remote"
        : mobileShellEntry
          ? "dist-mobile-shell"
          : "dist",
      emptyOutDir: true,
      rollupOptions: mobileEntry
        ? { input: { index: resolve(HERE, "mobile.html") } }
        : mobileShellEntry
          ? { input: { index: resolve(HERE, "mobile-shell.html") } }
          : undefined,
      // 生产不在浏览器产物暴露 sourceMappingURL，避免客户端侧还原业务源码。
      // Shell 直接同步进 APK 且没有二次冻结步骤，因此不生成 sourcemap 文件。
      sourcemap: mobileShellEntry ? false : mode === "production" || mobileEntry ? "hidden" : true,
    },
  };
});
