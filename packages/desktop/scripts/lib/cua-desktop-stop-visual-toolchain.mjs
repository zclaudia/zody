// stop-worker 固定 Rust 工具链的路径/环境/参数组装。
import { join } from "node:path";
import {
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  REPO_ROOT,
} from "./cua-desktop-session-config.mjs";

export function repoPath(path) {
  return path.startsWith("/") ? path : join(REPO_ROOT, path);
}

export function cargoEnv(baseline, paths) {
  const toolchainRoot = join(repoPath(baseline.toolchain.cargo), "..", "..");
  return {
    ...process.env,
    PATH: `${join(toolchainRoot, "bin")}:${process.env.PATH ?? ""}`,
    RUSTC: join(toolchainRoot, "bin/rustc"),
    CARGO_HOME: paths.cargoHome,
    CARGO_TARGET_DIR: paths.targetDir,
    CARGO_NET_OFFLINE: "true",
    MACOSX_DEPLOYMENT_TARGET: FIXED_DEPLOYMENT_TARGET,
  };
}

export function cargoArgs(paths, profile, subcommand = "build") {
  const args = [
    subcommand,
    "--manifest-path",
    join(paths.sourceRoot, "Cargo.toml"),
    "-p",
    "cua-macos-visual",
    ...(subcommand === "test" ? ["--lib"] : ["--release"]),
    "--locked",
    "--offline",
    "--target",
    FIXED_ARCH === "arm64" ? "aarch64-apple-darwin" : FIXED_ARCH,
  ];
  for (const feature of profile.cargoFeatures) {
    args.push("--features", feature);
  }
  return args;
}
