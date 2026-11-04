import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseInstaller } from "../src/runtime/releaseInstaller.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { writeStableLauncher } from "../src/runtime/stableLauncher.js";

// 用可执行的假 runtime/node 证明 stable launcher 实际命中哪个物理 release，而不是只检查退出码。
async function writePosixFakeRelease(releaseDir: string): Promise<string> {
  const runtimeDir = join(releaseDir, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "node"),
    [
      "#!/bin/sh",
      'physical=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)',
      "printf 'physical=%s\\n' \"$physical\"",
      "printf 'entry=%s\\n' \"$1\"",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  await writeFile(join(runtimeDir, "server-cli.js"), "", "utf8");
  return runtimeDir;
}

async function runPosixLauncher(launcherPath: string): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(launcherPath, [], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

describe("release installer", () => {
  it("rejects a release version before constructing a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-invalid-"));
    const layout = resolveServerLayout(join(root, "server"));
    await expect(new ReleaseInstaller(layout).installArchive({ archivePath: join(root, "missing.tar.gz"), target: "linux-x64", version: "../escape" })).rejects.toThrow(/Invalid release version/);
  });

  it("installs a tar release, writes pending and creates a stable launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-linux-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zody.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({ product: "zcode-server", target: "linux-x64", appVersion: "1.2.3", nodeVersion: "22.16.0", entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zody.cjs" }, native: ["node-pty"] }), "utf8");
    const archivePath = join(root, "release.tar.gz");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("tar", ["-czf", archivePath, "zcode-server-linux-x64"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    const installed = await new ReleaseInstaller(layout).installArchive({ archivePath, target: "linux-x64", version: "1.2.3" });
    expect(installed.target).toBe("linux-x64");
    expect(JSON.parse(await readFile(layout.pendingFile, "utf8"))).toMatchObject({ version: "1.2.3" });
    const launcher = await readFile(join(layout.stableBinDir, "zcode"), "utf8");
    expect(launcher).toContain("current.json");
    // I11: 边界比较对象是物理化后的 releases 根，不是逻辑 $ROOT/releases。
    expect(launcher).toContain('"$RELEASES_PHYSICAL"/*)');
  });

  it("installs a Windows zip and writes a launcher that is safe for quoted paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-win-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-win32-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node.exe"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zody.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({ product: "zcode-server", target: "win32-x64", appVersion: "1.2.4", nodeVersion: "22.16.0", entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zody.cjs" }, native: ["node-pty"] }), "utf8");
    const archivePath = join(root, "release.zip");
    const { execFile } = await import("node:child_process");
    // Bugfix: Windows 本机没有 Info-ZIP 的 `zip` 命令；System32 自带 bsdtar，`tar -a`
    // 可按 .zip 后缀写归档，与产品 stageRelease 在 Windows 上的产包方式一致。
    await new Promise<void>((resolve, reject) => execFile(
      process.platform === "win32" ? "tar" : "zip",
      process.platform === "win32"
        ? ["-acf", archivePath, "zcode-server-win32-x64"]
        : ["-qr", archivePath, "zcode-server-win32-x64"],
      { cwd: root },
      (error) => error ? reject(error) : resolve(),
    ));
    await new ReleaseInstaller(layout).installArchive({ archivePath, target: "win32-x64", version: "1.2.4" });
    const launcher = await readFile(join(layout.stableBinDir, "zcode.cmd"), "utf8");
    expect(launcher).toContain("ZODY_SERVER_ROOT");
    expect(launcher).toContain("Invalid current Zody Server release");
    // I11: Windows 入口必须解析链接目标并用哨兵 fail-closed，且不能沿用父进程的 RELEASE_DIR。
    // 本机无 PowerShell，无法执行该入口，至少钉住生成文本中的关键分支防止被回退。
    expect(launcher).toContain('set "RELEASE_DIR="');
    expect(launcher).toContain("ResolveLinkTarget");
    expect(launcher).toContain("ZODY_INVALID_RELEASE");
    expect(launcher).not.toContain("ZCODE_INVALID_RELEASE");
  });

  // Bugfix: 该用例验证 POSIX shell 版 stable launcher 的 fail-closed 输出，靠 shebang
  // 直接执行 shell 脚本；Windows 无法 spawn 无扩展名脚本（ENOENT），只在 POSIX 宿主运行。
  it.skipIf(process.platform === "win32")("fails closed when the POSIX stable launcher reads an external current release", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-launcher-boundary-"));
    const layout = resolveServerLayout(join(root, "server"));
    await writeStableLauncher(layout, "linux");
    await writeFile(layout.currentFile, JSON.stringify({ version: "1.0.0", releaseDir: join(root, "outside") }), "utf8");
    const { execFile } = await import("node:child_process");
    await expect(new Promise<void>((resolve, reject) => {
      execFile(join(layout.stableBinDir, "zcode"), [], (error, _stdout, stderr) => {
        if (error) reject(new Error(`${error.message}: ${stderr}`));
        else resolve();
      });
    })).rejects.toThrow(/Invalid current Zody Server release/);
  });

  // I11 反例：入口与 current.json 可能经不同的符号链接别名被访问（symlink HOME/安装根），
  // 也可能包含空格。launcher 必须把两侧都解析为物理路径后比较 release 归属。
  describe("stable launcher physical path matching", () => {
    it.skipIf(process.platform === "win32")("launches a release from a normal install root", async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-launcher-plain-"));
      const layout = resolveServerLayout(join(root, "server"));
      await writeStableLauncher(layout, "linux");
      const runtimeDir = await writePosixFakeRelease(join(layout.releasesDir, "1.0.0"));
      await writeFile(
        layout.currentFile,
        JSON.stringify({ version: "1.0.0", releaseDir: join(layout.releasesDir, "1.0.0") }),
        "utf8",
      );

      const { stdout } = await runPosixLauncher(join(layout.stableBinDir, "zcode"));
      expect(stdout).toContain(`physical=${await realpath(runtimeDir)}`);
    });

    it.skipIf(process.platform === "win32")("launches through a symlinked install root and matches the same physical release", async () => {
      const physicalParent = await mkdtemp(join(tmpdir(), "zcode-launcher-alias-root-"));
      const aliasParent = `${physicalParent}-alias`;
      await symlink(physicalParent, aliasParent, "dir");
      const layout = resolveServerLayout(join(physicalParent, "server"));
      await writeStableLauncher(layout, "linux");
      const runtimeDir = await writePosixFakeRelease(join(layout.releasesDir, "1.0.0"));
      // current.json 由 canonical root 写入；入口经符号链接别名被调用。
      await writeFile(
        layout.currentFile,
        JSON.stringify({
          version: "1.0.0",
          releaseDir: await realpath(join(layout.releasesDir, "1.0.0")),
        }),
        "utf8",
      );

      const { stdout } = await runPosixLauncher(join(aliasParent, "server", "bin", "zcode"));
      expect(stdout).toContain(`physical=${await realpath(runtimeDir)}`);
    });

    it.skipIf(process.platform === "win32")("launches when current.json records a symlink-aliased release dir", async () => {
      const physicalParent = await mkdtemp(join(tmpdir(), "zcode-launcher-alias-release-"));
      const aliasParent = `${physicalParent}-alias`;
      await symlink(physicalParent, aliasParent, "dir");
      const layout = resolveServerLayout(join(physicalParent, "server"));
      await writeStableLauncher(layout, "linux");
      const runtimeDir = await writePosixFakeRelease(join(layout.releasesDir, "1.0.0"));
      // 未 canonicalize 的写入方可能把别名 releaseDir 写进 current.json。
      await writeFile(
        layout.currentFile,
        JSON.stringify({
          version: "1.0.0",
          releaseDir: join(aliasParent, "server", "releases", "1.0.0"),
        }),
        "utf8",
      );

      const { stdout } = await runPosixLauncher(join(layout.stableBinDir, "zcode"));
      expect(stdout).toContain(`physical=${await realpath(runtimeDir)}`);
    });

    it.skipIf(process.platform === "win32")("launches a release under a path with spaces through a symlink alias", async () => {
      const physicalParent = await mkdtemp(join(tmpdir(), "zcode launcher space "));
      const aliasParent = `${physicalParent}-alias`;
      await symlink(physicalParent, aliasParent, "dir");
      const layout = resolveServerLayout(join(physicalParent, "zody server root"));
      await writeStableLauncher(layout, "linux");
      const runtimeDir = await writePosixFakeRelease(join(layout.releasesDir, "1.0.0"));
      await writeFile(
        layout.currentFile,
        JSON.stringify({
          version: "1.0.0",
          releaseDir: await realpath(join(layout.releasesDir, "1.0.0")),
        }),
        "utf8",
      );

      const { stdout } = await runPosixLauncher(join(aliasParent, "zody server root", "bin", "zcode"));
      expect(stdout).toContain(`physical=${await realpath(runtimeDir)}`);
    });

    it.skipIf(process.platform === "win32")("launches a release when the releases directory itself is a symlink", async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-launcher-releases-link-"));
      const layout = resolveServerLayout(join(root, "server"));
      await writeStableLauncher(layout, "linux");
      const physicalReleases = join(root, "physical releases");
      const runtimeDir = await writePosixFakeRelease(join(physicalReleases, "1.0.0"));
      await mkdir(layout.serverRoot, { recursive: true });
      await symlink(physicalReleases, layout.releasesDir, "dir");

      // 写入侧 assertReleaseDir 会 realpath(releasesDir)，因此该 release 可被安装；
      // launcher 必须物理化 <root>/releases 后给出一致结论，而不是在更新成功后拒绝启动。
      const releases = new ReleaseManager(layout);
      await releases.writePending({
        version: "1.0.0",
        releaseDir: join(layout.releasesDir, "1.0.0"),
      });
      await releases.applyPending();

      const { stdout } = await runPosixLauncher(join(layout.stableBinDir, "zcode"));
      expect(stdout).toContain(`physical=${await realpath(runtimeDir)}`);
    });

    it.skipIf(process.platform === "win32")("fails closed when releaseDir is relative, missing, or a dangling link", async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-launcher-unresolvable-"));
      const layout = resolveServerLayout(join(root, "server"));
      await writeStableLauncher(layout, "linux");
      await mkdir(layout.releasesDir, { recursive: true });
      const dangling = join(layout.releasesDir, "dangling");
      await symlink(join(root, "missing-release"), dangling, "dir");
      const releaseDirs = [
        "releases/relative",
        join(layout.releasesDir, "missing"),
        dangling,
      ];
      for (const releaseDir of releaseDirs) {
        await writeFile(layout.currentFile, JSON.stringify({ version: "1.0.0", releaseDir }), "utf8");
        await expect(runPosixLauncher(join(layout.stableBinDir, "zcode"))).rejects.toThrow(
          /Invalid current Zody Server release/,
        );
      }
    });

    it.skipIf(process.platform === "win32")("rejects a release dir that only physically escapes the releases directory", async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-launcher-escape-"));
      const layout = resolveServerLayout(join(root, "server"));
      await writeStableLauncher(layout, "linux");
      const outsideDir = join(root, "outside");
      await mkdir(join(outsideDir, "runtime"), { recursive: true });
      await writeFile(join(outsideDir, "runtime", "node"), "#!/bin/sh\nexit 0\n", {
        encoding: "utf8",
        mode: 0o755,
      });
      await writeFile(join(outsideDir, "runtime", "server-cli.js"), "", "utf8");
      await mkdir(layout.releasesDir, { recursive: true });
      await symlink(outsideDir, join(layout.releasesDir, "escape"), "dir");
      await writeFile(
        layout.currentFile,
        JSON.stringify({ version: "9.9.9", releaseDir: join(layout.releasesDir, "escape") }),
        "utf8",
      );

      await expect(runPosixLauncher(join(layout.stableBinDir, "zcode"))).rejects.toThrow(
        /Invalid current Zody Server release/,
      );
    });
  });

  it("reuses an identical immutable release without deleting or replacing its live directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-immutable-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-linux-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zody.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({
      product: "zcode-server",
      target: "linux-x64",
      appVersion: "2.0.0",
      nodeVersion: "22.16.0",
      entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zody.cjs" },
      native: ["node-pty"],
    }), "utf8");
    const archivePath = join(root, "release.tar.gz");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("tar", ["-czf", archivePath, "zcode-server-linux-x64"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    const installer = new ReleaseInstaller(layout);
    const [first, concurrent] = await Promise.all([
      installer.installArchive({ archivePath, target: "linux-x64", version: "2.0.0" }),
      installer.installArchive({ archivePath, target: "linux-x64", version: "2.0.0" }),
    ]);
    expect(concurrent.releaseDir).toBe(first.releaseDir);
    const firstDirectory = await stat(first.releaseDir);
    const second = await installer.installArchive({ archivePath, target: "linux-x64", version: "2.0.0" });

    expect(second.releaseDir).toBe(first.releaseDir);
    expect((await stat(second.releaseDir)).ino).toBe(firstDirectory.ino);
    await expect(readFile(join(second.releaseDir, "runtime", "node"), "utf8")).resolves.toBe("node");
    expect((await readdir(layout.releasesDir)).filter((entry) => entry.startsWith(".incoming-"))).toEqual([]);
  });

  it("rejects an existing release whose immutable archive identity is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-conflict-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-linux-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zody.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({
      product: "zcode-server",
      target: "linux-x64",
      appVersion: "2.1.0",
      nodeVersion: "22.16.0",
      entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zody.cjs" },
      native: ["node-pty"],
    }), "utf8");
    const archivePath = join(root, "release.tar.gz");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("tar", ["-czf", archivePath, "zcode-server-linux-x64"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    const installer = new ReleaseInstaller(layout);
    const first = await installer.installArchive({ archivePath, target: "linux-x64", version: "2.1.0" });
    await writeFile(join(first.releaseDir, "runtime", "server-core.js"), "tampered", "utf8");

    await expect(
      installer.installArchive({ archivePath, target: "linux-x64", version: "2.1.0" }),
    ).rejects.toThrow(/immutable release conflict/);
  });
});
