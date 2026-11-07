import { describe, expect, it, vi } from "vitest";
import type { ReadTextOutput } from "@zody/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  buildPostCompactFileRestore,
  replaceReadFileStateAfterCompact,
  restorePostCompactFiles,
  type PostCompactFileRead,
} from "../src/runtime/helpers/compact-post-reminders.js";
import { READ_FILE_UNCHANGED_STUB } from "../src/tool/handlers/read-text.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const root = "/tmp/zcode-post-compact-file-restore";

describe("post-compact file restore", () => {
  it("re-reads Read, Write and Edit records and skips other writers and excluded paths", async () => {
    const files = {
      read: `${root}/src/read.ts`,
      written: `${root}/src/written.ts`,
      edited: `${root}/src/edited.ts`,
      bashBackfill: `${root}/src/bash.ts`,
      seeded: `${root}/memory/MEMORY.md`,
      draft: `${root}/.zody/workflows/draft.js`,
      plan: `${root}/.zody/plans/plan-session.md`,
      instructions: `${root}/AGENTS.md`,
      codexMemory: "/Users/dev/.codex/memories/note.md",
      superpowersPlan: `${root}/docs/superpowers/plans/plan.md`,
      git: `${root}/.git/config`,
    };
    const readFileState = createState([
      entry(files.read, { mtimeMs: 9, sourceTool: "Read" }),
      entry(files.written, { mtimeMs: 8, sourceTool: "Write" }),
      entry(files.edited, { mtimeMs: 7, sourceTool: "Edit" }),
      entry(files.bashBackfill, { mtimeMs: 20 }),
      entry(files.seeded, { mtimeMs: 20, seededFromContext: true }),
      entry(files.draft, { mtimeMs: 20, sourceTool: "CreateWorkflow" }),
      entry(files.plan, { mtimeMs: 20, sourceTool: "Read" }),
      entry(files.instructions, { mtimeMs: 20, sourceTool: "Read" }),
      entry(files.codexMemory, { mtimeMs: 20, sourceTool: "Read" }),
      entry(files.superpowersPlan, { mtimeMs: 20, sourceTool: "Read" }),
      entry(files.git, { mtimeMs: 20, sourceTool: "Read" }),
    ]);
    const readFiles = vi.fn(perFile(async (filePath) => textRead(filePath, `disk ${filePath}`)));

    const restore = await buildPostCompactFileRestore({
      excludedPaths: [files.plan, files.instructions],
      readFiles,
      readFileState,
    });

    // 一次拿到全部候选，读权限规则只需加载一次。
    expect(readFiles.mock.calls.map(([paths]) => paths)).toEqual([
      [files.read, files.written, files.edited],
    ]);
    // 补回的是磁盘上的当前内容，不是读取状态里缓存的视图。
    // 反例（旧投影实现）：附件正文来自 readFileState 缓存内容 `cached ${path}`。
    expect(restore.entries.map(attachmentText)).toEqual([
      restoredText(files.read, `1\tdisk ${files.read}`),
      restoredText(files.written, `1\tdisk ${files.written}`),
      restoredText(files.edited, `1\tdisk ${files.edited}`),
    ]);
    expect(restore.entries.every(isFileRestoreAttachment)).toBe(true);
    expect(restore.readFileStateEntries.map((restored) => restored.path)).toEqual([
      files.read,
      files.written,
      files.edited,
    ]);
    expect(readFileState.size).toBe(11);
  });

  it("reads range records as the whole current file and records full views", async () => {
    const file = `${root}/src/range.ts`;
    const readFileState = createState([
      entry(file, { content: "two", limit: 1, offset: 2, sourceTool: "Read" }),
    ]);

    const restore = await buildPostCompactFileRestore({
      readFiles: perFile(async (filePath) => textRead(filePath, "one\ntwo\nthree")),
      readFileState,
    });

    // 反例（旧投影实现）：range 记录按 offset/limit 投影缓存片段（`2\ttwo`）。
    expect(restore.entries.map(attachmentText)).toEqual([
      restoredText(file, "1\tone\n2\ttwo\n3\tthree"),
    ]);
    expect(restore.readFileStateEntries).toEqual([
      expect.objectContaining({
        content: "one\ntwo\nthree",
        isPartialView: false,
        path: file,
        sourceTool: "Read",
      }),
    ]);
  });

  it("uses the Read tool result text for the restored body", async () => {
    const file = `${root}/src/empty.ts`;
    const restore = await buildPostCompactFileRestore({
      readFiles: perFile(async (filePath) =>
        textRead(filePath, "", { numLines: 0, startLine: 1, totalLines: 0 }),
      ),
      readFileState: createState([entry(file, { sourceTool: "Read" })]),
    });

    expect(restore.entries.map(attachmentText)).toEqual([
      restoredText(
        file,
        "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
      ),
    ]);
  });

  it("skips files Read in the preserved segment unless that Read returned file_unchanged", async () => {
    const preservedFile = `${root}/src/preserved.ts`;
    const unchangedFile = `${root}/src/unchanged.ts`;
    const preservedEntries: RuntimeMessageEntry[] = [
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "read-preserved", input: { file_path: preservedFile }, name: "Read" },
            { id: "read-unchanged", input: { file_path: unchangedFile }, name: "Read" },
          ],
        },
      },
      {
        message: {
          role: "tool",
          content: "1\texport const preserved = 1;",
          toolCallId: "read-preserved",
          toolName: "Read",
        },
      },
      {
        message: {
          role: "tool",
          content: READ_FILE_UNCHANGED_STUB,
          toolCallId: "read-unchanged",
          toolName: "Read",
        },
      },
    ];
    const readFiles = vi.fn(perFile(async (filePath) => textRead(filePath, "current")));

    await buildPostCompactFileRestore({
      preservedEntries,
      readFiles,
      readFileState: createState([
        entry(preservedFile, { mtimeMs: 2, sourceTool: "Read" }),
        entry(unchangedFile, { mtimeMs: 1, sourceTool: "Read" }),
      ]),
    });

    // 保留段里 Read 过的文件已在上下文中不补回；file_unchanged 只指向已被摘要的旧结果，仍补回。
    expect(readFiles.mock.calls.map(([paths]) => paths)).toEqual([[unchangedFile]]);
  });

  it("selects the five newest records before reading and lets skipped files keep their slot", async () => {
    const live = (name: string, mtimeMs: number, readAtMs: number) =>
      entry(`${root}/src/${name}.ts`, { mtimeMs, readAt: new Date(readAtMs), sourceTool: "Read" });
    const readFileState = createState([
      live("oldest", 1, 900),
      live("missing", 60, 10),
      live("newest", 70, 10),
      // 冷恢复出的记录按读取时间排序，不看 mtimeMs。
      entry(`${root}/src/resumed.ts`, {
        mtimeMs: 1,
        readAt: new Date(65),
        restoredFromSession: true,
        sourceTool: "Read",
      }),
      // 缺 mtimeMs 时用读取时间。
      entry(`${root}/src/no-mtime.ts`, { readAt: new Date(50), sourceTool: "Edit" }),
      live("fifth", 40, 10),
      live("sixth", 30, 10),
    ]);
    const readFiles = vi.fn(
      perFile(
        async (filePath): Promise<PostCompactFileRead> =>
          filePath.endsWith("missing.ts") ? { type: "skipped" } : textRead(filePath, filePath),
      ),
    );

    const restore = await buildPostCompactFileRestore({ readFiles, readFileState });

    expect(readFiles.mock.calls.map(([paths]) => paths)).toEqual([
      [
        `${root}/src/newest.ts`,
        `${root}/src/resumed.ts`,
        `${root}/src/missing.ts`,
        `${root}/src/no-mtime.ts`,
        `${root}/src/fifth.ts`,
      ],
    ]);
    // 读取失败/跳过的文件照占名额（missing 不产生记录，sixth 没被选）。
    expect(restore.readFileStateEntries.map((restored) => restored.path)).toEqual([
      `${root}/src/newest.ts`,
      `${root}/src/resumed.ts`,
      `${root}/src/no-mtime.ts`,
      `${root}/src/fifth.ts`,
    ]);
  });

  it("references files over the per-file token cap and records them as partial views", async () => {
    const capped = `${root}/src/capped.ts`;
    const truncated = `${root}/src/truncated.ts`;
    const tooLarge = `${root}/src/too-large.ts`;
    const restore = await buildPostCompactFileRestore({
      maxFileTokens: 10,
      readFiles: perFile(async (filePath): Promise<PostCompactFileRead> => {
        if (filePath === capped) return textRead(filePath, "x".repeat(31));
        if (filePath === truncated) {
          return textRead(filePath, "short", { truncated: true, truncatedByTokenCap: true });
        }
        return { type: "too_large" };
      }),
      readFileState: createState([
        entry(capped, { mtimeMs: 3, sourceTool: "Read" }),
        entry(truncated, { mtimeMs: 2, sourceTool: "Read" }),
        entry(tooLarge, { mtimeMs: 1, sourceTool: "Read" }),
      ]),
    });

    // 单文件超限转引用提示；too_large 不写 read-state 记录。
    expect(restore.entries.map(attachmentText)).toEqual([
      referenceText(capped),
      referenceText(truncated),
      referenceText(tooLarge),
    ]);
    expect(
      restore.readFileStateEntries.map((restored) => [restored.path, restored.isPartialView]),
    ).toEqual([
      [capped, true],
      [truncated, true],
    ]);
  });

  it("drops files that exceed the total token budget without a note or a record", async () => {
    const first = `${root}/src/first.ts`;
    const dropped = `${root}/src/dropped.ts`;
    const small = `${root}/src/small.ts`;
    // 每个文件约 150 token（正文 100 token 加上调用说明），小文件约 50 token。
    const contents: Record<string, string> = {
      [first]: "a".repeat(300),
      [dropped]: "b".repeat(300),
      [small]: "c",
    };
    const restore = await buildPostCompactFileRestore({
      maxFileTokens: 150,
      maxTotalTokens: 250,
      readFiles: perFile(async (filePath) => textRead(filePath, contents[filePath] ?? "")),
      readFileState: createState([
        entry(first, { mtimeMs: 3, sourceTool: "Read" }),
        entry(dropped, { mtimeMs: 2, sourceTool: "Read" }),
        entry(small, { mtimeMs: 1, sourceTool: "Read" }),
      ]),
    });

    // 反例（旧投影实现）：总量超限也放引用提示；新语义静默丢弃且更小的后续文件仍可入选。
    const text = restore.entries.map(attachmentText).join("\n");
    expect(text).toContain(first);
    expect(text).not.toContain(dropped);
    expect(text).toContain(small);
    expect(restore.readFileStateEntries.map((restored) => restored.path)).toEqual([first, small]);
  });

  it("propagates reader failures", async () => {
    const file = `${root}/src/aborted.ts`;
    await expect(
      buildPostCompactFileRestore({
        readFiles: async () => {
          throw new Error("read aborted");
        },
        readFileState: createState([entry(file, { sourceTool: "Read" })]),
      }),
    ).rejects.toThrow("read aborted");
  });

  it("keeps the original requestedPath spelling on restored read-state records", async () => {
    const file = `${root}/src/requested.ts`;
    const restore = await buildPostCompactFileRestore({
      readFiles: perFile(async (filePath) => textRead(filePath, "content")),
      readFileState: createState([
        entry(file, { requestedPath: "src/requested.ts", sourceTool: "Read" }),
      ]),
    });

    // 写回的记录保留原始写法，下一次 compaction 仍按它判定 deny。
    expect(restore.readFileStateEntries).toEqual([
      expect.objectContaining({
        path: file,
        requestedPath: "src/requested.ts",
      }),
    ]);
  });
});

