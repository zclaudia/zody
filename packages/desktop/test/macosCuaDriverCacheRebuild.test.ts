import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertTargetArchiveCoverage,
  prepareReconstructedCache,
} from "../scripts/lib/cua-driver-closure-cache-rebuild.mjs";

const tempDirs: string[] = [];
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-r6-cache-"));
  tempDirs.push(root);
  return root;
}

function sha(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function lockPackage(name: string, version: string, checksum: string) {
  return { name, version, source: SOURCE, checksum };
}

async function makeCrate(
  root: string,
  name: string,
  version: string,
  files: Record<string, string>,
) {
  const stage = join(root, "stage", `${name}-${version}`);
  await mkdir(stage, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(stage, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  const cacheDir = join(root, "cargo-home", "registry", "cache", "index.test");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(root, "cargo-home", "registry", "index", "index.test"), { recursive: true });
  await writeFile(
    join(root, "cargo-home", "registry", "index", "index.test", "config.json"),
    "{}\n",
  );
  const archive = join(cacheDir, `${name}-${version}.crate`);
  execFileSync("tar", ["-czf", archive, "-C", join(root, "stage"), `${name}-${version}`], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return { archive, checksum: sha(await readFile(archive)) };
}

async function writeOriginalSource(
  root: string,
  name: string,
  version: string,
  files: Record<string, string>,
) {
  const source = join(root, "cargo-home", "registry", "src", "index.test", `${name}-${version}`);
  await mkdir(source, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(source, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  await writeFile(join(source, ".cargo-ok"), '{"v":1}');
  return source;
}

describe("round 6 cache rebuild", () => {
  it("records the full original difference including Cargo.lock and rebuilds exactly", async () => {
    const root = await tempDir();
    const crate = await makeCrate(root, "serde", "1.0.0", {
      "Cargo.toml": '[package]\nname="serde"\nversion="1.0.0"\n',
      "Cargo.lock": "# locked\n",
      "src/lib.rs": "pub fn x() {}\n",
    });
    const source = await writeOriginalSource(root, "serde", "1.0.0", {
      "Cargo.toml": '[package]\nname="serde"\nversion="1.0.0"\n',
      "src/lib.rs": "pub fn x() {}\n",
    });
    const before = await readFile(join(source, "src/lib.rs"));
    const result = await prepareReconstructedCache({
      cargoHome: join(root, "cargo-home"),
      lockPackages: [lockPackage("serde", "1.0.0", crate.checksum)],
      stagingRoot: join(root, "staging"),
    });
    expect(result.status).toBe("pass");
    expect(result.originalCache).toMatchObject({
      status: "blocked",
      archivesChecksumStatus: "pass",
      originalSourceStatus: "blocked",
    });
    expect(result.reconstructedCache.status).toBe("pass");
    expect(result.originalCache.packages[0]).toMatchObject({
      key: "serde@1.0.0",
      checksumMatchesLock: true,
      sourceStatus: "present",
      cargoOkMarker: true,
      differences: { missing: ["Cargo.lock"], extra: [], changed: [] },
    });
    expect(
      result.reconstructedCache.packages[0].files.map((file: { path: string }) => file.path),
    ).toEqual(["Cargo.lock", "Cargo.toml", "src/lib.rs"]);
    expect(result.originalCache.inputBefore.treeSha256).toBe(
      result.originalCache.inputAfter.treeSha256,
    );
    expect(await readFile(join(source, "src/lib.rs"))).toEqual(before);
  });

  it("reports every checksum failure instead of stopping at the first error", async () => {
    const root = await tempDir();
    await makeCrate(root, "a", "1.0.0", { "Cargo.toml": "a\n" });
    await makeCrate(root, "b", "1.0.0", { "Cargo.toml": "b\n" });
    const result = await prepareReconstructedCache({
      cargoHome: join(root, "cargo-home"),
      lockPackages: [
        lockPackage("a", "1.0.0", "0".repeat(64)),
        lockPackage("b", "1.0.0", "1".repeat(64)),
      ],
      stagingRoot: join(root, "staging"),
    });
    expect(result.status).toBe("blocked");
    expect(
      result.originalCache.packages.map(
        (entry: { checksumMatchesLock: boolean }) => entry.checksumMatchesLock,
      ),
    ).toEqual([false, false]);
    expect(result.reconstructedCache.packages).toHaveLength(0);
  });

  it("excludes unlocked archives without extracting or executing them", async () => {
    const root = await tempDir();
    const crate = await makeCrate(root, "core-graphics", "0.24.0", { "Cargo.toml": "cg\n" });
    const result = await prepareReconstructedCache({
      cargoHome: join(root, "cargo-home"),
      lockPackages: [lockPackage("serde", "1.0.0", "2".repeat(64))],
      stagingRoot: join(root, "staging"),
    });
    expect(result.unlockedArchives).toEqual([
      expect.objectContaining({ key: "core-graphics-0.24.0", status: "excluded-not-in-lock" }),
    ]);
    expect(result.reconstructedCache.packages).toHaveLength(0);
    expect(crate.archive).toContain("core-graphics-0.24.0.crate");
  });

  it("rejects symlinks and hardlinks in separate archive cases", async () => {
    const cases = [
      {
        name: "link",
        error: /symlink/,
        setup: `os.symlink('Cargo.toml', os.path.join(stage, 'link'))`,
      },
      {
        name: "hard",
        error: /hardlink/,
        setup: `os.link(os.path.join(stage, 'Cargo.toml'), os.path.join(stage, 'hard'))`,
      },
    ];
    for (const entry of cases) {
      const root = await tempDir();
      const cacheDir = join(root, "cargo-home", "registry", "cache", "index.test");
      await mkdir(cacheDir, { recursive: true });
      await mkdir(join(root, "cargo-home", "registry", "index", "index.test"), { recursive: true });
      const stage = join(root, "stage", `${entry.name}-1.0.0`);
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, "Cargo.toml"), "ok\n");
      const archive = join(cacheDir, `${entry.name}-1.0.0.crate`);
      execFileSync("python3", [
        "-c",
        `import os,tarfile\nstage=${JSON.stringify(stage)}\np=${JSON.stringify(archive)}\n${entry.setup}\nwith tarfile.open(p,'w:gz') as t:\n t.add(stage, arcname='${entry.name}-1.0.0')`,
      ]);
      await expect(
        prepareReconstructedCache({
          cargoHome: join(root, "cargo-home"),
          lockPackages: [lockPackage(entry.name, "1.0.0", sha(await readFile(archive)))],
          stagingRoot: join(root, "staging"),
        }),
      ).rejects.toThrow(entry.error);
    }
  });

  it("rejects duplicate paths and archives carrying a Cargo marker", async () => {
    for (const entry of [
      {
        name: "dup",
        branch:
          "for n in ['dup-1.0.0/Cargo.toml','dup-1.0.0/Cargo.toml']:\n  i=tarfile.TarInfo(n); d=b'x'; i.size=1; t.addfile(i,io.BytesIO(d))",
        error: /duplicate/,
      },
      {
        name: "marker",
        branch:
          "i=tarfile.TarInfo('marker-1.0.0/.cargo-ok'); d=b'x'; i.size=1; t.addfile(i,io.BytesIO(d))",
        error: /Cargo marker/,
      },
    ]) {
      const root = await tempDir();
      const cacheDir = join(root, "cargo-home", "registry", "cache", "index.test");
      await mkdir(cacheDir, { recursive: true });
      await mkdir(join(root, "cargo-home", "registry", "index", "index.test"), { recursive: true });
      const archive = join(cacheDir, `${entry.name}-1.0.0.crate`);
      execFileSync("python3", [
        "-c",
        `import tarfile,io\np=${JSON.stringify(archive)}\nwith tarfile.open(p,'w:gz') as t:\n ${entry.branch}`,
      ]);
      await expect(
        prepareReconstructedCache({
          cargoHome: join(root, "cargo-home"),
          lockPackages: [lockPackage(entry.name, "1.0.0", sha(await readFile(archive)))],
          stagingRoot: join(root, "staging"),
        }),
      ).rejects.toThrow(entry.error);
    }
  });

  it("rejects original source symlinks instead of following them", async () => {
    const root = await tempDir();
    const crate = await makeCrate(root, "serde", "1.0.0", { "Cargo.toml": "ok\n" });
    const source = await writeOriginalSource(root, "serde", "1.0.0", { "Cargo.toml": "ok\n" });
    await symlink("Cargo.toml", join(source, "escape"));
    await expect(
      prepareReconstructedCache({
        cargoHome: join(root, "cargo-home"),
        lockPackages: [lockPackage("serde", "1.0.0", crate.checksum)],
        stagingRoot: join(root, "staging"),
      }),
    ).rejects.toThrow(/symlink/);
  });

  it("cleans only its own staging directory and leaves the original input unchanged", async () => {
    const root = await tempDir();
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "sentinel.txt"), "keep\n");
    const stage = join(root, "stage", "bad-1.0.0");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "Cargo.toml"), "ok\n");
    const cacheDir = join(root, "cargo-home", "registry", "cache", "index.test");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(join(root, "cargo-home", "registry", "index", "index.test"), { recursive: true });
    const archive = join(cacheDir, "bad-1.0.0.crate");
    execFileSync("python3", [
      "-c",
      `import tarfile,io\np=${JSON.stringify(archive)}\nwith tarfile.open(p,'w:gz') as t:\n i=tarfile.TarInfo('../escape'); d=b'x'; i.size=1; t.addfile(i,io.BytesIO(d))`,
    ]);
    const checksum = sha(await readFile(archive));
    const before = await readFile(join(stage, "Cargo.toml"));
    await expect(
      prepareReconstructedCache({
        cargoHome: join(root, "cargo-home"),
        lockPackages: [lockPackage("bad", "1.0.0", checksum)],
        stagingRoot: staging,
      }),
    ).rejects.toThrow(/path escape|unsafe/);
    expect(await readFile(join(staging, "sentinel.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(stage, "Cargo.toml"))).toEqual(before);
  });

  it("rejects a target graph archive that was not reconstructed", () => {
    expect(() =>
      assertTargetArchiveCoverage({
        graph: [{ name: "serde", version: "1.0.0", path: null }],
        lockPackages: [lockPackage("serde", "1.0.0", "2".repeat(64))],
        reconstructedKeys: new Set<string>(),
      }),
    ).toThrow(/target graph archive missing/);
  });

  it("rejects absolute, empty and oversized archive entries as separate cases", async () => {
    const cases = [
      {
        name: "abs",
        branch: "i=tarfile.TarInfo('/absolute'); d=b'x'; i.size=1; t.addfile(i,io.BytesIO(d))",
        error: /unsafe archive path/,
      },
      {
        name: "empty",
        branch: "i=tarfile.TarInfo(''); d=b'x'; i.size=1; t.addfile(i,io.BytesIO(d))",
        error: /unsafe archive path|duplicate/,
      },
      {
        name: "limit",
        branch:
          "i=tarfile.TarInfo('limit-1.0.0/Cargo.toml'); d=b'0123456789'; i.size=10; t.addfile(i,io.BytesIO(d))",
        error: /size limit/,
      },
      {
        name: "mode",
        branch:
          "i=tarfile.TarInfo('mode-1.0.0/Cargo.toml'); d=b'ok'; i.size=2; i.mode=0o4755; t.addfile(i,io.BytesIO(d))",
        error: /unsupported permission mode/,
      },
    ];
    for (const entry of cases) {
      const root = await tempDir();
      const cacheDir = join(root, "cargo-home", "registry", "cache", "index.test");
      await mkdir(cacheDir, { recursive: true });
      await mkdir(join(root, "cargo-home", "registry", "index", "index.test"), { recursive: true });
      const archive = join(cacheDir, `${entry.name}-1.0.0.crate`);
      execFileSync("python3", [
        "-c",
        `import tarfile,io\np=${JSON.stringify(archive)}\nwith tarfile.open(p,'w:gz') as t:\n ${entry.branch}`,
      ]);
      await expect(
        prepareReconstructedCache({
          cargoHome: join(root, "cargo-home"),
          lockPackages: [lockPackage(entry.name, "1.0.0", sha(await readFile(archive)))],
          stagingRoot: join(root, "staging"),
          limits: { maxMembersPerArchive: 10, maxFileBytes: 4, maxArchiveBytes: 8 },
        }),
      ).rejects.toThrow(entry.error);
    }
  });

  it("fails explicitly when registry/index is missing", async () => {
    const root = await tempDir();
    const crate = await makeCrate(root, "serde", "1.0.0", { "Cargo.toml": "ok\n" });
    await rm(join(root, "cargo-home", "registry", "index"), { recursive: true, force: true });
    await expect(
      prepareReconstructedCache({
        cargoHome: join(root, "cargo-home"),
        lockPackages: [lockPackage("serde", "1.0.0", crate.checksum)],
        stagingRoot: join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "cache-index-missing" });
  });

  it("records source mode drift as changed metadata without treating it as equal", async () => {
    const root = await tempDir();
    const crate = await makeCrate(root, "serde", "1.0.0", { "Cargo.toml": "ok\n" });
    const source = await writeOriginalSource(root, "serde", "1.0.0", { "Cargo.toml": "ok\n" });
    await chmod(join(source, "Cargo.toml"), 0o600);
    const result = await prepareReconstructedCache({
      cargoHome: join(root, "cargo-home"),
      lockPackages: [lockPackage("serde", "1.0.0", crate.checksum)],
      stagingRoot: join(root, "staging"),
    });
    expect(result.originalCache.originalSourceStatus).toBe("blocked");
    expect(result.originalCache.packages[0].differences).toMatchObject({
      changed: ["Cargo.toml"],
      changedMetadata: ["Cargo.toml"],
    });
    expect(result.reconstructedCache.status).toBe("pass");
  });
});
