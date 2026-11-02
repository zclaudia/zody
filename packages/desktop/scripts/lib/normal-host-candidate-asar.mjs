// app.asar extraction/repacking for the normal utility Host candidate.
// The source shell is an existing electron-builder --dir output; this module only replaces
// archived runtime files and preserves the complete node_modules tree. The shared macOS
// integrity owner refreshes Info.plist after this module's final archive rewrite.
import { createHash } from "node:crypto";
import { readFile, rename, rm, stat } from "node:fs/promises";
import asar from "@electron/asar";
import { createAppAsarPackArgs } from "../app-asar-repack.mjs";

export const APP_ASAR_UNPACK_GLOB = "*.{node,dll,dylib,exe}";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function extractAppAsar({ appAsarPath, destinationDir }) {
  await stat(appAsarPath);
  asar.extractAll(appAsarPath, destinationDir);
  return destinationDir;
}

export function listAppAsarFiles(appAsarPath) {
  return asar.listPackage(appAsarPath);
}

/** Read one archive entry without writing through the CLI or into the caller's cwd. */
export function readAppAsarFile({ appAsarPath, filePath }) {
  return asar.extractFile(appAsarPath, filePath);
}

export async function packAppAsar({ sourceDir, appAsarPath, targetPlatformKey }) {
  const nextPath = `${appAsarPath}.next`;
  const nextUnpackedPath = `${nextPath}.unpacked`;
  const unpackedPath = `${appAsarPath}.unpacked`;
  await Promise.all([
    rm(nextPath, { force: true, recursive: true }),
    rm(nextUnpackedPath, { force: true, recursive: true }),
  ]);
  try {
    const args = createAppAsarPackArgs({
      sourceDir,
      destinationPath: nextPath,
      targetPlatformKey,
    });
    await asar.createPackageWithOptions(sourceDir, nextPath, {
      unpack: APP_ASAR_UNPACK_GLOB,
      unpackDir: `node_modules/node-pty/prebuilds/${targetPlatformKey}`,
    });
    const archive = await stat(nextPath);
    const unpacked = await stat(nextUnpackedPath);
    if (!archive.isFile() || !unpacked.isDirectory()) {
      throw new Error(`app.asar repack did not produce archive plus unpacked sidecar: ${nextPath}`);
    }
    // Keep the pack arguments auditable even though the programmatic call is authoritative.
    if (!args.includes("--unpack") || !args.includes("--unpack-dir")) {
      throw new Error("app.asar repack arguments lost native unpack policy");
    }
    await rm(unpackedPath, { force: true, recursive: true });
    await rename(nextUnpackedPath, unpackedPath);
    await rm(appAsarPath, { force: true });
    await rename(nextPath, appAsarPath);
    const bytes = await readFile(appAsarPath);
    return { bytes: bytes.length, sha256: sha256(bytes), unpackedPath };
  } finally {
    await Promise.all([
      rm(nextPath, { force: true, recursive: true }),
      rm(nextUnpackedPath, { force: true, recursive: true }),
    ]);
  }
}