describe("post-compact file restore paths and read state", () => {
  // 修复原因（上游 a60ba6a7）：保留段里 Read 的 file_path 曾不解析就比较，模型用相对路径读过的
  // 文件匹配不上，会再补回一份。
  it("resolves preserved Read paths against the working directory before excluding them", async () => {
    const preservedFile = `${root}/src/relative.ts`;
    const readFiles = vi.fn(perFile(async (filePath) => textRead(filePath, "current")));

    await buildPostCompactFileRestore({
      preservedEntries: [
        {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "read-relative", input: { file_path: "src/relative.ts" }, name: "Read" },
            ],
          },
        },
      ],
      readFiles,
      readFileState: createState([entry(preservedFile, { sourceTool: "Read" })]),
      workingDirectory: root,
    });

    expect(readFiles).not.toHaveBeenCalled();
  });

  // 修复原因（上游 a60ba6a7）：补回记录曾按选择顺序（新到旧）写入，和「Map 遍历顺序即写入顺序」
  // 的约定相反。
  it("replaces the shared map in place and writes the newest restored file last", () => {
    const readFileState = createState([entry(`${root}/src/before.ts`, { sourceTool: "Read" })]);
    const shared = readFileState;
    const newest = entry(`${root}/src/newest.ts`, { sourceTool: "Read" });
    const oldest = entry(`${root}/src/oldest.ts`, { sourceTool: "Read" });

    replaceReadFileStateAfterCompact(readFileState, [newest, oldest]);

    // 原地替换执行器共享的同一个 Map 实例，顺序为最旧在前、最新在后。
    expect(readFileState).toBe(shared);
    expect([...readFileState.values()]).toEqual([oldest, newest]);
  });
});

