import { expect, it, vi } from "vitest";
import { uploadComposerAttachment } from "@/v4/composer/attachmentUpload.js";

// fork（bots 移除）：原以 "topic-history" 为载体的延迟文本材料元数据透传用例改为存活的
// "clipboard-text" 载体（specs/bot-channels-removal.md），透传行为本身保留。
it.each([true, false])(
  "preserves attachment source metadata across local/remote upload (local=%s)",
  async (local) => {
    const put = vi.fn(async () => ({ ref: "zcode-artifact://pasted-text" }));
    const ref = await uploadComposerAttachment(put, "task", {
      kind: "file",
      filename: "pasted-text.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      sourceKind: "clipboard-text",
      messageCount: 2,
      ...(local ? { localPath: "/target/pasted-text.txt" } : { textContent: "abc" }),
    });
    expect(ref).toMatchObject({ sourceKind: "clipboard-text", messageCount: 2 });
  },
);
