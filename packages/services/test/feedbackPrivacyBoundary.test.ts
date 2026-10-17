import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedbackService } from "../src/feedback/feedbackService.js";
import { setDataBaseDir } from "../src/paths.js";
import { describe, expect, it, vi } from "vitest";
import { FeedbackHttpClient } from "../src/feedback/feedbackHttpClient.js";
import type { ApiRequestInit } from "@zcode/shared";

describe("工单发送隐私边界", () => {
  it("创建和补充均脱敏文本，保留用户联系方式并丢弃模型列表", async () => {
    const bodies: string[] = [];
    const request = vi.fn(async (_url: string | URL | Request, init?: ApiRequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({
          code: 0,
          data: { ticket_id: "ticket", message_id: "message", created_at: 1 },
        }),
      );
    });
    const client = new FeedbackHttpClient({
      baseUrl: "https://example.invalid/api/v1",
      apiClient: { request },
      getAuthHeaders: async () => ({ "X-Device-Mid": "device" }),
    });
    await client.create({
      title: "https://hooks.slack.com/services/T000/B000/title-path-canary API_KEY=title-canary",
      description: [
        "请帮助我，token=body-canary",
        "https://example.com/reset/body-path-canary",
        JSON.stringify({ url: "https://files.example.com/object-path-canary?sig=sig-canary" }),
        JSON.stringify({ error: 'failed config: {"apiKey":"embedded-canary"}' }),
        '[info] {"apiKey":"prefix-canary"} {"status":401}',
        '{"cookie":"truncated-canary',
      ].join("\n"),
      type: "bug",
      contact: "user@example.com",
      device: {
        agentModelOptionsPreview: ["private-model-canary"],
        hostname: "host-canary",
        appVersion: "1.0",
      },
    });
    await client.comment(
      "ticket",
      "https://example.com/invite/comment-path-canary\nAuthorization: Bearer comment-canary",
    );
    const sent = bodies.join("\n");
    for (const secret of [
      "title-canary",
      "title-path-canary",
      "body-path-canary",
      "object-path-canary",
      "sig-canary",
      "comment-path-canary",
      "body-canary",
      "embedded-canary",
      "prefix-canary",
      "truncated-canary",
      "comment-canary",
      "private-model-canary",
      "host-canary",
    ])
      expect(sent).not.toContain(secret);
    expect(sent).toContain("user@example.com");
    expect(sent).toContain("请帮助我");
    expect(sent).toContain("1.0");
  });
});

// fork（F2.9）：官方上传链路停用后，附件不再写临时目录、不再发起上传；
// 隐私边界收敛为「拒绝且零网络请求」。反馈文本脱敏与归档隐私由
// feedbackPrivacy.test.ts 与 compactLogArchive.test.ts 继续覆盖。
it("工单附件上传在停用后直接拒绝，不写入暂存目录也不发请求", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-attachment-privacy-"));
  setDataBaseDir(root);
  const request = vi.fn(async () => {
    throw new Error("feedback service must not issue HTTP requests");
  });
  const upload = vi.spyOn(FeedbackHttpClient.prototype, "uploadFile");

  try {
    const service = createFeedbackService({
      apiClient: { request },
    });
    await expect(
      service.uploadAttachmentData("ticket", "image", {
        filename: "../../private.png",
        dataBase64: Buffer.from("synthetic-image").toString("base64"),
        contentType: "image/png",
      }),
    ).rejects.toThrow(/停用/);
    expect(upload).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally {
    upload.mockRestore();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});