describe("post-compact restore runtime binding", () => {
  const envFile = `${root}/.env`;
  const askFile = `${root}/ask-me.ts`;
  const instructionFile = `${root}/AGENTS.md`;
  const memoryFile = `${root}/memory/MEMORY.md`;

  function runtimeStub(options: {
    areReadsDeniedWithoutPrompt: (
      filePaths: readonly string[],
      traceContext: unknown,
    ) => Promise<boolean[]>;
    memoryRoot?: string;
  }) {
    const readFileState = createState([
      entry(envFile, { mtimeMs: 3, requestedPath: ".env", sourceTool: "Read" }),
      entry(askFile, { mtimeMs: 2, sourceTool: "Read" }),
      entry(instructionFile, { mtimeMs: 20, sourceTool: "Read" }),
      entry(memoryFile, { mtimeMs: 20, sourceTool: "Read" }),
    ]);
    return {
      contextSourceSnapshot: {
        userInstructions: { sources: [{ filePath: instructionFile, scope: "workspace" }] },
      },
      executor: { areReadsDeniedWithoutPrompt: options.areReadsDeniedWithoutPrompt },
      fileSystemPort: new MemoryFileSystem({
        [envFile]: "SECRET=1",
        [askFile]: "ask file content",
        [instructionFile]: "instruction content",
        [memoryFile]: "memory index",
      }),
      memoryRoot: options.memoryRoot ?? `${root}/memory`,
      readFileState,
      sessionId: "sess_post_compact_restore",
      workingDirectory: root,
      workspaceRoot: root,
    } as unknown as AgentRuntimeInternal;
  }

  // 修复原因（上游 a60ba6a7）：规则按原始字符串匹配，只用规范化后的绝对路径判定时，
  // `Read(.env)` 这类相对写法的 deny 规则拦不住补回。原始写法和规范化路径各判定一次。
  it("checks both the normalized path and the requested spelling for deny and skips denied files", async () => {
    const denyProbe = vi.fn(async (filePaths: readonly string[]) =>
      // 规则引擎语义：只有 `.env` 原始写法命中 deny；绝对路径形式不命中。
      filePaths.map((filePath) => filePath === ".env"),
    );
    const runtime = runtimeStub({ areReadsDeniedWithoutPrompt: denyProbe });

    const restore = await restorePostCompactFiles(runtime, {
      preservedEntries: [],
      traceContext: { traceId: "trace-post-compact-deny" } as never,
    });

    // deny 预检收到的是 [绝对路径, 原始写法] 展开后的列表；任一命中即跳过。
    // 指令文件与 MEMORY.md 在进入预检前就已被排除出候选。
    expect(denyProbe.mock.calls.map(([paths]) => paths)).toEqual([[envFile, ".env", askFile]]);
    expect(restore.entries.map(attachmentText).join("\n")).not.toContain(envFile);
    expect(restore.entries.map(attachmentText).join("\n")).toContain(askFile);
    expect(restore.readFileStateEntries.map((restored) => restored.path)).toEqual([askFile]);
  });

  it("keeps ask-rule files readable without a permission prompt blocking restore", async () => {
    const runtime = runtimeStub({
      areReadsDeniedWithoutPrompt: async () => [false, false, false, false],
    });

    const restore = await restorePostCompactFiles(runtime, {
      preservedEntries: [],
      traceContext: { traceId: "trace-post-compact-ask" } as never,
    });

    // ask 规则不算 deny：照常补回，不弹确认。
    expect(restore.entries.map(attachmentText).join("\n")).toContain(askFile);
  });

  it("excludes instruction files and the memory index from restore candidates", async () => {
    const denyProbe = vi.fn(async (filePaths: readonly string[]) => filePaths.map(() => false));
    const runtime = runtimeStub({ areReadsDeniedWithoutPrompt: denyProbe });

    await restorePostCompactFiles(runtime, {
      preservedEntries: [],
      traceContext: { traceId: "trace-post-compact-exclude" } as never,
    });

    // 上下文指令文件与 MEMORY.md 索引已在系统提示里，不进入候选（deny 预检也只见到其余文件）。
    expect(denyProbe.mock.calls.map(([paths]) => paths)).toEqual([[envFile, ".env", askFile]]);
  });
});

