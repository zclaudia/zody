// candidate sealed Host/CLI 的固定网络依赖材料。node-fetch 目前来自工作区
// 已锁定解析；构建必须保留实际 package source/license/lock 与每个 entry 的
// 输入 hash，不能只写一个“支持 fetch”的声明。
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DesktopSessionBuildError, REPO_ROOT } from "./cua-desktop-session-config.mjs";
import { sha256File } from "./cua-desktop-session-toolchain.mjs";

const EXPECTED_NAME = "node-fetch";
const EXPECTED_VERSION = "3.3.2";
const EXPECTED_LICENSE = "MIT";
const FETCH_CLOSURE_PACKAGES = [
  "node-fetch",
  "data-uri-to-buffer",
  "fetch-blob",
  "formdata-polyfill",
  "node-domexception",
  "web-streams-polyfill",
];
const CANDIDATE_FETCH_ENTRIES = new Set(["host-entry.mjs", "cli-entry.mjs"]);

function inputPackageName(input) {
  const marker = "node_modules/";
  const index = input.lastIndexOf(marker);
  if (index < 0) return undefined;
  const parts = input.slice(index + marker.length).split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function closureInputs(audit) {
  return Object.entries(audit.inputHashes ?? {})
    .filter(([input]) => FETCH_CLOSURE_PACKAGES.includes(inputPackageName(input)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sha256]) => ({ path, sha256 }));
}

export async function describeCandidateFetchMaterial(entries, repoRoot = REPO_ROOT) {
  const requireFromRoot = createRequire(join(repoRoot, "package.json"));
  let packageJsonPath;
  try {
    packageJsonPath = requireFromRoot.resolve(`${EXPECTED_NAME}/package.json`);
  } catch {
    throw new DesktopSessionBuildError(
      "candidate-fetch-missing",
      `${EXPECTED_NAME} is not resolvable from the locked workspace`,
    );
  }
  const packageDir = dirname(packageJsonPath);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (
    packageJson.name !== EXPECTED_NAME ||
    packageJson.version !== EXPECTED_VERSION ||
    packageJson.license !== EXPECTED_LICENSE
  ) {
    throw new DesktopSessionBuildError(
      "candidate-fetch-pin-mismatch",
      `${EXPECTED_NAME} must be ${EXPECTED_VERSION} ${EXPECTED_LICENSE}`,
      {
        name: packageJson.name,
        version: packageJson.version,
        license: packageJson.license,
      },
    );
  }
  const licensePath = join(packageDir, "LICENSE.md");
  const lockfilePath = join(repoRoot, "pnpm-lock.yaml");
  const lockfile = await readFile(lockfilePath, "utf8");
  if (!lockfile.includes(`${EXPECTED_NAME}@${EXPECTED_VERSION}:`) ||
      !lockfile.includes(`${EXPECTED_NAME}: ${EXPECTED_VERSION}`)) {
    throw new DesktopSessionBuildError(
      "candidate-fetch-lock-missing",
      `${EXPECTED_NAME}@${EXPECTED_VERSION} is not pinned by pnpm-lock.yaml`,
    );
  }
  const entriesWithFetch = {};
  for (const entry of entries) {
    const inputs = closureInputs(entry);
    if (CANDIDATE_FETCH_ENTRIES.has(entry.name) && inputs.length === 0) {
      throw new DesktopSessionBuildError(
        "candidate-fetch-not-bundled",
        `sealed entry ${entry.name} does not contain the real candidate fetch material`,
        { entryName: entry.name },
      );
    }
    if (inputs.length === 0) continue;
    entriesWithFetch[entry.name] = {
      bundleSha256: entry.sha256,
      bundleBytes: entry.bytes,
      inputs,
    };
  }
  return {
    name: EXPECTED_NAME,
    version: EXPECTED_VERSION,
    license: EXPECTED_LICENSE,
    importSpecifier: EXPECTED_NAME,
    installedBy: [...CANDIDATE_FETCH_ENTRIES],
    bundledIn: Object.keys(entriesWithFetch),
    packageDir,
    packageJson: { path: packageJsonPath, sha256: await sha256File(packageJsonPath) },
    licenseFile: { path: licensePath, sha256: await sha256File(licensePath) },
    lockfile: {
      path: lockfilePath,
      sha256: await sha256File(lockfilePath),
      resolution: `${EXPECTED_NAME}@${EXPECTED_VERSION}`,
      note: "workspace transitive resolution; bundle records actual inputs and hashes",
    },
    entries: entriesWithFetch,
  };
}
