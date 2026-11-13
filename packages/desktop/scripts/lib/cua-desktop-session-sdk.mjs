import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REPO_ROOT, SDK_RESOURCES } from "./cua-desktop-session-config.mjs";
import { sha256File } from "./cua-desktop-session-toolchain.mjs";

// SDK 固定资源先复制后按实际字节计算摘要，供入口和 prepare 共同封闭。
export async function buildSdkResources(resources) {
  const result = [];
  for (const resource of SDK_RESOURCES) {
    const output = join(resources, resource.name);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await copyFile(join(REPO_ROOT, resource.source), output);
    const bytes = (await readFile(output)).length;
    if (!bytes || bytes > resource.maxBytes)
      throw new Error(`invalid SDK resource size: ${resource.name}`);
    result.push({
      ...resource,
      bytes,
      sha256: await sha256File(output),
      capability: "sealed-computer-use-sdk",
      inputCount: 1,
      runtimeExternals: [],
      webAssemblyReferences: { count: 0, matches: [] },
    });
  }
  return result;
}
