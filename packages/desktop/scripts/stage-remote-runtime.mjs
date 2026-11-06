import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareLocalRemoteAssets } from "@zody/server/remote";

export const REMOTE_RUNTIME_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

/** 只复制当前 manifest 的引用闭包；发布前复用 runtime 的严格校验，漏件不得生成半成品包。 */
export async function stageRemoteRuntime({ sourceDir, targetDir, version }) {
  await mkdir(dirname(targetDir), { recursive: true });
  const staging = await mkdtemp(`${targetDir}.staging-`);
  const cache = join(staging, ".validation-cache");
  try {
    for (const platformArch of REMOTE_RUNTIME_PLATFORMS) {
      const prepared = await prepareLocalRemoteAssets(
        { kind: "local-only", rootDir: sourceDir },
        platformArch,
        cache,
        undefined,
        version,
      );
      const manifestRelativePath = join("releases", version, `manifest-${platformArch}.json`);
      const targetManifest = join(staging, manifestRelativePath);
      await mkdir(dirname(targetManifest), { recursive: true });
      // 使用已固定的 manifest，不能再次读取可能被并行构建替换的文件。
      await writeFile(targetManifest, JSON.stringify(prepared.manifest));
      for (const component of prepared.manifest.components) {
        const target = join(staging, component.artifactPath);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(sourceDir, component.artifactPath), target);
      }
    }
    // 复制后再校验，防止源目录更新使随包字节与已验证 manifest 不一致。
    for (const platformArch of REMOTE_RUNTIME_PLATFORMS) {
      await prepareLocalRemoteAssets(
        { kind: "local-only", rootDir: staging },
        platformArch,
        cache,
        undefined,
        version,
      );
    }
    await rm(cache, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    await rename(staging, targetDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "../../..");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await stageRemoteRuntime({
    sourceDir: join(root, "packages/desktop/mock-cdn"),
    targetDir: join(root, "packages/desktop/resources/remote-runtime"),
    version,
  });
  console.log(`[remote-runtime] staged four platforms for ${version}`);
}