function perFile(
  read: (filePath: string) => Promise<PostCompactFileRead>,
): (filePaths: readonly string[]) => Promise<PostCompactFileRead[]> {
  return (filePaths) => Promise.all(filePaths.map(read));
}

function createState(entries: ReadFileStateEntry[]): ReadFileStateMap {
  const state: ReadFileStateMap = new Map();
  for (const item of entries) state.set(createReadFileStatePathKey(item.path), item);
  return state;
}

function entry(path: string, overrides: Partial<ReadFileStateEntry> = {}): ReadFileStateEntry {
  return {
    content: `cached ${path}`,
    isPartialView: false,
    path,
    readAt: new Date(1),
    ...overrides,
  };
}

function textRead(
  filePath: string,
  content: string,
  overrides: Partial<ReadTextOutput> = {},
): PostCompactFileRead {
  const lineCount = content.split("\n").length;
  const output: ReadTextOutput = {
    content,
    filePath,
    numLines: lineCount,
    startLine: 1,
    totalLines: lineCount,
    type: "text",
    ...overrides,
  };
  return {
    output,
    readFileStateEntry: {
      content,
      isPartialView: output.truncatedByTokenCap === true,
      mtimeMs: 1,
      path: filePath,
      readAt: new Date(2),
      revisionId: `rev:${filePath}`,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      sourceTool: "Read",
    },
    type: "text",
  };
}

function restoredText(filePath: string, body: string): string {
  return [
    `Called the Read tool with the following input: ${JSON.stringify({ file_path: filePath })}`,
    "Result of calling the Read tool:",
    body,
  ].join("\n");
}

function referenceText(filePath: string): string {
  return `Note: ${filePath} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`;
}

function attachmentText(entry: RuntimeMessageEntry): string {
  return "message" in entry ? String(entry.message.content) : entry.content;
}

function isFileRestoreAttachment(entry: RuntimeMessageEntry): boolean {
  return !("message" in entry) && entry.metadata.source === "resume_referenced_session_context";
}
