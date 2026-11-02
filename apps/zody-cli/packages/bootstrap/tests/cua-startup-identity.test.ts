import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, type ZCodeWorkspaceRef } from "@zody/shared";
import type { ZCodeProtocolMessage } from "@zody/shared";
import { ZCodeProtocolAgentServer } from "../src/zody-protocol/server.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zody-protocol/server-types.js";
import { createWorkspaceZCodeApp } from "../src/zody-protocol/workspace-model-runtime.js";
import type { ZCodeAppOptions } from "../src/app/types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const LOCAL_WORKSPACE = {
  workspacePath: "/workspace/app",
  workspaceKey: "/workspace/app",
} satisfies ZCodeWorkspaceRef;
const TRUSTED_IDENTITY = {
  hostInstanceId: "host-real",
  runtimeInstanceId: "agent-real",
} as const;

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function createWorkspaceAppWithServerIdentity(
  workspace: ZCodeWorkspaceRef,
  options: Omit<ZCodeAppOptions, "providerRegistry">,
): Promise<ZCodeAppOptions | undefined> {
  const createdOptions: ZCodeAppOptions[] = [];
  const context = {
    cuaLaunchIdentity: TRUSTED_IDENTITY,
    deps: {
      createZCodeApp: (appOptions) => {
        createdOptions.push(appOptions ?? {});
        return createFakeApp(appOptions);
      },
    },
    notify: () => undefined,
    sessions: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
  await createWorkspaceZCodeApp(context, workspace, options);
  return createdOptions[0];
}

describe("CUA startup identity protocol", () => {
  it("pins the first identity, treats the same value as idempotent, and rejects replacement", async () => {
    const createdOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdOptions.push(options ?? {});
        return createFakeApp(options);
      },
      cwd: LOCAL_WORKSPACE.workspacePath,
      version: "test-version",
    });

    await expect(
      requestResult(server, {
        id: "startup-first",
        method: zcodeProtocolMethods.runtimeIdentityInitialize,
        params: { identity: TRUSTED_IDENTITY },
      }),
    ).resolves.toEqual({ initialized: true, reused: false });
    await expect(
      requestResult(server, {
        id: "startup-same",
        method: zcodeProtocolMethods.runtimeIdentityInitialize,
        params: { identity: { ...TRUSTED_IDENTITY } },
      }),
    ).resolves.toEqual({ initialized: true, reused: true });

    await expect(
      server.handleMessage({
        id: "startup-conflict",
        method: zcodeProtocolMethods.runtimeIdentityInitialize,
        params: {
          identity: { hostInstanceId: "other-host", runtimeInstanceId: "other-runtime" },
        },
      }),
    ).resolves.toMatchObject({
      error: { code: -32600, message: "fault.startup.runtimeIdentityConflict" },
    });

    await requestResult(server, {
      id: "create-after-conflict",
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace: LOCAL_WORKSPACE },
    });
    expect(createdOptions[0]?.cuaLaunchIdentity).toEqual({
      ...TRUSTED_IDENTITY,
      workspaceKey: LOCAL_WORKSPACE.workspacePath,
    });
  });

  it("injects only the trusted identity into local top-level apps and normalizes workspaceKey", async () => {
    const created = await createWorkspaceAppWithServerIdentity(
      {
        workspacePath: "/workspace/app",
        workspaceIdentity: "  local-workspace  ",
      },
      {
        cuaLaunchIdentity: {
          hostInstanceId: "forged-host",
          runtimeInstanceId: "forged-runtime",
          workspaceKey: "forged-workspace",
        },
        runtimeConfig: { workingDirectory: "/workspace/app" },
        sessionId: "session-local" as never,
      },
    );

    expect(created?.cuaLaunchIdentity).toEqual({
      ...TRUSTED_IDENTITY,
      workspaceKey: "local-workspace",
    });
  });

  it.each([
    {
      name: "remote workspace identity",
      workspace: {
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:example.test:22:coder:/workspace/app",
      },
      options: { sessionId: "session-remote" as never },
    },
    {
      name: "remote session",
      workspace: {
        workspacePath: "/workspace/app",
        remoteSessionId: "remote-session",
      },
      options: { sessionId: "session-remote-session" as never },
    },
    {
      name: "subagent session",
      workspace: LOCAL_WORKSPACE,
      options: {
        runtimeConfig: { parentSessionId: "parent-session" as never },
        sessionId: "session-child" as never,
      },
    },
  ])("does not inject startup identity for $name", async ({ workspace, options }) => {
    const created = await createWorkspaceAppWithServerIdentity(workspace, {
      ...options,
      runtimeConfig: {
        workingDirectory: workspace.workspacePath,
        ...options.runtimeConfig,
      },
    });
    expect(created).not.toHaveProperty("cuaLaunchIdentity");
  });
});
