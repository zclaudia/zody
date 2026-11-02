import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ZCODE_VERSION } from "@zody/shared";
import { createTarGzArchive } from "../../src/remote/localTarGz.js";
import { resolveRequiredLocalReleasePaths } from "../../src/remote/remoteAssetLocalPaths.js";

export async function createLocalRuntimeFixture(platformArch = "linux-x64") {
  const root = await mkdtemp(join(tmpdir(), "local-remote-assets-"));
  const source = { kind: "local-only" as const, rootDir: join(root, "source") };
  const components = [];
  for (const id of [
    "server-bundle",
    "node-runtime",
    "node-pty",
    "glm",
    "ripgrep",
    ...(platformArch.startsWith("linux-") ? ["bfs", "ugrep"] : []),
  ]) {
    const paths = resolveRequiredLocalReleasePaths(platformArch, [id]);
    const mount =
      id === "server-bundle"
        ? "server"
        : id === "node-runtime"
          ? `node/${platformArch}`
          : id === "node-pty"
            ? `node-pty/${platformArch}`
            : id === "glm"
              ? `glm/${platformArch}`
              : `tools/${platformArch}/${id}`;
    const dir = join(root, "build", id);
    for (const path of paths) {
      const file = join(dir, path.slice(mount.length + 1));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${id}:${path}`);
    }
    const artifactPath = `components/${platformArch}/${id}/fixture.tar.gz`;
    const archive = join(source.rootDir, artifactPath);
    await mkdir(dirname(archive), { recursive: true });
    await createTarGzArchive(
      archive,
      paths.map((path) => ({
        sourcePath: join(dir, path.slice(mount.length + 1)),
        archivePath: path.slice(mount.length + 1),
      })),
    );
    components.push({
      id,
      mount,
      artifactPath,
      version: "1.0.0",
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    });
  }
  const manifest = { schemaVersion: 1, appVersion: ZCODE_VERSION, platformArch, components };
  const manifestPath = join(
    source.rootDir,
    "releases",
    ZCODE_VERSION,
    `manifest-${platformArch}.json`,
  );
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, source, manifest, manifestPath, cacheDir: join(root, "cache"), platformArch };
}
