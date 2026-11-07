// fork（F23，上游 a60ba6a7 workspace-mcp-trust 模块）：workspace MCP 信任门。
// spec：docs/specs/workspace-mcp-trust.md（裁决 2 new-state + args 预置摘要）。
//
// 本模块是纯域实现：声明发现、store 读写与跨进程锁全部经注入 port，core 不做
// fs、不 import adapters（同 hooks/workspace-hook-trust-* 的纯域定位）。摘要算法
// （executionConfig 规范化 + 键排序稳定序列化 + sha256）以本文件为单源；spec §4
// 原计划放 shared，因 shared 根导出图必须保持 renderer-safe（无 node 内建依赖）、
// 而新增 subpath 导出需改 packages/shared/package.json（超出本卡落点），落位修订
// 为 core 单源，bootstrap wiring 侧经 @zody/core 复用同一实现，单源目标不变
// （spec §4 已随本实现更新）。

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  McpConnectOptions,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  WorkspaceMcpAdmissionUpdatedPayload,
} from "@zody/contracts";
import type { WorkspaceMcpTrustRecord } from "@zody/shared";
import { sanitizeHookDisplayText } from "../hooks/index.js";

/** 声明摘要算法版本；入参与输出形状变化时递增并使既有信任失配（fail-safe）。 */
const WORKSPACE_MCP_TRUST_DIGEST_VERSION = 1 as const;

export interface WorkspaceMcpTrustDeclarationInput {
  config: McpServerConfig;
  /** 声明来源文件绝对路径列表；参与摘要（改文件 = 改声明）。 */
  sourcePaths: string[];
}

export interface WorkspaceMcpTrustDeclaration extends WorkspaceMcpTrustDeclarationInput {
  declarationDigest: string;
}

/** 声明发现 port：返回当前全部 workspace 声明（project 作用域 + 桌面下发的 workspace 目录声明）。 */
export interface WorkspaceMcpTrustDiscoveryPort {
  /** 配置不可读时 throw（inspect 返回空投影、allows 拒绝、decide 拒绝落盘）。 */
  discover(): Promise<Record<string, WorkspaceMcpTrustDeclarationInput>>;
}

/**
 * 用户域 trust store port。同一 Host 的用户存储是唯一授权 owner；实现必须提供
 * 跨进程互斥（锁内重读 + 原子写，上游 a60ba6a7 用 withFileLock +
 * atomicWritePrivateTextFile）。store 文件 schema 单源见
 * @zody/shared 的 workspace-mcp-trust-store-file.ts。
 */
export interface WorkspaceMcpTrustStorePort {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  /** 缺文件 → []；损坏 → throw（fail-closed：不得返回部分记录）。 */
  readRecords(): Promise<WorkspaceMcpTrustRecord[]>;
  writeRecords(records: readonly WorkspaceMcpTrustRecord[]): Promise<void>;
}

export interface WorkspaceMcpTrustContract {
  /** 只读当前声明及持久授权投影；不连接 MCP。读取失败返回空投影（fail-closed 但不中断列表）。 */
  inspect(): Promise<Record<string, WorkspaceMcpTrustReviewProjection>>;
  /** 锁内重读当前声明；摘要精确匹配才落盘。持久写成功即返回，不启用、不连接。 */
  decide(serverName: string, declarationDigest: string, trusted: boolean): Promise<void>;
  /** 连接准入时重验：声明移除、变更、损坏、撤销后拒绝新连接。 */
  allows(serverName: string, config: McpServerConfig): Promise<boolean>;
  /** 包住整个 MCP lease 的守卫代理；signal 只使本 gate 失效，不关闭共享 raw port。 */
  guard(port: McpPort, signal?: AbortSignal): WorkspaceMcpTrustGuardedPort;
}

/** inspect 的投影条目；形状与协议层 WorkspaceMcpTrustReview 一致（shared zody-protocol 单源 schema）。 */
export interface WorkspaceMcpTrustReviewProjection {
  declarationDigest: string;
  sourcePaths: string[];
  display: string;
  trusted: boolean;
  configuredEnabled: boolean;
  transport: "stdio" | "http" | "sse";
}

/** guard 之后的端口：在 McpPort 之上增加 admission 刷新面。 */
export interface WorkspaceMcpTrustGuardedPort extends McpPort {
  /**
   * 串行重读 inspect 并发布 admission 变化（pendingCount/bundleDigest）；只更新
   * 会话提示，不连接、不授予权限。reannounce=true 时即使无变化也重发（断线重连后
   * 的状态重建）。
   */
  refreshWorkspaceTrustAdmission(reannounce?: boolean): Promise<void>;
}

