#!/usr/bin/env node
// 构建并冻结手机 Remote UI 发布制品（spec: specs/mobile-remote-ui-desktop-delivery.md 第 4 节）。
//
// 产物布局（packages/web/dist-mobile-remote）：
//   index.html   由 Vite 的 mobile.html 规范化而来，注入 <meta name="zody-mobile-ui-release">
//   release.json 严格 manifest（schema 来自 @zcode/shared 的 mobile-ui-release）
//   assets/ ...  Vite 内容哈希资源与其它静态资源；不含 sourcemap
//
// 确定性：releaseId 只由格式版本、desktopVersion 与 assetDigest 计算；assetDigest 只由制品文件的
// 相对路径（统一 `/`，按码点排序）与字节内容计算，不读取 mtime、构建目录或随机值。
// release meta 自身不参与摘要（否则 releaseId 与 HTML 互相依赖）：计算摘要时 index.html 先剥离该 meta，
// 校验时同样剥离，因此重复注入只会得到同一个 meta。
import { spawn } from "node:child_process";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { tsImport } from "tsx/esm/api";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_DIST_DIR = resolve(REPO_ROOT, "packages/web/dist-mobile-remote");

const VITE_HTML_NAME = "mobile.html";
const ENTRY_HTML_NAME = "index.html";
const BASE_PATH = "/assets/remote/";

// 摘要格式版本；改变摘要算法时递增，使旧 releaseId 不会与新算法碰撞。
const DIGEST_FORMAT = "zody-mobile-ui-asset-digest:v1";
const RELEASE_ID_FORMAT = "zody-mobile-ui-release:v1";

// 机器相关或临时文件不进入制品，也不参与摘要。
const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const EXCLUDED_FILE_PATTERN = /(?:\.map|\.tmp|\.swp|~)$/u;

const META_PATTERN = /<meta name="zody-mobile-ui-release" content="[^"]*" \/>\n?/gu;

