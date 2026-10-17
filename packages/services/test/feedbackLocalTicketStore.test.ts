import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { FeedbackLocalTicketStore } from "#src/feedback/feedbackLocalTicketStore.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FeedbackLocalTicketStore", () => {
  it("读取旧版匿名反馈时将待评估状态迁移为已提交", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-feedback-ticket-store-"));
    tempDirs.push(rootDir);
    writeFileSync(
      join(rootDir, "tickets.json"),
      JSON.stringify({
        tickets: [
          {
            deviceMid: "device-1",
            id: "legacy-ticket",
            title: "旧版匿名反馈",
            type: "bug",
            status: "待评估",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const store = new FeedbackLocalTicketStore(rootDir);

    await expect(store.list()).resolves.toEqual([
      {
        id: "legacy-ticket",
        title: "旧版匿名反馈",
        type: "bug",
        status: "已提交",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });

  it("读取未知缓存状态时按接口契约归一为已提交", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-feedback-ticket-store-"));
    tempDirs.push(rootDir);
    writeFileSync(
      join(rootDir, "tickets.json"),
      JSON.stringify({
        tickets: [
          {
            deviceMid: "device-1",
            id: "unknown-status-ticket",
            title: "未知状态反馈",
            type: "bug",
            status: "future_status",
            created_at: "2026-07-02T00:00:00.000Z",
            updated_at: "2026-07-02T00:00:00.000Z",
          },
        ],
      }),
    );

    const store = new FeedbackLocalTicketStore(rootDir);

    await expect(store.list()).resolves.toEqual([
      {
        id: "unknown-status-ticket",
        title: "未知状态反馈",
        type: "bug",
        status: "已提交",
        created_at: "2026-07-02T00:00:00.000Z",
        updated_at: "2026-07-02T00:00:00.000Z",
      },
    ]);
  });

  // fork（F2.9）：官方提交停用后 store 只读，历史工单不再按 device_mid 归属过滤，
  // 且列出的摘要不得把落盘的 deviceMid 元数据带出去。
  it("只读列出全部历史工单，不按设备过滤且不外泄 deviceMid 元数据", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-feedback-ticket-store-"));
    tempDirs.push(rootDir);
    writeFileSync(
      join(rootDir, "tickets.json"),
      JSON.stringify({
        tickets: [
          {
            deviceMid: "device-1",
            id: "ticket-a",
            title: "工单 A",
            type: "bug",
            status: "已提交",
            created_at: "2026-07-03T00:00:00.000Z",
            updated_at: "2026-07-03T00:00:00.000Z",
          },
          {
            deviceMid: "device-2",
            id: "ticket-b",
            title: "工单 B",
            type: "feature",
            status: "已采纳",
            created_at: "2026-07-04T00:00:00.000Z",
            updated_at: "2026-07-04T00:00:00.000Z",
          },
        ],
      }),
    );

    const store = new FeedbackLocalTicketStore(rootDir);

    const all = await store.list();
    expect(all.map((ticket) => ticket.id)).toEqual(["ticket-b", "ticket-a"]);
    expect(JSON.stringify(all)).not.toContain("device-1");
    expect(JSON.stringify(all)).not.toContain("deviceMid");

    const onlyBugs = await store.list({ type: "bug" });
    expect(onlyBugs.map((ticket) => ticket.id)).toEqual(["ticket-a"]);
  });
});
