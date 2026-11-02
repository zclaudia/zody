// Copies a normal Electron app shell into candidate staging. COPYFILE_FICLONE is only a
// hint: filesystems without clone support transparently retry with a regular copy.
import { constants as fsConstants } from "node:fs";
import { cp, rm } from "node:fs/promises";

const COPY_OPTIONS = Object.freeze({
  recursive: true,
  errorOnExist: true,
  preserveTimestamps: true,
  verbatimSymlinks: true,
});

const CLONE_UNSUPPORTED_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

export async function copyNormalHostAppBundle(
  source,
  destination,
  { cpImpl = cp, rmImpl = rm } = {},
) {
  try {
    return await cpImpl(source, destination, {
      ...COPY_OPTIONS,
      mode: fsConstants.COPYFILE_FICLONE,
    });
  } catch (error) {
    if (!CLONE_UNSUPPORTED_CODES.has(error?.code)) throw error;
    // cp may have created a partial destination before reporting clone failure.
    await rmImpl(destination, { recursive: true, force: true });
    return cpImpl(source, destination, COPY_OPTIONS);
  }
}
