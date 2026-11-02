import {
  createSessionId,
  type PermissionBrokerPort,
  type PermissionRuleset,
  type ProjectId,
  type SessionEventStorePort,
  type SessionGoal,
  type SessionId,
  type SessionStorePort,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import type { AgentRuntime } from "../../src/runtime.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../../src/runtime/types.js";
import type { RevokedProjection } from "../../src/runtime/cua/index.js";
import { createTestAgentRuntime } from "../test-agent-runtime.js";
import { createTestSessionEventStore } from "../test-event-store.js";
import { createTestModelFactory } from "../test-runtime-model.js";

export interface CuaRuntimeFixtureOptions {
  readonly key: string;
  readonly generateText?: (request: unknown, observation: unknown) => Promise<unknown>;
  readonly eventStore?: SessionEventStorePort;
  readonly sessionStore?: SessionStorePort;
  readonly onRevocation?: (projection: RevokedProjection) => void;
  readonly runtimeInstanceId?: string;
  readonly sessionId?: SessionId;
  readonly config?: Partial<AgentRuntimeConfig>;
  readonly omitCuaIdentity?: boolean;
  readonly maxPendingLiveSubmissions?: number;
  readonly maxLineages?: number;
  /** App 内确认弹窗等 CUA 链路测试注入的 broker stub；缺省走 runtime 的 deny broker。 */
  readonly permissionBroker?: PermissionBrokerPort;
}

export function createCuaTestRuntime(options: CuaRuntimeFixtureOptions): AgentRuntime {
  const sessionId = options.sessionId ?? createSessionId(options.key);
  const deps: AgentRuntimeDeps = {
    eventStore: options.eventStore ?? createTestSessionEventStore(),
    modelFactory: createTestModelFactory({
      generateText: (options.generateText ?? (async () => modelText("done"))) as never,
    }),
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.permissionBroker ? { permissionBroker: options.permissionBroker } : {}),
    ...(options.omitCuaIdentity
      ? {}
      : {
          cuaSubmission: {
            appIncarnation: "app-incarnation-r2r",
            hostInstanceId: "host-instance-r2r",
            runtimeInstanceId: options.runtimeInstanceId ?? `runtime-${options.key}`,
            sessionId: String(sessionId),
            workspaceKey: "/workspace/cua-runtime",
            ...(options.onRevocation ? { onRevocation: options.onRevocation } : {}),
            ...(options.maxPendingLiveSubmissions === undefined
              ? {}
              : { maxPendingLiveSubmissions: options.maxPendingLiveSubmissions }),
            ...(options.maxLineages === undefined ? {} : { maxLineages: options.maxLineages }),
          },
        }),
  };
  return createTestAgentRuntime(
    sessionId,
    {
      mode: "build",
      modelSelection: { providerId: "test-provider", modelId: "test-model" },
      ...options.config,
    },
    deps,
  );
}

export function cuaIntent(
  id: string,
  inputOrigin: "desktop" | "mobile" | undefined,
  delivery: "startNow" | "queue" | "guide" = "startNow",
): TurnInputIntentMetadata {
  return {
    sourceCommandId: id,
    queueItemId: `queue_${id}`,
    clientId: "cli",
    kind: "sendText",
    text: id,
    inputOrigin,
    admissionSeq: 1,
    admittedAt: 1,
    requestedDelivery: delivery === "guide" ? "guide" : delivery === "queue" ? "queue" : "startNow",
    admittedDelivery: delivery,
  };
}

export function modelText(text: string): unknown {
  return {
    finishReason: "stop",
    model: "test",
    providerMetadata: undefined,
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export interface CuaTargetSessionFixture {
  readonly store: SessionStorePort;
  readonly target: SessionGoal;
}

export interface CuaPermissionRuleStoreFixture {
  readonly store: SessionStorePort;
  readonly saves: Array<{ projectID: ProjectId; permission: PermissionRuleset }>;
  setProjectRules(rules: PermissionRuleset | null): void;
  failReads(error: Error | null): void;
}

/**
 * App 内确认的规则判读/持久化测试用最小 SessionStore：只实现 getSession、
 * getProjectPermission、saveProjectPermission 与 updateSession，不复制生产存储。
 */
export function createCuaPermissionRuleStore(
  initialRules: PermissionRuleset | null = null,
): CuaPermissionRuleStoreFixture {
  const projectID = "project-cua-confirm" as ProjectId;
  let projectRules = initialRules;
  let readError: Error | null = null;
  let sessionPermission: PermissionRuleset | undefined;
  const saves: Array<{ projectID: ProjectId; permission: PermissionRuleset }> = [];
  const store = {
    async createSession(input: { id: SessionId }) {
      return {
        ...input,
        taskType: "interactive",
        time: { created: 1, updated: 1 },
      };
    },
    async saveSessionEntry() {},
    async saveMessage() {},
    async savePart() {},
    async messages() {
      return [];
    },
    async getSession() {
      return {
        id: createSessionId("cua-confirm"),
        projectID,
        ...(sessionPermission ? { permission: sessionPermission } : {}),
      };
    },
    async getProjectPermission() {
      if (readError) throw readError;
      return projectRules;
    },
    async saveProjectPermission(input: { projectID: ProjectId; permission: PermissionRuleset }) {
      projectRules = input.permission;
      saves.push(input);
      return input.permission;
    },
    async updateSession(input: { permission?: PermissionRuleset }) {
      if (input.permission) sessionPermission = input.permission;
      return input;
    },
  } as unknown as SessionStorePort;
  return {
    store,
    saves,
    setProjectRules: (rules) => {
      projectRules = rules;
    },
    failReads: (error) => {
      readError = error;
    },
  };
}

/** 只实现 target-continuation 测试实际走到的 SessionStore 面，不复制生产存储。 */
export function createCuaTargetSessionStore(sessionId: SessionId): CuaTargetSessionFixture {
  let target: SessionGoal = {
    sessionID: sessionId,
    targetID: "target-cua-runtime" as never,
    objective: "continue CUA target",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1, updated: 1 },
  };
  const store = {
    async createSession(input: { id: SessionId }) {
      return {
        ...input,
        taskType: "interactive",
        time: { created: 1, updated: 1 },
      };
    },
    async saveSessionEntry() {},
    async saveMessage() {},
    async savePart() {},
    async messages() {
      return [];
    },
    async readTarget() {
      return target;
    },
    async setTarget(input: { objective: string; sessionID: SessionId }) {
      target = { ...target, objective: input.objective };
      return target;
    },
    async updateTargetStatus(input: { status: SessionGoal["status"] }) {
      target = {
        ...target,
        status: input.status,
        time: { ...target.time, updated: target.time.updated + 1 },
      };
      return target;
    },
    async accountTargetUsage() {
      return target;
    },
    async finishTargetRun() {
      return target;
    },
    async heartbeatTargetRun() {},
    async getSession() {
      return null;
    },
    async updateSession(input: unknown) {
      return input;
    },
  } as unknown as SessionStorePort;
  return { store, target };
}