export interface WorkspaceMcpTrustOptions {
  /** 工作目录（绝对路径化由本模块负责）。 */
  workingDirectory: string;
  /** 身份键 = workspaceIdentity?.trim() || workingDirectory（AGENTS.md 统一规则）。 */
  workspaceIdentity?: string;
  discovery: WorkspaceMcpTrustDiscoveryPort;
  store: WorkspaceMcpTrustStorePort;
  /** 准入状态变化回调（会话事件 WorkspaceMcpAdmissionUpdated 的载荷）。 */
  onAdmissionChanged?: (state: WorkspaceMcpAdmissionUpdatedPayload) => Promise<void>;
  now?: () => Date;
}

/**
 * 审核摘要与 Host DTO 共用 Windows 命令归一化（上游 a60ba6a7 shared/mcp.ts 的
 * normalizeMcpStdioCommand）：`cmd /c <cmd> ...` 拆包，避免批准 cmd /c 后执行
 * npx 被误判为声明变更（或反向：批准外壳、执行内核）。
 */
export function normalizeWorkspaceMcpStdioCommand(command: string, args: readonly string[] = []) {
  const isWin32 =
    (typeof process !== "undefined" && process.platform === "win32") ||
    (typeof navigator !== "undefined" && /win/i.test(navigator.platform));
  const lowerCmd = command.toLowerCase();
  const unwrappedCommand = args[1];
  if (
    isWin32 &&
    (lowerCmd === "cmd" || lowerCmd === "cmd.exe") &&
    args[0] === "/c" &&
    unwrappedCommand
  ) {
    return { command: unwrappedCommand, args: args.slice(2) };
  }
  return { command, args: [...args] };
}

/**
 * args 预置（spec §2.1）：摘要输入不是原始配置，而是规范化后的执行身份。
 * enabled/source 不进摘要（启停与来源标记不是执行身份）；oauth 只取 type
 * （凭据值轮换不强制重信任，且避免把 secret 纳入摘要规范）。
 */
function executionConfig(config: McpServerConfig, workingDirectory: string): unknown {
  const { enabled: _enabled, source: _source, ...execution } = config;
  if (config.type === "stdio") {
    const normalized = normalizeWorkspaceMcpStdioCommand(config.command, config.args);
    return {
      ...execution,
      command: normalized.command,
      args: normalized.args,
      env: config.env ?? {},
      cwd: config.cwd
        ? isAbsolute(config.cwd)
          ? config.cwd
          : resolve(workingDirectory, config.cwd)
        : workingDirectory,
    };
  }
  return {
    ...execution,
    headers: config.headers ?? {},
    ...(config.oauth ? { oauth: { type: config.oauth.type } } : {}),
  };
}

/** 键排序稳定序列化：同语义配置（键序不同）必须得到同一摘要。 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, (item as Record<string, unknown>)[key]]),
      );
    }
    return item;
  });
}

export function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** 声明摘要（spec §5.2）：身份 + 来源文件 + 预置执行配置的整体 sha256。 */
export function computeWorkspaceMcpDeclarationDigest(input: {
  workspaceIdentity: string;
  workingDirectory: string;
  serverName: string;
  sourcePaths: readonly string[];
  config: McpServerConfig;
}): string {
  return sha256Stable({
    version: WORKSPACE_MCP_TRUST_DIGEST_VERSION,
    workspaceIdentity: input.workspaceIdentity,
    workingDirectory: input.workingDirectory,
    serverName: input.serverName,
    sourcePaths: [...input.sourcePaths],
    config: executionConfig(input.config, input.workingDirectory),
  });
}

/** admission bundleDigest：启用且未信任声明的 [name, digest] 有序集合摘要（仅提示去重）。 */
export function computeWorkspaceMcpAdmissionBundleDigest(
  pending: readonly (readonly [string, string])[],
): string {
  return sha256Stable([...pending]);
}

