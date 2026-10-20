import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareLocalRemoteAssets } from "../src/remote/localRemoteAssets.js";
import { createLocalRuntimeFixture } from "./helpers/localRuntimeFixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-only remote runtime", () => {
  it.each(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"])(
    "从本地归档物化 %s 且不调用网络",
    async (platformArch) => {
      const fixture = await createLocalRuntimeFixture(platformArch);
      roots.push(fixture.root);
      const fetch = vi.fn(() => {
        throw new Error("network forbidden");
      });
      vi.stubGlobal("fetch", fetch);
      const prepared = await prepareLocalRemoteAssets(
        fixture.source,
        platformArch,
        fixture.cacheDir,
      );
      expect(prepared.manifest.platformArch).toBe(platformArch);
      expect(
        await readFile(join(prepared.releaseDir, "server/zcode-server.cjs"), "utf8"),
      ).toContain("server-bundle");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "corrupt", "version", "platform", "mount", "component"])(
    "损坏来源 %s 时明确失败，不回退",
    async (fault) => {
      const fixture = await createLocalRuntimeFixture();
      roots.push(fixture.root);
      const first = fixture.manifest.components[0]!;
      if (fault === "missing") await rm(join(fixture.source.rootDir, first.artifactPath));
      if (fault === "corrupt")
        await writeFile(join(fixture.source.rootDir, first.artifactPath), "broken");
      if (fault === "version") fixture.manifest.appVersion = "wrong";
      if (fault === "platform") fixture.manifest.platformArch = "wrong";
      if (fault === "mount") first.mount = "../escape";
      if (fault === "component") fixture.manifest.components.splice(1, 1);
      await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
      await expect(
        prepareLocalRemoteAssets(fixture.source, fixture.platformArch, fixture.cacheDir),
      ).rejects.toThrow(/local|manifest|component|sha256/i);
    },
  );

  it("不凭 ready 标记信任损坏的解包缓存", async () => {
    const fixture = await createLocalRuntimeFixture();
    roots.push(fixture.root);
    const first = await prepareLocalRemoteAssets(
      fixture.source,
      fixture.platformArch,
      fixture.cacheDir,
    );
    await writeFile(join(first.releaseDir, "server/zcode-server.cjs"), "corrupt cache");
    const repaired = await prepareLocalRemoteAssets(
      fixture.source,
      fixture.platformArch,
      fixture.cacheDir,
    );
    expect(await readFile(join(repaired.releaseDir, "server/zcode-server.cjs"), "utf8")).toContain(
      "server-bundle",
    );
  });

  it("并发物化共享一代缓存；已有缓存也不能掩盖随包归档损坏", async () => {
    const fixture = await createLocalRuntimeFixture();
    roots.push(fixture.root);
    const [a, b] = await Promise.all([
      prepareLocalRemoteAssets(fixture.source, fixture.platformArch, fixture.cacheDir),
      prepareLocalRemoteAssets(fixture.source, fixture.platformArch, fixture.cacheDir),
    ]);
    expect(a.releaseDir).toBe(b.releaseDir);
    await writeFile(
      join(fixture.source.rootDir, fixture.manifest.components[0]!.artifactPath),
      "bad source",
    );
    await expect(
      prepareLocalRemoteAssets(fixture.source, fixture.platformArch, fixture.cacheDir),
    ).rejects.toThrow(/sha256/);
  });

  it("取消前置准备，不产生上传需要的 release", async () => {
    const fixture = await createLocalRuntimeFixture();
    roots.push(fixture.root);
    await expect(
      prepareLocalRemoteAssets(
        fixture.source,
        fixture.platformArch,
        fixture.cacheDir,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
  });
});
