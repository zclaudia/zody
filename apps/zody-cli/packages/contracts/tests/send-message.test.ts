import { describe, expect, it } from "vitest";
import {
  SEND_MESSAGE_MAX_CONTENT_CHARS,
  SendMessageInputSchema,
  SendMessageRuntimeInputSchema,
} from "../src/tools/send-message.js";

const TO = "agent_0123456789abcdef0123456789abcdef";

/** 码元扫描：不允许出现未配对的高位/低位代理（半个 emoji）。 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("SendMessage contracts", () => {
  describe("SendMessageRuntimeInputSchema message 校验", () => {
    it("rejects a whitespace-only message (upstream a60ba6a7)", () => {
      for (const message of ["   ", " \n\t ", "\u00a0\u3000 "]) {
        const parsed = SendMessageRuntimeInputSchema.safeParse({
          to: TO,
          summary: "preview",
          message,
        });
        expect(parsed.success).toBe(false);
      }
    });

    it("keeps the provider-visible min/max bounds on message", () => {
      expect(
        SendMessageRuntimeInputSchema.safeParse({ to: TO, message: "" }).success,
      ).toBe(false);
      expect(
        SendMessageRuntimeInputSchema.safeParse({
          to: TO,
          message: "a".repeat(SEND_MESSAGE_MAX_CONTENT_CHARS + 1),
        }).success,
      ).toBe(false);
      expect(
        SendMessageRuntimeInputSchema.safeParse({
          to: TO,
          message: "a".repeat(SEND_MESSAGE_MAX_CONTENT_CHARS),
        }).success,
      ).toBe(true);
    });

    it("accepts a non-empty message and keeps it verbatim", () => {
      const parsed = SendMessageRuntimeInputSchema.parse({
        to: TO,
        summary: "preview",
        message: " start and end with spaces ",
      });
      expect(parsed.message).toBe(" start and end with spaces ");
    });
  });

  describe("SendMessageRuntimeInputSchema summary 截断", () => {
    it("truncates an over-long ASCII summary to 200 code units with an ellipsis", () => {
      const parsed = SendMessageRuntimeInputSchema.parse({
        to: TO,
        summary: "a".repeat(201),
        message: "hello",
      });
      expect(parsed.summary).toBe(`${"a".repeat(199)}…`);
      expect(parsed.summary?.length).toBeLessThanOrEqual(200);
    });

    it("does not split a surrogate pair when the cut lands on an emoji", () => {
      // 198 个 ASCII + 两个 emoji = 202 码元；slice(0,199) 会以第一个 emoji 的高位代理收尾。
      const summary = `${"a".repeat(198)}😀😀`;
      const parsed = SendMessageRuntimeInputSchema.parse({
        to: TO,
        summary,
        message: "hello",
      });
      const truncated = parsed.summary ?? "";
      expect(truncated.endsWith("…")).toBe(true);
      expect(hasLoneSurrogate(truncated)).toBe(false);
      expect(truncated.length).toBeLessThanOrEqual(200);
    });

    it("keeps a surrogate-safe truncated summary valid under the provider schema", () => {
      const summary = `${"a".repeat(198)}😀😀`;
      const parsed = SendMessageRuntimeInputSchema.parse({
        to: TO,
        summary,
        message: "hello",
      });
      expect(
        SendMessageInputSchema.safeParse({
          to: TO,
          summary: parsed.summary,
          message: "hello",
        }).success,
      ).toBe(true);
    });

    it("leaves a summary at or under the limit untouched", () => {
      // 199 ASCII + 1 个 emoji（2 码元）= 201 码元，超限：slice(0,199) 边界落在 ASCII 上。
      const summary = `${"a".repeat(199)}😀`;
      expect(summary.length).toBe(201);
      const overLimit = SendMessageRuntimeInputSchema.parse({
        to: TO,
        summary,
        message: "hello",
      });
      expect(overLimit.summary).toBe(`${"a".repeat(199)}…`);

      const exactlyLimit = `${"a".repeat(198)}😀`; // 200 码元
      const kept = SendMessageRuntimeInputSchema.parse({
        to: TO,
        summary: exactlyLimit,
        message: "hello",
      });
      expect(kept.summary).toBe(exactlyLimit);
    });

    it("keeps an omitted summary undefined", () => {
      const parsed = SendMessageRuntimeInputSchema.parse({
        to: TO,
        message: "hello",
      });
      expect(parsed.summary).toBeUndefined();
    });
  });

  describe("provider-facing SendMessageInputSchema", () => {
    it("rejects unknown top-level properties (strict object)", () => {
      const parsed = SendMessageInputSchema.safeParse({
        to: TO,
        summary: "preview",
        message: "hello",
        extra: true,
      });
      expect(parsed.success).toBe(false);
    });

    it("enforces the summary upper bound at the provider boundary", () => {
      expect(
        SendMessageInputSchema.safeParse({ to: TO, summary: "a".repeat(201), message: "hi" })
          .success,
      ).toBe(false);
    });
  });
});
