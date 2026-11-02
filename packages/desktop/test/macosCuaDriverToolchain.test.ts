import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeDriverToolchain } from "../scripts/lib/cua-driver-closure-toolchain.mjs";

const tempDirs: string[] = [];
const RUSTC_COMMIT = "8bab26f4f68e0e26f0bb7960be334d5b520ea452";
const CARGO_COMMIT = "c980f4866141969fab6254a680546a277789d6f0";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-r6-toolchain-"));
  tempDirs.push(root);
  return root;
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function script(body: string) {
  return `#!/bin/sh\n${body}\n`;
}

async function fakeToolchain(
  root: string,
  options: { version?: string; host?: string; rustcCommit?: string; sysroot?: string } = {},
) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const version = options.version ?? "1.97.1";
  const host = options.host ?? "aarch64-apple-darwin";
  const rustcCommit = options.rustcCommit ?? RUSTC_COMMIT;
  const sysroot = options.sysroot ?? root;
  const rustcText = script(
    `if [ "$1" = "--print" ]; then echo "${sysroot}"; exit 0; fi\nprintf 'rustc ${version} (${rustcCommit.slice(0, 9)} 2026-07-14)\\nbinary: rustc\\ncommit-hash: ${rustcCommit}\\ncommit-date: 2026-07-14\\nhost: ${host}\\nrelease: ${version}\\nLLVM version: 22.1.6\\n'`,
  );
  const cargoText = script(
    `printf 'cargo ${version} (${CARGO_COMMIT.slice(0, 9)} 2026-06-30)\\nrelease: ${version}\\ncommit-hash: ${CARGO_COMMIT}\\ncommit-date: 2026-06-30\\nhost: ${host}\\n'`,
  );
  await writeFile(join(bin, "rustc"), rustcText);
  await writeFile(join(bin, "cargo"), cargoText);
  await chmod(join(bin, "rustc"), 0o755);
  await chmod(join(bin, "cargo"), 0o755);
  return {
    config: {
      version: "1.97.1",
      host: "aarch64-apple-darwin",
      rustc: { version: "1.97.1", commit: RUSTC_COMMIT, sha256: sha(rustcText) },
      cargo: { version: "1.97.1", commit: CARGO_COMMIT, sha256: sha(cargoText) },
    },
  };
}

describe("round 6 driver toolchain probe", () => {
  it("accepts only the pinned absolute toolchain and records digests", async () => {
    const root = await tempRoot();
    const { config } = await fakeToolchain(root);
    const rootReal = await realpath(root);
    const probe = await probeDriverToolchain({ toolchainRoot: root, config });
    expect(probe).toMatchObject({
      status: "pass",
      rustc: { version: "1.97.1", commit: RUSTC_COMMIT, host: "aarch64-apple-darwin" },
      cargo: { version: "1.97.1", commit: CARGO_COMMIT, host: "aarch64-apple-darwin" },
      rustcPath: join(rootReal, "bin", "rustc"),
      cargoPath: join(rootReal, "bin", "cargo"),
    });
  });

  it("refuses to fall back when the pinned root is missing", async () => {
    const root = await tempRoot();
    await expect(
      probeDriverToolchain({
        toolchainRoot: join(root, "missing"),
        config: { version: "1.97.1", host: "aarch64-apple-darwin" },
        sourceEnv: { PATH: "/usr/bin:/bin" },
      }),
    ).rejects.toMatchObject({ code: "toolchain-unavailable" });
  });

  it("rejects version, commit, host and sysroot drift", async () => {
    for (const drift of [
      { version: "1.96.0" },
      { rustcCommit: "9".repeat(40) },
      { host: "x86_64-apple-darwin" },
      { sysroot: "/tmp/other-sysroot" },
    ]) {
      const root = await tempRoot();
      const { config } = await fakeToolchain(root, drift);
      await expect(probeDriverToolchain({ toolchainRoot: root, config })).rejects.toMatchObject({
        code: expect.stringMatching(/toolchain-(mismatch|host|sysroot)/),
      });
    }
  });

  it("rejects binary digest drift before executing the drifted binary", async () => {
    const root = await tempRoot();
    const { config } = await fakeToolchain(root);
    const marker = join(root, "executed");
    const rustcPath = join(root, "bin", "rustc");
    const original = await readFile(rustcPath, "utf8");
    await writeFile(rustcPath, `${original}\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(rustcPath, 0o755);
    await expect(
      probeDriverToolchain({
        toolchainRoot: root,
        config: { ...config, rustc: { ...config.rustc, sha256: "0".repeat(64) } },
      }),
    ).rejects.toMatchObject({ code: "toolchain-digest" });
    await expect(access(marker)).rejects.toThrow();
  });
});
