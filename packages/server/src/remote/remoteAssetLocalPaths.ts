import { REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS } from "./zodyAgentOfficialPluginAssets.js";

export function resolveRequiredLocalReleasePaths(
  platformArch: string,
  componentIds: string[] | undefined,
): string[] {
  const ids =
    componentIds && componentIds.length > 0 ? componentIds : ["server-bundle", "node-runtime"];
  const requiredPaths = new Set<string>();

  for (const componentId of ids) {
    switch (componentId) {
      case "server-bundle":
        requiredPaths.add("server/zody-server.cjs");
        break;
      case "node-runtime":
        requiredPaths.add(`node/${platformArch}/node`);
        break;
      case "node-pty":
        requiredPaths.add(`node-pty/${platformArch}/pty.node`);
        if (platformArch.startsWith("darwin-")) {
          requiredPaths.add(`node-pty/${platformArch}/spawn-helper`);
        }
        break;
      case "glm":
        requiredPaths.add(`glm/${platformArch}/zody.cjs`);
        for (const relativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
          requiredPaths.add(`glm/${platformArch}/packages/${relativePath}`);
        }
        break;
      case "bfs":
        requiredPaths.add(`tools/${platformArch}/bfs/bfs`);
        break;
      case "ripgrep":
        requiredPaths.add(`tools/${platformArch}/ripgrep/rg`);
        break;
      case "ugrep":
        requiredPaths.add(`tools/${platformArch}/ugrep/ugrep`);
        break;
    }
  }

  return [...requiredPaths];
}
