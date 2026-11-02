import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { ExecutionRequest, ExecutionShellSelection } from "@zcode/contracts";
import type { ZCodeToolExecResource } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { resolveWindowsGitBashShell } from "../src/exec/bash-shell-provider.js";
import type { ExecutionOutputPaths } from "../src/exec/execution-adapter-types.js";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import { shellInitSnapshotsDir } from "../src/exec/shell-init-snapshot.js";

describe("Bash 执行适配器资源生命周期", () => {
  it("真实 Bash 退出保留输出和 exit code，资源耗时从 spawn 起算", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-resource-"));
    const onToolExecResource = vi.fn();
    const adapter = new NodeExecutionAdapter({ outputRootDir: root, onToolExecResource });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const result = await adapter.run(
        {
          command: {
            mode: "shell",
            shellProfile: "posix-bash",
            shellOverride: shell,
            command: "echo telemetry-output && exit 7",
          },
          cwd: root,
        },
        {
          onEvent: (event) => {
            if (event.type === "started") now = 40000;
          },
        },
      );
      expect(result.stdout.text).toContain("telemetry-output");
      expect(result.exitCode).toBe(7);
      expect(onToolExecResource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ durationMs: 40000, exitKind: "completed", toolName: "bash" }),
      );
    } finally {
      vi.restoreAllMocks();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

const shell: ExecutionShellSelection =
  process.platform === "win32"
    ? {
        dialect: "cmd",
        path: process.env.ComSpec ?? "cmd.exe",
        display: { name: "CMD" },
        source: "user-config",
      }
    : { dialect: "posix", path: "/bin/bash", display: { name: "Bash" }, source: "user-config" };

// I16：bash-startup 只为 posix/git-bash 方言 materialize；win32 有 Git Bash 时用真实
// Bash 方言跑回落验收，没有时返回 undefined，由用例显式跳过（不静默放宽断言）。
const fallbackExecutionShell: ExecutionShellSelection | undefined =
  process.platform === "win32"
    ? (() => {
        const gitBash = resolveWindowsGitBashShell(process.env);
        return gitBash
          ? {
              dialect: "git-bash" as const,
              path: gitBash,
              display: { name: "Git Bash" },
              source: "user-config" as const,
            }
          : undefined;
      })()
    : shell;

async function gatedCommand(
  onToolExecResource: NonNullable<
    ConstructorParameters<typeof NodeExecutionAdapter>[0]
  >["onToolExecResource"],
) {
  const root = await mkdtemp(join(tmpdir(), "bash-resource-gated-"));
  const script = join(root, "command.cjs");
  const release = join(root, "release");
  await writeFile(
    script,
    `const fs = require('node:fs/promises');
process.stdout.write('ready\\n');
const timer = setInterval(async () => {
  try { await fs.access(process.env.PROBE_RELEASE); clearInterval(timer); }
  catch {}
}, 10);`,
  );
  const adapter = new NodeExecutionAdapter({ outputRootDir: root, onToolExecResource });
  const request: ExecutionRequest = {
    command: {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: shell,
      command: `"${process.execPath}" "${script}"`,
    },
    env: { set: { PROBE_RELEASE: release } },
    cwd: root,
    timeoutMs: 0,
  };
  return {
    adapter,
    request,
    release: () => writeFile(release, "done"),
    async close() {
      await writeFile(release, "done");
      await adapter.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

it.each(["timeout", "cancel", "output_limit", "signal"] as const)(
  "真实子进程退出分类：%s",
  async (kind) => {
    if (kind === "signal" && process.platform === "win32") return;
    const onToolExecResource = vi.fn();
    const fixture = await gatedCommand(onToolExecResource);
    const controller = new AbortController();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const result = await fixture.adapter.run(
        { ...fixture.request, timeoutMs: kind === "timeout" ? 100 : 0 },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type !== "started") return;
            now = 40000;
            if (kind === "cancel" || kind === "output_limit")
              controller.abort(kind === "output_limit" ? kind : undefined);
            if (kind === "signal" && event.pid) process.kill(event.pid, "SIGTERM");
          },
        },
      );
      expect(result.status).toBe(
        kind === "timeout" ? "timed_out" : kind === "signal" ? "failed" : "cancelled",
      );
      expect(onToolExecResource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          durationMs: 40000,
          exitKind: kind === "timeout" ? "timeout" : "killed",
        }),
      );
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  },
);

