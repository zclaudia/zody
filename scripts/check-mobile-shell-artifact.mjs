#!/usr/bin/env node
// Shell 轻壳产物断言（M2-T1）。
//
// Shell 只包含配对/设置/discovery/选电脑，必须：
// - 有 WebViewAssetLoader 固定入口 index.html（源 mobile-shell.html 已在 Vite 产物中改名）；
// - 至少包含构建后的 JS 与 CSS；
// - 不含 sourcemap、PDF.js CMaps 或 Remote 工作台代码标记。
//
// 普通 Web（dist）和 Remote（dist-mobile-remote）的插件/产物契约不受本脚本影响。
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_DIST_DIR = resolve(REPO_ROOT, "packages/web/dist-mobile-shell");
const ENTRY_HTML = "index.html";
const SOURCE_HTML = "mobile-shell.html";

// Remote 专属的 PDF.js 资源与所有 sourcemap 都不属于轻壳。
const FORBIDDEN_EXTENSIONS = [".map", ".cmap", ".bcmap"];
// material-icons 的 pdf.svg 是通用文件类型图标，不属于 PDF.js；只拒绝 pdfjs/worker/cmap 资源。
const FORBIDDEN_FILE_PATTERN = /(?:^|\/)(?:pdfjs|pdf\.worker)(?:[.-]|$)/iu;

// 只用于诊断的稳定源码标记；命中说明 Remote 工作台被打进了 Shell。
const REMOTE_WORKBENCH_MARKERS = [
  "bootstrapGatewayWebRemoteControl",
  "GatewayTerminalTransport",
  "createAcknowledgedWebRemoteControlRelayProtocol",
  // `@zody/ui/mobile-shell` 子入口若意外回退到根入口，会把 PDF/Office 预览重新带进来。
  "pdfjs-dist",
  "react-pdf",
  "pptxRendererPreviewEngine",
  "previewPaneOffice",
];

async function walkFiles(dir, relativeDir = "") {
  const entries = await readdir(resolve(dir, relativeDir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const stats = await stat(resolve(dir, relativePath));
    if (stats.isDirectory()) {
      files.push(...(await walkFiles(dir, relativePath)));
    } else if (stats.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function main() {
  if (!existsSync(DEFAULT_DIST_DIR)) {
    console.error(
      `[mobile-shell-artifact] 缺少 Shell 产物：${relative(REPO_ROOT, DEFAULT_DIST_DIR)}。` +
        "先运行 `pnpm build:mobile-shell`。",
    );
    process.exit(1);
  }

  const files = await walkFiles(DEFAULT_DIST_DIR);
  const failures = [];

  if (!files.includes(ENTRY_HTML)) {
    failures.push(`缺少固定入口 ${ENTRY_HTML}`);
  }
  if (files.includes(SOURCE_HTML)) {
    failures.push(`产物仍包含未改名的 ${SOURCE_HTML}`);
  }
  if (!files.some((file) => file.endsWith(".js"))) {
    failures.push("缺少构建后的 JS");
  }
  if (!files.some((file) => file.endsWith(".css"))) {
    failures.push("缺少构建后的 CSS");
  }

  for (const file of files) {
    if (FORBIDDEN_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      failures.push(`包含 Remote/sourcemap 专属资源：${file}`);
    }
    if (FORBIDDEN_FILE_PATTERN.test(file)) {
      failures.push(`包含 PDF.js 资源：${file}`);
    }
  }

  for (const file of files.filter(
    (candidate) => candidate.endsWith(".js") || candidate.endsWith(".html"),
  )) {
    const text = await readFile(resolve(DEFAULT_DIST_DIR, file), "utf8");
    for (const marker of REMOTE_WORKBENCH_MARKERS) {
      if (text.includes(marker)) {
        failures.push(`包含 Remote 工作台标记 "${marker}"：${file}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("[mobile-shell-artifact] 断言失败：");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `[mobile-shell-artifact] OK：${files.length} 个文件，入口 ${ENTRY_HTML}，无 sourcemap/PDF.js/Remote 工作台资源`,
  );
}

await main();
