import { prepareWorkspaceIdentity } from "./third-party-workspace-identity.mjs";
export { prepareWorkspaceIdentity } from "./third-party-workspace-identity.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const exec = promisify(execFile);
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noticeName =
  /(?:^|[._-])(?:licen[sc]es?|copying|notice|copyright|unlicense|third.party|ofl)(?:[._-]|$)/iu;

export async function readPackageNotices(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", "tests", "fixtures"].includes(entry.name)) continue;
      // Chromium 聚合许可由打包流程经 resources/licenses/electron 单独分发，不进 npm 通知。
      if (entry.isFile() && entry.name === "LICENSES.chromium.html") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && noticeName.test(entry.name)) {
        const bytes = await readFile(full);
        if (bytes.includes(0) || bytes.length === 0) continue;
        files.push({ member: relative(directory, full).replaceAll("\\", "/"), bytes });
      } else if (entry.isFile() && /^readme(?:\.[^/]*)?$/iu.test(entry.name)) {
        const text = await readFile(full, "utf8");
        const match = /^(?:#{1,6}\s+licen[sc]e[^\n]*\n|licen[sc]e\s*\n[=-]+\n)/imu.exec(text);
        if (match) {
          const section = text.slice(match.index).split(/\n(?=#{1,6}\s)/u)[0];
          files.push({
            member: `${relative(directory, full).replaceAll("\\", "/")} (license section)`,
            bytes: Buffer.from(section),
          });
        }
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.member.localeCompare(b.member, "en"));
}

// 解析锁文件（v9）packages 段的平台约束：`  'name@version':` 下的 `    os/cpu/libc: [..]` 行。
export function readLockfilePlatformConstraints(lockfileText) {
  const constraints = new Map();
  let inPackages = false;
  let key = null;
  for (const line of lockfileText.split(/\r?\n/u)) {
    if (/^\S/u.test(line)) {
      inPackages = line === "packages:";
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const header = /^ {2}(?:'([^']+)'|([^\s'][^:]*)):$/u.exec(line);
    if (header) {
      key = header[1] ?? header[2];
      continue;
    }
    const field = key && /^ {4}(os|cpu|libc): \[(.*)\]$/u.exec(line);
    if (field) {
      const values = field[2]
        .split(",")
        .map((value) => value.trim().replace(/^'(.*)'$/u, "$1"))
        .filter(Boolean);
      constraints.set(key, { ...constraints.get(key), [field[1]]: values });
    }
  }
  return constraints;
}

// 照搬 pnpm package-is-installable 的 checkList，保证与实际安装结果一致（含否定项语义）。
function pnpmCheckList(values, list) {
  if (list.length === 1 && list[0] === "any") return true;
  let match = false;
  let blc = 0;
  for (const value of values) {
    for (const item of list) {
      if (item[0] === "!") {
        if (item.slice(1) === value) return false;
        ++blc;
      } else {
        match = match || item === value;
      }
    }
  }
  return match || blc === list.length;
}

// targets.libc 为 null 表示宿主 libc 未知（非 Linux），pnpm 此时不检查 libc。
export function createInstallablePackageFilter(constraints, targets) {
  return (name, version) => {
    const wanted = constraints.get(`${name}@${version.split("(")[0]}`);
    if (!wanted) return true;
    if (wanted.os && !pnpmCheckList(targets.os, wanted.os)) return false;
    if (wanted.cpu && !pnpmCheckList(targets.cpu, wanted.cpu)) return false;
    if (wanted.libc && targets.libc && !pnpmCheckList(targets.libc, wanted.libc)) return false;
    return true;
  };
}