let sharedContractPromise;
/** 复用 shared 的 schema 与常量，避免脚本里再复制一份契约。 */
function loadSharedContract() {
  sharedContractPromise ??= tsImport(
    pathToFileURL(resolve(REPO_ROOT, "packages/shared/src/mobile-ui-release.ts")).href,
    import.meta.url,
  );
  return sharedContractPromise;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isExcluded(name) {
  return EXCLUDED_FILE_NAMES.has(name) || EXCLUDED_FILE_PATTERN.test(name);
}

/** 递归列出制品文件（相对路径，统一 `/`）；符号链接和非常规文件一律 fail closed。 */
async function listArtifactFiles(rootDir, relativeDir = "") {
  const entries = await readdir(resolve(rootDir, relativeDir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDir ? posix.join(relativeDir, entry.name) : entry.name;
    const stats = await lstat(resolve(rootDir, relativePath));
    if (stats.isSymbolicLink()) {
      throw new Error(`Mobile UI artifact must not contain symbolic links: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      files.push(...(await listArtifactFiles(rootDir, relativePath)));
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Mobile UI artifact contains a non-regular file: ${relativePath}`);
    }
    files.push(relativePath);
  }
  return files;
}

/** 去掉 release meta，得到摘要使用的 HTML 基线。 */
export function stripReleaseMeta(html) {
  return html.replace(META_PATTERN, "");
}

/** 注入（或替换）release meta；重复调用只会保留一个。 */
export async function injectReleaseMeta(html, releaseId) {
  const { MOBILE_UI_RELEASE_META_NAME } = await loadSharedContract();
  const baseline = stripReleaseMeta(html);
  if (!baseline.includes("</head>")) {
    throw new Error("Mobile UI entry HTML has no </head> to inject the release meta");
  }
  const meta = `<meta name="${MOBILE_UI_RELEASE_META_NAME}" content="${releaseId}" />\n`;
  return baseline.replace("</head>", `${meta}</head>`);
}

/** 读取 release meta 的 content；缺失或出现多处返回 undefined/抛错，由调用方 fail closed。 */
export function readReleaseMeta(html) {
  const matches = [...html.matchAll(/<meta name="zody-mobile-ui-release" content="([^"]*)" \/>/gu)];
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error("Mobile UI entry HTML contains multiple release metas");
  return matches[0][1];
}

/** 全部制品文件的路径与字节内容摘要（index.html 以剥离 meta 的基线参与）。 */
export async function computeAssetDigest(distDir) {
  const files = (await listArtifactFiles(distDir))
    .filter((file) => {
      const name = posix.basename(file);
      // release.json 是摘要的产物，不能参与自身。
      return !isExcluded(name) && file !== "release.json";
    })
    .sort(compareCodePoints);
  if (files.length === 0) {
    throw new Error(`Mobile UI artifact is empty: ${distDir}`);
  }
  const digest = createHash("sha256").update(`${DIGEST_FORMAT}\n`);
  for (const file of files) {
    let bytes = await readFile(resolve(distDir, file));
    if (file === ENTRY_HTML_NAME) {
      bytes = Buffer.from(stripReleaseMeta(bytes.toString("utf8")), "utf8");
    }
    digest.update(`${file}\0${sha256(bytes)}\n`);
  }
  return digest.digest("hex");
}

/** releaseId = sha256(格式版本 + desktopVersion + assetDigest) 的前 24 位。 */
export function computeReleaseId({ desktopVersion, assetDigest }) {
  return sha256(`${RELEASE_ID_FORMAT}\0${desktopVersion}\0${assetDigest}`).slice(0, 24);
}

/** 入口 HTML 里所有指向 Remote base 的 src/href，必须在制品中真实存在。 */
export function collectReferencedAssets(html) {
  const references = new Set();
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/gu)) {
    const value = match[1];
    if (!value.startsWith(BASE_PATH)) continue;
    const path = value.slice(BASE_PATH.length).split(/[?#]/u)[0];
    if (path) references.add(decodeURIComponent(path));
  }
  return [...references].sort(compareCodePoints);
}

async function assertFileExists(distDir, relativePath, label) {
  const stats = await lstat(resolve(distDir, relativePath)).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new Error(`Mobile UI artifact is missing ${label}: ${relativePath}`);
  }
}

async function removeExcludedFiles(distDir) {
  for (const file of await listArtifactFiles(distDir)) {
    if (isExcluded(posix.basename(file))) {
      await rm(resolve(distDir, file), { force: true });
    }
  }
}

/**
 * 把 Vite 产物冻结为发布制品：mobile.html → index.html、清理 sourcemap/临时文件、
 * 校验引用资源、写入 release.json 与 HTML meta。已规范化的目录可重复调用，结果不变。
 */
export async function finalizeMobileWebRelease({ distDir = DEFAULT_DIST_DIR, desktopVersion }) {
  if (typeof desktopVersion !== "string" || desktopVersion.length === 0) {
    throw new Error("desktopVersion is required to finalize the mobile UI release");
  }
  const contract = await loadSharedContract();
  const viteHtml = resolve(distDir, VITE_HTML_NAME);
  const entryHtml = resolve(distDir, ENTRY_HTML_NAME);
  const hasViteHtml = await lstat(viteHtml).then(
    (stats) => stats.isFile(),
    () => false,
  );
  const hasEntryHtml = await lstat(entryHtml).then(
    (stats) => stats.isFile(),
    () => false,
  );
  if (hasViteHtml && hasEntryHtml) {
    throw new Error(`Ambiguous mobile UI artifact: both ${VITE_HTML_NAME} and ${ENTRY_HTML_NAME}`);
  }
  if (!hasViteHtml && !hasEntryHtml) {
    throw new Error(`Mobile UI artifact is missing entry HTML: ${distDir}`);
  }
  if (hasViteHtml) {
    await rename(viteHtml, entryHtml);
  }

  await removeExcludedFiles(distDir);
  const baselineHtml = stripReleaseMeta(await readFile(entryHtml, "utf8"));
  const referenced = collectReferencedAssets(baselineHtml);
  if (referenced.length === 0) {
    throw new Error("Mobile UI entry HTML references no assets under /assets/remote/");
  }
  for (const asset of referenced) {
    await assertFileExists(distDir, asset, "referenced asset");
  }

  // 先把剥离 meta 的基线写回，摘要对 HTML 的取值才与校验阶段一致。
  await writeFile(entryHtml, baselineHtml, "utf8");
  const assetDigest = await computeAssetDigest(distDir);
  const releaseId = computeReleaseId({ desktopVersion, assetDigest });
  await writeFile(entryHtml, await injectReleaseMeta(baselineHtml, releaseId), "utf8");

  const manifest = contract.parseMobileUiReleaseManifest({
    schemaVersion: contract.MOBILE_UI_RELEASE_SCHEMA_VERSION,
    releaseId,
    desktopVersion,
    supportedBridgeVersions: [contract.MOBILE_UI_RELEASE_BRIDGE_VERSION_V1],
    entry: contract.MOBILE_UI_RELEASE_ENTRY,
    assetDigest,
  });
  await writeFile(
    resolve(distDir, contract.MOBILE_UI_RELEASE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

/**
 * 校验已冻结的制品：manifest 合法、入口 HTML 的 meta 与 manifest 一致、摘要和 releaseId 可复算、
 * 引用资源齐全且不含 sourcemap。任何一项缺失都抛错（fail closed），供桌面打包与 provider 复用。
 */
export async function verifyMobileWebRelease({ distDir = DEFAULT_DIST_DIR }) {
  const contract = await loadSharedContract();
  const manifestPath = resolve(distDir, contract.MOBILE_UI_RELEASE_MANIFEST_FILE);
  const manifest = contract.parseMobileUiReleaseManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  await assertFileExists(distDir, ENTRY_HTML_NAME, "entry HTML");
  const html = await readFile(resolve(distDir, ENTRY_HTML_NAME), "utf8");
  if (readReleaseMeta(html) !== manifest.releaseId) {
    throw new Error("Mobile UI entry HTML release meta does not match release.json");
  }
  for (const asset of collectReferencedAssets(html)) {
    await assertFileExists(distDir, asset, "referenced asset");
  }
  const files = await listArtifactFiles(distDir);
  const sourcemap = files.find((file) => file.endsWith(".map"));
  if (sourcemap) {
    throw new Error(`Mobile UI artifact must not contain sourcemaps: ${sourcemap}`);
  }
  const assetDigest = await computeAssetDigest(distDir);
  if (assetDigest !== manifest.assetDigest) {
    throw new Error("Mobile UI artifact bytes do not match release.json assetDigest");
  }
  const releaseId = computeReleaseId({ desktopVersion: manifest.desktopVersion, assetDigest });
  if (releaseId !== manifest.releaseId) {
    throw new Error("Mobile UI releaseId cannot be recomputed from release.json");
  }
  return manifest;
}

function runViteBuild({ root }) {
  // Windows 上 pnpm 是 .cmd 文件；与 scripts/mise-run.mjs 保持同一启动方式。
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      command,
      [
        "--filter",
        "@zcode/web",
        "exec",
        "vite",
        "build",
        "--mode",
        "mobile",
        `--base=${BASE_PATH}`,
      ],
      { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`vite build failed (${signal ?? `exit ${code}`})`));
    });
  });
}

/** 完整流程：Vite 构建 → 冻结制品 → 复核。`runBuild` 可注入，便于测试。 */
export async function buildMobileWebRelease({
  root = REPO_ROOT,
  distDir = resolve(root, "packages/web/dist-mobile-remote"),
  runBuild = runViteBuild,
} = {}) {
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await runBuild({ root, distDir });
  await finalizeMobileWebRelease({ distDir, desktopVersion: version });
  return verifyMobileWebRelease({ distDir });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const manifest = await buildMobileWebRelease();
    console.log(
      `[mobile-web-release] releaseId=${manifest.releaseId} desktopVersion=${manifest.desktopVersion} ` +
        `assetDigest=${manifest.assetDigest}`,
    );
  } catch (error) {
    console.error(`[mobile-web-release] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
