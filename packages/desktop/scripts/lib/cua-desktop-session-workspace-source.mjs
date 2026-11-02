// workspace dist -> current source：先让 esbuild 按真实 package exports/条件解析，
// 再把 workspace 包 dist 结果换成同包现有 src 文件；不猜私有入口，不碰 node_modules。
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { REPO_ROOT } from "./cua-desktop-session-config.mjs";

const WORKSPACE_PACKAGE_ROOTS = [
  join(REPO_ROOT, "packages"),
  join(REPO_ROOT, "apps", "zcode-cli", "packages"),
];

function isWorkspacePackagePath(path) {
  // @zcode/adapters/node_modules/* 是锁定的第三方闭包，不是 workspace 包源码。
  if (path.split(sep).includes("node_modules")) return false;
  return WORKSPACE_PACKAGE_ROOTS.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

export async function workspaceSourceCounterpart(inputPath) {
  const absolute = resolve(REPO_ROOT, inputPath);
  if (!isWorkspacePackagePath(absolute)) return undefined;
  const marker = `${sep}dist${sep}`;
  const index = absolute.lastIndexOf(marker);
  if (index < 0) return undefined;
  const sourceBase = `${absolute.slice(0, index)}${sep}src${sep}${absolute.slice(index + marker.length)}`;
  const candidates = sourceBase.endsWith(".js")
    ? [".ts", ".tsx", ".mts", ".cts"].map((extension) => sourceBase.slice(0, -3) + extension)
    : [];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // 继续尝试下一个源码扩展名；全部不存在时保留 esbuild 的真实解析结果。
    }
  }
  return undefined;
}

export function staleWorkspaceDistInputs(metafile) {
  return Object.keys(metafile.inputs ?? {})
    .filter((input) => {
      const absolute = resolve(REPO_ROOT, input);
      return isWorkspacePackagePath(absolute) && absolute.includes(`${sep}dist${sep}`);
    })
    .sort();
}

export function createWorkspaceSourcePlugin() {
  return {
    name: "cua-desktop-session-workspace-source",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^@zcode\// }, async (args) => {
        if (args.pluginData?.cuaWorkspaceSourceResolving) return null;
        const resolved = await pluginBuild.resolve(args.path, {
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { ...args.pluginData, cuaWorkspaceSourceResolving: true },
        });
        if (resolved.errors.length > 0 || resolved.external) {
          return { ...resolved, pluginData: args.pluginData };
        }
        const source = await workspaceSourceCounterpart(resolved.path);
        return source === undefined
          ? { ...resolved, pluginData: args.pluginData }
          : { ...resolved, path: source, pluginData: args.pluginData };
      });
    },
  };
}