function hostLibc() {
  if (process.platform !== "linux") return null;
  return process.report?.getReport?.()?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

// 与 pnpm checkPlatform 相同：supportedArchitectures 未配置时只取宿主，`current` 替换为宿主值。
export async function readInstallTargets(root) {
  const { parse } = await import("yaml");
  const workspace = parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")) ?? {};
  const supported = workspace.supportedArchitectures ?? {};
  const resolveCurrent = (list, current) =>
    (list ?? ["current"]).map((value) => (value === "current" ? current : value));
  const libc = hostLibc();
  return {
    os: resolveCurrent(supported.os, process.platform),
    cpu: resolveCurrent(supported.cpu, process.arch),
    libc: libc ? resolveCurrent(supported.libc, libc) : null,
  };
}

// pnpm 跳过的平台包及其独有依赖不属于可安装生产图。
export function productionPackages(projects, isInstallable = () => true, identity) {
  // 纯图测试可不提供异步 identity；仅绝对路径完全一致才识别 workspace。
  const ownPaths = new Set(
    projects.map((project) => project.path && resolve(project.path)).filter(Boolean),
  );
  const classify =
    identity?.classify ??
    ((info, parentPath, alias) => {
      const link = typeof info.version === "string" && info.version.startsWith("link:");
      const target = info.path
        ? resolve(info.path)
        : link && parentPath
          ? resolve(parentPath, info.version.slice(5))
          : undefined;
      if (target && ownPaths.has(target)) return "workspace";
      if (link)
        throw new Error(
          `Unresolved non-workspace link identity: parent=${parentPath ?? "(unknown)"} alias=${alias} target=${target ?? info.version}`,
        );
      return "third-party";
    });
  const required = new Map();
  function dependencies(deps, parentPath) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const name = info.name ?? alias;
      if (!isInstallable(name, info.version)) continue;
      if (classify(info, parentPath, alias) === "third-party") {
        required.set(`${name}@${info.version}`, { name, version: info.version });
      }
      // pnpm 的递归 ls 在嵌套节点保留顶层 importer 的 link 值和相对基准。
      dependencies(info.dependencies, parentPath);
      dependencies(info.optionalDependencies, parentPath);
    }
  }
  for (const project of projects) {
    dependencies(project.dependencies, project.path);
    dependencies(project.optionalDependencies, project.path);
  }
  return required;
}

export function assertProductionGraphs(lockedProjects, installedProjects, isInstallable, identity) {
  const locked = productionPackages(lockedProjects, isInstallable, identity);
  const installed = productionPackages(installedProjects, isInstallable, identity);
  const missing = [...locked].filter(([key]) => !installed.has(key));
  const stale = [...installed.keys()].filter((key) => !locked.has(key));
  if (missing.length || stale.length) {
    throw new Error(
      `Installed production graph differs from pnpm-lock.yaml. Run pnpm install --frozen-lockfile.\nMissing: ${missing.map(([key]) => key).join(", ")}\nStale: ${stale.join(", ")}`,
    );
  }
  return locked;
}

export async function readWorkspaceProductionGraph(root) {
  root = await realpath(root);
  // 修复：pnpm ls 默认读取安装快照，不能把旧图与当前锁文件哈希拼成有效声明。
  const [locked, actual] = await Promise.all(
    [true, false].map(async (lockfileOnly) => {
      const { stdout } = await exec(
        "pnpm",
        [
          "-r",
          "ls",
          "--prod",
          "--json",
          "--depth",
          "Infinity",
          ...(lockfileOnly ? ["--lockfile-only"] : []),
        ],
        {
          cwd: root,
          maxBuffer: 256 * 1024 * 1024,
          ...resolveSpawnRuntimeOptions("pnpm"),
        },
      );
      return JSON.parse(stdout);
    }),
  );
  const isInstallable = createInstallablePackageFilter(
    readLockfilePlatformConstraints(await readFile(join(root, "pnpm-lock.yaml"), "utf8")),
    await readInstallTargets(root),
  );
  const identity = await prepareWorkspaceIdentity(locked, actual);
  const required = assertProductionGraphs(locked, actual, isInstallable, identity);
  return { required, projects: actual };
}

export async function scanInstalledPackages(root, projects) {
  // 修复：真实 workspace 目录与外部同名包必须分开，不能用 name/version 推断来源。
  const installed = new Map();
  const visited = new Set();
  const visitedPackages = new Set();
  const workspacePaths = new Set(
    await Promise.all(
      projects.filter((project) => project.path).map((project) => realpath(project.path)),
    ),
  );
  async function scanNodeModules(directory) {
    let actual;
    try {
      actual = await realpath(directory);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
      throw error;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name.startsWith(".")) continue;
      const target = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of (await readdir(target)).sort())
          await scanPackage(join(target, scoped));
      } else await scanPackage(target);
    }
  }
  async function scanPackage(directory) {
    let pkg, actual;
    try {
      actual = await realpath(directory);
      pkg = JSON.parse(await readFile(join(actual, "package.json"), "utf8"));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
      throw error;
    }
    if (visitedPackages.has(actual)) return;
    visitedPackages.add(actual);
    if (!workspacePaths.has(actual) && pkg.name && pkg.version) {
      const key = `${pkg.name}@${pkg.version}`;
      const current = installed.get(key);
      const copy = { pkg, directory: actual };
      if (current) current.copies.push(copy);
      else installed.set(key, { ...copy, copies: [copy] });
    }
    // workspace 本体不计入第三方，但其 node_modules 仍须递归。
    await scanNodeModules(join(actual, "node_modules"));
  }
  for (const project of projects) await scanNodeModules(join(project.path, "node_modules"));
  await scanNodeModules(join(root, "node_modules"));
  await scanNodeModules(join(root, "apps/zody-cli/node_modules"));
  return installed;
}