/** 审核展示文本（spec §3.1 规则 3）：不含 env 值、header 值与 URL 凭据。 */
export function buildWorkspaceMcpTrustDisplay(
  config: McpServerConfig,
  workingDirectory: string,
): string {
  if (config.type === "stdio") {
    const normalized = normalizeWorkspaceMcpStdioCommand(config.command, config.args);
    return sanitizeHookDisplayText(
      JSON.stringify(
        {
          command: sanitizeHookDisplayText([normalized.command, ...normalized.args].join(" ")),
          cwd: config.cwd ?? workingDirectory,
          env: Object.keys(config.env ?? {}),
        },
        null,
        2,
      ),
    );
  }
  const url = new URL(config.url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return JSON.stringify(
    {
      type: config.type,
      url: url.toString(),
      headers: Object.keys(config.headers ?? {}),
      oauth: config.oauth?.type,
    },
    null,
    2,
  );
}

export function createWorkspaceMcpTrust(
  options: WorkspaceMcpTrustOptions,
): WorkspaceMcpTrustContract {
  const workingDirectory = resolve(options.workingDirectory);
  const workspaceIdentity = options.workspaceIdentity?.trim() || workingDirectory;
  const now = options.now ?? (() => new Date());
  const discovery = options.discovery;
  const store = options.store;

  const digestOf = (name: string, declaration: WorkspaceMcpTrustDeclarationInput) =>
    computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity,
      workingDirectory,
      serverName: name,
      sourcePaths: declaration.sourcePaths,
      config: declaration.config,
    });

  /** 锁外的声明读取（含摘要计算）；配置不可读时 throw，由调用方决定 fail-closed 形态。 */
  const discoverDeclarations = async (): Promise<Record<string, WorkspaceMcpTrustDeclaration>> => {
    const declarations: Record<string, WorkspaceMcpTrustDeclaration> = {};
    for (const [name, input] of Object.entries(await discovery.discover())) {
      declarations[name] = { ...input, declarationDigest: digestOf(name, input) };
    }
    return declarations;
  };

  /** 损坏存储不能把已有声明显示成可信：读取失败按无记录处理。 */
  const readRecordsSafe = async (): Promise<WorkspaceMcpTrustRecord[]> => {
    try {
      return await store.readRecords();
    } catch {
      return [];
    }
  };

  const matches = (record: WorkspaceMcpTrustRecord, name: string, value: string) =>
    record.workspaceIdentity === workspaceIdentity &&
    record.serverName === name &&
    record.declarationDigest === value;

  const authority: WorkspaceMcpTrustContract = {
    async inspect() {
      let declarations: Record<string, WorkspaceMcpTrustDeclaration>;
      try {
        declarations = await discoverDeclarations();
      } catch {
        // 读取失败没有可批准的声明；执行 gate 仍拒绝，不能连带中断用户/插件 MCP 列表。
        return {};
      }
      if (Object.keys(declarations).length === 0) return {};
      const trusted = await readRecordsSafe();
      return Object.fromEntries(
        Object.entries(declarations).map(([name, entry]) => [
          name,
          {
            declarationDigest: entry.declarationDigest,
            configuredEnabled: entry.config.enabled !== false,
            transport: entry.config.type,
            sourcePaths: entry.sourcePaths,
            display: buildWorkspaceMcpTrustDisplay(entry.config, workingDirectory),
            trusted: trusted.some((record) => matches(record, name, entry.declarationDigest)),
          },
        ]),
      );
    },
    async allows(name, config) {
      // 只处理 workspace 声明；宿主标记的插件与内建来源不进入本审核（spec §5.1）。
      if (config.source?.kind === "plugin" || config.source?.kind === "builtin") return true;
      try {
        const entry = (await discoverDeclarations())[name];
        // 无 workspace 声明（用户作用域 / env / cli / 未知来源）：保持既有准入语义。
        if (!entry) return true;
        if (entry.config.enabled === false) return false;
        // 连接输入必须与当前声明逐字段一致（args 预置摘要），否则视为声明变更拒绝。
        if (digestOf(name, { config, sourcePaths: entry.sourcePaths }) !== entry.declarationDigest)
          return false;
        const records = await readRecordsSafe();
        return records.some((record) => matches(record, name, entry.declarationDigest));
      } catch {
        return false;
      }
    },
    async decide(serverName, declarationDigest, trusted) {
      await store.withLock(async () => {
        // 锁内重读（spec §3.3 规则 9）：防止「审核 A 落盘 B」。
        const entry = (await discoverDeclarations())[serverName];
        if (!entry || entry.declarationDigest !== declarationDigest)
          throw new Error("workspace_mcp_declaration_changed");
        // 损坏存储上不得授信：readRecords 抛错即中止（fail-closed）。
        const current = await store.readRecords();
        const next = current.filter((record) => !matches(record, serverName, declarationDigest));
        if (trusted)
          next.push({
            workspaceIdentity,
            serverName,
            declarationDigest,
            grantedAt: now().toISOString(),
          });
        await store.writeRecords(next);
      });
    },
    guard: (port, signal) =>
      guardPort(
        port,
        authority,
        { workingDirectory, workspaceIdentity },
        signal,
        options.onAdmissionChanged,
      ),
  };
  return authority;
}

