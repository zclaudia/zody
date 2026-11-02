// oxlint-disable max-lines -- the prepare, provenance, archive and build checks stay in one auditable module
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
export const R9_SOURCE_ROOT = join(
  REPO_ROOT,
  "output/cua-driver-round9/candidate-work/controller-final/full-source",
);
export const R9_TREE_SHA256 =
  "421530ae2c2cab7b537226e459905916c849c1cf76095db0a45f574f9c49e02e";
export const OVERLAY_ROOT = join(
  REPO_ROOT,
  "packages/desktop/native/macos-cua-helper-round11/visual-overlay",
);
export const VISUAL_OUTPUT_ROOT = join(
  REPO_ROOT,
  "output/cua-helper-round11/visual-worker",
);
export const ROUND11_VISUAL_HEADER = join(
  OVERLAY_ROOT,
  "include/cua_r11_visual.h",
);
export const ROUND11_VISUAL_STATICLIB = join(
  VISUAL_OUTPUT_ROOT,
  "lib/libcua_macos_visual_round11.a",
);
export const ROUND11_VISUAL_PATCH = join(OVERLAY_ROOT, "round11-visual.patch");
export const ROUND11_VISUAL_HELPER = join(OVERLAY_ROOT, "src/helper_bridge.rs");
export const R9_CARGO_HOME = join(
  REPO_ROOT,
  "output/cua-driver-round9/native-work/cargo-home",
);
export const DERIVED_SOURCE_ROOT = join(VISUAL_OUTPUT_ROOT, "source");
export const RUST_TOOLCHAIN_ROOT = join(
  REPO_ROOT,
  "output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin",
);
export const RUST_CARGO = join(RUST_TOOLCHAIN_ROOT, "bin/cargo");
export const FIXED_TARGET = "aarch64-apple-darwin";

const VISUAL_CRATE = "crates/cua-macos-visual";
const LICENSE_FILES = [
  "LICENSE-MIT",
  "PROVENANCE.md",
  "native/DERIVATION.md",
  "native/licenses/LICENSE-APACHE",
  "native/licenses/LICENSE-MIT",
];
const PATCHED_FILES = [
  `${VISUAL_CRATE}/Cargo.toml`,
  `${VISUAL_CRATE}/src/capture.rs`,
  `${VISUAL_CRATE}/src/lib.rs`,
  `${VISUAL_CRATE}/src/session.rs`,
];

export class Round11VisualError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "Round11VisualError";
    this.code = code;
    this.details = details;
  }
}

function visualPaths(outputRoot) {
  const root = resolve(outputRoot);
  return {
    root,
    sourceRoot: join(root, "source"),
    buildRoot: join(root, "build"),
    libRoot: join(root, "lib"),
    cargoHome: join(root, "cargo-home"),
    targetDir: join(root, "target"),
    prepareManifest: join(root, "build/prepare-manifest.json"),
    staticlib: join(root, "lib/libcua_macos_visual_round11.a"),
    header: join(root, "lib/cua_r11_visual.h"),
  };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function computeTreeSha256(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(`${file.path}\0${file.sha256}\n`);
  }
  return hash.digest("hex");
}

async function scanTree(root) {
  const files = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, path);
      } else if (entry.isFile()) {
        files.push({ path, sha256: await sha256File(absolute) });
      } else {
        throw new Round11VisualError(
          "source-shape",
          `unsupported source entry: ${path}`,
        );
      }
    }
  }
  await walk(root, "");
  return { files, treeSha256: computeTreeSha256(files) };
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 900_000,
      maxBuffer: 64 * 1024 * 1024,
      env: options.env ?? process.env,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function outputRootFrom(options) {
  return resolve(
    options?.outputRoot ??
      process.env.CUA_HELPER_ROUND11_VISUAL_OUTPUT_ROOT ??
      VISUAL_OUTPUT_ROOT,
  );
}

