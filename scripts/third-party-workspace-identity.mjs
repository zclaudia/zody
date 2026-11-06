import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// 修复：workspace 与第三方包可同名同版本；必须比较真实目录，不能以名称或命名空间推断归属。
export async function prepareWorkspaceIdentity(
  lockedProjects,
  installedProjects,
  { canonicalize = realpath } = {},
) {
  const workspacePaths = new Set();
  for (const project of [...lockedProjects, ...installedProjects]) {
    if (project.path) workspacePaths.add(await canonicalize(resolve(project.path)));
  }
  const candidates = new Set();
  function visit(deps, parentPath) {
    for (const info of Object.values(deps ?? {})) {
      const link = typeof info.version === "string" && info.version.startsWith("link:");
      const target = info.path
        ? resolve(info.path)
        : link && parentPath
          ? resolve(parentPath, info.version.slice(5))
          : undefined;
      if (target) candidates.add(target);
      if (link && parentPath) candidates.add(resolve(parentPath, info.version.slice(5)));
      visit(info.dependencies, parentPath);
      visit(info.optionalDependencies, parentPath);
    }
  }
  for (const project of [...lockedProjects, ...installedProjects]) {
    visit(project.dependencies, project.path);
    visit(project.optionalDependencies, project.path);
  }
  const canonical = new Map();
  const paths = [...candidates];
  // 控制并发，避免大 workspace 的 pnpm 图同时打开过多文件。
  for (let index = 0; index < paths.length; index += 32) {
    await Promise.all(
      paths.slice(index, index + 32).map(async (target) => {
        try {
          canonical.set(target, await canonicalize(target));
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
          canonical.set(target, null);
        }
      }),
    );
  }
  return {
    classify(info, parentPath, alias) {
      const link = typeof info.version === "string" && info.version.startsWith("link:");
      const target = info.path
        ? resolve(info.path)
        : link && parentPath
          ? resolve(parentPath, info.version.slice(5))
          : undefined;
      const actual = target && (canonical.has(target) ? canonical.get(target) : target);
      const linkTarget =
        link && parentPath ? resolve(parentPath, info.version.slice(5)) : undefined;
      const actualLink =
        linkTarget && (canonical.has(linkTarget) ? canonical.get(linkTarget) : linkTarget);
      if (link && info.path && (!actual || !actualLink || actual !== actualLink)) {
        throw new Error(
          `Conflicting workspace link identity: parent=${parentPath ?? "(unknown)"} alias=${alias} path=${target} link=${linkTarget}`,
        );
      }
      if (actual && workspacePaths.has(actual)) return "workspace";
      if (link)
        throw new Error(
          `Unresolved non-workspace link identity: parent=${parentPath ?? "(unknown)"} alias=${alias} target=${target ?? info.version}`,
        );
      return "third-party";
    },
  };
}
