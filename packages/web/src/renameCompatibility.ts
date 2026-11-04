import { checkRenameGeneration, type ServerRemoteInfo } from "@zody/shared";

/** 校验未缓存的服务端代际后才允许 Web 建立业务连接。 */
export async function requireCompatibleServerInfo(
  response: Response,
): Promise<Partial<ServerRemoteInfo>> {
  if (!response.ok) throw new Error(`server-info HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !checkRenameGeneration((value as Record<string, unknown>).renameGeneration).ok
  ) {
    throw new Error("incompatible-generation");
  }
  return value as Partial<ServerRemoteInfo>;
}

export async function resolveCompatibleWebBootstrap(
  wsOrigin: string,
  search: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ wsUrl: string; initialWorkspaceAbsPath?: string; initialWorkspaceIdentity?: string }> {
  const remoteId = new URLSearchParams(search).get("remote");
  const wsUrl = remoteId ? `${wsOrigin}/ws/remote/${remoteId}` : `${wsOrigin}/ws`;
  const serverInfo = await requireCompatibleServerInfo(
    await fetchImpl("/api/server-info", { cache: "no-store" }),
  );
  if (remoteId) return { wsUrl };
  const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
  return {
    wsUrl,
    ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
    ...(workspace?.workspaceIdentity
      ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
      : {}),
  };
}
