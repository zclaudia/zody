import { readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  sha256Buffer,
} from "./cua-driver-closure-core.mjs";
import { gitClosureEnvironment, runClosureCommand } from "./cua-driver-closure-command.mjs";

export function failedDependencies(error) {
  return {
    ...gateError(error),
    lock: { entryCount: 0, checksumEntries: 0 },
    graph: null,
    registry: { checked: 0, status: "blocked" },
    targetGraph: { status: "blocked", error: { message: error.message } },
    build: null,
  };
}

export function gateError(error) {
  return {
    status: error instanceof ClosureBlockedError ? "blocked" : "fail",
    error: {
      code: error.code ?? "verification-failed",
      message: error.message,
    },
  };
}

export async function readUpstreamLicense({ sourceRepo, revision, path }) {
  const result = await runClosureCommand(
    "git",
    ["-C", sourceRepo, "cat-file", "blob", `${revision}:${path}`],
    {
      env: gitClosureEnvironment(),
      timeoutMs: 15_000,
      maxOutputBytes: 2 * 1024 * 1024,
      allowFailure: true,
    },
  );
  if (result.code !== 0 || !Buffer.isBuffer(result.stdoutBuffer)) {
    throw new ClosureBlockedError("upstream-license-missing", `missing upstream license: ${path}`);
  }
  return {
    path,
    sha256: sha256Buffer(result.stdoutBuffer),
    observedFirstLine: result.stdoutBuffer.toString("utf8").split(/\r?\n/, 1)[0] ?? "",
    buffer: result.stdoutBuffer,
  };
}

export async function licensePackageRoots(dependencies) {
  const sourceCopy = await realpath(dependencies.workspace.sourceCopy);
  const licenseMetadata = new Map(
    dependencies.metadata.packages.map((entry) => [
      `${entry.name}@${entry.version}`,
      entry.license,
    ]),
  );
  const registryDirectories = await readdir(
    join(dependencies.workspace.cargoHomeCopy, "registry", "src"),
    { withFileTypes: true },
  );
  const registrySources = new Map();
  for (const directory of registryDirectories.filter((entry) => entry.isDirectory())) {
    const root = join(dependencies.workspace.cargoHomeCopy, "registry", "src", directory.name);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (registrySources.has(entry.name)) {
        throw new ClosureVerificationError(`ambiguous registry source: ${entry.name}`);
      }
      registrySources.set(entry.name, join(root, entry.name));
    }
  }
  if (registrySources.size === 0) {
    throw new ClosureBlockedError("registry-source-missing", "registry source cache is missing");
  }
  return Promise.all(
    dependencies.graph.packages.map(async (entry) => {
      const key = `${entry.name}@${entry.version}`;
      if (entry.path) {
        const path = relative(sourceCopy, await realpath(entry.path));
        if (path.startsWith("..")) {
          throw new ClosureVerificationError(
            `license package path escapes the candidate source: ${key}`,
          );
        }
        return {
          package: key,
          root: entry.path,
          label: path.startsWith("vendor/") ? path : `source/${path}`,
          expression:
            typeof licenseMetadata.get(key) === "string" ? licenseMetadata.get(key) : null,
          workspaceRootLicenseApplicable: !path.startsWith("vendor/"),
        };
      }
      const sourceRoot = registrySources.get(`${entry.name}-${entry.version}`);
      if (!sourceRoot) {
        throw new ClosureBlockedError("registry-source-missing", `missing registry source: ${key}`);
      }
      return {
        package: key,
        root: sourceRoot,
        label: `registry/${entry.name}-${entry.version}`,
        expression: null,
      };
    }),
  );
}

export async function normalizeGraph(graph, sourceCopy) {
  if (!graph) return null;
  const sourceRoot = await realpath(sourceCopy);
  const packages = [];
  for (const entry of graph.packages) {
    let path = null;
    if (entry.path) {
      const relativePath = relative(sourceRoot, await realpath(entry.path));
      path = relativePath.startsWith("..") ? null : relativePath;
    }
    packages.push({ ...entry, path });
  }
  return { ...graph, packages };
}

function appendArgument(lines, value) {
  lines[lines.length - 1] += " \\";
  lines.push(value);
}

export function buildRerun(options) {
  const lines = [
    "node packages/desktop/scripts/audit-macos-cua-driver-closure.mjs \\",
    `  --source-repo ${options.sourceRepo} \\`,
    `  --candidate-root ${options.candidateRoot} \\`,
    `  --cargo-home ${options.cargoHome} \\`,
    `  --output-dir ${options.outputDir}`,
  ];
  if (options.rebuildCache) appendArgument(lines, "  --rebuild-cache");
  if (options.toolchainRoot) appendArgument(lines, `  --toolchain-root ${options.toolchainRoot}`);
  if (options.licenseSupplements)
    appendArgument(lines, `  --license-supplements ${options.licenseSupplements}`);
  if (options.buildMode) appendArgument(lines, `  --${options.buildMode}`);
  return lines.join("\n");
}

