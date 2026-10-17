// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 手机独立入口（T1.2）。
 * 方案「Android 壳 · 内置页面」要求手机页面单独一个 Vite entry、不复用桌面 Web 客户端的入口，
 * 并且普通 Web 客户端构建产物里不能出现 `@zclaudia/gateway-client`。
 * 产物层面的检查由 `scripts/check-mobile-web-bundle-isolation.mjs`（`pnpm check:mobile-web-isolation`）负责，
 * 这里锁定入口文件结构与「手机入口不依赖桌面 Web 客户端入口」这条源码不变量。
 */

const WEB_ROOT = resolve(import.meta.dirname, "..");
const MOBILE_HTML = resolve(WEB_ROOT, "mobile.html");
const WEB_HTML = resolve(WEB_ROOT, "index.html");
const MOBILE_ENTRY = "src/mobile-remote/main.tsx";
const WEB_ENTRY = "src/main.tsx";

/** 解析相对导入（仓库源码里 `.js` 后缀指向 `.ts`/`.tsx` 源文件）。 */
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

/** 从入口出发遍历相对导入图，返回访问到的文件（绝对路径）。 */
function collectModuleGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of collectLocalImports(file)) {
      const resolved = resolveLocalModule(file, specifier);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return visited;
}

describe("手机独立入口 mobile.html", () => {
  it("挂载手机入口模块，并保留预热主题的启动壳", () => {
    const html = readFileSync(MOBILE_HTML, "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    const script = document.querySelector<HTMLScriptElement>('script[type="module"]');

    expect(script?.getAttribute("src")).toBe(`/${MOBILE_ENTRY}`);
    expect(document.querySelector("#root")).not.toBeNull();
    // 与 index.html 同因：bundle 执行前先把主题写到 html 根，避免手机 WebView 首帧白底。
    expect(html).toContain("data-zcode-browser-theme-surface");
    expect(html).toContain("data-zcode-bootstrap-theme");
    expect(html).toContain("viewport-fit=cover");
  });

  it("不复用桌面 Web 客户端入口，也不与其共用 HTML 入口文件", () => {
    const mobileHtml = readFileSync(MOBILE_HTML, "utf8");
    const webHtml = readFileSync(WEB_HTML, "utf8");

    expect(mobileHtml).not.toContain(`/${WEB_ENTRY}"`);
    expect(webHtml).not.toContain(`/${MOBILE_ENTRY}"`);
    expect(webHtml).toContain(`/${WEB_ENTRY}"`);
  });

  it("手机入口的模块图不包含桌面 Web 客户端入口", () => {
    const graph = collectModuleGraph(resolve(WEB_ROOT, MOBILE_ENTRY));
    const relativePaths = [...graph].map((file) => file.replace(`${WEB_ROOT}/`, ""));

    expect(relativePaths).toContain(MOBILE_ENTRY);
    expect(relativePaths).toContain("src/mobile-remote/bootstrap.tsx");
    // 桌面 Web 客户端的 OAuth、分享页与 `/web-remote` 旧路径都不属于手机页面。
    expect(relativePaths).not.toContain(WEB_ENTRY);
    expect(relativePaths.filter((path) => path.startsWith("src/auth/"))).toEqual([]);
    expect(relativePaths.filter((path) => path.startsWith("src/share/"))).toEqual([]);
  });
});
