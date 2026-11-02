import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ClosureVerificationError } from "./cua-driver-closure-core.mjs";

async function canonicalParent(directory) {
  const parent = dirname(resolve(directory));
  try {
    return await realpath(parent);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(parent, { recursive: true });
    return realpath(parent);
  }
}

export async function prepareClosureOutputDirectory(
  directory,
  { allowEmptyExisting = false } = {},
) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new ClosureVerificationError("invalid output directory");
  }
  const parent = await canonicalParent(directory);
  const target = join(parent, basename(resolve(directory)));
  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new ClosureVerificationError("output directory must not be a symlink");
    }
    if (!existing.isDirectory()) {
      throw new ClosureVerificationError("output path is not a directory");
    }
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new ClosureVerificationError("output directory already contains files");
    }
    if (!allowEmptyExisting) {
      throw new ClosureVerificationError("output directory already exists; choose a new directory");
    }
    return;
  }
  await mkdir(target);
  const created = await lstat(target);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new ClosureVerificationError("output directory was not created safely");
  }
}
