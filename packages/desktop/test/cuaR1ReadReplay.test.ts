import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { startUpstreamReplayServer } from "./e2e/helpers/upstream-replay-server.js";

describe("R1 C synthetic provider replay routing (not live acceptance)", () => {
  it("routes every batch after a tool-result user message and completes the last batch", async () => {
    const server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve("output/cua-r1-closeout-20261114/replay-self-test.json"),
      fixturePaths: [
        resolve(
          "packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-cua-r1-noninterference.json",
        ),
      ],
      artifactWriter: async () => {},
    });
    const messages: unknown[] = [
      { role: "user", content: "E2E_CUA_R1_C: controlled input replay" },
    ];
    try {
      for (let part = 1; part <= 10; part++) {
        const response = await fetch(`${server.baseUrl}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "cua-r1-fixture",
            tools: [{ name: "mcp__node_repl__js" }],
            messages,
          }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        const id = `toolu_cua_r1_c_${part}`;
        expect(text).toContain(id);
        messages.push({
          role: "assistant",
          content: [{ type: "tool_use", id, name: "mcp__node_repl__js", input: {} }],
        });
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: `R1_C_PAGE_${part}_DONE` }],
        });
      }
      const final = await fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "cua-r1-fixture", messages }),
      });
      expect(final.status).toBe(200);
      expect(await final.text()).toContain("E2E_CUA_R1_C_DONE");
    } finally {
      await server.stop();
    }
  });
});