it.each(["explicit", "auto_on_timeout"] as const)(
  "前后台沿用同一命令，移交不发完成通知：%s",
  async (mode) => {
    const onToolExecResource = vi.fn();
    const fixture = await gatedCommand(onToolExecResource);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const outcome = await fixture.adapter.runBashWithBackgroundLifecycle(
        { ...fixture.request, timeoutMs: 20 },
        { mode },
      );
      expect(outcome.kind).toBe("backgrounded");
      expect(onToolExecResource).not.toHaveBeenCalled();
      now = 40000;
      await fixture.release();
      if (outcome.kind !== "backgrounded") throw new Error("expected background task");
      const done = await fixture.adapter.waitForBackgroundTask(outcome.task.taskId);
      expect(done?.result?.stdout.text).toContain("ready");
      expect(onToolExecResource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ durationMs: 40000, exitKind: "completed" }),
      );
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  },
);

it("运行时烟测：真实慢命令经平台探针产生非零 RSS，通知失败不影响输出", async () => {
  const onToolExecResource = vi.fn((_sample: ZCodeToolExecResource) => {
    throw new Error("telemetry sink closed");
  });
  const fixture = await gatedCommand(onToolExecResource);
  try {
    const running = fixture.adapter.run(fixture.request, {
      onEvent: (event) => {
        if (event.type === "started") setTimeout(() => void fixture.release(), 16500);
      },
    });
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toContain("ready");
    expect(onToolExecResource).toHaveBeenCalledTimes(1);
    const sample = onToolExecResource.mock.calls[0]?.[0];
    expect(sample.durationMs).toBeGreaterThanOrEqual(15000);
    if (process.platform !== "win32") {
      expect(sample.treeRssKbPeak).toBeGreaterThan(0);
      expect(sample.sampleCount).toBe(1);
    }
  } finally {
    await fixture.close();
  }
}, 25000);

const DAY_MS = 24 * 60 * 60 * 1000;

class OutputPathProbe extends NodeExecutionAdapter {
  pathsFor(request: ExecutionRequest) {
    return this.outputPathsForRequest(request);
  }

  // I16：输出根选择与路径派生是执行前的合同；直接暴露给测试可在不 spawn
  // 平台相关 shell 的前提下验证回落顺序与 close 清理。
  preparePathsFor(request: ExecutionRequest) {
    return this.prepareOutputPaths(request);
  }
}

/** I16：在命令准备阶段挂起，用于确定性验证“准备完成后、spawn 前”的取消窗口。 */
class GatedCommandPreparationAdapter extends OutputPathProbe {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  protected override async prepareChildSpawn(request: ExecutionRequest) {
    this.entered.resolve();
    await this.release.promise;
    return await super.prepareChildSpawn(request);
  }
}

/** I16：在输出根准备阶段挂起，用于验证并发 close() 会等待准备结束再删除临时根。 */
class GatedOutputPreparationAdapter extends OutputPathProbe {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  prepared?: ExecutionOutputPaths;

  protected override async prepareOutputPaths(request: ExecutionRequest) {
    this.entered.resolve();
    await this.release.promise;
    const paths = await super.prepareOutputPaths(request);
    this.prepared = paths;
    return paths;
  }
}

function bashRequest(
  root: string,
  input: {
    sessionId: string;
    toolCallId: string;
    command: string;
    persistOutput?: "none" | "always";
  },
): ExecutionRequest {
  return {
    command: {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: shell,
      command: input.command,
    },
    cwd: root,
    timeoutMs: 5_000,
    outputLimit: { persistOutput: input.persistOutput ?? "always" },
    trace: {
      sessionId: input.sessionId,
      attributes: { toolCallId: input.toolCallId },
    } as unknown as ExecutionRequest["trace"],
  };
}

async function writeBarrierScript(root: string): Promise<string> {
  const script = join(root, "barrier-writer.cjs");
  await writeFile(
    script,
    `const fs = require('node:fs');
fs.writeFileSync(process.env.PROBE_MARKER, 'ready');
const timer = setInterval(() => {
  if (!fs.existsSync(process.env.PROBE_PEER)) return;
  clearInterval(timer);
  process.stdout.write(process.env.PROBE_TEXT);
}, 10);`,
  );
  return script;
}