export async function verifyInstalledCopies(key, item) {
  const copies = item.copies ?? [item];
  if (copies.length < 2) return;
  const signatures = [];
  for (const copy of copies) {
    const notices = await readPackageNotices(copy.directory);
    signatures.push(
      JSON.stringify({
        license: copy.pkg.license ?? copy.pkg.licenses ?? null,
        repository:
          typeof copy.pkg.repository === "string"
            ? copy.pkg.repository
            : (copy.pkg.repository?.url ?? null),
        notices: notices.map(({ member, bytes }) => ({ member, sha256: hashBytes(bytes) })),
      }),
    );
  }
  if (new Set(signatures).size !== 1) {
    throw new Error(
      `Conflicting installed third-party copies for ${key}: ${copies.map((copy) => copy.directory).join(", ")}`,
    );
  }
}

// 基础检查覆盖全部安装包，生产标记仅来自已验证的生产图。
export async function collectInstalledLicenseRecords(scanned, required, normalize) {
  const records = new Map();
  for (const [key, item] of scanned) {
    await verifyInstalledCopies(key, item);
    records.set(key, {
      name: item.pkg.name,
      version: item.pkg.version,
      license: normalize(item.pkg),
      isProd: required.has(key),
    });
  }
  return records;
}

export function missingProductionPackages(required, installed) {
  const missing = [...required].filter(([key]) => !installed.has(key)).map(([, item]) => item);
  for (const item of missing) {
    throw new Error(`Missing installed dependency: ${item.name}@${item.version}`);
  }
  return missing;
}

export async function collectNpmNotices(root, overrides) {
  root = await realpath(root);
  const { required, projects } = await readWorkspaceProductionGraph(root);
  // 修复：标识门禁和声明生成必须扫描同一安装集合，避免嵌套版本只进声明、不进门禁。
  const installed = await scanInstalledPackages(root, projects);
  const packages = [];
  const missing = [];
  const notInstalled = missingProductionPackages(required, installed);
  for (const [key, item] of [...required].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const installedPackage = installed.get(key);
    if (!installedPackage) {
      continue;
    }
    await verifyInstalledCopies(key, installedPackage);
    const { pkg, directory } = installedPackage;
    const notices = await readPackageNotices(directory);
    const override = overrides.find((record) => record.package === key);
    if (override?.file) {
      const bytes = await readFile(join(root, override.file));
      if (hashBytes(bytes) !== override.sha256) throw new Error(`Changed upstream notice: ${key}`);
      notices.push({ member: override.source, bytes });
    }
    // README 中仅有 MIT 等标签不能冒充完整许可文件；这种包仍需要版本固定的补充材料。
    if (
      !notices.some(({ member }) => !member.endsWith(" (license section)")) &&
      !override?.acceptedMissingNotice
    )
      missing.push(key);
    packages.push({
      ...item,
      license:
        pkg.license ??
        pkg.licenses?.map((item) => (typeof item === "string" ? item : item.type)).join(" OR ") ??
        override?.license ??
        "(not declared)",
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      ...(override?.acceptedMissingNotice
        ? { acceptedMissingNotice: override.acceptedMissingNotice }
        : {}),
      notices,
    });
  }
  if (missing.length) throw new Error(`Missing complete upstream notices:\n${missing.join("\n")}`);
  return {
    packages,
    notInstalled,
    workspaceManifests: projects.map((project) =>
      relative(root, join(project.path, "package.json")).replaceAll("\\", "/"),
    ),
  };
}
