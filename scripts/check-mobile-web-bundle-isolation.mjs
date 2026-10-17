#!/usr/bin/env node
// 校验手机远控入口的产物隔离（T1.2，方案「Android 壳 · 内置页面」）：
//   1. 普通 Web 客户端构建产物（packages/web/dist）不得包含 @zclaudia/gateway-client；
//   2. 手机入口产物（packages/web/dist-mobile-remote）必须存在，且入口是 mobile.html。
// 只扫代码类产物（.js/.mjs/.css/.html/.map）：dist 里的 THIRD-PARTY-NOTICES.md 会列出依赖名，
// 那是许可证清单而不是被打进 bundle 的代码，不能作为命中依据。
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WEB_DIST = resolve(REPO_ROOT, "packages/web/dist");
const MOBILE_DIST = resolve(REPO_ROOT, "packages/web/dist-mobile-remote");
const MOBILE_ENTRY_HTML = "mobile.html";

// gateway-client（0.3.0）里只可能来自该 SDK 的标记：包名 + SDK 的 API 名。
// 不用 `peer_hello`：shared 的 web-remote-control-channel.ts 注释里也有这个词，而普通 Web
// 客户端合法引用 shared 后，source map 的 sourcesContent 会把它带进 .map，造成假阳性。
const GATEWAY_CLIENT_MARKERS = ["@zclaudia/gateway-client", "@zclaudia/", "discoverBackends"];

const SCANNED_EXTENSIONS = [".js", ".mjs", ".css", ".html", ".map"];

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
      continue;
    }
    if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

async function scanBundle(dir) {
  const files = await walkFiles(dir);
  const hits = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const marker of GATEWAY_CLIENT_MARKERS) {
      if (text.includes(marker)) {
        hits.push({ file: relative(REPO_ROOT, file), marker });
      }
    }
  }
  return { fileCount: files.length, hits };
}

async function main() {
  if (!existsSync(WEB_DIST)) {
    console.error(
      `[mobile-web-isolation] 缺少普通 Web 客户端产物：${relative(REPO_ROOT, WEB_DIST)}。` +
        "先运行 `pnpm --filter @zcode/web build`。",
    );
    process.exit(1);
  }

  const webBundle = await scanBundle(WEB_DIST);
  console.log(
    `[mobile-web-isolation] 普通 Web 客户端产物：${webBundle.fileCount} 个代码文件，` +
      `命中 ${webBundle.hits.length} 处 gateway-client 标记`,
  );

  const mobileExists = existsSync(MOBILE_DIST);
  const mobileEntry = mobileExists ? resolve(MOBILE_DIST, MOBILE_ENTRY_HTML) : undefined;
  const mobileEntryExists = mobileEntry !== undefined && (await stat(mobileEntry)).isFile();
  if (mobileExists) {
    const mobileBundle = await scanBundle(MOBILE_DIST);
    console.log(
      `[mobile-web-isolation] 手机入口产物：${relative(REPO_ROOT, MOBILE_DIST)}，` +
        `${mobileBundle.fileCount} 个代码文件，入口 ${MOBILE_ENTRY_HTML} ${
          mobileEntryExists ? "存在" : "缺失"
        }（允许包含 gateway-client）`,
    );
  } else {
    console.log(
      `[mobile-web-isolation] 未发现手机入口产物：${relative(REPO_ROOT, MOBILE_DIST)}；` +
        "运行 `pnpm build:mobile-web` 后本项才会检查入口文件。",
    );
  }

  if (webBundle.hits.length > 0) {
    console.error("[mobile-web-isolation] 普通 Web 客户端产物里出现了 gateway-client：");
    for (const hit of webBundle.hits.slice(0, 20)) {
      console.error(`  - ${hit.file} ← ${hit.marker}`);
    }
    console.error(
      "手机远控代码必须只经 mobile.html 入口打包；普通 Web 客户端入口不应引用 @zclaudia/gateway-client。",
    );
    process.exit(1);
  }

  if (mobileExists && !mobileEntryExists) {
    console.error(
      `[mobile-web-isolation] 手机入口产物缺少 ${MOBILE_ENTRY_HTML}：` +
        `${relative(REPO_ROOT, MOBILE_DIST)}`,
    );
    process.exit(1);
  }

  console.log("[mobile-web-isolation] OK");
}

await main();
