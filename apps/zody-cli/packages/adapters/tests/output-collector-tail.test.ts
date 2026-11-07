/**
 * F21 请求级尾部（`ExecutionOutputLimit.tailBytes` → `ExecutionStreamResult.tail`）。
 * 移植自上游 v3.17.1（commit a60ba6a7）；对应 spec：docs/execution-output-request-tail-spec.md。
 *
 * 钉住三件事：尾部与 inline 截断互不影响（inline 照常计数、truncated 照常置位、执行照常读到
 * 退出）；请求了就必带 `tail`（零输出为空串），未请求则字段不在场（老调用方结果形状不变）；
 * 尾部是纯内存旁路——不落盘、不扣盘预算（I16 输出目录行为不回归）。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NodeExecutionAdapter } from "../src/exec/index.js";
import { OutputCollector } from "../src/exec/output-collector.js";

function collector(options: { maxInlineBytes: number; requestedTailBytes?: number }) {
  return new OutputCollector({
    maxInlineBytes: options.maxInlineBytes,
    maxPersistedBytes: 0,
    legacyOutputEncoding: null,
    maxTailBytes: 0,
    persistOutput: "none",
    requestedTailBytes: options.requestedTailBytes,
  });
}

describe("OutputCollector — requested tail", () => {
  it("F21-T1: keeps the last n bytes across many chunks, independent of the inline cap", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 5 });
    for (const piece of ["abc", "defg", "", "hijklmnop", "q"]) out.append(Buffer.from(piece));
    const result = out.result();
    expect(result).toMatchObject({ text: "", bytes: 17, truncated: true, tail: "mnopq" });
  });

  it("returns the whole stream when it is shorter than n", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 64 });
    out.append(Buffer.from("short"));
    expect(out.result().tail).toBe("short");
  });

  it("F21-T2: cuts a single chunk larger than n and evicts whole leading blocks afterwards", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 3 });
    // 单 chunk 超预算：只保留该 chunk 末尾 n 字节。
    out.append(Buffer.from("0123456789"));
    expect(out.result().tail).toBe("789");
    // 后续 chunk 累积后队首整块出队，尾部恒 <= 预算且为最新字节。
    out.append(Buffer.from("ab"));
    expect(out.result().tail).toBe("9ab");
    out.append(Buffer.from("cdef"));
    expect(out.result().tail).toBe("def");
  });

  it("F21-T3: result() is idempotent and append never concatenates the whole tail", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 5 });
    // 摊还关键证据：append 阶段不复制既有尾部（无 Buffer.concat），复制只发生在 result() 结算。
    const concatSpy = vi.spyOn(Buffer, "concat");
    for (let round = 0; round < 200; round += 1) {
      out.append(Buffer.from(`chunk-${round};`));
    }
    const concatCallsDuringAppend = concatSpy.mock.calls.length;
    const first = out.result();
    const second = out.result();
    concatSpy.mockRestore();

    expect(concatCallsDuringAppend).toBe(0);
    expect(first.tail).toBe(second.tail);
    expect(first.bytes).toBe(second.bytes);
    // 流以 "chunk-199;" 结尾，最后 5 字节即尾部。
    expect(first.tail).toBe("-199;");
  });

  it("F21-T4: is an empty string for an empty stream or empty chunks when requested", () => {
    expect(collector({ maxInlineBytes: 0, requestedTailBytes: 8 }).result().tail).toBe("");
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 8 });
    out.append(Buffer.alloc(0));
    out.append(Buffer.from(""));
    const result = out.result();
    expect(result.tail).toBe("");
    expect("tail" in result).toBe(true);
  });

  it("F21-T5: leaves the result shape unchanged when no tail was requested", () => {
    for (const requestedTailBytes of [undefined, 0, -3]) {
      const out = collector({ maxInlineBytes: 16, requestedTailBytes });
      out.append(Buffer.from("hello"));
      const result = out.result();
      expect(result).not.toHaveProperty("tail");
      expect(result).toMatchObject({ text: "hello", bytes: 5, truncated: false });
    }
  });

  it("F21-T7: cuts on byte boundaries and decodes a partial leading rune as U+FFFD", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 2 });
    // "你" = E4 BD A0（3 字节）；预算 2 字节时从中间切开，首字符解出 U+FFFD 而不是抛错。
    out.append(Buffer.from("你"));
    const tail = out.result().tail;
    expect(typeof tail).toBe("string");
    expect(tail!.startsWith("\uFFFD")).toBe(true);
    expect(tail!.length).toBeGreaterThan(0);
  });
});

describe("NodeExecutionAdapter — requested tail", () => {
  it("F21-T6: runs a large-output process to exit with the tail of each stream kept separate", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-exec-tail-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    try {
      // 1 MiB 的 stdout 加尾标记、stderr 同理，然后非零退出：inline 为 0 时只能从 tail 拿到尾巴，
      // 两路各自持有尾部互不串。
      const script = [
        "process.stdout.write('x'.repeat(1024 * 1024) + 'OUT-END');",
        "process.stderr.write('y'.repeat(1024 * 1024) + 'ERR-END');",
        "process.exitCode = 3;",
      ].join("");
      const result = await adapter.run({
        command: { mode: "argv", file: process.execPath, args: ["-e", script] },
        outputLimit: { maxInlineBytes: 0, tailBytes: 7 },
      });
      expect(result.status).toBe("failed");
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toMatchObject({ text: "", truncated: true, tail: "OUT-END" });
      expect(result.stdout.bytes).toBe(1024 * 1024 + 7);
      expect(result.stderr).toMatchObject({ text: "", truncated: true, tail: "ERR-END" });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("F21-T8: requesting a tail does not create extra files or eat the persisted budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-exec-tail-persist-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    try {
      const result = await adapter.run({
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "process.stdout.write('abcdefghi')"],
        },
        outputLimit: {
          maxInlineBytes: 4,
          maxPersistedBytes: 8,
          persistOutput: "on_truncate",
          tailBytes: 5,
        },
        trace: {
          sessionId: "tail-persist-session",
          attributes: { toolCallId: "toolu_tail_persist" },
        } as any,
      });

      // inline 截断与写盘预算照常；tail 是旁路缓冲，不扣盘预算、不受 artifact 截断影响。
      expect(result.status).toBe("completed");
      expect(result.stdout).toMatchObject({
        text: "abcd",
        bytes: 9,
        truncated: true,
        artifactBytes: 8,
        artifactTruncated: true,
        tail: "efghi",
      });
      const toolCallDir = join(root, "tail-persist-session", "toolu_tail_persist");
      await expect(readFile(join(toolCallDir, "stdout.log"), "utf8")).resolves.toBe("abcdefgh");
      // 尾部不落盘：toolCall 目录里只有 inline 截断触发的 stdout 落盘文件，没有额外 tail 文件。
      await expect(readdir(toolCallDir)).resolves.toEqual(["stdout.log"]);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
