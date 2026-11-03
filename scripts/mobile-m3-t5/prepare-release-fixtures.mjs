#!/usr/bin/env node
/**
 * M3-T5 发布夹具：从当前 `pnpm build:mobile-web` 的制品复制出可独立提供服务的
 * release A/B、bridge 不兼容版本和无效 manifest 版本。
 *
 * 目的：真实 Gateway + Android WebView 需要同一 backend 下依次切换制品根目录，
 * 观察 release A→B→A 的检测、二次确认、限频与回滚。夹具只改变制品字节/清单，
 * 不改动仓库内源文件，也不写入任何凭证。
 *
 * 用法：
 *   node --import tsx scripts/mobile-m3-t5/prepare-release-fixtures.mjs [outputDir]
 *
 * 输出（默认 /tmp/zody-m3-releases）：
 *   a/           当前 dist-mobile-remote 的拷贝（releaseId A）
 *   b/           A + 一个 CSS 注释，重新冻结为 releaseId B
 *   incompatible/ B 的拷贝，supportedBridgeVersions=[2]（bridge 不兼容）
 *   invalid/     A 的拷贝，release.json 为无效 schema
 *   fixtures.json 各 releaseId / baseline 摘要
 */
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = resolve(repoRoot, "packages/web/dist-mobile-remote");
const outputDir = resolve(process.argv[2] || "/tmp/zody-m3-releases");

const buildScriptUrl = pathToFileURL(
  resolve(repoRoot, "scripts/build-mobile-web-release.mjs"),
).href;
const { finalizeMobileWebRelease, verifyMobileWebRelease } = await import(buildScriptUrl);

async function findFirstFile(dir, predicate) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstFile(full, predicate);
      if (nested) return nested;
    } else if (predicate(entry.name)) {
      return full;
    }
  }
  return undefined;
}

async function copyRelease(name) {
  const target = resolve(outputDir, name);
  await rm(target, { recursive: true, force: true });
  await cp(sourceDir, target, { recursive: true });
  return target;
}

await mkdir(outputDir, { recursive: true });
const a = await copyRelease("a");
const b = await copyRelease("b");

// 真实重建会改变内容哈希文件名；这里显式改名并更新 HTML 引用，才能验证旧 hash 404。
async function varyCssRelease(dir, marker, suffix) {
  const cssFile = await findFirstFile(dir, (name) => name.endsWith(".css"));
  if (!cssFile) throw new Error("release fixture has no CSS asset to vary");
  const oldName = cssFile.slice(cssFile.lastIndexOf("/") + 1);
  const newName = oldName.replace(/\.css$/u, `-${suffix}.css`);
  const newFile = cssFile.slice(0, cssFile.lastIndexOf("/") + 1) + newName;
  await writeFile(cssFile, `${await readFile(cssFile, "utf8")}\n/* ${marker} */\n`, "utf8");
  await rename(cssFile, newFile);
  const htmlPath = resolve(dir, "index.html");
  const html = await readFile(htmlPath, "utf8");
  if (!html.includes(oldName)) throw new Error(`entry HTML does not reference ${oldName}`);
  await writeFile(htmlPath, html.replaceAll(oldName, newName), "utf8");
}

await varyCssRelease(b, "m3-t5 release B", "m3b");
const manifestB = await finalizeMobileWebRelease({ distDir: b, desktopVersion: "0.1.0" });
await verifyMobileWebRelease({ distDir: b });

const incompatible = await copyRelease("incompatible");
await varyCssRelease(incompatible, "m3-t5 bridge-incompatible release", "m3i");
const manifestIncompatible = await finalizeMobileWebRelease({
  distDir: incompatible,
  desktopVersion: "0.1.0",
});
const incompatibleManifestPath = resolve(incompatible, "release.json");
const incompatibleManifest = JSON.parse(await readFile(incompatibleManifestPath, "utf8"));
incompatibleManifest.supportedBridgeVersions = [2];
await writeFile(
  incompatibleManifestPath,
  `${JSON.stringify(incompatibleManifest, null, 2)}\n`,
  "utf8",
);

const invalid = await copyRelease("invalid");
await writeFile(
  resolve(invalid, "release.json"),
  '{"schemaVersion":99,"releaseId":"not-a-release","desktopVersion":"0.1.0"}\n',
  "utf8",
);

const manifestA = await verifyMobileWebRelease({ distDir: a });
const fixtures = {
  outputDir,
  a: { releaseId: manifestA.releaseId, assetDigest: manifestA.assetDigest },
  b: { releaseId: manifestB.releaseId, assetDigest: manifestB.assetDigest },
  incompatible: {
    releaseId: manifestIncompatible.releaseId,
    supportedBridgeVersions: incompatibleManifest.supportedBridgeVersions,
  },
  invalid: { description: "invalid release.json schema" },
};
await writeFile(resolve(outputDir, "fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(JSON.stringify(fixtures, null, 2));