describe("Bash 隔离输出根（I16）", () => {
  it("同一 session 的并发执行使用独立 toolCall 目录且输出不串", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-isolation-"));
    const script = await writeBarrierScript(root);
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const command = `"${process.execPath}" "${script}"`;
    const run = (toolCallId: string, text: string) =>
      adapter.run({
        ...bashRequest(root, {
          sessionId: "shared-session",
          toolCallId,
          command,
        }),
        env: {
          set: {
            PROBE_MARKER: join(root, `${toolCallId}.ready`),
            PROBE_PEER: join(root, toolCallId === "call-a" ? "call-b.ready" : "call-a.ready"),
            PROBE_TEXT: text,
          },
        },
      });
    try {
      const [first, second] = await Promise.all([
        run("call-a", "alpha-only"),
        run("call-b", "beta-only"),
      ]);
      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      const firstPath = first.stdout.artifactPath;
      const secondPath = second.stdout.artifactPath;
      expect(firstPath).toBeTruthy();
      expect(secondPath).toBeTruthy();
      expect(dirname(firstPath!)).toBe(join(root, "shared-session", "call-a"));
      expect(dirname(secondPath!)).toBe(join(root, "shared-session", "call-b"));
      expect(await readFile(firstPath!, "utf8")).toBe("alpha-only");
      expect(await readFile(secondPath!, "utf8")).toBe("beta-only");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("配置根不可写时按顺序落到默认数据根，路径结构不变", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-fallback-default-"));
    const blockedRoot = join(root, "blocked-root");
    const storageRoot = join(root, "storage");
    await writeFile(blockedRoot, "not a directory");
    await mkdir(storageRoot);
    const adapter = new OutputPathProbe({
      outputRootDir: blockedRoot,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: storageRoot },
    });
    try {
      const request = bashRequest(root, {
        sessionId: "fallback-session",
        toolCallId: "fallback-call",
        command: "echo never",
      });
      const paths = await adapter.preparePathsFor(request);
      // 第二层回落：默认数据根 <ZCODE_STORAGE_DIR>/cli/exec，不与配置根混用。
      expect(paths.stdoutPersistedOutputPath).toBe(
        join(storageRoot, "cli", "exec", "fallback-session", "fallback-call", "stdout.log"),
      );
      // 同一请求重复准备（run 前、后台记录前）必须复用同一 toolCall 目录。
      await expect(adapter.preparePathsFor(request)).resolves.toEqual(paths);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("第二层默认数据根被选中时同样按 30 天清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-fallback-retention-"));
    const blockedRoot = join(root, "blocked-root");
    await writeFile(blockedRoot, "not a directory");
    const storageRoot = join(root, "storage");
    const staleFile = join(
      storageRoot,
      "cli",
      "exec",
      "retention-session",
      "old-call",
      "stdout.log",
    );
    const recentFile = join(
      storageRoot,
      "cli",
      "exec",
      "retention-session",
      "recent-call",
      "stdout.log",
    );
    await mkdir(dirname(staleFile), { recursive: true });
    await mkdir(dirname(recentFile), { recursive: true });
    await writeFile(staleFile, "old-output");
    await writeFile(recentFile, "recent-output");
    // I16：默认根同样是 shell 启动快照的写域，选中时必须一起按龄清理。
    const snapshotsDir = shellInitSnapshotsDir(join(storageRoot, "cli", "exec"));
    const staleSnapshot = join(snapshotsDir, "stale-shell.sh");
    const recentSnapshot = join(snapshotsDir, "recent-shell.sh");
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(staleSnapshot, "old-snapshot");
    await writeFile(recentSnapshot, "recent-snapshot");
    const oldDate = new Date(Date.now() - 31 * DAY_MS);
    await utimes(staleFile, oldDate, oldDate);
    await utimes(staleSnapshot, oldDate, oldDate);
    const adapter = new OutputPathProbe({
      outputRootDir: blockedRoot,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: storageRoot },
    });
    try {
      const paths = await adapter.preparePathsFor(
        bashRequest(root, {
          sessionId: "fallback-session",
          toolCallId: "fallback-call",
          command: "echo never",
        }),
      );
      expect(paths.stdoutPersistedOutputPath).toBe(
        join(storageRoot, "cli", "exec", "fallback-session", "fallback-call", "stdout.log"),
      );
      // 默认数据根是持久根，选中时异步扫描；close() 等待扫描结束。
      await adapter.close();
      await expect(stat(dirname(staleFile))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(recentFile, "utf8")).toBe("recent-output");
      await expect(stat(staleSnapshot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(recentSnapshot, "utf8")).toBe("recent-snapshot");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("前两层输出根都不可写时使用临时回落根，close 后清理回落目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-fallback-temp-"));
    const blockedRoot = join(root, "blocked-root");
    const blockedDefault = join(root, "blocked-default");
    await writeFile(blockedRoot, "not a directory");
    await writeFile(blockedDefault, "not a directory");
    const adapter = new OutputPathProbe({
      outputRootDir: blockedRoot,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: blockedDefault },
    });
    try {
      const paths = await adapter.preparePathsFor(
        bashRequest(root, {
          sessionId: "fallback-session",
          toolCallId: "fallback-call",
          command: "echo never",
        }),
      );
      const artifact = paths.stdoutPersistedOutputPath!;
      // 回落仍保持 <sessionId>/<toolCallId>/stdout.log 结构。
      expect(basename(artifact)).toBe("stdout.log");
      expect(basename(dirname(artifact))).toBe("fallback-call");
      expect(basename(dirname(dirname(artifact)))).toBe("fallback-session");
      const fallbackRoot = dirname(dirname(dirname(artifact)));
      expect(basename(fallbackRoot)).toMatch(/^zody-cli-exec-/u);
      expect(fallbackRoot.startsWith(root)).toBe(false);
      expect((await stat(fallbackRoot)).isDirectory()).toBe(true);
      await adapter.close();
      // 回落根是临时降级，close() 完成前删除。
      await expect(stat(fallbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  // 平台分支原因：本用例通过 embedded-search 启动脚本验证「bash-startup 与输出文件共用
  // 同一个实际回落根」。该脚本只在 posix/git-bash 方言下 materialize（embedded-search-prelude.ts
  // 的 buildEmbeddedSearchPreludeContent 对 cmd 返回 undefined，bash-startup-script.ts 的
  // supportsBashSourceScripts 同口径）。win32 有 Git Bash 时改用 git-bash 方言跑完整合同；
  // 没有 Git Bash 时无法生成启动脚本，显式跳过并由上方两个不依赖 shell 方言的
  // preparePathsFor 用例覆盖根选择顺序、回落路径结构与 close 清理。真实 Windows 命令执行
  // 证据在具备 Git Bash 的 Windows 环境运行本用例，不用路径 mock 冒充平台验收。
  it.skipIf(!fallbackExecutionShell)(
    "输出根不可写时回落到可写临时根并完成真实命令，close 后清理回落目录",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "bash-fallback-"));
      const blockedRoot = join(root, "blocked-root");
      const blockedDefault = join(root, "blocked-default");
      await writeFile(blockedRoot, "not a directory");
      await writeFile(blockedDefault, "not a directory");
      const script = join(root, "fallback-writer.cjs");
      await writeFile(script, "process.stdout.write('fallback-output')");
      const adapter = new NodeExecutionAdapter({
        outputRootDir: blockedRoot,
        processEnv: { ...process.env, ZCODE_STORAGE_DIR: blockedDefault },
      });
      try {
        const baseRequest = bashRequest(root, {
          sessionId: "fallback-session",
          toolCallId: "fallback-call",
          command: `"${process.execPath}" "${script}"`,
        });
        const result = await adapter.run({
          ...baseRequest,
          command: {
            ...baseRequest.command,
            shellOverride: fallbackExecutionShell!,
          },
          // I16-B：embedded search prelude 在 posix/git-bash 方言下会先 materialize 到
          // 输出根；回落必须同样作用于 bash-startup，否则配置根不可写仍会在 spawn 前失败。
          bashPrelude: {
            kind: "embedded-search",
            backend: { kind: "internal-cli", command: process.execPath, args: ["-e", ""] },
          },
        });
        expect(result.status).toBe("completed");
        expect(result.stdout.text).toBe("fallback-output");
        const artifact = result.stdout.artifactPath;
        expect(artifact).toBeTruthy();
        expect(artifact!.startsWith(blockedRoot)).toBe(false);
        expect(artifact!.startsWith(blockedDefault)).toBe(false);
        expect(basename(artifact!)).toBe("stdout.log");
        expect(basename(dirname(artifact!))).toBe("fallback-call");
        expect(basename(dirname(dirname(artifact!)))).toBe("fallback-session");
        expect(await readFile(artifact!, "utf8")).toBe("fallback-output");
        const fallbackRoot = dirname(dirname(dirname(artifact!)));
        // posix/git-bash 下启动脚本与输出文件必须共用回落根。
        const startupScripts = await readdir(
          join(fallbackRoot, "bash-startup", "fallback-session"),
        );
        expect(startupScripts.some((name) => name.endsWith(".sh"))).toBe(true);
        await adapter.close();
        await expect(stat(fallbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("三层输出根都不可用时 run/start/lifecycle 都按 spawn_error 结算", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-no-output-root-"));
    const blockedRoot = join(root, "blocked-root");
    const blockedDefault = join(root, "blocked-default");
    await writeFile(blockedRoot, "not a directory");
    await writeFile(blockedDefault, "not a directory");
    const missingTmp = join(root, "missing-tmp");
    const previousTmp = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    const adapter = new NodeExecutionAdapter({
      outputRootDir: blockedRoot,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: blockedDefault },
    });
    // os.tmpdir() 每次调用读取环境变量；指向不存在目录即可让 mkdtemp 失败。
    process.env.TMPDIR = missingTmp;
    process.env.TEMP = missingTmp;
    process.env.TMP = missingTmp;
    try {
      const result = await adapter.run(
        bashRequest(root, {
          sessionId: "no-root-session",
          toolCallId: "no-root-call",
          command: "echo never",
        }),
      );
      expect(result.status).toBe("spawn_error");
      expect(result.error?.type).toBe("spawn_error");

      const task = await adapter.start(
        bashRequest(root, {
          sessionId: "no-root-session",
          toolCallId: "no-root-bg",
          command: "echo never",
        }),
      );
      await expect(adapter.waitForBackgroundTask(task.taskId)).resolves.toMatchObject({
        status: "spawn_error",
        error: { type: "spawn_error" },
      });
      await expect(
        adapter.readBackgroundBashOutput(task.taskId, "no-root-session"),
      ).resolves.toEqual({ kind: "unavailable", workId: task.taskId });

      const lifecycle = await adapter.runBashWithBackgroundLifecycle(
        bashRequest(root, {
          sessionId: "no-root-session",
          toolCallId: "no-root-lifecycle",
          command: "echo never",
        }),
        { mode: "auto_on_timeout" },
      );
      expect(lifecycle).toMatchObject({ kind: "foreground", result: { status: "spawn_error" } });
    } finally {
      for (const key of ["TMPDIR", "TEMP", "TMP"] as const) {
        if (previousTmp[key] === undefined) delete process.env[key];
        else process.env[key] = previousTmp[key];
      }
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("spawn 失败不留下 toolCall 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-spawn-failure-"));
    const adapter = new OutputPathProbe({ outputRootDir: root });
    try {
      const failed = bashRequest(root, {
        sessionId: "probe-session",
        toolCallId: "spawn-failure",
        command: "echo never",
      });
      // source 必须是非 user-config：user-config 选择在 posix 上会重新自动探测 shell，
      // 只有 runtime 已解析的具体路径（auto-detected）才会按原样 spawn 并触发 ENOENT。
      failed.command = {
        ...failed.command,
        shellOverride: {
          ...shell,
          path: join(root, "missing-shell"),
          source: "auto-detected",
        },
      } as ExecutionRequest["command"];
      expect(adapter.pathsFor(failed).stdoutPersistedOutputPath).toBe(
        join(root, "probe-session", "spawn-failure", "stdout.log"),
      );
      const failedResult = await adapter.run(failed);
      expect(failedResult.status).toBe("spawn_error");
      await expect(stat(join(root, "probe-session", "spawn-failure"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("通用 pipe 后台任务 spawn 失败时清理本次预创建的空输出", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-pipe-spawn-failure-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    try {
      const request: ExecutionRequest = {
        command: { mode: "argv", file: join(root, "missing-executable") },
        cwd: root,
        timeoutMs: 5_000,
        outputLimit: { persistOutput: "always" },
        trace: {
          sessionId: "pipe-session",
          attributes: { toolCallId: "pipe-call" },
        } as unknown as ExecutionRequest["trace"],
      };
      const task = await adapter.start(request);
      await expect(adapter.waitForBackgroundTask(task.taskId)).resolves.toMatchObject({
        status: "spawn_error",
        error: { type: "spawn_error" },
      });
      // I16-C：通用 pipe 的后台记录会预创建 stdout/stderr；spawn 失败时只删除本次新建的
      // 空文件，不能把空 toolCall 目录留给后续按龄清理。
      await expect(stat(join(root, "pipe-session", "pipe-call"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("命令准备完成后取消不再 spawn，也不留下 toolCall 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-prepare-cancel-"));
    const marker = join(root, "spawned.marker");
    const script = join(root, "marker-writer.cjs");
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
    );
    const adapter = new GatedCommandPreparationAdapter({ outputRootDir: root });
    const controller = new AbortController();
    try {
      const pending = adapter.run(
        bashRequest(root, {
          sessionId: "probe-session",
          toolCallId: "prepare-cancel",
          command: `"${process.execPath}" "${script}"`,
        }),
        { signal: controller.signal },
      );
      // 取消发生在输出根准备之后、命令准备挂起期间；不能再用已 abort 的 signal 让 run()
      // 在入口直接返回（那样 prepare/discard 分支根本没有执行）。
      await adapter.entered.promise;
      controller.abort();
      adapter.release.resolve();
      const result = await pending;
      expect(result.status).toBe("cancelled");
      // 命令从未启动，也没有创建 toolCall 输出目录。
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, "probe-session", "prepare-cancel"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      adapter.release.resolve();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("close 等待 start 的输出准备结束后再删除临时回落根", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-close-preparation-"));
    const blockedRoot = join(root, "blocked-root");
    const blockedDefault = join(root, "blocked-default");
    await writeFile(blockedRoot, "not a directory");
    await writeFile(blockedDefault, "not a directory");
    const adapter = new GatedOutputPreparationAdapter({
      outputRootDir: blockedRoot,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: blockedDefault },
    });
    try {
      const starting = adapter.start(
        bashRequest(root, {
          sessionId: "close-race-session",
          toolCallId: "close-race-call",
          command: "echo never",
        }),
      );
      await adapter.entered.promise;
      const closing = adapter.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      // 输出准备被挂起时 close() 必须等待；否则临时根会在 close 之后才创建并残留。
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe(false);
      adapter.release.resolve();
      // close() 期间不再启动新执行；准备创建出来的临时根必须由 shutdown 删除。
      await expect(starting).rejects.toThrow("shutting down");
      await closing;
      const artifact = adapter.prepared?.stdoutPersistedOutputPath;
      expect(artifact).toBeTruthy();
      const fallbackRoot = dirname(dirname(dirname(artifact!)));
      expect(basename(fallbackRoot)).toMatch(/^zody-cli-exec-/u);
      await expect(stat(fallbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      adapter.release.resolve();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("close 等待 lifecycle 的输出准备结束并按取消结算，临时根不残留", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-close-lifecycle-preparation-"));
    const blockedRoot = join(root, "blocked-root");
    const blockedDefault = join(root, "blocked-default");
    await writeFile(blockedRoot, "not a directory");
    await writeFile(blockedDefault, "not a directory");
    const adapter = new GatedOutputPreparationAdapter({
      outputRootDir: blockedRoot,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: blockedDefault },
    });
    try {
      const pending = adapter.runBashWithBackgroundLifecycle(
        bashRequest(root, {
          sessionId: "close-lifecycle-session",
          toolCallId: "close-lifecycle-call",
          command: "echo never",
        }),
        { mode: "explicit" },
      );
      await adapter.entered.promise;
      const closing = adapter.close();
      adapter.release.resolve();
      // close() 期间准备完成也不再启动执行；按取消结算而不是挂起或报错。
      await expect(pending).resolves.toMatchObject({
        kind: "foreground",
        result: { status: "cancelled" },
      });
      await closing;
      const artifact = adapter.prepared?.stdoutPersistedOutputPath;
      expect(artifact).toBeTruthy();
      const fallbackRoot = dirname(dirname(dirname(artifact!)));
      expect(basename(fallbackRoot)).toMatch(/^zody-cli-exec-/u);
      await expect(stat(fallbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      adapter.release.resolve();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("前台未保留输出时结算后清理空的 toolCall 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-foreground-cleanup-"));
    const adapter = new OutputPathProbe({ outputRootDir: root });
    const script = join(root, "transient-writer.cjs");
    await writeFile(script, "process.stdout.write('transient')");
    const request = bashRequest(root, {
      sessionId: "foreground-session",
      toolCallId: "transient-call",
      command: `"${process.execPath}" "${script}"`,
      persistOutput: "none",
    });
    try {
      expect(adapter.pathsFor(request).stdoutPersistedOutputPath).toBe(
        join(root, "foreground-session", "transient-call", "stdout.log"),
      );
      const result = await adapter.run(request);
      expect(result.status).toBe("completed");
      expect(result.stdout.text).toBe("transient");
      expect(result.stdout.artifactPath).toBeUndefined();
      await expect(stat(join(root, "foreground-session", "transient-call"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("构造时清理 30 天前的输出并保留近期文件与符号链接目标", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-retention-"));
    const oldFile = join(root, "retention-session", "old-call", "stdout.log");
    const recentFile = join(root, "retention-session", "recent-call", "stdout.log");
    const legacyFile = join(root, "retention-session", "legacy-call-stdout.log");
    const existingEmptyDir = join(root, "retention-session", "empty-call");
    const existingEmptySession = join(root, "empty-session");
    await mkdir(dirname(oldFile), { recursive: true });
    await mkdir(dirname(recentFile), { recursive: true });
    await mkdir(dirname(legacyFile), { recursive: true });
    await mkdir(existingEmptyDir);
    await mkdir(existingEmptySession);
    await writeFile(oldFile, "old-output");
    await writeFile(recentFile, "recent-output");
    await writeFile(legacyFile, "legacy-output");
    const oldDate = new Date(Date.now() - 31 * DAY_MS);
    await utimes(oldFile, oldDate, oldDate);
    await utimes(legacyFile, oldDate, oldDate);

    const outside = join(root, "outside-target.txt");
    await writeFile(outside, "outside");
    const linkDir = join(root, "retention-session", "link-call");
    const linkFile = join(linkDir, "stdout.log");
    if (process.platform !== "win32") {
      await mkdir(linkDir, { recursive: true });
      await symlink(outside, linkFile);
      await utimes(outside, oldDate, oldDate);
    }

    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    try {
      await adapter.close();
      await expect(stat(oldFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(dirname(oldFile))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(legacyFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(recentFile, "utf8")).toBe("recent-output");
      // 原本就为空的目录不是“因此变空”，扫描不得删除，避免与并发创建竞态。
      expect((await stat(existingEmptyDir)).isDirectory()).toBe(true);
      expect((await stat(existingEmptySession)).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(await readFile(outside, "utf8")).toBe("outside");
        expect((await lstat(linkFile)).isSymbolicLink()).toBe(true);
      }
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("后台查询从 toolCall 隔离目录读取并返回同一路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-background-query-"));
    const script = join(root, "background-writer.cjs");
    await writeFile(script, "process.stdout.write('background-output')");
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    try {
      const task = await adapter.start(
        bashRequest(root, {
          sessionId: "background-session",
          toolCallId: "background-call",
          command: `"${process.execPath}" "${script}"`,
        }),
      );
      await adapter.waitForBackgroundTask(task.taskId);
      const expectedPath = join(root, "background-session", "background-call", "stdout.log");
      expect(task.stdoutPersistedOutputPath).toBe(expectedPath);
      const read = await adapter.readBackgroundBashOutput(task.taskId, "background-session");
      expect(read).toMatchObject({
        kind: "output",
        status: "completed",
        output: "background-output",
      });
      if (read.kind === "output") expect(read.outputPath).toBe(expectedPath);
      expect(await readFile(expectedPath, "utf8")).toBe("background-output");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("同一 session 的并发后台任务分别命中各自的 toolCall 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-background-isolation-"));
    const script = await writeBarrierScript(root);
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const command = `"${process.execPath}" "${script}"`;
    const start = (toolCallId: string, text: string) =>
      adapter.start({
        ...bashRequest(root, {
          sessionId: "shared-background-session",
          toolCallId,
          command,
        }),
        env: {
          set: {
            PROBE_MARKER: join(root, `${toolCallId}.ready`),
            PROBE_PEER: join(root, toolCallId === "bg-a" ? "bg-b.ready" : "bg-a.ready"),
            PROBE_TEXT: text,
          },
        },
      });
    try {
      const [first, second] = await Promise.all([
        start("bg-a", "alpha-bg"),
        start("bg-b", "beta-bg"),
      ]);
      await Promise.all([
        adapter.waitForBackgroundTask(first.taskId),
        adapter.waitForBackgroundTask(second.taskId),
      ]);
      const firstPath = join(root, "shared-background-session", "bg-a", "stdout.log");
      const secondPath = join(root, "shared-background-session", "bg-b", "stdout.log");
      expect(first.stdoutPersistedOutputPath).toBe(firstPath);
      expect(second.stdoutPersistedOutputPath).toBe(secondPath);
      const firstRead = await adapter.readBackgroundBashOutput(
        first.taskId,
        "shared-background-session",
      );
      const secondRead = await adapter.readBackgroundBashOutput(
        second.taskId,
        "shared-background-session",
      );
      expect(firstRead).toMatchObject({ kind: "output", status: "completed", output: "alpha-bg" });
      expect(secondRead).toMatchObject({ kind: "output", status: "completed", output: "beta-bg" });
      if (firstRead.kind === "output") expect(firstRead.outputPath).toBe(firstPath);
      if (secondRead.kind === "output") expect(secondRead.outputPath).toBe(secondPath);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("close 后同进程仍可查询，新 adapter 对旧 workId 返回 unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-close-query-"));
    const script = join(root, "close-query-writer.cjs");
    await writeFile(script, "process.stdout.write('close-query-output')");
    const sessionId = "close-query-session";
    const outputPath = join(root, sessionId, "close-query-call", "stdout.log");
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const task = await adapter.start(
      bashRequest(root, {
        sessionId,
        toolCallId: "close-query-call",
        command: `"${process.execPath}" "${script}"`,
      }),
    );
    await adapter.waitForBackgroundTask(task.taskId);
    try {
      await adapter.close();
      // I16-E：close 不删除主根已产生的输出，同进程终态查询继续按记录路径尾读。
      expect(await readFile(outputPath, "utf8")).toBe("close-query-output");
      await expect(adapter.readBackgroundBashOutput(task.taskId, sessionId)).resolves.toMatchObject(
        {
          kind: "output",
          status: "completed",
          output: "close-query-output",
          outputPath,
        },
      );

      // 新 adapter 没有旧 workId 记录：返回 unavailable，且不 cold resume；历史完整路径仍可打开。
      const restarted = new NodeExecutionAdapter({ outputRootDir: root });
      try {
        await expect(restarted.readBackgroundBashOutput(task.taskId, sessionId)).resolves.toEqual({
          kind: "unavailable",
          workId: task.taskId,
        });
        await expect(restarted.getBackgroundTask(task.taskId)).resolves.toBeUndefined();
        expect(await readFile(outputPath, "utf8")).toBe("close-query-output");
      } finally {
        await restarted.close();
      }
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("临时回落根在 close 前可查询，close 后明确报错", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-temp-query-"));
    const blockedRoot = join(root, "blocked-root");
    const blockedDefault = join(root, "blocked-default");
    await writeFile(blockedRoot, "not a directory");
    await writeFile(blockedDefault, "not a directory");
    const script = join(root, "temp-query-writer.cjs");
    await writeFile(script, "process.stdout.write('temp-query-output')");
    const adapter = new NodeExecutionAdapter({
      outputRootDir: blockedRoot,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: blockedDefault },
    });
    const sessionId = "temp-query-session";
    try {
      const task = await adapter.start(
        bashRequest(root, {
          sessionId,
          toolCallId: "temp-query-call",
          command: `"${process.execPath}" "${script}"`,
        }),
      );
      await adapter.waitForBackgroundTask(task.taskId);
      const artifact = task.stdoutPersistedOutputPath!;
      const fallbackRoot = dirname(dirname(dirname(artifact)));
      expect(basename(fallbackRoot)).toMatch(/^zody-cli-exec-/u);
      // I16-E：第三层临时根在 close 前与持久根查询语义一致。
      await expect(adapter.readBackgroundBashOutput(task.taskId, sessionId)).resolves.toMatchObject(
        {
          kind: "output",
          status: "completed",
          output: "temp-query-output",
          outputPath: artifact,
        },
      );
      await adapter.close();
      // close() 删除临时根后，查询按记录路径明确返回 read_failed，不回退到其它路径。
      await expect(adapter.readBackgroundBashOutput(task.taskId, sessionId)).resolves.toEqual({
        kind: "read_failed",
        workId: task.taskId,
        code: "ENOENT",
      });
      await expect(stat(fallbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("session/toolCall 段的 `.`/`..` 不会逃出输出根", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-path-traversal-"));
    const adapter = new OutputPathProbe({ outputRootDir: root });
    const request = bashRequest(root, {
      sessionId: "..",
      toolCallId: "..",
      command: `"${process.execPath}" -e "process.stdout.write('traversal-ok')"`,
    });
    try {
      const outputPath = adapter.pathsFor(request).stdoutPersistedOutputPath!;
      // 两段都被替换为占位名，路径仍位于 root 下且不含 `..` 段。
      expect(outputPath).toBe(join(root, "unknown", "unknown", "stdout.log"));
      expect(outputPath.startsWith(`${root}${sep}`)).toBe(true);
      expect(relative(root, outputPath).split(sep)).not.toContain("..");
      const result = await adapter.run(request);
      expect(result.status).toBe("completed");
      expect(result.stdout.artifactPath).toBe(outputPath);
      expect(await readFile(outputPath, "utf8")).toBe("traversal-ok");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
