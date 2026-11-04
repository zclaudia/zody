import { PassThrough } from "node:stream";
import { SessionEventType, type SessionEvent } from "@zody/contracts";
import { describe, expect, it } from "vitest";
import { mapSessionEvent } from "../src/zody-protocol/session-mapper.js";
import { ZodyProtocolNdjsonConnection } from "../src/zody-protocol/transport.js";

describe("Agent metadata LF wire", () => {
  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "sends model and recovery retry through real LF framing for %s",
    async (deliveryKind) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let wire = "";
      output.on("data", (data: Buffer) => {
        wire += data.toString("utf8");
      });
      const connection = new ZodyProtocolNdjsonConnection({
        input,
        output,
        handleMessage: async () => undefined,
      });
      connection.start();
      const payloads = [
        {
          type: "model_retry_scheduled",
          attempt: 2,
          maxAttempts: 11,
          delayMs: 1234,
          statusCode: 502,
          querySource: "main_turn",
        },
        { attemptId: "attempt_1", retryNumber: 3, maxRetries: 10, streamMode: "sse" },
      ];
      for (const [index, payload] of payloads.entries()) {
        const event = {
          id: `evt_${index}`,
          sessionId: "sess_1",
          traceId: "trace_1",
          sequenceNumber: index + 1,
          timestamp: new Date(1),
          type:
            index === 0
              ? SessionEventType.ModelNetworkStatus
              : SessionEventType.StreamRecoveryRetryStarted,
          payload: { ...payload, _meta: { zcode: { opaque: "old" }, zody: { keep: "new" } } },
        } as unknown as SessionEvent;
        connection.send({
          jsonrpc: "2.0",
          method: "session/event",
          params: mapSessionEvent(event, deliveryKind),
        });
      }
      expect(wire.endsWith("\n")).toBe(true);
      const rows = wire
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows[0].params.payload._meta).toMatchObject({
        zcode: { opaque: "old" },
        zody: { keep: "new", apiRetry: { attempt: 2 } },
      });
      expect(rows[1].params.payload._meta.zody.apiRetry.attempt).toBe(3);
      expect(rows.map((row) => row.params.deliveryKind)).toEqual([deliveryKind, deliveryKind]);
      input.end();
      await connection.waitForClose();
      output.destroy();
    },
  );
});
