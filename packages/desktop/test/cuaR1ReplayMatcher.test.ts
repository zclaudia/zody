import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { startUpstreamReplayServer } from "./e2e/helpers/upstream-replay-server.js";
import type { E2ENetworkCaptureArtifact } from "./e2e/helpers/network-capture-proxy.js";

it("R1 Stop 旧结果不抢占下一 user turn 的恢复 fixture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r1-replay-match-"));
  const fixture = resolve(
    import.meta.dirname,
    "e2e/fixtures/upstream/conversation-session/conversation-session-cua-r1-observation.json",
  );
  async function match(last: unknown, resumeResult = false) {
    let capture: E2ENetworkCaptureArtifact | undefined;
    const server = await startUpstreamReplayServer({
      artifactPath: join(dir, "unused.json"),
      fixturePaths: [fixture],
      artifactWriter: async (_path, value) => {
        capture = value as E2ENetworkCaptureArtifact;
      },
    });
    try {
      const response = await fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "E2E_CUA_R1_STOP" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_cua_r1_stop_1",
                  name: "mcp__node_repl__js",
                  input: {},
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_cua_r1_stop_1", content: "cancelled" },
              ],
            },
            ...(last ? [{ role: "user", content: last }] : []),
            ...(resumeResult
              ? [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "tool_use",
                        id: "toolu_cua_r1_resume_1",
                        name: "mcp__node_repl__js",
                        input: {},
                      },
                    ],
                  },
                  {
                    role: "user",
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: "toolu_cua_r1_resume_1",
                        content: "R1_FULL_OK",
                      },
                    ],
                  },
                ]
              : []),
          ],
        }),
      });
      await response.text();
      return capture?.records.at(-1)?.replay?.fixtureId;
    } finally {
      await server.stop();
    }
  }
  try {
    expect(await match("E2E_CUA_R1_RESUME")).toBe("cua-r1-resume-call-1");
    expect(await match("E2E_CUA_R1_RESUME", true)).toBe("cua-r1-resume-final");
    expect(await match("E2E_CUA_R1_STOP")).toBe("cua-r1-stop-final");
    expect(await match(null)).toBe("cua-r1-stop-final");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("重建和新 turn 恢复读取不强制 full", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = resolve(
    import.meta.dirname,
    "e2e/fixtures/upstream/conversation-session/conversation-session-cua-r1-observation.json",
  );
  const data = JSON.parse(await readFile(path, "utf8")) as {
    fixtures: Array<{ id: string; response: { toolUse?: { input: { code: string } } } }>;
  };
  for (const id of ["cua-r1-rebuild-call-4", "cua-r1-resume-call-1"]) {
    const code = data.fixtures.find((f) => f.id === id)?.response.toolUse?.input.code;
    expect(code).toContain("get_app_state({app_ref:ref})");
    expect(code).not.toContain("disable_diffing");
  }
});