export async function prepareRound11Visual(options = {}) {
  const paths = visualPaths(outputRootFrom(options));
  const patchSha256 = await sha256File(ROUND11_VISUAL_PATCH);
  const helperSha256 = await sha256File(ROUND11_VISUAL_HELPER);
  const headerSha256 = await sha256File(ROUND11_VISUAL_HEADER);

  if (await exists(paths.sourceRoot)) {
    const existing = JSON.parse(
      await readFile(paths.prepareManifest, "utf8").catch(() => "null"),
    );
    const current = await scanTree(paths.sourceRoot);
    if (
      existing?.status === "pass" &&
      existing.source?.treeSha256 === R9_TREE_SHA256 &&
      existing.derived?.treeSha256 === current.treeSha256 &&
      existing.overlay?.patchSha256 === patchSha256 &&
      existing.overlay?.helperSha256 === helperSha256 &&
      existing.overlay?.headerSha256 === headerSha256
    ) {
      return existing;
    }
    throw new Round11VisualError(
      "output-not-fresh",
      "existing visual output does not match this overlay; use a fresh outputRoot",
      { outputRoot: paths.root, derivedTreeSha256: current.treeSha256 },
    );
  }

  const source = await scanTree(R9_SOURCE_ROOT);
  if (source.treeSha256 !== R9_TREE_SHA256 || source.files.length !== 776) {
    throw new Round11VisualError(
      "r9-tree-drift",
      "R9 visual source tree does not match its pin",
      {
        expected: R9_TREE_SHA256,
        actual: source.treeSha256,
        files: source.files.length,
      },
    );
  }

  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await cp(R9_SOURCE_ROOT, paths.sourceRoot, {
    recursive: true,
    dereference: false,
  });
  const copied = await scanTree(paths.sourceRoot);
  if (copied.treeSha256 !== R9_TREE_SHA256) {
    throw new Round11VisualError(
      "copy-drift",
      "copied R9 source tree does not match the pin",
    );
  }

  // 在派生源码根应用 patch，并用 GIT_CEILING_DIRECTORIES 阻止 git 向上找到
  // 仓库根；否则 `crates/...` 会被相对仓库根解析并静默跳过。随后逐文件哈希
  // 校验，不能把跳过当成功。
  const patchEnv = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: dirname(paths.sourceRoot),
  };
  const patchCheck = await run(
    "git",
    ["apply", "--check", ROUND11_VISUAL_PATCH],
    {
      cwd: paths.sourceRoot,
      env: patchEnv,
      timeoutMs: 60_000,
    },
  );
  if (patchCheck.code !== 0) {
    throw new Round11VisualError(
      "patch-check",
      "visual overlay patch does not apply",
      {
        stderr: patchCheck.stderr,
      },
    );
  }
  const patch = await run("git", ["apply", ROUND11_VISUAL_PATCH], {
    cwd: paths.sourceRoot,
    env: patchEnv,
    timeoutMs: 60_000,
  });
  if (patch.code !== 0) {
    throw new Round11VisualError("patch-apply", "visual overlay patch failed", {
      stderr: patch.stderr,
    });
  }
  for (const relativePath of PATCHED_FILES) {
    const before = copied.files.find(
      (file) => file.path === relativePath,
    )?.sha256;
    const after = await sha256File(join(paths.sourceRoot, relativePath));
    if (!before || before === after) {
      throw new Round11VisualError(
        "patch-skip",
        `patch did not change ${relativePath}`,
      );
    }
  }
  await copyFile(
    ROUND11_VISUAL_HELPER,
    join(paths.sourceRoot, VISUAL_CRATE, "src/helper_bridge.rs"),
  );

  if (!(await exists(join(paths.cargoHome, "registry")))) {
    await cp(R9_CARGO_HOME, paths.cargoHome, {
      recursive: true,
      dereference: false,
    });
  }

  const derived = await scanTree(paths.sourceRoot);
  const lock = await sha256File(join(paths.sourceRoot, "Cargo.lock"));
  const r9Lock = await sha256File(join(R9_SOURCE_ROOT, "Cargo.lock"));
  const licenses = {};
  for (const licensePath of LICENSE_FILES) {
    licenses[licensePath] = await sha256File(
      join(R9_SOURCE_ROOT, VISUAL_CRATE, licensePath),
    );
  }
  const manifest = {
    schemaVersion: 1,
    kind: "zody-cua-helper-round11-visual-prepare",
    status: "pass",
    generatedAt: new Date().toISOString(),
    outputRoot: paths.root,
    source: {
      root: R9_SOURCE_ROOT,
      revisionPin: R9_TREE_SHA256,
      treeSha256: source.treeSha256,
      files: source.files.length,
      licenses,
    },
    overlay: {
      root: OVERLAY_ROOT,
      patch: ROUND11_VISUAL_PATCH,
      patchSha256,
      helperSha256,
      headerSha256,
      modified: PATCHED_FILES,
    },
    derived: {
      root: paths.sourceRoot,
      visualCrateRoot: join(paths.sourceRoot, VISUAL_CRATE),
      treeSha256: derived.treeSha256,
      files: derived.files.length,
    },
    lock: { copiedSha256: lock, r9Sha256: r9Lock },
    toolchain: {
      root: RUST_TOOLCHAIN_ROOT,
      cargo: RUST_CARGO,
      target: FIXED_TARGET,
      deploymentTarget: "14.2",
      offline: true,
      locked: true,
    },
  };
  if (manifest.lock.copiedSha256 !== manifest.lock.r9Sha256) {
    throw new Round11VisualError(
      "lock-drift",
      "derived Cargo.lock differs from R9",
    );
  }
  await mkdir(paths.buildRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    paths.prepareManifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return manifest;
}

