import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type ToolPart,
} from "@zody/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { READ_FILE_UNCHANGED_STUB } from "../src/tool/handlers/read-text.js";
import { createReadFileStatePathKey, setReadFileStateEntry } from "../src/tool/read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";

const workspaceRoot = "/tmp/zcode-read-state-hydrator";

describe("read file state hydrator", () => {
  it("restores full Read state from structured completed metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-full");
    const file = join(workspaceRoot, "src", "index.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read", 10, [
          completedToolPart(sessionID, "assistant-full-read", "tool-read", "Read", {
            input: { file_path: "src/index.ts" },
            output: "1\texport const answer = 42;\n2\t",
            metadata: readStateMetadata(file, "export const answer = 42;\n"),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "export const answer = 42;\n",
      isPartialView: false,
      limit: undefined,
      mtimeMs: 1,
      offset: undefined,
      path: file,
      revisionId: `rev:${file}:${Buffer.byteLength("export const answer = 42;\n", "utf8")}:1`,
    });
  });

  it.each([0, 1])(
    "restores explicit offset %i Read without limit as a full Read",
    async (offset) => {
      const sessionID = createSessionId(`hydrate-read-state-full-offset-${offset}`);
      const file = join(workspaceRoot, "src", `offset-${offset}.ts`);
      const readFileState: ReadFileStateMap = new Map();

      const result = await hydrateReadFileStateFromSession({
        messages: [
          assistantToolMessage(sessionID, `assistant-full-offset-${offset}`, 10, [
            completedToolPart(sessionID, `assistant-full-offset-${offset}`, "tool-read", "Read", {
              input: { file_path: file, offset },
              output: "1\talpha\n2\tbeta\n",
              metadata: readStateMetadata(file, "alpha\nbeta\n", { offset }),
            }),
          ]),
        ],
        readFileState,
        workingDirectory: workspaceRoot,
        workspaceRoot,
      });

      expect(result.restoredCount).toBe(1);
      expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
        content: "alpha\nbeta\n",
        isPartialView: false,
        limit: undefined,
        offset: undefined,
        path: file,
      });
    },
  );

  it("skips string-only Read output when completed metadata is missing", async () => {
    const sessionID = createSessionId("hydrate-read-state-legacy-output");
    const file = join(workspaceRoot, "src", "legacy.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-legacy-read", 10, [
          completedToolPart(sessionID, "assistant-legacy-read", "tool-read-legacy", "Read", {
            input: { file_path: file },
            output:
              "1\talpha\n2\tbeta\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware.\n</system-reminder>\n",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("skips empty Read warning output when completed metadata is missing", async () => {
    const sessionID = createSessionId("hydrate-read-state-empty-output");
    const file = join(workspaceRoot, "src", "empty.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-empty-read", 10, [
          completedToolPart(sessionID, "assistant-empty-read", "tool-read-empty", "Read", {
            input: { file_path: file },
            output:
              "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("skips Read metadata without complete freshness fields", async () => {
    const sessionID = createSessionId("hydrate-read-state-incomplete-metadata");
    const file = join(workspaceRoot, "src", "incomplete.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-incomplete-read", 10, [
          completedToolPart(
            sessionID,
            "assistant-incomplete-read",
            "tool-read-incomplete",
            "Read",
            {
              input: { file_path: file },
              output: "1\tincomplete\n2\t",
              metadata: {
                readFileState: {
                  content: "incomplete\n",
                  isPartialView: false,
                  path: file,
                  readAtMs: 2,
                  schemaVersion: 1,
                  sizeBytes: Buffer.byteLength("incomplete\n", "utf8"),
                  tool: "Read",
                },
                schemaVersion: 1,
              },
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("restores a historical range Read as the file's latest view during resume", async () => {
    const sessionID = createSessionId("hydrate-read-state-range");
    const file = join(workspaceRoot, "src", "range.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-range-read", 10, [
          completedToolPart(sessionID, "assistant-range-read", "tool-read-range", "Read", {
            input: { file_path: file, offset: 2, limit: 1 },
            output: "2\tline two",
            metadata: readStateMetadata(file, "line two", { limit: 1, offset: 2 }),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 反例（旧实现）：range Read 跨 resume 不恢复（skippedRangeReadCount），
    // 「完整 → 范围 → 重启 → 完整」会命中旧的完整视图返回 Wasted call，与 live 不一致。
    expect(result.restoredCount).toBe(1);
    expect(readFileState.size).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "line two",
      limit: 1,
      offset: 2,
      path: file,
    });
  });

  it("keeps a range Read without structured metadata skipped during resume", async () => {
    const sessionID = createSessionId("hydrate-read-state-range-no-metadata");
    const file = join(workspaceRoot, "src", "range-no-metadata.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-range-read-no-metadata", 10, [
          completedToolPart(
            sessionID,
            "assistant-range-read-no-metadata",
            "tool-read-range",
            "Read",
            {
              input: { file_path: file, offset: 2, limit: 1 },
              output: "2\tline two",
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 没有结构化快照就没有可恢复的事实；不从 provider-visible cat-n 文本恢复。
    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("replaces an earlier full Read with a later range Read during resume", async () => {
    const sessionID = createSessionId("hydrate-read-state-full-then-range");
    const file = join(workspaceRoot, "src", "full-then-range.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read-before-range", 10, [
          completedToolPart(
            sessionID,
            "assistant-full-read-before-range",
            "tool-read-full",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n2\tline two\n3\t",
              metadata: readStateMetadata(file, "line one\nline two\n"),
            },
          ),
        ]),
        assistantToolMessage(sessionID, "assistant-range-read-after-full", 20, [
          completedToolPart(
            sessionID,
            "assistant-range-read-after-full",
            "tool-read-range-after-full",
            "Read",
            {
              input: { file_path: file, offset: 2, limit: 1 },
              output: "2\tline two",
              metadata: readStateMetadata(file, "line two", { limit: 1, offset: 2 }),
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 反例（旧多键模型）：完整视图与范围视图并存，重启后同一次完整 Read 命中旧完整视图
    // 返回 file_unchanged，而 live 语义下最新视图是 range，完整 Read 应返回正文。
    expect(result.restoredCount).toBe(2);
    expect(readFileState.size).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "line two",
      limit: 1,
      offset: 2,
      path: file,
    });
  });

  it("restores a later token-truncated full Read as partial state over an earlier full Read", async () => {
    const sessionID = createSessionId("hydrate-read-state-full-then-partial");
    const file = join(workspaceRoot, "src", "full-then-partial.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read-before-partial", 10, [
          completedToolPart(
            sessionID,
            "assistant-full-read-before-partial",
            "tool-read-full-before-partial",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n2\tline two\n3\t",
              metadata: readStateMetadata(file, "line one\nline two\n"),
            },
          ),
        ]),
        assistantToolMessage(sessionID, "assistant-partial-full-read-after-full", 20, [
          completedToolPart(
            sessionID,
            "assistant-partial-full-read-after-full",
            "tool-read-partial-after-full",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n<system-reminder>partial view</system-reminder>",
              metadata: readStateMetadata(file, "line one\n", { isPartialView: true }),
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(2);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "line one\n",
      isPartialView: true,
      limit: undefined,
      offset: undefined,
      path: file,
    });
  });

  it("restores Write state from structured metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-completed-time");
    const file = join(workspaceRoot, "src", "write-completed-time.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-completed-time", 10, [
          completedToolPart(
            sessionID,
            "assistant-write-completed-time",
            "tool-write-completed-time",
            "Write",
            {
              input: { file_path: file, content: "written\n" },
              output: "The file has been updated successfully.",
              metadata: readStateMetadata(file, "written\n", { tool: "Write" }),
              time: { start: 100, end: 200 },
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "written\n",
      mtimeMs: 1,
      path: file,
      readAt: new Date(2),
      revisionId: `rev:${file}:${Buffer.byteLength("written\n", "utf8")}:1`,
    });
  });

  it("skips legacy Write and Edit parts without structured read state metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-edit-legacy-skip");
    const writeFile = join(workspaceRoot, "legacy-written.ts");
    const editFile = join(workspaceRoot, "legacy-edited.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-edit-legacy", 10, [
          completedToolPart(
            sessionID,
            "assistant-write-edit-legacy",
            "tool-write-legacy",
            "Write",
            {
              input: { file_path: writeFile, content: "written content\n" },
              output: "The file has been updated successfully.",
            },
          ),
          completedToolPart(sessionID, "assistant-write-edit-legacy", "tool-edit-legacy", "Edit", {
            input: { file_path: editFile, old_string: "old", new_string: "edited" },
            output: "The file has been updated successfully.",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("restores Write and Edit states from structured metadata without reading current disk", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-edit");
    const writeFile = join(workspaceRoot, "written.ts");
    const editFile = join(workspaceRoot, "edited.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-edit", 10, [
          completedToolPart(sessionID, "assistant-write-edit", "tool-write", "Write", {
            input: { file_path: writeFile, content: "written content\n" },
            metadata: readStateMetadata(writeFile, "written content\n", { tool: "Write" }),
            output: "The file has been updated successfully.",
          }),
          completedToolPart(sessionID, "assistant-write-edit", "tool-edit", "Edit", {
            input: { file_path: editFile, old_string: "old", new_string: "edited" },
            metadata: readStateMetadata(editFile, "edited from metadata\n", { tool: "Edit" }),
            output: "The file has been updated successfully.",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(2);
    expect(readFileState.get(createReadFileStatePathKey(writeFile))).toMatchObject({
      content: "written content\n",
      isPartialView: false,
      path: writeFile,
    });
    expect(readFileState.get(createReadFileStatePathKey(editFile))).toMatchObject({
      content: "edited from metadata\n",
      isPartialView: false,
      path: editFile,
    });
  });

  it("only restores tool state from messages after the active compaction boundary", async () => {
    const sessionID = createSessionId("hydrate-read-state-compact");
    const oldFile = join(workspaceRoot, "old.ts");
    const newFile = join(workspaceRoot, "new.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-before-compact", 10, [
          completedToolPart(sessionID, "assistant-before-compact", "tool-old", "Read", {
            input: { file_path: oldFile },
            output: "1\told\n2\t",
            metadata: readStateMetadata(oldFile, "old\n"),
          }),
        ]),
        compactionMessage(sessionID, "compact-boundary", 20),
        assistantToolMessage(sessionID, "assistant-after-compact", 30, [
          completedToolPart(sessionID, "assistant-after-compact", "tool-new", "Read", {
            input: { file_path: newFile },
            output: "1\tnew\n2\t",
            metadata: readStateMetadata(newFile, "new\n"),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(readFileState.has(createReadFileStatePathKey(oldFile))).toBe(false);
    expect(readFileState.has(createReadFileStatePathKey(newFile))).toBe(true);
  });

  it("replays same-assistant snapshots in snapshotIndex order, not part declaration order", async () => {
    const sessionID = createSessionId("hydrate-read-state-snapshot-index");
    const file = join(workspaceRoot, "src", "parallel.ts");
    const readFileState: ReadFileStateMap = new Map();

    // part 声明序：完整 Read 在前、range Read 在后；live 写入序（snapshotIndex）相反。
    // 并行工具下结果返回先后不等于写入先后，重放必须按 snapshotIndex 还原 live 的最终视图。
    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-parallel-reads", 10, [
          completedToolPart(sessionID, "assistant-parallel-reads", "tool-read-full", "Read", {
            input: { file_path: file },
            output: "1\tfull\n2\t",
            metadata: readStateMetadata(file, "full\n", { snapshotIndex: 1 }),
          }),
          completedToolPart(sessionID, "assistant-parallel-reads", "tool-read-range", "Read", {
            input: { file_path: file, offset: 2, limit: 1 },
            output: "2\trange",
            metadata: readStateMetadata(file, "range", {
              limit: 1,
              offset: 2,
              snapshotIndex: 0,
            }),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 反例（旧实现按 part 声明序重放）：最终留下 range 视图，重启后同一次完整 Read
    // 返回 file_unchanged 而不是正文。
    expect(result.restoredCount).toBe(2);
    expect(readFileState.size).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "full\n",
      limit: undefined,
      offset: undefined,
      path: file,
    });
  });

  it("falls back to part declaration order when any snapshot lacks snapshotIndex", async () => {
    const sessionID = createSessionId("hydrate-read-state-legacy-snapshot-order");
    const file = join(workspaceRoot, "src", "legacy-order.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-legacy-order", 10, [
          completedToolPart(sessionID, "assistant-legacy-order", "tool-read-range", "Read", {
            input: { file_path: file, offset: 2, limit: 1 },
            output: "2\trange",
            metadata: readStateMetadata(file, "range", { limit: 1, offset: 2 }),
          }),
          completedToolPart(sessionID, "assistant-legacy-order", "tool-read-full", "Read", {
            input: { file_path: file },
            output: "1\tfull\n2\t",
            metadata: readStateMetadata(file, "full\n", { snapshotIndex: 1 }),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 旧数据没有 snapshotIndex：保持 part 原顺序（本例 range 在前、完整在后，最终完整）。
    expect(result.restoredCount).toBe(2);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "full\n",
    });
  });

  it("skips Read parts that returned the file_unchanged stub", async () => {
    const sessionID = createSessionId("hydrate-read-state-unchanged-stub");
    const file = join(workspaceRoot, "src", "unchanged.ts");
    const readFileState: ReadFileStateMap = new Map();

    // 旧数据的 file_unchanged 结果也带了快照（当时最新记录的副本）；按它重放会把读取时间
    // 改成这次调用的时间。跳过它，由之前那次真实读取恢复。
    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-real-read", 10, [
          completedToolPart(sessionID, "assistant-real-read", "tool-read-real", "Read", {
            input: { file_path: file },
            output: "1\treal\n2\t",
            metadata: readStateMetadata(file, "real\n", { readAtMs: 2 }),
          }),
        ]),
        assistantToolMessage(sessionID, "assistant-unchanged-read", 20, [
          completedToolPart(sessionID, "assistant-unchanged-read", "tool-read-unchanged", "Read", {
            input: { file_path: file },
            output: READ_FILE_UNCHANGED_STUB,
            metadata: readStateMetadata(file, "real\n", { readAtMs: 99 }),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "real\n",
      readAt: new Date(2),
    });
  });

  it("marks restored entries with restoredFromSession when resume requests it", async () => {
    const sessionID = createSessionId("hydrate-read-state-mark-restored");
    const file = join(workspaceRoot, "src", "mark-restored.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      markRestoredFromSession: true,
      messages: [
        assistantToolMessage(sessionID, "assistant-mark-restored", 10, [
          completedToolPart(sessionID, "assistant-mark-restored", "tool-read-marked", "Read", {
            input: { file_path: file },
            output: "1\tmarked\n2\t",
            metadata: readStateMetadata(file, "marked\n"),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // resume 标记 restoredFromSession：compaction 补回对这些记录按读取时间排序。
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      restoredFromSession: true,
    });
  });

  it("does not mark restoredFromSession for rewind rebuilds", async () => {
    const sessionID = createSessionId("hydrate-read-state-rewind-unmarked");
    const file = join(workspaceRoot, "src", "rewind-unmarked.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-rewind-unmarked", 10, [
          completedToolPart(sessionID, "assistant-rewind-unmarked", "tool-read-rewind", "Read", {
            input: { file_path: file },
            output: "1\trewind\n2\t",
            metadata: readStateMetadata(file, "rewind\n"),
          }),
        ]),
      ],
      readFileState,
      retainContextSeeds: true,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // rewind 在同一进程里重建，不带 restoredFromSession，与 live 记录一样按 mtime 参与补回排序。
    const restored = readFileState.get(createReadFileStatePathKey(file));
    expect(restored).toMatchObject({ content: "rewind\n" });
    expect(restored?.restoredFromSession).toBeUndefined();
  });

  it("retains context seeds on rewind and drops them on resume", async () => {
    const sessionID = createSessionId("hydrate-read-state-context-seed");
    const seedFile = join(workspaceRoot, "memory", "MEMORY.md");
    const seed: ReadFileStateEntry = {
      content: "memory index",
      isPartialView: false,
      limit: undefined,
      offset: undefined,
      path: seedFile,
      readAt: new Date(1),
      requestedPath: undefined,
      revisionId: "rev:seed",
      seededFromContext: true,
      sizeBytes: 12,
    };
    const readFileState: ReadFileStateMap = new Map();
    setReadFileStateEntry(readFileState, seed);

    await hydrateReadFileStateFromSession({
      messages: [],
      readFileState,
      retainContextSeeds: true,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 反例（旧实现整表 clear()）：rewind 丢掉 MEMORY.md 的 context 记录，
    // 而 rewind 不重新加载 context，之后 Write MEMORY.md 误报未读。
    expect(readFileState.get(createReadFileStatePathKey(seedFile))).toBe(seed);

    await hydrateReadFileStateFromSession({
      messages: [],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // resume 由 context 初始化重新写入 seed，这里不保留。
    expect(readFileState.has(createReadFileStatePathKey(seedFile))).toBe(false);
  });

  it("backfills requestedPath from the tool part input for old and new snapshots", async () => {
    const sessionID = createSessionId("hydrate-read-state-requested-path");
    const file = join(workspaceRoot, "src", "requested.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-requested-path", 10, [
          completedToolPart(sessionID, "assistant-requested-path", "tool-read-relative", "Read", {
            input: { file_path: "src/requested.ts" },
            output: "1\trequested\n2\t",
            metadata: readStateMetadata(file, "requested\n"),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 快照里没有 requestedPath（旧数据）；tool part 一直存着输入，从这里回填，
    // compaction 补回按原始写法再判定一次 deny。
    expect(result.restoredCount).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      path: file,
      requestedPath: "src/requested.ts",
    });
  });
});

function completedToolPart(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  callID: string,
  tool: string,
  state: {
    input: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    output: string;
    time?: {
      end: number;
      start: number;
    };
  },
): ToolPart {
  const messageID = createMessageId(messageIDText);
  return {
    callID,
    id: createPartId(`${callID}-part`),
    messageID,
    sessionID,
    state: {
      input: state.input,
      metadata: state.metadata ?? { schemaVersion: 1 },
      output: state.output,
      status: "completed",
      title: tool,
      time: state.time ?? { start: 1, end: 2 },
    },
    tool,
    type: "tool",
  };
}

function assistantToolMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  created: number,
  parts: ToolPart[],
): MessageWithParts {
  const messageID = createMessageId(messageIDText);
  return {
    info: {
      agent: "zcode-agent",
      cost: 0,
      id: messageID,
      mode: "build",
      modelID: "model-test",
      parentID: createMessageId(`${messageIDText}-user`),
      path: { cwd: workspaceRoot, root: workspaceRoot },
      providerID: "provider-test",
      role: "assistant",
      sessionID,
      time: { created },
      tokens: emptyTokens(),
    },
    parts,
  };
}

function compactionMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  created: number,
): MessageWithParts {
  const messageID = createMessageId(messageIDText);
  return {
    info: {
      agent: "zcode-agent",
      id: messageID,
      model: { modelID: "model-test", providerID: "provider-test" },
      role: "user",
      sessionID,
      time: { created },
    },
    parts: [
      {
        id: createPartId(`${messageIDText}-part`),
        messageID,
        sessionID,
        type: "compaction",
      } as MessageWithParts["parts"][number],
    ],
  };
}

function readStateMetadata(
  filePath: string,
  content: string,
  options: {
    isPartialView?: boolean;
    limit?: number;
    offset?: number;
    readAtMs?: number;
    snapshotIndex?: number;
    tool?: "Read" | "Write" | "Edit";
  } = {},
): Record<string, unknown> {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  return {
    readFileState: {
      content,
      isPartialView: options.isPartialView ?? false,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      mtimeMs: 1,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      path: filePath,
      readAtMs: options.readAtMs ?? 2,
      revisionId: `rev:${filePath}:${sizeBytes}:1`,
      schemaVersion: 1,
      sizeBytes,
      ...(options.snapshotIndex === undefined ? {} : { snapshotIndex: options.snapshotIndex }),
      tool: options.tool ?? "Read",
    },
    schemaVersion: 1,
  };
}

function emptyTokens() {
  return {
    cache: {
      read: 0,
      write: 0,
    },
    input: 0,
    output: 0,
    reasoning: 0,
  };
}
