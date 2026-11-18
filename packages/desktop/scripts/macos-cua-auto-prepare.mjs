// 自动准备仅发布完成固定 pin 和代码身份校验的冻结树；restore 保持纯校验，避免递归。
import { lstat, mkdir, mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fetchCuaNarrowFrozen } from "./fetch-cua-narrow-frozen.mjs";
import { resolveMacosCuaDemoBuildSelection } from "./macos-cua-demo-defaults.mjs";
import { REPO_ROOT } from "./macos-cua-narrow-resources-constants.mjs";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureCuaNarrowFrozen({
  repoRoot = REPO_ROOT,
  env = process.env,
  deps = {},
} = {}) {
  const root = resolve(repoRoot);
  const output = join(root, "output");
  const destination = join(output, "cua-narrow-frozen");
  const lock = join(output, ".cua-narrow-publish.lock");
  const selectVerified = deps.selectVerified ?? resolveMacosCuaDemoBuildSelection;
  const verify = () =>
    selectVerified({ repoRoot: root, env, targetOs: "darwin", targetArch: "arm64" });
  if (await exists(destination)) return verify();

  await mkdir(output, { recursive: true });
  const temporaryRepo = await mkdtemp(join(output, ".cua-narrow-prepare-"));
  try {
    await (deps.fetchFrozen ?? fetchCuaNarrowFrozen)({
      repoRoot: temporaryRepo,
      env,
      pinFilePath: join(root, "packages/desktop/build/cua-narrow-frozen.json"),
    });
    try {
      await mkdir(lock);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const busy = new Error(
        `CUA frozen publication is busy: ${lock}; remove the lock only after confirming no build is active`,
      );
      busy.code = "cua-frozen-publish-busy";
      throw busy;
    }
    try {
      // rename 在 POSIX 上可替换空目录，锁内必须重查，避免覆盖部分或竞争材料。
      if (await exists(destination)) return await verify();
      await rename(join(temporaryRepo, "output/cua-narrow-frozen"), destination);
      return await verify();
    } finally {
      await rmdir(lock);
    }
  } finally {
    await rm(temporaryRepo, { recursive: true, force: true });
  }
}