const cachedBuilds = new Map();

async function allowedRegistryPackages() {
  const report = JSON.parse(
    await readFile(
      join(
        REPO_ROOT,
        "output/cua-driver-round9/controller-final-audit/report.json",
      ),
      "utf8",
    ),
  );
  return new Set(report.licenses.entries.map((entry) => entry.package));
}

async function archiveMinos(paths) {
  const extractRoot = join(paths.buildRoot, "ar-extract");
  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true, mode: 0o700 });
  const extract = await run("/usr/bin/ar", ["-x", paths.staticlib], {
    cwd: extractRoot,
  });
  if (extract.code !== 0) {
    throw new Round11VisualError(
      "ar-extract",
      "failed to extract staticlib members",
      extract,
    );
  }
  const objects = (await readdir(extractRoot)).filter((name) =>
    name.endsWith(".o"),
  );
  let max = 0;
  let sawTarget = false;
  const overTarget = [];
  for (const object of objects) {
    const otool = await run("/usr/bin/otool", [
      "-l",
      join(extractRoot, object),
    ]);
    for (const match of otool.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm)) {
      const value = Number(match[1]);
      if (value > 14.2) overTarget.push({ object, minos: match[1] });
      if (value === 14.2) sawTarget = true;
      if (value > max) max = value;
    }
  }
  if (!objects.includes("CuaVisualCapture.o")) {
    throw new Round11VisualError(
      "swift-object",
      "archive does not contain CuaVisualCapture.o",
    );
  }
  const swiftOtool = await run("/usr/bin/otool", [
    "-l",
    join(extractRoot, "CuaVisualCapture.o"),
  ]);
  const swiftMinos = [
    ...swiftOtool.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm),
  ].map((match) => match[1]);
  return {
    objects: objects.length,
    max,
    sawTarget,
    overTarget,
    swiftMinos,
    extractRoot,
  };
}

