import { createConfig, resolvePath } from "@zody/adapters/config";
import type { Logger, McpConnectionSnapshot, McpPort, McpServerStatus } from "@zody/contracts";
import {
  zodyMcpListParamsSchema,
  zodyMcpListResultSchema,
  zodyWorkspaceMcpTrustParamsSchema,
  type ZodyMcpListResult,
  type ZodyWorkspaceMcpTrustResult,
} from "@zody/shared";
import {
  listMcpServerStatuses,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../mcp-config.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { getCliStorageRoot } from "../app/paths.js";
import { resolveStartupPlugins } from "../app/startup-marks.js";
import { createAppWorkspaceMcpTrust } from "../app/runtime-config.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { parseParams, type ZodyProtocolAgentServerContext } from "./server-types.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS = 5_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS = 100;

export async function listMcpServers(
  context: ZodyProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZodyMcpListResult> {
  const params = parseParams(zodyMcpListParamsSchema, rawParams);
  const workingDirectory = params.workspace.workspacePath;
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory,
  });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  const startupTimer = new StartupTimer(
    context.logger ?? noopLogger,
    {
      module: "bootstrap.zody_protocol.mcp",
      workspaceKey: params.workspace.workspaceKey,
      workspacePath: params.workspace.workspacePath,
    },
    startupNow(),
  );
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: context.deps.env,
    logger: context.logger,
    options: {},
    startupTimer,
    workingDirectory,
  });
  const explicitMcpServersProvided = params.mcpServers !== undefined;
  const explicitRuntimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  const configuredMcpServers = {
    ...pluginOutcome.mcpServers,
    // 设置页的本地 MCP 列表由 desktop main 解析 `.zcode` / `.agents` fallback，
    // session runtime 也使用这批 params.mcpServers。mcp/list 不能再只靠 agent createConfig，
    // 否则 `.agents` fallback 行会缺少 status snapshot 并被 UI 误标红。
    ...(explicitMcpServersProvided
      ? (explicitRuntimeMcp?.servers ?? {})
      : configResult.config.mcp.servers),
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginOutcome.mcpServers,
  );
  // fork（F23④，上游 a60ba6a7）：workspace MCP 信任门（spec docs/specs/workspace-mcp-trust.md
  // §3.1/§6）。inspect 只读声明与授权投影，不连接任何 MCP；未信任 workspace 声明在
  // mcp/list 投影为 pending_trust + toolCount 0（裁决 2 new-state，不复用 untrusted 槽位）。
  // 上游此处直接 createWorkspaceMcpTrust；本仓经 app/runtime-config 的组装单点注入
  // core 纯域 + adapters ports（store 是共享状态，多实例安全）。
  const authority = createAppWorkspaceMcpTrust({
    workingDirectory,
    ...(params.workspace.workspaceIdentity
      ? { workspaceIdentity: params.workspace.workspaceIdentity }
      : {}),
    env: context.deps.env,
  });
  const reviews = await authority.inspect();
  const untrustedProjectMcpServers = new Set(
    Object.entries(reviews)
      .filter(([, review]) => !review.trusted)
      .map(([name]) => name),
  );
  // 上游此处为配置补 source.kind "workspace"/"user" 标记；本仓 McpServerRuntimeSource
  // 只有 builtin|plugin（F23① 裁决：workspace 判定走声明发现而非来源标记），无需打标。
  const withReviews = async (statuses: Record<string, McpServerStatus>) => {
    for (const [name, review] of Object.entries(await authority.inspect())) {
      // reviews 只含发现到的 workspace 声明；用户作用域/插件/内建天然不在其中
      // （spec §5.1 豁免），无需上游的 source.kind 跳过分支。
      statuses[name] = {
        ...(statuses[name] ?? {
          status: "disconnected",
          transport: review.transport,
          toolCount: 0,
          updatedAt: new Date().toISOString(),
        }),
        // disabled 优先于待信任：停用是更明确的配置态（spec §2.3 求值序）。
        ...(!review.configuredEnabled
          ? { status: "disabled" as const, toolCount: 0 }
          : !review.trusted
            ? { status: "pending_trust" as const, toolCount: 0 }
            : {}),
        workspaceTrust: review,
      };
    }
    return statuses;
  };
  if (params.mode === "status") {
    // 只读轮询曾接管共享 lease，取消其他工作区的 OAuth；仅显式连接允许切换 owner。
    const cached = context.deps.mcpPort && settingsPorts.get(context.deps.mcpPort);
    const current = cached?.workspaceKey === params.workspace.workspaceKey ? cached : undefined;
    await current?.ready;
    let statuses = await listMcpServerStatuses(
      current && !current.controller.signal.aborted ? current.port : undefined,
      configuredMcpServers,
      untrustedProjectMcpServers,
    );
    // 读取期间被显式切换时，丢弃共享 lease 的迟到快照，避免串入新 owner 的状态。
    if (current?.controller.signal.aborted) {
      statuses = await listMcpServerStatuses(
        undefined,
        configuredMcpServers,
        untrustedProjectMcpServers,
      );
    }
    return zodyMcpListResultSchema.parse({ statuses: await withReviews(statuses) });
  }

  const mcpPort = context.deps.mcpPort
    ? await settingsPort(context.deps.mcpPort, params.workspace.workspaceKey, authority)
    : undefined;
  if (mcpPort) {
    // OAuth 轮询已由 mode=status 隔离；默认/connect 必须继续执行 replace 收敛，
    // 否则任一 server 待授权时，配置新增/删除和 stale MCP 清理都会被跳过。
    // 默认/connect 模式服务的是设置页刷新这类"重新探测"诉求，而 mcpPort 是进程级
    // `protocol-settings` lease；不带 revalidate 时连接池会直接复用旧 entry 并返回陈旧快照，
    // 停掉的 HTTP MCP 会永远显示已连接（见 adapters/src/mcp/pool.ts revalidateEntry）。
    // 未信任 workspace 声明双重拦截：omit 先摘除（不进入 connect 集合），guarded port
    // 的准入在 connectServer 前再验一次（spec §7.2 慢握手不提前放行）。
    const connectPromise = mcpPort.connectConfiguredServers(
      omitMcpServers(
        configuredMcpServers,
        untrustedProjectMcpServers,
        trustedOfficialCuaServerNames,
      ),
      {
        revalidate: true,
        workingDirectory,
        ...(params.workspace.workspaceIdentity
          ? { workspaceIdentity: params.workspace.workspaceIdentity }
          : {}),
      },
    );
    const pendingAuthorizationSnapshot = await waitForOAuthAuthorizationSnapshot(
      mcpPort,
      connectPromise,
    );
    if (pendingAuthorizationSnapshot) {
      void connectPromise.catch((error) => {
        context.logger?.warn("MCP background authorization connection failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.authorization.background.failed",
          workspaceKey: params.workspace.workspaceKey,
          workspacePath: params.workspace.workspacePath,
        });
      });
      return zodyMcpListResultSchema.parse({
        statuses: await withReviews(pendingAuthorizationSnapshot.statuses),
      });
    }

    await connectPromise;
  }
  const statuses = await listMcpServerStatuses(
    mcpPort,
    configuredMcpServers,
    untrustedProjectMcpServers,
  );
  return zodyMcpListResultSchema.parse({ statuses: await withReviews(statuses) });
}

