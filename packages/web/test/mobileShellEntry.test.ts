// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";

/**
 * Shell 独立入口（M2-T1）。
 *
 * 锁定三件事：
 * 1. `mobile-shell.html` 只挂载 Shell 入口，并保留移动端主题/安全区启动壳；
 * 2. Shell 模块图不包含 Remote bootstrap、GatewayTerminalTransport 或普通 Web 入口；
 * 3. Vite 的三个 mode 产物目录/入口互相隔离，Shell 不启用 PDF.js CMaps 插件。
 *
 * 真实构建产物另由 `scripts/check-mobile-shell-artifact.mjs` 在 `pnpm build:mobile-shell`
 * 末尾断言；这里在产物存在时补一次只读检查。
 */

const WEB_ROOT = resolve(import.meta.dirname, "..");
const SHELL_HTML = resolve(WEB_ROOT, "mobile-shell.html");
const SHELL_ENTRY = "src/mobile-shell/main.tsx";
const WEB_ENTRY = "src/main.tsx";
const SHELL_DIST = resolve(WEB_ROOT, "dist-mobile-shell");

function resolveLocalModule(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
}

function collectLocalImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers = new Set<string>();
  const pattern = /(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier?.startsWith(".")) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function collectModuleGraph(entry: string, resolveSpecifier = resolveLocalModule): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of collectLocalImports(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return visited;
}

const UI_ROOT = resolve(WEB_ROOT, "../ui");

/** UI 包内部大量使用 `@/` 别名；解析时映射到 packages/ui/src。 */
function resolveUiModule(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) {
    return resolveLocalModule(resolve(UI_ROOT, "src/index.ts"), `./${specifier.slice(2)}`);
  }
  return resolveLocalModule(fromFile, specifier);
}

async function loadWebConfig(mode: string) {
  const configFile = resolve(WEB_ROOT, "vite.config.ts");
  return loadConfigFromFile(
    { command: "build", mode, isPreview: false, isSsrBuild: false },
    configFile,
    WEB_ROOT,
    "silent",
  );
}

describe("Shell 独立入口 mobile-shell.html", () => {
  it("挂载 Shell 入口并保留移动端主题/安全区启动壳", () => {
    const html = readFileSync(SHELL_HTML, "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    const script = document.querySelector<HTMLScriptElement>('script[type="module"]');

    expect(script?.getAttribute("src")).toBe(`/${SHELL_ENTRY}`);
    expect(document.querySelector("#root")).not.toBeNull();
    expect(html).toContain("data-zcode-browser-theme-surface");
    expect(html).toContain("data-zcode-bootstrap-theme");
    expect(html).toContain("viewport-fit=cover");
  });

  it("Shell 模块图不包含 Remote bootstrap / transport 或普通 Web 入口", () => {
    const graph = collectModuleGraph(resolve(WEB_ROOT, SHELL_ENTRY));
    const relativePaths = [...graph].map((file) => file.replace(`${WEB_ROOT}/`, ""));

    expect(relativePaths).toContain(SHELL_ENTRY);
    expect(relativePaths).toContain("src/mobile-shell/bootstrap.ts");
    expect(relativePaths).toContain("src/mobile-shell/mobileShellConfigClient.ts");
    expect(relativePaths).toContain("src/mobile-remote/mobileRemoteSetup.tsx");
    expect(relativePaths).toContain("src/mobile-remote/mobileRemoteBackendDiscovery.ts");

    expect(relativePaths).not.toContain("src/mobile-remote/bootstrap.tsx");
    expect(relativePaths).not.toContain("src/mobile-remote/main.tsx");
    expect(relativePaths).not.toContain("src/mobile-remote/gatewayTerminalTransport.ts");
    expect(relativePaths).not.toContain(WEB_ENTRY);
  });

  it("@zcode/ui/mobile-shell 子入口不会传递依赖 Remote/PDF 工作台", () => {
    const graph = collectModuleGraph(
      resolve(UI_ROOT, "src/mobileShell.ts"),
      resolveUiModule,
    );
    const relativePaths = [...graph].map((file) => file.replace(`${UI_ROOT}/`, ""));

    expect(relativePaths).toContain("src/WebRemoteControlMobileSettingsScreen.tsx");
    expect(relativePaths).toContain("src/WebRemoteControlMobileBackendPicker.tsx");
    expect(relativePaths).toContain("src/i18n/IntlProvider.tsx");

    expect(relativePaths.filter((path) => /(?:^|\/)(?:Root|App)\.tsx?$/u.test(path))).toEqual([]);
    expect(
      relativePaths.filter((path) => /(?:previewPane|pdf|RemoteControlMobileStartPage|Terminal)/iu.test(path)),
    ).toEqual([]);
  });
});

describe("Web Vite 三入口隔离", () => {
  it("mobile-shell mode 输出 dist-mobile-shell 与独立 HTML 入口", async () => {
    const shell = await loadWebConfig("mobile-shell");
    expect(shell?.config.build?.outDir).toBe("dist-mobile-shell");
    expect(shell?.config.build?.rollupOptions?.input).toMatchObject({
      index: resolve(WEB_ROOT, "mobile-shell.html"),
    });
  });

  it("Shell 跳过 PDF.js CMaps 插件，Remote 与普通 Web 保持原插件", async () => {
    const pluginNames = async (mode: string) => {
      const plugins = ((await loadWebConfig(mode))?.config.plugins ?? []) as unknown[];
      return plugins.flat(Infinity).map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name: unknown }).name)
          : undefined,
      );
    };

    expect(await pluginNames("mobile-shell")).not.toContain("zcode:pdfjs-cmaps");
    expect(await pluginNames("mobile")).toContain("zcode:pdfjs-cmaps");
    expect(await pluginNames("production")).toContain("zcode:pdfjs-cmaps");
    expect(await pluginNames("mobile-shell")).toContain("zcode:mobile-shell-entry");
  });

  it("Remote 与普通 Web 的产物目录保持 M1 契约", async () => {
    const remote = await loadWebConfig("mobile");
    const web = await loadWebConfig("production");

    expect(remote?.config.build?.outDir).toBe("dist-mobile-remote");
    expect(remote?.config.build?.rollupOptions?.input).toMatchObject({
      index: resolve(WEB_ROOT, "mobile.html"),
    });
    expect(web?.config.build?.outDir).toBe("dist");
    expect(web?.config.build?.rollupOptions?.input).toBeUndefined();
  });
});

describe.runIf(existsSync(resolve(SHELL_DIST, "index.html")))(
  "已构建 Shell 产物只读断言",
  () => {
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = resolve(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    }

    it("有 index.html 与 JS/CSS，且没有 PDF.js / sourcemap 资源", () => {
      const html = readFileSync(resolve(SHELL_DIST, "index.html"), "utf8");
      const files = walk(SHELL_DIST).map((file) => file.replace(`${SHELL_DIST}/`, ""));

      expect(html).toContain('id="root"');
      expect(files.some((file) => file.endsWith(".js"))).toBe(true);
      expect(files.some((file) => file.endsWith(".css"))).toBe(true);
      expect(files).not.toContain("mobile-shell.html");
      expect(
        files.filter((file) => /\.(?:map|cmap|bcmap)$/u.test(file)),
      ).toEqual([]);
      expect(
        files.filter((file) => /(?:^|\/)(?:pdfjs|pdf\.worker)(?:[.-]|$)/iu.test(file)),
      ).toEqual([]);
    });
  },
);