export function blockedItems({ cache, dependencies, licenses, toolchain, build, gates }) {
  const items = [];
  if (cache?.originalCache?.status && cache.originalCache.status !== "pass") {
    items.push({
      gate: "originalCache",
      status: cache.originalCache.status,
      reason: cache.originalCache.driftReason,
    });
  }
  if (dependencies.status !== "pass") {
    items.push({
      gate: "dependencies",
      status: dependencies.status,
      reason:
        dependencies.error?.message ??
        dependencies.registry?.error?.message ??
        dependencies.targetGraph?.error?.message ??
        "dependency audit incomplete",
    });
  }
  if (build?.status && build.status !== "pass") {
    items.push({
      gate: "build",
      status: build.status,
      reason: build.error?.message ?? "build evidence incomplete",
    });
  }
  if (licenses.status !== "pass") {
    const licenseReason =
      licenses.error?.message ??
      `${licenses.missingMaterials?.length ?? 0} packages lack package-level material (workspace-root relation may be pending); ${licenses.reviewRequired?.length ?? 0} require license review; ${licenses.incompleteCoverage?.length ?? 0} have partial material coverage`;
    items.push({
      gate: "licenses",
      status: licenses.status,
      reason: licenseReason,
    });
  }
  if (toolchain.status !== "pass") {
    items.push({ gate: "toolchain", status: toolchain.status, reason: toolchain.reason });
  }
  if (gates.productAdoption !== "pass") {
    items.push({ gate: "productAdoption", status: "blocked", reason: gates.productAdoptionReason });
  }
  return items;
}

export function renderAuditReadme(report) {
  const { source, dependencies, licenses, originalCache, reconstructedCache } = report;
  const cacheLine = originalCache
    ? `- 原始 cache：${originalCache.status}（checksum ${originalCache.archivesChecksumStatus}，source ${originalCache.originalSourceStatus}）；重建 ${reconstructedCache?.packageCount ?? 0} 个包，${reconstructedCache?.status ?? "blocked"}。`
    : "- 原始 cache：未启用 `--rebuild-cache`，沿用第五轮入口。";
  const buildLine = report.build
    ? `- 编译证据：${report.build.status}（${report.build.mode}，build scripts ${report.build.buildScriptCount ?? 0}，compiled proc-macro ${report.build.compiledProcMacroCount ?? 0}）。未启动上游应用或测试。`
    : "- 编译证据：未请求。";
  return `# Driver 依赖闭包审计结果\n\n生成时间：${report.generatedAt}\n\n- 固定 upstream：\`${report.revision}\` (\`${report.sourceRoot}\`)\n- 来源审计：${source.status}；${source.counts.selected} 个固定源文件，${source.counts.modified} 个冻结差额文件，${source.counts.added} 个新增文件，${source.counts.candidate} 个候选文件。\n- 自包含 patch：\`${report.patch.path}\`，sha256 \`${report.patch.sha256}\`；应用后逐字节重建：${report.patch.reconstruction}。\n${cacheLine}\n- 锁定依赖：${dependencies.lock.entryCount} 个 lock 条目；实际 macOS normal/build 图：${dependencies.graph?.packageCount ?? "blocked"} 个包，root \`${dependencies.graph?.root ?? dependencies.graph?.package ?? "unknown"}\`。\n- registry 缓存：${dependencies.registry.checked} 个包完成 archive checksum 与解包源逐文件比对；状态 ${dependencies.registry.status}。\n- 许可材料：${licenses.packageCount} 个包；缺包级正文 ${licenses.missingMaterials?.length ?? 0}，待义务审查 ${licenses.reviewRequired?.length ?? 0}，部分材料覆盖 ${licenses.incompleteCoverage?.length ?? 0}；归档 ${licenses.archive?.fileCount ?? 0} 个正文/通知文件。该结果仅为表达式/正文/哈希清单，不是法律结论。\n- 工具链：声明 ${report.toolchain.upstreamDeclared}，本机审计 ${report.toolchain.auditedVersion}；${report.toolchain.reason}\n${buildLine}\n\n## Gates\n\n| Gate | Status |\n| --- | --- |\n| source | ${report.gates.source} |\n| dependencies | ${report.gates.dependencies} |\n| licenses | ${report.gates.licenses} |\n| toolchain | ${report.gates.toolchain} |\n| build | ${report.gates.build ?? "not-requested"} |\n| productAdoption | ${report.gates.productAdoption} |\n\n退出码 \`${report.gates.exitCode}\` 仅表示已实现来源审计是否可完成/无验证失败；不表示产品闭包通过。本轮不是全产品验收。\n\n## 阻断项\n\n${report.blockedItems.map((item) => `- ${item.gate} (${item.status})：${item.reason}`).join("\n")}\n\n完整逐文件哈希、特性、registry 包和许可材料见 \`report.json\`；许可正文位于 \`licenses/\`，索引见 \`licenses-index.json\`。本工具仅在显式请求时执行 Cargo 离线编译；不启动上游应用或测试、不申请 TCC，也不启用产品 CUA。\n`;
}
