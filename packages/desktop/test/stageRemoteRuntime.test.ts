import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZCODE_VERSION } from "@zcode/shared";
import { createLocalRuntimeFixture } from "../../server/test/helpers/localRuntimeFixture.js";
import { stageRemoteRuntime, REMOTE_RUNTIME_PLATFORMS } from "../scripts/stage-remote-runtime.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged SSH/WSL runtime", () => {
  it("只暂存当前四平台 manifest 引用闭包，不携带旧版本或松散目录", async () => {
    const fixtures = [];
    for (const platform of REMOTE_RUNTIME_PLATFORMS) {
      const fixture = await createLocalRuntimeFixture(platform);
      roots.push(fixture.root);
      fixtures.push(fixture);
    }
    const first = fixtures[0]!;
    for (const fixture of fixtures.slice(1))
      await cp(fixture.source.rootDir, first.source.rootDir, { recursive: true });
    await mkdir(join(first.source.rootDir, "releases", "old"), { recursive: true });
    await writeFile(join(first.source.rootDir, "unreferenced.tar.gz"), "old");
    const targetDir = join(first.root, "packaged", "remote-runtime");
    await stageRemoteRuntime({
      sourceDir: first.source.rootDir,
      targetDir,
      version: ZCODE_VERSION,
    });
    expect((await readdir(targetDir)).sort()).toEqual(["components", "releases"]);
    expect(await readdir(join(targetDir, "releases"))).toEqual([ZCODE_VERSION]);
    for (const fixture of fixtures) {
      const manifest = JSON.parse(
        await readFile(
          join(targetDir, "releases", ZCODE_VERSION, `manifest-${fixture.platformArch}.json`),
          "utf8",
        ),
      );
      expect(manifest.components).toEqual(fixture.manifest.components);
    }
  });

  it("四平台缺件时不替换已经暂存的资源", async () => {
    const fixture = await createLocalRuntimeFixture();
    roots.push(fixture.root);
    const targetDir = join(fixture.root, "packaged");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "sentinel"), "keep");
    await expect(
      stageRemoteRuntime({ sourceDir: fixture.source.rootDir, targetDir, version: ZCODE_VERSION }),
    ).rejects.toThrow(/manifest/);
    expect(await readFile(join(targetDir, "sentinel"), "utf8")).toBe("keep");
  });
});
