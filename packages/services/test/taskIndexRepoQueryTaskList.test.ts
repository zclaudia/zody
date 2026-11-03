import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZodyTaskMeta } from "@zody/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-query-list-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  // Windows 需要等待 SQLite 释放文件句柄，避免临时目录清理出现 EPERM。
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/workspace/project";

function meta(params: {
  taskId: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}): ZodyTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.title ?? `Title ${params.taskId}`,
    workspacePath: WORKSPACE,
    createdAt: params.createdAt ?? 100,
    updatedAt: params.updatedAt ?? 200,
    mode: "default",
    status: "completed",
  };
}

async function seed(
  params: Parameters<TaskIndexRepo["syncTaskMeta"]>[0] & {
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    searchableText?: string;
  },
) {
  await repo.syncTaskMeta(params);
}

function query(overrides: Partial<Parameters<TaskIndexRepo["queryTaskList"]>[0]> = {}) {
  return repo.queryTaskList({
    kind: "active",
    workspaceScopes: [{ workspacePath: WORKSPACE }],
    sortBy: "updated",
    ...overrides,
  });
}

describe("TaskIndexRepo.queryTaskList", () => {
  it("kind × search × deleted tombstone 矩阵：deleted 任务在任何过滤组合下都不出现", async () => {
    await seed({ meta: meta({ taskId: "active-hit" }), searchableText: "chat mentions needle here" });
    await seed({ meta: meta({ taskId: "active-miss" }), searchableText: "plain body text" });
    await seed({
      meta: meta({ taskId: "pinned-hit" }),
      pinned: true,
      searchableText: "pinned chat has needle",
    });
    await seed({
      meta: meta({ taskId: "archived-hit" }),
      archived: true,
      searchableText: "archived chat has needle",
    });
    await seed({
      meta: meta({ taskId: "pinned-archived-hit" }),
      pinned: true,
      archived: true,
      searchableText: "pinned and archived needle",
    });
    // tombstone：已删除任务的正文即使命中搜索词也绝不能回到列表。
    await seed({
      meta: meta({ taskId: "deleted-hit" }),
      deleted: true,
      searchableText: "deleted chat still has needle",
    });

    const bySearch = await query({ search: "needle" });
    expect(bySearch.items.map((item) => item.taskId)).toEqual(["active-hit"]);
    expect(bySearch.total).toBe(1);

    const pinned = await query({ kind: "pinned", search: "needle" });
    expect(pinned.items.map((item) => item.taskId)).toEqual(["pinned-hit"]);

    const archived = await query({ kind: "archived", search: "needle" });
    // pinned+archived 只归档视图可见；pinned 视图要求 archived=0。
    // 时间全同 → task_id DESC tie-break：pinned-archived-hit 排在 archived-hit 前。
    expect(archived.items.map((item) => item.taskId)).toEqual([
      "pinned-archived-hit",
      "archived-hit",
    ]);

    const timeline = await query({ kind: "timeline", search: "needle" });
    expect(timeline.items.map((item) => item.taskId)).toEqual(["active-hit"]);

    // 无搜索时同样受 kind 与 deleted 过滤约束。
    const activeAll = await query({});
    expect(activeAll.items.map((item) => item.taskId).sort()).toEqual([
      "active-hit",
      "active-miss",
    ]);
    const archivedAll = await query({ kind: "archived" });
    expect(archivedAll.items.map((item) => item.taskId).sort()).toEqual([
      "archived-hit",
      "pinned-archived-hit",
    ]);
  });

  it("search 同时命中 title 与 searchable_text，并生成正文摘要", async () => {
    await seed({ meta: meta({ taskId: "title-hit", title: "needle in title" }) });
    await seed({
      meta: meta({ taskId: "body-hit", title: "plain title" }),
      searchableText: "body text contains needle for snippet",
    });
    await seed({ meta: meta({ taskId: "miss" }), searchableText: "nothing here" });

    const result = await query({ search: "needle" });
    expect(result.items.map((item) => item.taskId).sort()).toEqual(["body-hit", "title-hit"]);
    const bodyHit = result.items.find((item) => item.taskId === "body-hit");
    // 正文命中要带回 searchSnippets，供手机搜索结果展示上下文。
    expect(bodyHit?.searchSnippets?.some((snippet) => snippet.toLocaleLowerCase().includes("needle"))).toBe(
      true,
    );
    const titleHit = result.items.find((item) => item.taskId === "title-hit");
    expect(titleHit?.searchSnippets ?? []).toEqual([]);
  });

  it("limit 精确下推：只取 limit 行，total/hasMore 反映全量", async () => {
    for (let index = 0; index < 5; index += 1) {
      await seed({
        meta: meta({ taskId: `task-${index}`, updatedAt: 1000 + index }),
      });
    }
    const limited = await query({ limit: 3 });
    expect(limited.items).toHaveLength(3);
    expect(limited.items.map((item) => item.taskId)).toEqual(["task-4", "task-3", "task-2"]);
    expect(limited.total).toBe(5);
    expect(limited.hasMore).toBe(true);

    const exact = await query({ limit: 5 });
    expect(exact.items).toHaveLength(5);
    expect(exact.hasMore).toBe(false);

    const unlimited = await query({});
    expect(unlimited.items).toHaveLength(5);
    expect(unlimited.hasMore).toBe(false);
  });

  it("相同 updatedAt/createdAt 时按 task_id DESC tie-break（updated 与 created 两种排序一致）", async () => {
    for (const taskId of ["task-a", "task-b", "task-c"]) {
      await seed({
        meta: meta({ taskId, createdAt: 500, updatedAt: 900 }),
        searchableText: "needle",
      });
    }
    const byUpdated = await query({ sortBy: "updated", search: "needle" });
    expect(byUpdated.items.map((item) => item.taskId)).toEqual([
      "task-c",
      "task-b",
      "task-a",
    ]);
    const byCreated = await query({ sortBy: "created", search: "needle" });
    expect(byCreated.items.map((item) => item.taskId)).toEqual([
      "task-c",
      "task-b",
      "task-a",
    ]);
  });

  it("searchable_text 超过 200_000 字符被截断，第 200_001 位之后的关键词搜不到", async () => {
    const filler = "a".repeat(200_000);
    // 关键词起点正好在截断边界之外（第 200_001 个字符）。
    await seed({
      meta: meta({ taskId: "beyond-limit", title: "plain title beyond" }),
      searchableText: `${filler}zzzboundaryneedle`,
    });
    // 对照组：关键词在截断边界内。
    await seed({
      meta: meta({ taskId: "within-limit", title: "plain title within" }),
      searchableText: `${filler.slice(0, 199_000)}zzzboundaryneedle${filler.slice(0, 100)}`,
    });

    const result = await query({ search: "zzzboundaryneedle" });
    expect(result.items.map((item) => item.taskId)).toEqual(["within-limit"]);
    expect(result.total).toBe(1);

    const row = (
      repo as unknown as { getDatabase(): { prepare(sql: string): { get(): unknown } } }
    )
      .getDatabase()
      .prepare(
        "SELECT LENGTH(searchable_text) AS length FROM tasks WHERE task_id = 'beyond-limit'",
      )
      .get() as { length: number };
    expect(row.length).toBe(200_000);
  });
});
