import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ZCODE_VERSION, type RemoteAssetSource } from "@zody/shared";
import { extractTarGzArchive } from "./localTarGz.js";
import {
  parseRemoteAssetManifestFromResponse,
  type RemoteAssetManifest,
} from "./remoteAssetCache.js";
import { resolveRequiredLocalReleasePaths } from "./remoteAssetLocalPaths.js";

const materializations = new Map<string, Promise<string>>();

export interface PreparedLocalRemoteAssets {
  manifest: RemoteAssetManifest;
  releaseDir: string;
}

/** 固定本地 manifest 后完成全量前置验证；该模块没有网络依赖。 */
export async function prepareLocalRemoteAssets(
  source: RemoteAssetSource,
  platformArch: string,
  cacheDir: string,
  signal?: AbortSignal,
  appVersion = ZCODE_VERSION,
): Promise<PreparedLocalRemoteAssets> {
  signal?.throwIfAborted();
  const rootDir = await realpath(source.rootDir);
  const manifestPath = join(rootDir, "releases", appVersion, `manifest-${platformArch}.json`);
  let manifest: RemoteAssetManifest;
  try {
    manifest = await parseRemoteAssetManifestFromResponse(
      new Response(await readFile(manifestPath, "utf8")),
      manifestPath,
      appVersion,
      platformArch,
    );
  } catch (error) {
    throw new Error(
      `[remote-assets] local manifest unavailable for ${platformArch} / ${appVersion}: ${String(error)}`,
    );
  }
  const requiredIds = [
    "server-bundle",
    "node-runtime",
    "node-pty",
    "glm",
    "ripgrep",
    ...(platformArch.startsWith("linux-") ? ["bfs", "ugrep"] : []),
  ];
  for (const id of requiredIds) {
    if (!manifest.components.some((component) => component.id === id)) {
      throw new Error(
        `[remote-assets] local manifest missing component=${id} platform=${platformArch}`,
      );
    }
  }
  const manifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await mkdir(cacheDir, { recursive: true });
  const cacheRoot = join(
    await realpath(cacheDir),
    "local-runtime",
    appVersion,
    platformArch,
    manifestDigest,
  );
  const lockKey = `${rootDir}\0${cacheRoot}`;
  let task = materializations.get(lockKey);
  if (!task) {
    task = materialize(rootDir, cacheRoot, manifest);
    materializations.set(lockKey, task);
    void task
      .finally(() => {
        if (materializations.get(lockKey) === task) materializations.delete(lockKey);
      })
      .catch(() => {});
  }
  const releaseDir = await task;
  signal?.throwIfAborted();
  return { manifest, releaseDir };
}

async function materialize(
  rootDir: string,
  cacheRoot: string,
  manifest: RemoteAssetManifest,
): Promise<string> {
  // 缓存命中也先验原始归档，不能让残缺安装包靠旧 ready 标记继续工作。
  for (const component of manifest.components) {
    const path = await realpath(join(rootDir, component.artifactPath)).catch((error) => {
      throw new Error(`[remote-assets] local component=${component.id} missing: ${String(error)}`);
    });
    assertWithinRoot(rootDir, path);
    if ((await hashFile(path)) !== component.sha256)
      throw new Error(
        `[remote-assets] local sha256 mismatch: component=${component.id} path=${path}`,
      );
  }
  try {
    const pointer = JSON.parse(await readFile(join(cacheRoot, "current.json"), "utf8")) as {
      generation: string;
      treeSha256: string;
    };
    if (/^[a-f0-9-]{36}$/.test(pointer.generation) && /^[a-f0-9]{64}$/.test(pointer.treeSha256)) {
      const releaseDir = join(cacheRoot, pointer.generation, "release");
      if (pointer.treeSha256 === (await hashTree(releaseDir))) return releaseDir;
    }
  } catch {
    /* 缓存缺失或损坏从已校验的本地归档重建，不降级到 CDN。 */
  }
  // 不删除其他窗口正在使用的 cache generation；仅原子切换本次完整物化的指针。
  await mkdir(cacheRoot, { recursive: true });
  const generation = randomUUID();
  const staging = join(cacheRoot, generation);
  const stagingRelease = join(staging, "release");
  const pointerPath = join(cacheRoot, `.current-${generation}.json`);
  let committed = false;
  try {
    await mkdir(stagingRelease, { recursive: true });
    for (const component of manifest.components) {
      // 再次固定本次解包的字节，避免开发态构建替换归档导致“校验旧字节、安装新字节”。
      const bytes = await readFile(join(rootDir, component.artifactPath));
      if (createHash("sha256").update(bytes).digest("hex") !== component.sha256)
        throw new Error(`[remote-assets] local sha256 changed: component=${component.id}`);
      const archive = join(staging, "component.tar.gz");
      await writeFile(archive, bytes);
      await extractTarGzArchive(archive, join(stagingRelease, component.mount));
    }
    for (const path of resolveRequiredLocalReleasePaths(
      manifest.platformArch,
      manifest.components.map((component) => component.id),
    )) {
      const required = await realpath(join(stagingRelease, path)).catch(() => {
        throw new Error(`[remote-assets] local component file missing: ${path}`);
      });
      assertWithinRoot(stagingRelease, required);
      if (!(await lstat(required)).isFile())
        throw new Error(`[remote-assets] local component file invalid: ${path}`);
    }
    await writeFile(
      join(stagingRelease, `manifest-${manifest.platformArch}.json`),
      JSON.stringify(manifest),
    );
    await rm(join(staging, "component.tar.gz"));
    await writeFile(
      pointerPath,
      JSON.stringify({ generation, treeSha256: await hashTree(stagingRelease) }),
    );
    await rename(pointerPath, join(cacheRoot, "current.json"));
    committed = true;
    return stagingRelease;
  } finally {
    await rm(pointerPath, { force: true });
    if (!committed) await rm(staging, { recursive: true, force: true });
  }
}

function assertWithinRoot(root: string, path: string): void {
  const part = relative(root, path);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error(`[remote-assets] local path escapes root: ${path}`);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const stat = await lstat(path);
      hash.update(JSON.stringify([relative(root, path), stat.mode & 0o777]));
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) hash.update(await hashFile(path));
      else if (stat.isSymbolicLink()) {
        assertWithinRoot(root, await realpath(path));
        hash.update(await readlink(path));
      } else throw new Error(`[remote-assets] invalid local cache entry: ${path}`);
    }
  };
  await walk(root);
  return hash.digest("hex");
}