async function waitForOAuthAuthorizationSnapshot(
  mcpPort: McpPort,
  connectPromise: Promise<McpConnectionSnapshot>,
): Promise<McpConnectionSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS) {
    const race = await Promise.race([
      connectPromise.then(
        (snapshot) => ({ kind: "completed" as const, snapshot }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      delay(MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS).then(() => ({ kind: "poll" as const })),
    ]);

    if (race.kind === "completed") {
      return undefined;
    }
    if (race.kind === "failed") {
      throw race.error;
    }

    const statuses = await mcpPort.status();
    if (hasPendingOAuthAuthorization(statuses)) {
      return {
        statuses,
        tools: await mcpPort.listTools(),
      };
    }
  }

  return undefined;
}

function hasPendingOAuthAuthorization(statuses: Record<string, McpServerStatus>): boolean {
  return Object.values(statuses).some((status) => Boolean(status.authorization?.authorizationUrl));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fork（F23④，上游 a60ba6a7）：mcpPort 是进程级 `protocol-settings` 共享 lease；
// 设置页默认/connect 模式的连接必须经信任门 guard 准入（spec §7.2：准入包住整个
// lease，不只 UI 入口），且工作区切换时先失效旧 gate（AbortSignal 只令旧 gate 停止
// 后续操作，不关闭共享 lease），防止旧工作区的迟到握手写入新目标（spec §7.3）。
const settingsPorts = new WeakMap<
  McpPort,
  { workspaceKey: string; port: McpPort; controller: AbortController; ready: Promise<void> }
>();
async function settingsPort(
  raw: McpPort,
  workspaceKey: string,
  authority: ReturnType<typeof createAppWorkspaceMcpTrust>,
): Promise<McpPort> {
  const previous = settingsPorts.get(raw);
  if (previous?.workspaceKey === workspaceKey) {
    await previous.ready;
    return previous.port;
  }
  // 旧 OAuth 可在切换后才完成；先使旧 gate 失效，禁止它继续向共享 lease 写入连接。
  previous?.controller.abort();
  const controller = new AbortController();
  const port = authority.guard(raw, controller.signal);
  // 清理只串行等待前次清理，不等待 OAuth；并发切换不能迟到断开新 workspace 的连接。
  const ready = (previous?.ready ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      for (const name of Object.keys(await raw.status())) {
        if (controller.signal.aborted) return;
        await raw.disconnectServer(name);
      }
    });
  settingsPorts.set(raw, { workspaceKey, port, controller, ready });
  try {
    await ready;
  } catch (error) {
    // 清理失败不缓存永久 rejected 的 gate；只撤销自己，不能删除已接管的新目标。
    controller.abort();
    if (settingsPorts.get(raw)?.port === port) settingsPorts.delete(raw);
    throw error;
  }
  return port;
}

// fork（F23④，上游 a60ba6a7 setWorkspaceMcpTrust）：workspace/mcp/trust 方法 handler。
// params 经 shared zodyWorkspaceMcpTrustParamsSchema 严格校验（workspace ref + serverName
// + 64 位摘要 + trusted）；decide 在锁内重读声明、摘要精确匹配才落盘（spec §3.3）。
// 成功后按 workspace 通知活跃会话 reloadWorkspaceMcpTrust（重发 admission 事件，
// 横幅 A 数据链），与 Hooks 的 grant 通知同构；已落盘的决定不得误报为授权失败。
// dependencies 仅测试注入（homeDir 隔离临时 HOME），与 grantWorkspaceHookTrustForProtocol
// 的依赖注入先例同构；生产 dispatch 不传。
export async function setWorkspaceMcpTrust(
  context: ZodyProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: { createAuthority?: typeof createAppWorkspaceMcpTrust } = {},
): Promise<ZodyWorkspaceMcpTrustResult> {
  const params = parseParams(zodyWorkspaceMcpTrustParamsSchema, rawParams);
  const createAuthority = dependencies.createAuthority ?? createAppWorkspaceMcpTrust;
  try {
    await createAuthority({
      workingDirectory: params.workspace.workspacePath,
      ...(params.workspace.workspaceIdentity
        ? { workspaceIdentity: params.workspace.workspaceIdentity }
        : {}),
      env: context.deps.env,
    }).decide(params.serverName, params.declarationDigest, params.trusted);
    // 与 Hooks 一样按 workspace 通知活跃会话；不能把已落盘的决定误报为授权失败。
    const refreshes = await Promise.allSettled(
      [...context.sessions.values()]
        .filter((record) => record.workspace.workspaceKey === params.workspace.workspaceKey)
        .map((record) => record.app.reloadWorkspaceMcpTrust()),
    );
    if (refreshes.some((result) => result.status === "rejected")) {
      context.logger?.warn("MCP trust admission refresh failed", {
        event: "mcp.trust.admission.refresh.failed",
        workspaceKey: params.workspace.workspaceKey,
      });
    }
    return { accepted: true };
  } catch (error) {
    return {
      accepted: false,
      reasonCode:
        error instanceof Error && error.message === "workspace_mcp_declaration_changed"
          ? "workspace_mcp_declaration_changed"
          : "workspace_mcp_trust_unavailable",
    };
  }
}