/**
 * 准入包住整个 MCP lease 而非 UI 入口（spec §7.2）：subagent、旧连接和资源读取
 * 也必须经过同一权限边界。上游 a60ba6a7 guardPort 的移植，状态名按裁决 2 使用
 * pending_trust（不占用 untrusted 槽位）。
 */
function guardPort(
  port: McpPort,
  authority: WorkspaceMcpTrustContract,
  target: { workingDirectory: string; workspaceIdentity: string },
  signal?: AbortSignal,
  onAdmissionChanged?: (state: WorkspaceMcpAdmissionUpdatedPayload) => Promise<void>,
): WorkspaceMcpTrustGuardedPort {
  const configurations = new Map<string, McpServerConfig>();
  const blocked = new Map<string, McpServerStatus>();
  // 连接替换只有一个 owner；配置 A 的迟到握手不能覆盖配置 B 的执行映射。
  let mutationTail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const isClosed = () => closed || signal?.aborted === true;
  // 重读与发布共用一个顺序，避免设置授权后的清零被较早的 pending 读取覆盖。
  let admissionTail: Promise<unknown> = Promise.resolve();
  let publishedAdmission: string | undefined;
  const refreshWorkspaceTrustAdmission = (reannounce = false): Promise<void> => {
    if (!onAdmissionChanged || isClosed()) return Promise.resolve();
    const next = admissionTail.then(async () => {
      if (isClosed()) return;
      const pending = Object.entries(await authority.inspect())
        .filter(([, review]) => review.configuredEnabled && !review.trusted)
        .map(([name, review]) => [name, review.declarationDigest] as const)
        .sort(([left], [right]) => left.localeCompare(right));
      // 首次无待审核项不发事件（旧快照默认 null，无需清零）。
      if (!reannounce && publishedAdmission === undefined && pending.length === 0) return;
      const state = {
        pendingCount: pending.length,
        bundleDigest: computeWorkspaceMcpAdmissionBundleDigest(pending),
        workspaceIdentity: target.workspaceIdentity,
      };
      const serialized = JSON.stringify(state);
      if (isClosed() || (!reannounce && publishedAdmission === serialized)) return;
      await onAdmissionChanged(state);
      publishedAdmission = serialized;
    });
    admissionTail = next.catch(() => undefined);
    return next;
  };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(() => {
      if (isClosed()) throw new Error("MCP port is closed");
      return operation();
    });
    mutationTail = result.catch(() => undefined);
    return result;
  };
  const blockedStatus = (config: McpServerConfig): McpServerStatus => ({
    // disabled 优先于待信任：停用是更明确的配置态，不与信任门混淆。
    status: config.enabled === false ? "disabled" : "pending_trust",
    transport: config.type,
    toolCount: 0,
    updatedAt: new Date().toISOString(),
  });
  // 授权变化允许延迟到下次连接准入；连接内只查已有结果，避免逐次同步读配置。
  const isAdmitted = (name: string) =>
    !isClosed() && configurations.has(name) && !blocked.has(name);
  async function admitted(name: string): Promise<boolean> {
    const config = configurations.get(name);
    if (!config) return false;
    const allowed = config.enabled !== false && (await authority.allows(name, config));
    if (isClosed() || configurations.get(name) !== config) return false;
    if (allowed) {
      blocked.delete(name);
      return true;
    }
    blocked.set(name, blockedStatus(config));
    return false;
  }
  const requestMethods = new Set([
    "callTool",
    "readResource",
    "listResources",
    "listResourceTemplates",
    "subscribeResource",
    "unsubscribeResource",
  ]);
  const proxy = new Proxy(port, {
    get(raw: McpPort, key: string | symbol) {
      if (key === "refreshWorkspaceTrustAdmission") return refreshWorkspaceTrustAdmission;
      if (key === "close")
        return async () => {
          closed = true;
          configurations.clear();
          blocked.clear();
          await raw.close();
        };
      if (key === "disconnectServer")
        return (name: string) =>
          mutate(async () => {
            configurations.delete(name);
            blocked.delete(name);
            return raw.disconnectServer(name);
          });
      if (key === "connectServer")
        return async (name: string, config: McpServerConfig, options: McpConnectOptions = {}) => {
          // 审核、摘要与传输使用同一不可变副本，调用方修改原对象不能批准 A 后执行 B。
          const frozen = JSON.parse(JSON.stringify(config)) as McpServerConfig;
          return mutate(async () => {
            configurations.set(name, frozen);
            // 工作区声明检查完成前默认拒绝；非 workspace 来源保持原准入语义。
            if (frozen.enabled === false) blocked.set(name, blockedStatus(frozen));
            else blocked.delete(name);
            if (!(await admitted(name)) || isClosed()) {
              if (isClosed()) throw new Error("MCP port is closed");
              await raw.disconnectServer(name);
              return blocked.get(name)!;
            }
            return raw.connectServer(name, frozen, { ...options, ...target });
          });
        };
      if (key === "connectConfiguredServers")
        return async (
          servers: Record<string, McpServerConfig>,
          options: McpConnectOptions = {},
        ) => {
          const frozen = JSON.parse(JSON.stringify(servers)) as Record<string, McpServerConfig>;
          return mutate(async () => {
            configurations.clear();
            blocked.clear();
            for (const [name, config] of Object.entries(frozen)) {
              configurations.set(name, config);
              if (config.enabled === false) blocked.set(name, blockedStatus(config));
            }
            const accepted: Record<string, McpServerConfig> = {};
            const gated: Record<string, McpServerConfig> = {};
            for (const [name, config] of Object.entries(frozen)) {
              if (!(await admitted(name))) continue;
              const isWorkspaceDeclaration = (await authority.inspect())[name] !== undefined;
              if (isWorkspaceDeclaration) gated[name] = config;
              else accepted[name] = config;
            }
            if (isClosed()) throw new Error("MCP port is closed");
            await raw.connectConfiguredServers(accepted, { ...options, ...target });
            // 普通 MCP 的慢握手不能让工作区授权检查提前；每个实际连接前再验一次。
            await Promise.all(
              Object.entries(gated).map(async ([name, config]) => {
                if ((await admitted(name)) && !isClosed())
                  await raw.connectServer(name, config, { ...options, ...target });
              }),
            );
            const statuses = { ...(await raw.status()), ...Object.fromEntries(blocked) };
            const tools = (await raw.listTools()).filter(
              (tool) => !blocked.has(tool.serverName) && configurations.has(tool.serverName),
            );
            return { statuses, tools };
          });
        };
      if (key === "status")
        return async () => {
          return { ...(await raw.status()), ...Object.fromEntries(blocked) };
        };
      if (key === "listTools")
        return async () => {
          const allowed = new Set<string>();
          for (const name of configurations.keys()) if (isAdmitted(name)) allowed.add(name);
          return (await raw.listTools()).filter((tool) => allowed.has(tool.serverName));
        };
      const method = Reflect.get(raw, key, raw) as unknown;
      if (typeof method !== "function") return method;
      if (requestMethods.has(String(key)))
        return async (request: { serverName: string }, ...args: unknown[]) => {
          const observed = mutationTail;
          await observed;
          if (!isAdmitted(request.serverName) || observed !== mutationTail)
            throw new Error("workspace_mcp_pending_trust");
          return (method as (...fnArgs: unknown[]) => unknown).call(raw, request, ...args);
        };
      if (key === "pingServer")
        return async (name: string, ...args: unknown[]) => {
          const observed = mutationTail;
          await observed;
          return isAdmitted(name) && observed === mutationTail
            ? (method as (...fnArgs: unknown[]) => unknown).call(raw, name, ...args)
            : false;
        };
      if (key === "appConnectionSnapshot")
        return (name: string) =>
          blocked.has(name)
            ? null
            : ((method as (arg: string) => unknown).call(raw, name) as ReturnType<
                NonNullable<McpPort["appConnectionSnapshot"]>
              >);
      if (key === "waitForAppConnection")
        return async (name: string) =>
          isAdmitted(name)
            ? ((await (method as (arg: string) => Promise<unknown>).call(raw, name)) as Awaited<
                ReturnType<NonNullable<McpPort["waitForAppConnection"]>>
              >)
            : null;
      // 按 subscriber 释放只清理已有订阅；执行授权失败不能阻止 MCP App 生命周期收尾。
      return (method as (...fnArgs: unknown[]) => unknown).bind(raw);
    },
  });
  return proxy as WorkspaceMcpTrustGuardedPort;
}