async function buildOnce(options = {}) {
  const paths = visualPaths(outputRootFrom(options));
  await prepareRound11Visual({ outputRoot: paths.root });
  const env = {
    ...process.env,
    PATH: `${join(RUST_TOOLCHAIN_ROOT, "bin")}:${process.env.PATH ?? ""}`,
    RUSTC: join(RUST_TOOLCHAIN_ROOT, "bin/rustc"),
    CARGO_HOME: paths.cargoHome,
    CARGO_TARGET_DIR: paths.targetDir,
    CARGO_NET_OFFLINE: "true",
    MACOSX_DEPLOYMENT_TARGET: "14.2",
  };
  const manifestPath = join(paths.sourceRoot, "Cargo.toml");
  const args = [
    "build",
    "--manifest-path",
    manifestPath,
    "-p",
    "cua-macos-visual",
    "--release",
    "--locked",
    "--offline",
    "--target",
    FIXED_TARGET,
  ];
  const command = [RUST_CARGO, ...args].join(" ");
  const build = await run(RUST_CARGO, args, {
    env,
    cwd: REPO_ROOT,
    timeoutMs: 900_000,
  });
  await mkdir(paths.buildRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.buildRoot, "build-command.txt"), `${command}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(paths.buildRoot, "build.log"),
    `${build.stdout}\n${build.stderr}\n`,
    {
      mode: 0o600,
    },
  );
  if (build.code !== 0) {
    throw new Round11VisualError(
      "build-failed",
      "locked/offline staticlib build failed",
      {
        command,
        stdout: build.stdout.slice(-8_000),
        stderr: build.stderr.slice(-16_000),
      },
    );
  }

  const treeArgs = [
    "tree",
    "--manifest-path",
    manifestPath,
    "-p",
    "cua-macos-visual",
    "--target",
    FIXED_TARGET,
    "--locked",
    "--offline",
    "--prefix",
    "none",
  ];
  const tree = await run(RUST_CARGO, treeArgs, {
    env,
    cwd: REPO_ROOT,
    timeoutMs: 300_000,
  });
  if (tree.code !== 0) {
    throw new Round11VisualError("cargo-tree", "cargo tree failed", tree);
  }
  await writeFile(join(paths.buildRoot, "cargo-tree.txt"), tree.stdout, {
    mode: 0o600,
  });
  const allowed = await allowedRegistryPackages();
  const packages = [
    ...new Set(
      [...tree.stdout.matchAll(/^[\s│├└─]*([A-Za-z0-9_-]+) v([^\s]+)/gm)].map(
        (match) => `${match[1]}@${match[2]}`,
      ),
    ),
  ];
  const unexpected = packages.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    throw new Round11VisualError(
      "cargo-tree-drift",
      "target graph added packages",
      {
        unexpected,
      },
    );
  }

  const cargoArtifact = join(
    paths.targetDir,
    FIXED_TARGET,
    "release/libcua_macos_visual.a",
  );
  if (!(await stat(cargoArtifact)).isFile()) {
    throw new Round11VisualError(
      "artifact-missing",
      "staticlib artifact is missing",
    );
  }
  await mkdir(paths.libRoot, { recursive: true, mode: 0o755 });
  await copyFile(cargoArtifact, paths.staticlib);
  await copyFile(ROUND11_VISUAL_HEADER, paths.header);
  await mkdir(join(paths.libRoot, "licenses"), {
    recursive: true,
    mode: 0o755,
  });
  for (const licensePath of LICENSE_FILES) {
    await copyFile(
      join(R9_SOURCE_ROOT, VISUAL_CRATE, licensePath),
      join(paths.libRoot, "licenses", licensePath.replaceAll("/", "_")),
    );
  }

  const lipo = await run("/usr/bin/lipo", ["-archs", paths.staticlib]);
  if (lipo.code !== 0 || lipo.stdout.trim() !== "arm64") {
    throw new Round11VisualError(
      "architecture",
      "staticlib is not arm64",
      lipo,
    );
  }
  const minos = await archiveMinos(paths);
  if (minos.overTarget.length > 0 || !minos.sawTarget) {
    throw new Round11VisualError(
      "deployment-target",
      "staticlib members exceed 14.2 or contain no 14.2 object",
      minos,
    );
  }
  if (
    minos.swiftMinos.length === 0 ||
    minos.swiftMinos.some((value) => value !== "14.2")
  ) {
    throw new Round11VisualError(
      "swift-minos",
      "Swift bridge object is not 14.2",
      minos,
    );
  }
  const requiredSymbols = [
    "_cua_r11_visual_start",
    "_cua_r11_visual_wait",
    "_cua_r11_visual_take_png",
    "_cua_r11_visual_cancel",
    "_cua_r11_visual_callback_resources_released",
    "_cua_r11_visual_destroy",
    "_cua_r11_visual_free_png",
  ];
  // `nm` on the whole archive trips over newer LLVM attributes in the
  // prebuilt Rust std objects. Check only this crate's objects, which carry the
  // private C ABI, so a toolchain reader mismatch is not a false product pass.
  const crateObjects = (await readdir(minos.extractRoot)).filter(
    (name) => name.startsWith("cua_macos_visual-") && name.endsWith(".o"),
  );
  let symbolOutput = "";
  for (const object of crateObjects) {
    const nm = await run("/usr/bin/nm", [
      "-gU",
      join(minos.extractRoot, object),
    ]);
    symbolOutput += nm.stdout;
  }
  for (const symbol of requiredSymbols) {
    if (!symbolOutput.includes(symbol)) {
      throw new Round11VisualError(
        "symbol-missing",
        `staticlib is missing ${symbol}`,
      );
    }
  }
  if (
    symbolOutput.includes("_request_window_capture") ||
    symbolOutput.includes("approved")
  ) {
    throw new Round11VisualError(
      "symbol-leak",
      "private staticlib exported a generic entry",
    );
  }

  const prepareManifest = JSON.parse(
    await readFile(paths.prepareManifest, "utf8"),
  );
  const manifest = {
    schemaVersion: 1,
    kind: "zody-cua-helper-round11-visual-build",
    status: "pass",
    generatedAt: new Date().toISOString(),
    prepareManifestSha256: await sha256File(paths.prepareManifest),
    source: prepareManifest.source,
    overlay: prepareManifest.overlay,
    derived: prepareManifest.derived,
    build: {
      command,
      cargoTreeCommand: [RUST_CARGO, ...treeArgs].join(" "),
      offline: true,
      locked: true,
      target: FIXED_TARGET,
      deploymentTarget: "14.2",
    },
    artifact: {
      path: paths.staticlib,
      sha256: await sha256File(paths.staticlib),
      sizeBytes: (await stat(paths.staticlib)).size,
      architectures: ["arm64"],
      minimumMacOSVersion: "14.2",
      archiveMembers: minos.objects,
      maxMemberMinOS: minos.max.toFixed(1),
      rustStdMayBeLowerThanTarget: true,
      swiftObjectMinOS: minos.swiftMinos,
      symbols: requiredSymbols,
      finalHelperRequirement:
        "the linked Helper Mach-O must also report minos 14.2",
    },
    cargoTree: {
      path: join(paths.buildRoot, "cargo-tree.txt"),
      sha256: await sha256File(join(paths.buildRoot, "cargo-tree.txt")),
      packages,
      onlyR9AuditedPackages: true,
    },
    header: { path: paths.header, sha256: await sha256File(paths.header) },
    licenses: {
      sourceRoot: join(R9_SOURCE_ROOT, VISUAL_CRATE),
      files: prepareManifest.source.licenses,
      copiedTo: join(paths.libRoot, "licenses"),
    },
    captureEntry: false,
  };
  await writeFile(
    join(paths.buildRoot, "build-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return manifest;
}

export async function buildRound11Visual(options = {}) {
  const root = outputRootFrom(options);
  if (!cachedBuilds.has(root)) {
    cachedBuilds.set(
      root,
      buildOnce({ outputRoot: root }).catch((error) => {
        cachedBuilds.delete(root);
        throw error;
      }),
    );
  }
  return cachedBuilds.get(root);
}

export async function runRound11VisualUnitTests(options = {}) {
  const paths = visualPaths(outputRootFrom(options));
  await prepareRound11Visual({ outputRoot: paths.root });
  const env = {
    ...process.env,
    PATH: `${join(RUST_TOOLCHAIN_ROOT, "bin")}:${process.env.PATH ?? ""}`,
    RUSTC: join(RUST_TOOLCHAIN_ROOT, "bin/rustc"),
    CARGO_HOME: paths.cargoHome,
    CARGO_TARGET_DIR: paths.targetDir,
    CARGO_NET_OFFLINE: "true",
    MACOSX_DEPLOYMENT_TARGET: "14.2",
  };
  const args = [
    "test",
    "--manifest-path",
    join(paths.sourceRoot, "Cargo.toml"),
    "-p",
    "cua-macos-visual",
    "--lib",
    "--locked",
    "--offline",
  ];
  const tests = await run(RUST_CARGO, args, {
    env,
    cwd: REPO_ROOT,
    timeoutMs: 900_000,
  });
  return {
    status: tests.code === 0 ? "pass" : "fail",
    output: `${tests.stdout}\n${tests.stderr}`,
  };
}
