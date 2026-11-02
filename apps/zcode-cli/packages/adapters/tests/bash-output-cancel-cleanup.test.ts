import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRequest, ExecutionShellSelection } from "@zcode/contracts";

const { openSpy, gate } = vi.hoisted(() => ({
  openSpy: vi.fn(),
  gate: {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  openSpy.mockImplementation((async (path: string, flags: string | number, mode?: number) => {
    // 只挂起本次用例的输出文件打开；adapter 的可写探针/其它文件保持即时。
    if (String(path).endsWith("stdout.log")) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    return await actual.open(path, flags, mode);
  }) as unknown as typeof actual.open);
  return { ...actual, open: openSpy };
});

import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";

const shell: ExecutionShellSelection =
  process.platform === "win32"
    ? {
        dialect: "cmd",
        path: process.env.ComSpec ?? "cmd.exe",
        display: { name: "CMD" },
        source: "user-config",
      }
    : { dialect: "posix", path: "/bin/bash", display: { name: "Bash" }, source: "user-config" };

afterEach(() => {
  // 失败路径也要释放挂起的 open，避免测试进程泄漏句柄。
  gate.release.resolve();
  vi.clearAllMocks();
});

describe("Bash 输出取消清理（I16-C）", () => {
  it("取消发生在输出文件打开后、spawn 前：discard 删除文件与空 toolCall 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-cancel-discard-"));
    const marker = join(root, "spawned.marker");
    const script = join(root, "marker-writer.cjs");
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
    );
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const controller = new AbortController();
    const request: ExecutionRequest = {
      command: {
        mode: "shell",
        shellProfile: "posix-bash",
        shellOverride: shell,
        command: `"${process.execPath}" "${script}"`,
      },
      cwd: root,
      timeoutMs: 5_000,
      outputLimit: { persistOutput: "always" },
      trace: {
        sessionId: "cancel-session",
        attributes: { toolCallId: "cancel-call" },
      },
    };
    try {
      const pending = adapter.run(request, { signal: controller.signal });
      // 等 BashFileOutput.prepare() 真正打开 stdout.log 后再取消：
      // 这样覆盖 run() 的 stoppedAfterOutputPreparation → file.discard() 分支，
      // 而不是在入口用已 abort 的 signal 直接返回 cancelled。
      await gate.entered.promise;
      controller.abort();
      gate.release.resolve();
      const result = await pending;
      expect(result.status).toBe("cancelled");
      // 取消发生在 spawn 之前，命令从未启动。
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      // discard 必须删除本次创建但未保留的输出文件，并清理因此变空的 toolCall 目录。
      await expect(stat(join(root, "cancel-session", "cancel-call"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      gate.release.resolve();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
