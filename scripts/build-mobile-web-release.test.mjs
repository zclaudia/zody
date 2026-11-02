import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildMobileWebRelease,
  collectReferencedAssets,
  computeAssetDigest,
  computeReleaseId,
  finalizeMobileWebRelease,
  injectReleaseMeta,
  readReleaseMeta,
  stripReleaseMeta,
  verifyMobileWebRelease,
} from "./build-mobile-web-release.mjs";

const HTML = `<!doctype html>
<html>
  <head>
    <link rel="icon" href="/assets/remote/favicon.ico" />
    <script type="module" crossorigin src="/assets/remote/assets/index-AAAA.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/remote/assets/index-BBBB.css" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

/** 构造一份与 Vite 产物同形的目录：mobile.html、哈希资源、静态资源和 hidden sourcemap。 */
async function writeViteOutput(dir, overrides = {}) {
  await mkdir(join(dir, "assets"), { recursive: true });
  await mkdir(join(dir, "pdfjs"), { recursive: true });
  await writeFile(join(dir, "mobile.html"), overrides.html ?? HTML);
  await writeFile(join(dir, "favicon.ico"), "icon");
  await writeFile(join(dir, "assets/index-AAAA.js"), overrides.js ?? "console.log('a');");
  await writeFile(join(dir, "assets/index-BBBB.css"), "body{}");
  await writeFile(join(dir, "assets/index-AAAA.js.map"), "{}");
  await writeFile(join(dir, "pdfjs/worker.js"), "worker");
}

async function fixture(t, overrides) {
  const root = await mkdtemp(join(tmpdir(), "zody-mobile-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "dist");
  await writeViteOutput(dir, overrides);
  return { root, dir };
}

async function listAll(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listAll(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

test("规范化为 index.html，写入合法 manifest，并清理 sourcemap", async (t) => {
  const { dir } = await fixture(t);
  const manifest = await finalizeMobileWebRelease({ dir, distDir: dir, desktopVersion: "0.1.0" });

  assert.match(manifest.releaseId, /^[0-9a-f]{24}$/u);
  assert.match(manifest.assetDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(manifest.supportedBridgeVersions, [1]);
  assert.equal(manifest.entry, "/assets/remote/index.html");
  assert.equal(manifest.desktopVersion, "0.1.0");

  const files = await listAll(dir);
  assert.ok(files.includes("index.html"));
  assert.ok(files.includes("release.json"));
  assert.ok(!files.includes("mobile.html"));
  assert.deepEqual(
    files.filter((file) => file.endsWith(".map")),
    [],
  );
  assert.deepEqual(JSON.parse(await readFile(join(dir, "release.json"), "utf8")), manifest);
  await verifyMobileWebRelease({ distDir: dir });
});

test("HTML meta 与 release.json 一致，重复注入不产生多个基线", async (t) => {
  const { dir } = await fixture(t);
  const manifest = await finalizeMobileWebRelease({ distDir: dir, desktopVersion: "0.1.0" });
  const html = await readFile(join(dir, "index.html"), "utf8");
  assert.equal(readReleaseMeta(html), manifest.releaseId);
  assert.equal(html.match(/zody-mobile-ui-release/gu)?.length, 1);

  // 对已冻结目录重复执行：结果完全不变，meta 仍只有一个。
  const again = await finalizeMobileWebRelease({ distDir: dir, desktopVersion: "0.1.0" });
  assert.deepEqual(again, manifest);
  const htmlAgain = await readFile(join(dir, "index.html"), "utf8");
  assert.equal(htmlAgain, html);

  const injectedTwice = await injectReleaseMeta(
    await injectReleaseMeta(HTML, "0123456789abcdef01234567"),
    "fedcba987654321001234567",
  );
  assert.equal(injectedTwice.match(/zody-mobile-ui-release/gu)?.length, 1);
  assert.equal(readReleaseMeta(injectedTwice), "fedcba987654321001234567");
  assert.equal(stripReleaseMeta(injectedTwice), HTML);
});

test("多个 release meta 视为损坏", () => {
  const meta = '<meta name="zody-mobile-ui-release" content="0123456789abcdef01234567" />';
  assert.throws(() => readReleaseMeta(`${meta}${meta}`), /multiple release metas/u);
});

test("同一输入在不同构建目录、不同 mtime 下 releaseId 一致", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const old = new Date("2001-01-01T00:00:00Z");
  for (const file of await listAll(second.dir)) {
    await utimes(join(second.dir, file), old, old);
  }
  const a = await finalizeMobileWebRelease({ distDir: first.dir, desktopVersion: "0.1.0" });
  const b = await finalizeMobileWebRelease({ distDir: second.dir, desktopVersion: "0.1.0" });
  assert.equal(a.releaseId, b.releaseId);
  assert.equal(a.assetDigest, b.assetDigest);
});

test("任一字节变化或 desktopVersion 变化都会改变 releaseId", async (t) => {
  const base = await fixture(t);
  const changedJs = await fixture(t, { js: "console.log('b');" });
  const changedHtml = await fixture(t, { html: HTML.replace("<body>", "<body class='x'>") });
  const baseline = await finalizeMobileWebRelease({ distDir: base.dir, desktopVersion: "0.1.0" });
  const js = await finalizeMobileWebRelease({ distDir: changedJs.dir, desktopVersion: "0.1.0" });
  const html = await finalizeMobileWebRelease({
    distDir: changedHtml.dir,
    desktopVersion: "0.1.0",
  });
  assert.notEqual(js.releaseId, baseline.releaseId);
  assert.notEqual(html.releaseId, baseline.releaseId);
  assert.notEqual(js.assetDigest, baseline.assetDigest);

  const other = await fixture(t);
  const version = await finalizeMobileWebRelease({ distDir: other.dir, desktopVersion: "0.1.1" });
  assert.equal(version.assetDigest, baseline.assetDigest);
  assert.notEqual(version.releaseId, baseline.releaseId);
});

test("sourcemap 与临时文件不参与摘要", async (t) => {
  const { dir } = await fixture(t);
  const before = await computeAssetDigest(dir);
  await writeFile(join(dir, "assets/extra.js.map"), "different");
  await writeFile(join(dir, ".DS_Store"), "x");
  await writeFile(join(dir, "assets/leftover.tmp"), "x");
  assert.equal(await computeAssetDigest(dir), before);
});

test("摘要按路径码点排序，与文件系统枚举顺序无关", async (t) => {
  const { dir } = await fixture(t);
  const digest = await computeAssetDigest(dir);
  // 新建同内容目录但以相反顺序写入文件，摘要必须相同。
  const mirror = await mkdtemp(join(tmpdir(), "zody-mobile-release-mirror-"));
  t.after(() => rm(mirror, { recursive: true, force: true }));
  const files = (await listAll(dir)).reverse();
  for (const file of files) {
    await mkdir(join(mirror, file, ".."), { recursive: true });
    await cp(join(dir, file), join(mirror, file));
  }
  assert.equal(await computeAssetDigest(mirror), digest);
});

test("computeReleaseId 只依赖版本与摘要且为 24 位小写十六进制", () => {
  const digest = "a".repeat(64);
  const id = computeReleaseId({ desktopVersion: "0.1.0", assetDigest: digest });
  assert.match(id, /^[0-9a-f]{24}$/u);
  assert.equal(id, computeReleaseId({ desktopVersion: "0.1.0", assetDigest: digest }));
  assert.notEqual(id, computeReleaseId({ desktopVersion: "0.1.1", assetDigest: digest }));
  assert.notEqual(id, computeReleaseId({ desktopVersion: "0.1.0", assetDigest: "b".repeat(64) }));
});

test("collectReferencedAssets 只收集 Remote base 下的引用", () => {
  assert.deepEqual(
    collectReferencedAssets(
      `${HTML}<a href="https://example.com/x.js"></a><link href="/other/y.css" />`,
    ),
    ["assets/index-AAAA.js", "assets/index-BBBB.css", "favicon.ico"],
  );
});

test("入口 HTML、引用资源缺失时 fail closed", async (t) => {
  const noHtml = await fixture(t);
  await rm(join(noHtml.dir, "mobile.html"));
  await assert.rejects(
    finalizeMobileWebRelease({ distDir: noHtml.dir, desktopVersion: "0.1.0" }),
    /missing entry HTML/u,
  );

  const noAsset = await fixture(t);
  await rm(join(noAsset.dir, "assets/index-AAAA.js"));
  await assert.rejects(
    finalizeMobileWebRelease({ distDir: noAsset.dir, desktopVersion: "0.1.0" }),
    /missing referenced asset: assets\/index-AAAA\.js/u,
  );

  const noRefs = await fixture(t, { html: "<html><head></head><body></body></html>" });
  await assert.rejects(
    finalizeMobileWebRelease({ distDir: noRefs.dir, desktopVersion: "0.1.0" }),
    /references no assets/u,
  );

  const both = await fixture(t);
  await writeFile(join(both.dir, "index.html"), HTML);
  await assert.rejects(
    finalizeMobileWebRelease({ distDir: both.dir, desktopVersion: "0.1.0" }),
    /Ambiguous/u,
  );

  await assert.rejects(finalizeMobileWebRelease({ distDir: both.dir, desktopVersion: "" }));
});

test("制品含符号链接时 fail closed", async (t) => {
  const { dir, root } = await fixture(t);
  await writeFile(join(root, "outside.txt"), "secret");
  await symlink(join(root, "outside.txt"), join(dir, "assets/link.txt"));
  await assert.rejects(
    finalizeMobileWebRelease({ distDir: dir, desktopVersion: "0.1.0" }),
    /symbolic links/u,
  );
});

test("verify 对 manifest 缺失、篡改、meta 不一致、sourcemap 残留均拒绝", async (t) => {
  const { dir } = await fixture(t);
  await assert.rejects(verifyMobileWebRelease({ distDir: dir }));
  await finalizeMobileWebRelease({ distDir: dir, desktopVersion: "0.1.0" });
  await verifyMobileWebRelease({ distDir: dir });

  // 资源字节被改：摘要不再匹配。
  await writeFile(join(dir, "assets/index-AAAA.js"), "tampered");
  await assert.rejects(verifyMobileWebRelease({ distDir: dir }), /assetDigest/u);
  await finalizeMobileWebRelease({ distDir: dir, desktopVersion: "0.1.0" });

  // manifest 多出字段：严格 schema 拒绝。
  const manifestPath = join(dir, "release.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, extra: 1 }));
  await assert.rejects(verifyMobileWebRelease({ distDir: dir }), /Invalid mobile UI release/u);
  await writeFile(manifestPath, JSON.stringify(manifest));

  // meta 与 manifest 不一致。
  const htmlPath = join(dir, "index.html");
  const html = await readFile(htmlPath, "utf8");
  await writeFile(htmlPath, html.replace(manifest.releaseId, "0".repeat(24)));
  await assert.rejects(verifyMobileWebRelease({ distDir: dir }), /release meta/u);
  await writeFile(htmlPath, html);

  // sourcemap 残留。
  await writeFile(join(dir, "assets/index-AAAA.js.map"), "{}");
  await assert.rejects(verifyMobileWebRelease({ distDir: dir }), /sourcemaps/u);
});

test("buildMobileWebRelease 串联构建、冻结与复核，版本取根 package.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zody-mobile-release-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", version: "9.8.7" }));
  const distDir = resolve(root, "packages/web/dist-mobile-remote");
  const calls = [];
  const manifest = await buildMobileWebRelease({
    root,
    distDir,
    runBuild: async (context) => {
      calls.push(context);
      await writeViteOutput(context.distDir);
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(manifest.desktopVersion, "9.8.7");
  assert.ok((await listAll(distDir)).includes("release.json"));

  await assert.rejects(
    buildMobileWebRelease({
      root,
      distDir,
      runBuild: async () => {
        throw new Error("vite failed");
      },
    }),
    /vite failed/u,
  );
});
