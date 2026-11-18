import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const prefix = "zody-macos-private-signing-";
const genericError = () =>
  new Error(
    "Private macOS keychain setup failed; check the configured certificate secrets and runner environment.",
  );
const cleanupError = () =>
  new Error(
    "Private macOS keychain cleanup failed; ownership could not be verified or resources could not be removed.",
  );
const safeAbsolute = (value) =>
  typeof value === "string" &&
  isAbsolute(value) &&
  !["\r", "\n", "\0"].some((character) => value.includes(character));
const runDefault = async (command, args) => exec(command, args);

export async function setupPrivateKeychain({ env = process.env, deps = {} } = {}) {
  const encoded = env.ZODY_MAC_PRIVATE_CERT_P12_BASE64;
  const password = env.ZODY_MAC_PRIVATE_CERT_PASSWORD;
  if (!encoded || !password)
    throw new Error(
      "Private macOS signing requires ZODY_MAC_PRIVATE_CERT_P12_BASE64 and ZODY_MAC_PRIVATE_CERT_PASSWORD.",
    );
  if (
    !safeAbsolute(env.RUNNER_TEMP) ||
    !safeAbsolute(env.GITHUB_ENV) ||
    env.ZODY_MAC_PRIVATE_DIRECTORY ||
    env.ZODY_MAC_PRIVATE_OWNER ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    throw genericError();
  const run = deps.run ?? runDefault;
  const secret = (deps.randomPassword ?? (() => randomBytes(32).toString("hex")))();
  let directory;
  let ownedEnv;
  try {
    directory = await mkdtemp(join(resolve(env.RUNNER_TEMP), prefix));
    const keychain = join(directory, "signing.keychain-db");
    const p12 = join(directory, "identity.p12");
    const owner = randomUUID();
    await (deps.writeFile ?? writeFile)(
      join(directory, "owner.json"),
      JSON.stringify({ kind: "zody-private-keychain", owner }),
      { mode: 0o600, flag: "wx" },
    );
    ownedEnv = { ...env, ZODY_MAC_PRIVATE_DIRECTORY: directory, ZODY_MAC_PRIVATE_OWNER: owner };
    // 修复依据：always可能在setup未成功时执行；只发布本次唯一目录及所有权凭据，绝不扫描固定路径。
    await (deps.appendFile ?? appendFile)(
      env.GITHUB_ENV,
      `ZODY_MAC_PRIVATE_DIRECTORY=${directory}\nZODY_MAC_PRIVATE_OWNER=${owner}\nZODY_MAC_PRIVATE_KEYCHAIN=${keychain}\n`,
    );
    await (deps.writeFile ?? writeFile)(p12, Buffer.from(encoded, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    await run("/usr/bin/security", ["create-keychain", "-p", secret, keychain]);
    await run("/usr/bin/security", ["unlock-keychain", "-p", secret, keychain]);
    await run("/usr/bin/security", [
      "import",
      p12,
      "-k",
      keychain,
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
    ]);
    await run("/usr/bin/security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      secret,
      keychain,
    ]);
    await rm(p12, { force: true });
    return keychain;
  } catch {
    try {
      if (ownedEnv) await cleanupPrivateKeychain({ env: ownedEnv, deps });
      else if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      /* keep all command errors and secret-bearing arguments out of logs */
    }
    throw genericError();
  }
}

export async function cleanupPrivateKeychain({ env = process.env, deps = {} } = {}) {
  const directory = env.ZODY_MAC_PRIVATE_DIRECTORY;
  const owner = env.ZODY_MAC_PRIVATE_OWNER;
  if (!directory && !owner) return;
  if (
    !safeAbsolute(env.RUNNER_TEMP) ||
    !safeAbsolute(directory) ||
    typeof owner !== "string" ||
    !owner ||
    dirname(directory) !== resolve(env.RUNNER_TEMP) ||
    !basename(directory).startsWith(prefix)
  )
    throw cleanupError();
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw cleanupError();
    const marker = join(directory, "owner.json");
    const markerInfo = await lstat(marker);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1)
      throw cleanupError();
    const actual = JSON.parse(await readFile(marker, "utf8"));
    if (actual.kind !== "zody-private-keychain" || actual.owner !== owner) throw cleanupError();
  } catch (error) {
    if (error?.code === "ENOENT") {
      // 已清理的唯一目录允许幂等结束；已有目录但缺marker不得移除。
      try {
        await lstat(directory);
      } catch (missing) {
        if (missing?.code === "ENOENT") return;
      }
    }
    throw cleanupError();
  }
  const keychain = join(directory, "signing.keychain-db");
  let failed = false;
  try {
    await (deps.run ?? runDefault)("/usr/bin/security", ["delete-keychain", keychain]);
  } catch {
    failed = true;
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    failed = true;
  }
  if (failed) throw cleanupError();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "setup") await setupPrivateKeychain();
    else if (process.argv[2] === "cleanup") await cleanupPrivateKeychain();
    else throw new Error("Expected setup or cleanup.");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
