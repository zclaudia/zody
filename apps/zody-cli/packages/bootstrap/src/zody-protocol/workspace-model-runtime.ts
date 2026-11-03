/* eslint-disable max-lines -- workspace 模型协议与兼容请求处理仍集中在本文件。 */
import { createInMemorySessionEventStore } from "@zody/adapters/storage";
import type { ModelSelection } from "@zody/contracts";
import {
  isRemoteWorkspaceIdentity,
  zcodeProviderTestModelConnectivityParamsSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  type ZodyWorkspaceRef,
} from "@zody/shared";
import type { ZodyApp, ZodyAppOptions } from "../app/types.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import {
  parseParams,
  type ZodyProtocolAgentServerContext,
  type ZodyProtocolSessionRecord,
} from "./server-types.js";
import { runSessionModelConfigMutation } from "../zody-protocol-v4/model-config-mutation.js";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";

export async function readWorkspacePresentation(
  context: ZodyProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);
  return {
    workspace: params.workspace,
    mode: "build" as const,
    slashCommands: await listProtocolSlashCommands({
      // 灰度门是 Host 判定的 workspace 级事实，目录装配读进程缓存。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
      workingDirectory: params.workspace.workspacePath,
    }),
  };
}

export async function testProviderModelConnectivity(
  context: ZodyProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeProviderTestModelConnectivityParamsSchema, rawParams);
  // 旧 Personal Config 跨进程 watcher 可能永久漏掉原子写事件；连接测试若不先
  // 主动刷新，会反复查询旧 Registry。这里复用正式 Registry refresh，不旁路创建配置事实。
  await context.deps.refreshProviderRegistry?.("provider-connectivity");
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: params.workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));
  try {
    await app.testModelConnectivity(
      { selection: params.selection as ModelSelection },
      { abortSignal },
    );
    return { success: true as const };
  } finally {
    if (!active) await app.close?.();
  }
}

export async function createWorkspaceZCodeApp(
  context: ZodyProtocolAgentServerContext,
  workspace: ZodyWorkspaceRef,
  options: Omit<ZodyAppOptions, "providerRegistry">,
): Promise<ZodyApp> {
  // 只接受本进程 startup 帧固定下来的 Host/runtime 身份；调用方 options 的同名字段一律丢弃。
  const { cuaLaunchIdentity: _untrustedLaunchIdentity, ...trustedOptions } = options;
  const workspaceIdentity = workspace.workspaceIdentity?.trim();
  const workspaceKey = workspaceIdentity || workspace.workspacePath;
  const localTopLevel =
    !workspace.remoteSessionId &&
    !(workspaceIdentity && isRemoteWorkspaceIdentity(workspaceIdentity)) &&
    options.runtimeConfig?.parentSessionId === undefined &&
    options.sessionId !== undefined;
  const cuaLaunchIdentity =
    context.cuaLaunchIdentity && localTopLevel
      ? { ...context.cuaLaunchIdentity, workspaceKey }
      : undefined;
  const providerRuntimeHeadersPort =
    options.providerRuntimeHeadersPort ?? createProviderRuntimeHeadersPort(context, workspace);
  return context.deps.createZCodeApp({
    ...trustedOptions,
    ...(cuaLaunchIdentity ? { cuaLaunchIdentity } : {}),
    includeVisualize: true,
    platform: context.deps.platform,
    providerRuntimeHeadersPort,
    runtimeConfig: {
      ...options.runtimeConfig,
      // createZCodeApp 会把 workingDirectory 规范化为执行 cwd。把协议入口的
      // workspacePath 单独注入 runtime，session 持久化才能保留本地 workspaceKey 的路径表示。
      workspacePath: workspace.workspacePath,
      // 远端 session 是 shared-host CUA 的第二层隔离边界：不能只传 workspacePath/identity，
      // 否则同一远端 workspace 的不同 attachment 会复用 Accessibility frame/action 状态。
      // 放在这个 helper 里而不是各调用点，是为了两条 session 创建路径都拿到同一份隔离键。
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      ...(workspace.workspaceIdentity
        ? {
            memory: {
              ...options.runtimeConfig?.memory,
              workspaceIdentity: workspace.workspaceIdentity,
            },
          }
        : {}),
      // Electron/Protocol 主会话之前没有像 CLI/TUI 那样显式开启模型流式，
      // 导致主 turn 退回 generateText 非流式请求，遇到返回 SSE 的兼容端点会按 JSON 解析失败。
      modelStreaming: options.runtimeConfig?.modelStreaming ?? "on",
    },
  });
}

export function hasSessionModelProvider(
  _context: ZodyProtocolAgentServerContext,
  record: Pick<ZodyProtocolSessionRecord, "app" | "workspace">,
  providerId: string,
): boolean {
  return record.app.listModels().some((model) => model.ref.providerId === providerId);
}

async function ensureSessionModelAvailableUnlocked(
  context: ZodyProtocolAgentServerContext,
  record: ZodyProtocolSessionRecord,
): Promise<boolean> {
  // 存量模型失效时不能静默改成 Registry 第一项覆盖用户选择；失效选择保持未绑定，
  // 由恢复/Composer 的选择校验和首发门禁处理；这里不能再写入另一份默认模型事实。
  // 保留该过渡入口是为了让旧协议调用方平稳退场。
  void context;
  void record;
  return false;
}

export async function ensureSessionModelAvailable(
  context: ZodyProtocolAgentServerContext,
  record: ZodyProtocolSessionRecord,
): Promise<boolean> {
  return runSessionModelConfigMutation(record.app, () =>
    ensureSessionModelAvailableUnlocked(context, record),
  );
}

export function resolveSessionModelContextWindow(
  _context: ZodyProtocolAgentServerContext,
  record: Pick<ZodyProtocolSessionRecord, "app" | "workspace" | "restoredModelSelection">,
): number | undefined {
  // 缺档位会让恢复选择暂不绑定 Runtime，但模型身份仍可只读查询容量，不能伪造 20 万。
  const selection = record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
  const value = selection && record.app.getModelOption?.(selection)?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
