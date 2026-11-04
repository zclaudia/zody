import { ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@zody/rpc";
import { describe, expect, it } from "vitest";
import { createZodySessionApiRetryRuntimeTracker } from "../src/zody-session/zodySessionApiRetry.js";

const retry = {
  kind: "api_retry",
  attempt: 2,
  maxRetries: 4,
  retryDelayMs: 1000,
  errorStatus: 502,
  error: "synthetic",
};
const params = {
  workspacePath: "/synthetic",
  workspaceIdentity: "remote:ssh:a:/synthetic",
  sessionId: "sess_a",
};
const snapshot = {
  session: { sessionId: "sess_a", status: "running", workspace: params },
  runtime: {},
};

describe("Agent retry metadata across RPC", () => {
  it("uses the actual retry tracker through ChannelServer/ChannelClient without an old alias", async () => {
    const tracker = createZodySessionApiRetryRuntimeTracker();
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "synthetic");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(
      "retry",
      ProxyChannel.fromService({
        async ingest(payload: unknown) {
          tracker.trackApiRetryFromSessionEvent(params, {
            type: "session.event",
            event: { type: "session.updated", sessionId: "sess_a", payload },
          } as never);
          return tracker.withApiRetryRuntime(snapshot as never);
        },
        async inspectOtherWorkspace() {
          return tracker.withApiRetryRuntime({
            ...snapshot,
            session: {
              ...snapshot.session,
              workspace: { ...params, workspaceIdentity: "remote:ssh:b:/synthetic" },
            },
          } as never);
        },
      }),
    );
    const remote = ProxyChannel.toService<{
      ingest(payload: unknown): Promise<typeof snapshot & { runtime: { apiRetry?: unknown } }>;
      inspectOtherWorkspace(): Promise<typeof snapshot & { runtime: { apiRetry?: unknown } }>;
    }>(client.getChannel("retry"));
    try {
      expect(
        (await remote.ingest({ _meta: { zcode: { apiRetry: retry } } })).runtime.apiRetry,
      ).toBeUndefined();
      expect(
        (
          await remote.ingest({
            _meta: { zody: { apiRetry: retry }, zcode: { apiRetry: { ...retry, attempt: 9 } } },
          })
        ).runtime.apiRetry,
      ).toEqual(retry);
      expect((await remote.inspectOtherWorkspace()).runtime.apiRetry).toBeUndefined();
      const direct = { ...retry, attempt: 3 };
      const runtime = { ...retry, attempt: 4 };
      expect(
        (
          await remote.ingest({
            apiRetry: direct,
            runtime: { apiRetry: runtime },
            _meta: { zody: { apiRetry: retry } },
          })
        ).runtime.apiRetry,
      ).toEqual(direct);
      expect(
        (
          await remote.ingest({
            runtime: { apiRetry: runtime },
            _meta: { zody: { apiRetry: retry } },
          })
        ).runtime.apiRetry,
      ).toEqual(runtime);
      expect(
        (await remote.ingest({ apiRetry: {}, _meta: { zody: { apiRetry: direct } } })).runtime
          .apiRetry,
      ).toEqual(runtime);
      expect(
        (await remote.ingest({ runtime: { apiRetry: {} }, _meta: { zody: { apiRetry: direct } } }))
          .runtime.apiRetry,
      ).toEqual(direct);
      await remote.ingest({ runtime: { apiRetry: runtime } });
      for (const invalid of [{}, [], "not-a-record"]) {
        expect(
          (await remote.ingest({ _meta: { zody: { apiRetry: invalid } } })).runtime.apiRetry,
        ).toEqual(runtime);
      }
      // 非空对象按既有 normalizer 契约提供默认值，本批不收紧这个规则。
      expect(
        (await remote.ingest({ _meta: { zody: { apiRetry: { unknown: true } } } })).runtime
          .apiRetry,
      ).toMatchObject({ kind: "api_retry", attempt: 1 });
      expect(
        (await remote.ingest({ _meta: { zody: { apiRetry: null }, zcode: { apiRetry: retry } } }))
          .runtime.apiRetry,
      ).toBeNull();
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});

describe("retry owner reconnect isolation", () => {
  it("keeps same path and session independent by workspace identity across RPC reconnect", async () => {
    const tracker = createZodySessionApiRetryRuntimeTracker();
    const target = (id: string) => ({ ...params, workspaceIdentity: id });
    const inspect = (id: string) =>
      tracker.withApiRetryRuntime({
        ...snapshot,
        session: { ...snapshot.session, workspace: target(id) },
      } as never);
    const open = () => {
      const [a, b] = createQueuePair();
      const server = new ChannelServer(a, "test");
      const client = new ChannelClient(b);
      server.registerChannel(
        "retry",
        ProxyChannel.fromService({
          async write(id: string, value: unknown) {
            tracker.trackApiRetryFromSessionEvent(target(id), {
              type: "session.event",
              event: {
                type: "session.updated",
                sessionId: "sess_a",
                payload: { _meta: { zody: { apiRetry: value } } },
              },
            } as never);
            return inspect(id);
          },
          async read(id: string) {
            return inspect(id);
          },
        }),
      );
      return {
        server,
        client,
        proxy: ProxyChannel.toService<{
          write(id: string, value: unknown): Promise<{ runtime: { apiRetry?: unknown } }>;
          read(id: string): Promise<{ runtime: { apiRetry?: unknown } }>;
        }>(client.getChannel("retry")),
      };
    };
    const a = "remote:ssh:a:/synthetic",
      b = "remote:ssh:b:/synthetic";
    let connection = open();
    try {
      expect((await connection.proxy.write(a, retry)).runtime.apiRetry).toEqual(retry);
      expect((await connection.proxy.read(b)).runtime.apiRetry).toBeUndefined();
      expect(
        (await connection.proxy.write(b, { ...retry, attempt: 4 })).runtime.apiRetry,
      ).toMatchObject({ attempt: 4 });
      connection.client.dispose();
      connection.server.dispose();
      connection = open();
      expect((await connection.proxy.read(a)).runtime.apiRetry).toMatchObject({ attempt: 2 });
      expect((await connection.proxy.read(b)).runtime.apiRetry).toMatchObject({ attempt: 4 });
      expect((await connection.proxy.write(a, null)).runtime.apiRetry).toBeNull();
      expect((await connection.proxy.read(b)).runtime.apiRetry).toMatchObject({ attempt: 4 });
    } finally {
      connection.client.dispose();
      connection.server.dispose();
    }
  });
});
