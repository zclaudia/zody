import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_RUNTIME_ENV_KEY,
  hostResponseMessageSchema,
} from "@zody/shared";
import {
  ZCODE_PROCESS_DIAGNOSTIC_PREFIX,
  ZCODE_AGENT_LIFECYCLE_LOG_MARKER,
} from "@zody/shared/process-diagnostic";
import {
  buildE2EAgentCoverageEnv,
  createZCodeAgentCommandResolver,
  resolveDefaultZCodeAgentCommand,
  resolveZCodeAgentNativeRuntimeCommand,
  validateZCodeAgentNativeRuntimeConfig,
  wrapZCodeAgentCommandWithStdioTapDevProxy,
  ZCodeAgentProcessManager,
  type ZCodeAgentCommand,
} from "../src/zody-agent/zcodeAgentProcessManager.js";
import { setDataBaseDir } from "../src/paths.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeProcessExceptionEvent,
} from "../src/process/runtimeProcessLifecycle.js";
import { setZCodeStdioTapDevEnabled } from "../src/zody-agent/zcodeStdioTapDevConfig.js";
import { ZCodeStdioTransport } from "../src/zody-agent/zcodeStdioTransport.js";
import { CuaAgentAdmissionGate } from "../src/cua-permission-broker/cuaAgentAdmissionGate.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("E2E agent coverage", () => {
  it("在 CLI bundle 解析前安装 coverage signal preload", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "zcode-agent-coverage-"));
    try {
      const env = buildE2EAgentCoverageEnv({
        NODE_OPTIONS: "--trace-warnings",
        ZCODE_E2E_ARTIFACT_DIR: artifactDir,
        ZCODE_E2E_COVERAGE: "1",
      });
      const preloadPath = join(
        artifactDir,
        "coverage",
        "raw",
        "cli",
        "zcode-e2e-coverage-preload.cjs",
      );

      expect(env).toEqual({
        NODE_OPTIONS: `--trace-warnings --require=${JSON.stringify(preloadPath)}`,
        NODE_V8_COVERAGE: dirname(preloadPath),
      });
      expect(readFileSync(preloadPath, "utf8")).toContain("takeCoverage");
      expect(readFileSync(preloadPath, "utf8")).toContain("coverage-ready-");
      expect(readFileSync(preloadPath, "utf8")).toContain("coverageFlushStarted");
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});

describe("resolveZCodeAgentNativeRuntimeCommand", () => {
  const context = { workspacePath: "/repo/workspace", workspaceKey: "/repo/workspace" };

  it("uses the fixed native launcher argv and fd6/7 protocol streams", () => {
    const command = resolveZCodeAgentNativeRuntimeCommand(
      {
        launcherPath: "/opt/zody/native/zody-native",
        env: { CUSTOM_ENV: "1" },
      },
      context,
    );
    expect(command.command).toBe("/opt/zody/native/zody-native");
    expect(command.args).toEqual([
      "--launch-session",
      "--entry-name",
      "cli-entry.mjs",
      "--cli-in-fd",
      "6",
      "--cli-out-fd",
      "7",
    ]);
    expect(command.env).toEqual({ CUSTOM_ENV: "1" });
    expect(command.nativeLauncher).toBe(true);
    expect(command.supportsStorageStartup).toBe(false);
    expect(command.stdioIndexes).toEqual({ stdin: 6, stdout: 7, stderr: 2 });
    expect(command.stdio).toEqual([
      "ignore",
      "ignore",
      "pipe",
      "ignore",
      "ignore",
      "ignore",
      "pipe",
      "pipe",
    ]);
  });

  it("rejects relative launchers, wrong entries, env Node mode, and duplicate fds", () => {
    expect(() =>
      validateZCodeAgentNativeRuntimeConfig({ launcherPath: "zody-native" }),
    ).toThrow(/absolute path/);
    expect(() =>
      validateZCodeAgentNativeRuntimeConfig({
        launcherPath: "/opt/zody/native/zody-native",
        entryName: "other.mjs" as never,
      }),
    ).toThrow(/native entry/);
    expect(() =>
      validateZCodeAgentNativeRuntimeConfig({
        launcherPath: "/opt/zody/native/zody-native",
        env: { ELECTRON_RUN_AS_NODE: "1" },
      }),
    ).toThrow(/ELECTRON_RUN_AS_NODE/);
    expect(() =>
      validateZCodeAgentNativeRuntimeConfig({
        launcherPath: "/opt/zody/native/zody-native",
        cliInFd: 6,
        cliOutFd: 6,
      }),
    ).toThrow(/must differ/);
    expect(() =>
      validateZCodeAgentNativeRuntimeConfig({
        launcherPath: "/opt/zody/native/zody-native",
        launchMode: "other" as never,
      }),
    ).toThrow(/launchMode/);
  });

  it("appends the workspace relay flag only for the explicit relay mode", () => {
    const direct = resolveZCodeAgentNativeRuntimeCommand(
      { launcherPath: "/opt/zody/native/zody-native", launchMode: "direct" },
      context,
    );
    expect(direct.args?.at(-1)).toBe("7");
    const relay = resolveZCodeAgentNativeRuntimeCommand(
      { launcherPath: "/opt/zody/native/zody-native", launchMode: "workspace-relay" },
      context,
    );
    expect(relay.args).toEqual([
      "--launch-session",
      "--entry-name",
      "cli-entry.mjs",
      "--cli-in-fd",
      "6",
      "--cli-out-fd",
      "7",
      "--launch-via-workspace",
    ]);
  });

  it("wins over PATH/env command discovery and is never wrapped by stdio tap", () => {
    const previous = process.env.ZCODE_AGENT_SERVER_COMMAND;
    process.env.ZCODE_AGENT_SERVER_COMMAND = "/tmp/attacker-cli";
    try {
      const nativeConfig = { launcherPath: "/opt/zody/native/zody-native" };
      const command = resolveDefaultZCodeAgentCommand(context, { nativeRuntime: nativeConfig });
      expect(command?.command).toBe("/opt/zody/native/zody-native");
      expect(command?.nativeLauncher).toBe(true);
      expect(wrapZCodeAgentCommandWithStdioTapDevProxy(command!, context.workspaceKey)).toBe(
        command,
      );
    } finally {
      if (previous === undefined) delete process.env.ZCODE_AGENT_SERVER_COMMAND;
      else process.env.ZCODE_AGENT_SERVER_COMMAND = previous;
    }
  });
});

describe("createZCodeAgentCommandResolver", () => {
  const context = { workspacePath: "/repo/workspace", workspaceKey: "/repo/workspace" };

  it("uses the selective native runtime only for the workspace it accepts", async () => {
    const nativeRuntimeResolver = vi.fn((resolverContext: { workspacePath: string }) =>
      resolverContext.workspacePath === context.workspacePath
        ? { launcherPath: "/opt/zody/native/zody-native", launchMode: "workspace-relay" as const }
        : null,
    );
    const fallbackResolver = vi.fn(() => ({ command: "/opt/zody/bin/zcode" }));
    const resolver = createZCodeAgentCommandResolver({
      commandResolver: fallbackResolver,
      nativeRuntimeResolver,
    });

    await expect(resolver(context)).resolves.toMatchObject({
      command: "/opt/zody/native/zody-native",
      nativeLauncher: true,
      args: expect.arrayContaining(["--launch-via-workspace"]),
    });
    expect(fallbackResolver).not.toHaveBeenCalled();

    await expect(
      resolver({ workspacePath: "/repo/other", workspaceKey: "/repo/other" }),
    ).resolves.toEqual({ command: "/opt/zody/bin/zcode" });
    expect(fallbackResolver).toHaveBeenCalledTimes(1);
  });

  it("keeps the original resolver intact when the selective resolver declines", async () => {
    const fallbackResolver = vi.fn(() => ({ command: "/opt/zody/bin/zcode" }));
    const resolver = createZCodeAgentCommandResolver({
      commandResolver: fallbackResolver,
      nativeRuntimeResolver: () => null,
    });

    await expect(resolver(context)).resolves.toEqual({ command: "/opt/zody/bin/zcode" });
    expect(fallbackResolver).toHaveBeenCalledWith(context);
  });

  it("keeps the explicit native runtime override as the highest-priority composition", async () => {
    const nativeRuntimeResolver = vi.fn(() => null);
    const fallbackResolver = vi.fn(() => ({ command: "/opt/zody/bin/zcode" }));
    const resolver = createZCodeAgentCommandResolver({
      nativeRuntime: { launcherPath: "/opt/zody/native/zody-native" },
      nativeRuntimeResolver,
      commandResolver: fallbackResolver,
    });

    expect(await resolver(context)).toMatchObject({
      command: "/opt/zody/native/zody-native",
      nativeLauncher: true,
    });
    expect(nativeRuntimeResolver).not.toHaveBeenCalled();
    expect(fallbackResolver).not.toHaveBeenCalled();
  });

  it("applies the selective resolver only to the chat/main lane", async () => {
    const nativeRuntimeResolver = vi.fn(() => ({
      launcherPath: "/opt/zody/native/zody-native",
      launchMode: "workspace-relay" as const,
    }));
    const fallbackResolver = vi.fn(() => ({ command: "/opt/zody/bin/zcode" }));

    await expect(
      createZCodeAgentCommandResolver({
        commandResolver: fallbackResolver,
        nativeRuntimeResolver,
      })(context),
    ).resolves.toMatchObject({ nativeLauncher: true });
    expect(nativeRuntimeResolver).toHaveBeenCalledTimes(1);

    for (const lane of ["mcp-status", "plugin", "background"]) {
      const resolver = createZCodeAgentCommandResolver({
        commandResolver: fallbackResolver,
        nativeRuntimeResolver,
        lane,
      });
      await expect(await resolver(context)).toEqual({ command: "/opt/zody/bin/zcode" });
    }
    expect(nativeRuntimeResolver).toHaveBeenCalledTimes(1);
    expect(fallbackResolver).toHaveBeenCalledTimes(3);
  });
});

describe("selective native runtime spawn", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const root of roots.splice(0).reverse()) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), `zcode-agent-selective-${prefix}-`));
    roots.push(root);
    return root;
  }

  function createNativeLauncher(root: string, markerName: string) {
    const launcherPath = join(root, "native-launcher.sh");
    const markerPath = join(root, markerName);
    writeFileSync(
      launcherPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(markerPath)}\nsleep 30\n`,
      { mode: 0o755 },
    );
    return { launcherPath, markerPath };
  }

  function fallbackCommand(root: string, markerName: string): ZCodeAgentCommand {
    const markerPath = join(root, markerName);
    return {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "fallback"); setInterval(() => {}, 1000);`,
      ],
      cwd: root,
    };
  }

  function readLines(path: string): string[] {
    return readFileSync(path, "utf8").trim().split("\n");
  }

  it("spawns the native workspace-relay launcher through getClient for chat", async () => {
    const root = createRoot("chat-native");
    const { launcherPath, markerPath } = createNativeLauncher(root, "native-args.txt");
    const nativeRuntimeResolver = vi.fn(() => ({
      launcherPath,
      launchMode: "workspace-relay" as const,
    }));
    const commandResolver = vi.fn(() => fallbackCommand(root, "fallback.txt"));
    const manager = new ZCodeAgentProcessManager({ commandResolver, nativeRuntimeResolver });

    try {
      await manager.getClient({ workspacePath: root });
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true));
      expect(readLines(markerPath)).toEqual([
        "--launch-session",
        "--entry-name",
        "cli-entry.mjs",
        "--cli-in-fd",
        "6",
        "--cli-out-fd",
        "7",
        "--launch-via-workspace",
      ]);
      expect(nativeRuntimeResolver).toHaveBeenCalledTimes(1);
      expect(commandResolver).not.toHaveBeenCalled();
      expect(manager.listManagedProcesses()).toHaveLength(1);
    } finally {
      manager.disposeAll();
    }
  });

  it("keeps the ordinary resolver for declined, remote, and mcp-status lanes", async () => {
    const root = createRoot("fallbacks");
    const nativeRuntimeResolver = vi.fn(() => ({
      launcherPath: join(root, "must-not-spawn.sh"),
      launchMode: "workspace-relay" as const,
    }));

    const normalManager = new ZCodeAgentProcessManager({
      commandResolver: () => fallbackCommand(root, "normal-fallback.txt"),
      nativeRuntimeResolver: () => null,
    });
    try {
      await normalManager.getClient({ workspacePath: root });
      await vi.waitFor(() => expect(existsSync(join(root, "normal-fallback.txt"))).toBe(true));
    } finally {
      normalManager.disposeAll();
    }

    const remoteManager = new ZCodeAgentProcessManager({
      commandResolver: () => fallbackCommand(root, "remote-fallback.txt"),
      nativeRuntimeResolver: (context) =>
        context.workspaceIdentity?.startsWith("remote:") ? null : nativeRuntimeResolver(),
    });
    try {
      await remoteManager.getClient({
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:host:/remote/workspace",
      });
      await vi.waitFor(() => expect(existsSync(join(root, "remote-fallback.txt"))).toBe(true));
    } finally {
      remoteManager.disposeAll();
    }

    const mcpManager = new ZCodeAgentProcessManager({
      commandResolver: () => fallbackCommand(root, "mcp-fallback.txt"),
      nativeRuntimeResolver,
      lane: "mcp-status",
    });
    try {
      await mcpManager.getClient({ workspacePath: root });
      await vi.waitFor(() => expect(existsSync(join(root, "mcp-fallback.txt"))).toBe(true));
      expect(nativeRuntimeResolver).not.toHaveBeenCalled();
    } finally {
      mcpManager.disposeAll();
    }
  });
});

describe("resolveDefaultZCodeAgentCommand", () => {
  const desktopSurfaceArgsCases = [
    {
      name: "separate surface value",
      input: ["app-server", "--surface", "terminal", "--stdio"],
      expected: ["app-server", "--stdio", "--surface", "desktop"],
    },
    {
      name: "equals surface value",
      input: ["app-server", "--surface=terminal", "--stdio"],
      expected: ["app-server", "--stdio", "--surface", "desktop"],
    },
    {
      name: "orphan surface before another option",
      input: ["app-server", "--surface", "--stdio"],
      expected: ["app-server", "--stdio", "--surface", "desktop"],
    },
    {
      name: "trailing orphan surface",
      input: ["app-server", "--surface"],
      expected: ["app-server", "--surface", "desktop"],
    },
  ] as const;

  const originalCwd = process.cwd();
  const originalCommand = process.env.ZCODE_AGENT_SERVER_COMMAND;
  const originalArgsJson = process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
  const originalCwdEnv = process.env.ZCODE_AGENT_SERVER_CWD;
  const originalBinaryEnv = process.env[ZCODE_AGENT_RUNTIME.binaryEnvVar];
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRuntimeEnv = process.env[ZCODE_RUNTIME_ENV_KEY];
  const originalBytecodeEnv = process.env.ZCODE_DESKTOP_AGENT_BYTECODE;
  const originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
  const createdDirs: string[] = [];

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = value;
  }

  beforeEach(() => {
    delete process.env.ZCODE_DESKTOP_AGENT_BYTECODE;
    // 修复原因：stdio tap 开关持久化在用户真实配置目录中。测试若直接读取该目录，
    // 本机开启抓包后会意外包装临时 Node agent，导致用例结果依赖用户环境。
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-agent-manager-data-"));
    createdDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    restoreEnv("ZCODE_AGENT_SERVER_COMMAND", originalCommand);
    restoreEnv("ZCODE_AGENT_SERVER_ARGS_JSON", originalArgsJson);
    restoreEnv("ZCODE_AGENT_SERVER_CWD", originalCwdEnv);
    restoreEnv(ZCODE_AGENT_RUNTIME.binaryEnvVar, originalBinaryEnv);
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv(ZCODE_RUNTIME_ENV_KEY, originalRuntimeEnv);
    restoreEnv("ZCODE_DESKTOP_AGENT_BYTECODE", originalBytecodeEnv);
    if (originalElectronVersion)
      Object.defineProperty(process.versions, "electron", originalElectronVersion);
    else delete process.versions.electron;
    setDataBaseDir(null);

    // Windows: 等待子进程退出后再删除目录
    await new Promise((resolve) => setTimeout(resolve, 100));

    for (const dir of createdDirs.splice(0).reverse()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 有时仍会有权限问题，忽略即可
      }
    }
  });

  it("内置 dist zcode-agent 通过 Electron Node 模式启动", () => {
    delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    delete process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
    delete process.env.ZCODE_AGENT_SERVER_CWD;

    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-default-command-"));
    createdDirs.push(sandboxRoot);

    const appRepoDir = join(sandboxRoot, "z-code");
    const desktopDir = join(appRepoDir, "packages", "desktop");
    const distEntrypoint = join(
      appRepoDir,
      "apps",
      "zcode-cli",
      "packages",
      "cli",
      "dist",
      "zody.cjs",
    );
    mkdirSync(desktopDir, { recursive: true });
    mkdirSync(dirname(distEntrypoint), { recursive: true });
    writeFileSync(distEntrypoint, "console.log('zcode agent');\n");

    process.chdir(desktopDir);

    const command = resolveDefaultZCodeAgentCommand({
      workspacePath: "/repo/workspace",
      workspaceKey: "/repo/workspace",
    });

    expect(command).toEqual({
      supportsStorageStartup: true,
      storagePreparationEntry: expect.any(String),
      command: process.execPath,
      args: [expect.any(String), "app-server", "--stdio"],
      cwd: "/repo/workspace",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(realpathSync(command!.args![0]!)).toBe(realpathSync(distEntrypoint));
    expect(realpathSync(command!.storagePreparationEntry!)).toBe(realpathSync(distEntrypoint));
  });

  it.each([
    [false, true],
    [true, true],
    [true, false],
  ])(
    "字节码开关只替换 Electron 的 stdio 入口，保留存储 Worker JS 入口：electron=%s enabled=%s",
    (electron, enabled) => {
      delete process.env.ZCODE_AGENT_SERVER_COMMAND;
      process.env.ZCODE_DESKTOP_AGENT_BYTECODE = enabled ? "1" : "0";
      Object.defineProperty(process.versions, "electron", {
        configurable: true,
        value: electron ? "41.0.3" : undefined,
      });
      const root = mkdtempSync(join(tmpdir(), "zcode-bytecode-resolver-"));
      createdDirs.push(root);
      const source = join(root, "apps/zody-cli/packages/cli/dist/zody.cjs");
      const bytecode = join(dirname(source), "zcode.bytecode.cjs");
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, "");
      writeFileSync(bytecode, "");
      process.chdir(root);
      const command = resolveDefaultZCodeAgentCommand({
        workspacePath: root,
        workspaceKey: root,
        presentationSurface: "desktop",
      });
      expect(realpathSync(command!.args![0]!)).toBe(
        realpathSync(electron && enabled ? bytecode : source),
      );
      expect(command!.args!.slice(1)).toEqual(["app-server", "--stdio", "--surface", "desktop"]);
      expect(realpathSync(command!.storagePreparationEntry!)).toBe(realpathSync(source));
      expect(command!.supportsStorageStartup).toBe(true);
    },
  );

  it("字节码入口缺失时拒绝静默回退 JS", () => {
    delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    process.env.ZCODE_DESKTOP_AGENT_BYTECODE = "1";
    Object.defineProperty(process.versions, "electron", { configurable: true, value: "41.0.3" });
    const root = mkdtempSync(join(tmpdir(), "zcode-bytecode-missing-"));
    createdDirs.push(root);
    const source = join(root, "apps/zody-cli/packages/cli/dist/zody.cjs");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "");
    process.chdir(root);
    expect(() =>
      resolveDefaultZCodeAgentCommand({ workspacePath: root, workspaceKey: root }),
    ).toThrow(/字节码入口缺失/);
  });

  it("Desktop surface 会显式传给默认 app-server 命令", () => {
    delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    delete process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
    delete process.env.ZCODE_AGENT_SERVER_CWD;

    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-desktop-surface-"));
    createdDirs.push(sandboxRoot);

    const appRepoDir = join(sandboxRoot, "z-code");
    const desktopDir = join(appRepoDir, "packages", "desktop");
    const distEntrypoint = join(
      appRepoDir,
      "apps",
      "zcode-cli",
      "packages",
      "cli",
      "dist",
      "zody.cjs",
    );
    mkdirSync(desktopDir, { recursive: true });
    mkdirSync(dirname(distEntrypoint), { recursive: true });
    writeFileSync(distEntrypoint, "console.log('zcode agent');\n");

    process.chdir(desktopDir);

    const command = resolveDefaultZCodeAgentCommand({
      presentationSurface: "desktop",
      workspacePath: "/repo/workspace",
      workspaceKey: "/repo/workspace",
    });

    expect(command?.args).toEqual([
      expect.any(String),
      "app-server",
      "--stdio",
      "--surface",
      "desktop",
    ]);
  });

  it.each(desktopSurfaceArgsCases)(
    "Desktop surface 归一化 $name 时不吞掉无关参数",
    ({ input, expected }) => {
      process.env.ZCODE_AGENT_SERVER_COMMAND = "zcode-agent";
      process.env.ZCODE_AGENT_SERVER_ARGS_JSON = JSON.stringify(input);

      const command = resolveDefaultZCodeAgentCommand({
        presentationSurface: "desktop",
        workspacePath: "/repo/workspace",
        workspaceKey: "/repo/workspace",
      });

      expect(command).toMatchObject({
        command: "zcode-agent",
        args: expected,
      });
    },
  );

  it("monorepo 不可达时回退到已部署原生 binary", () => {
    delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    delete process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
    delete process.env.ZCODE_AGENT_SERVER_CWD;

    // Bugfix: SSH 远端把 zody-server.cjs 部署到 ~/.zcoder/server/，cwd 不在仓库内、
    // ZCODE_AGENT_SERVER_COMMAND 也没设；旧 resolver 只识别 env 和 monorepo 源码树，
    // 即使 zcode-agent 已部署到 ~/.zcoder/server/agents/glm/，resolver 也找不到。
    // 这里用 GLM_BINARY_PATH（=runtime.binaryEnvVar）模拟该部署场景，
    // 验证 resolver 复用 findZCodeAgentRuntimeBinary 命中已部署 binary。
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-deployed-binary-"));
    createdDirs.push(sandboxRoot);

    const binaryPath = join(sandboxRoot, "zcode-agent");
    writeFileSync(binaryPath, "#!/bin/sh\necho zcode-agent\n");

    process.env[ZCODE_AGENT_RUNTIME.binaryEnvVar] = binaryPath;
    process.chdir(sandboxRoot);

    const command = resolveDefaultZCodeAgentCommand({
      workspacePath: "/repo/workspace",
      workspaceKey: "/repo/workspace",
    });

    expect(command).toEqual({
      command: binaryPath,
      args: ZCODE_AGENT_RUNTIME.spawnArgs,
      cwd: "/repo/workspace",
    });
  });

  it("并发启动同一 workspace 时只创建一个 client", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-"));
    createdDirs.push(workspacePath);
    const command = createDeferred<ZCodeAgentCommand>();
    const commandResolver = vi.fn(() => command.promise);
    const manager = new ZCodeAgentProcessManager({ commandResolver });

    const first = manager.getClient({ workspacePath });
    const second = manager.getClient({ workspacePath });
    await Promise.resolve();

    expect(commandResolver).toHaveBeenCalledTimes(1);

    command.resolve({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: workspacePath,
    });

    const [firstClient, secondClient] = await Promise.all([first, second]);
    expect(firstClient).toBe(secondClient);
    expect(commandResolver).toHaveBeenCalledTimes(1);

    manager.disposeAll();
  });

  it("Helper 恢复期不会 spawn，commit 后只允许同一 pending start 继续", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-cua-admission-"));
    createdDirs.push(workspacePath);
    const gate = new CuaAgentAdmissionGate();
    const recoveryEpoch = gate.beginRecovery();
    const commandResolver = vi.fn<() => ZCodeAgentCommand>(() => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: workspacePath,
    }));
    const manager = new ZCodeAgentProcessManager({
      commandResolver,
      waitForSpawnAdmission: (context) => gate.waitForSpawnAdmission(context),
    });

    const first = manager.getClient({ workspacePath });
    const second = manager.getClient({ workspacePath });
    await Promise.resolve();
    expect(commandResolver).toHaveBeenCalledTimes(1);
    expect(gate.isRecovering()).toBe(true);

    gate.commitRecovery(recoveryEpoch);
    const [firstClient, secondClient] = await Promise.all([first, second]);
    expect(firstClient).toBe(secondClient);
    expect(commandResolver).toHaveBeenCalledTimes(1);

    await manager.disposeAllAndWait();
  });

  it("workspace dispose 不会遗失 pending start，旧代际不能在恢复后 spawn", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-cua-dispose-"));
    createdDirs.push(workspacePath);
    const command = createDeferred<ZCodeAgentCommand>();
    const gate = new CuaAgentAdmissionGate();
    const recoveryEpoch = gate.beginRecovery();
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => command.promise,
      waitForSpawnAdmission: (context) => gate.waitForSpawnAdmission(context),
    });

    const starting = manager.getClient({ workspacePath });
    await Promise.resolve();
    command.resolve({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: workspacePath,
    });
    await vi.waitFor(() => expect(gate.isRecovering()).toBe(true));

    const duplicate = manager.getClient({ workspacePath });
    await manager.disposeWorkspace({ workspacePath });
    gate.commitRecovery(recoveryEpoch);

    await expect(starting).rejects.toThrow("Zody agent process start was cancelled.");
    await expect(duplicate).rejects.toThrow("Zody agent process start was cancelled.");
    await expect(manager.getClient({ workspacePath })).resolves.toBeDefined();

    await manager.disposeAllAndWait();
  });

  it("把宿主声明的 presentation surface 传给 command resolver", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-surface-"));
    createdDirs.push(workspacePath);
    const commandResolver = vi.fn(() => null);
    const manager = new ZCodeAgentProcessManager({
      commandResolver,
      presentationSurface: "desktop",
    });

    await manager.canStart({ workspacePath });

    expect(commandResolver).toHaveBeenCalledWith({
      presentationSurface: "desktop",
      workspacePath,
      workspaceKey: workspacePath,
    });
  });

  it("workspace cleanup 抛错后重试并允许重新拉起 agent", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-restart-"));
    createdDirs.push(workspacePath);
    const commandResolver = vi.fn<() => ZCodeAgentCommand>(() => ({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
      cwd: workspacePath,
    }));
    const manager = new ZCodeAgentProcessManager({ commandResolver });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const firstClient = await manager.getClient({ workspacePath });
    const disposeAndWait = firstClient.disposeAndWait.bind(firstClient);
    let cleanupAttemptCount = 0;
    vi.spyOn(firstClient, "disposeAndWait").mockImplementation(async () => {
      cleanupAttemptCount += 1;
      if (cleanupAttemptCount === 1) {
        throw new Error("simulated process tree residual");
      }
      await disposeAndWait();
    });

    await expect(manager.disposeWorkspace({ workspacePath })).resolves.toBeUndefined();
    const secondClient = await manager.getClient({ workspacePath });

    expect(secondClient).not.toBe(firstClient);
    expect(cleanupAttemptCount).toBe(2);
    expect(commandResolver).toHaveBeenCalledTimes(2);
    expect(
      errorSpy.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes("ZCode agent process cleanup failed")),
      ),
    ).toBe(false);

    errorSpy.mockRestore();
    manager.disposeAll();
  });

  it("Host 在每次 Worker 启动时注入所属 Environment 的 Provider Config 路径", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-provider-env-"));
    createdDirs.push(workspacePath);
    const markerPath = join(workspacePath, "provider-env.json");
    const zcodeBuiltinFilePath = join(workspacePath, "zody-builtin.json");
    const personalFilePath = join(workspacePath, "personal.json");
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ official: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE })); setInterval(() => {}, 1000);`,
        ],
        cwd: workspacePath,
      }),
      resolveSpawnEnv: () => ({
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinFilePath,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFilePath,
      }),
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true));
      expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({
        official: zcodeBuiltinFilePath,
        personal: personalFilePath,
      });
    } finally {
      manager.disposeAll();
    }
  });

  it("查询 dormant workspace runtime identity 不会隐式启动 agent", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-dormant-runtime-"));
    createdDirs.push(workspacePath);
    const commandResolver = vi.fn<() => ZCodeAgentCommand>(() => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: workspacePath,
    }));
    const manager = new ZCodeAgentProcessManager({ commandResolver });
    await expect(manager.getRuntimeIdentity({ workspacePath })).rejects.toThrow(
      "ZCode agent runtime identity is unavailable.",
    );
    expect(commandResolver).not.toHaveBeenCalled();

    manager.disposeAll();
  });

  it("transport 首轮进程树回收误报残留时重试并允许重新拉起 agent", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-recycle-retry-"));
    createdDirs.push(workspacePath);
    const commandResolver = vi.fn<() => ZCodeAgentCommand>(() => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: workspacePath,
    }));
    const manager = new ZCodeAgentProcessManager({ commandResolver });
    const originalDisposeAndWait = ZCodeStdioTransport.prototype.disposeAndWait;
    const disposeAndWaitSpy = vi
      .spyOn(ZCodeStdioTransport.prototype, "disposeAndWait")
      .mockRejectedValueOnce(
        new Error("runtime process tree cleanup incomplete; remaining pid=12345"),
      )
      .mockImplementation(function (this: ZCodeStdioTransport) {
        return originalDisposeAndWait.call(this);
      });

    try {
      const firstClient = await manager.getClient({ workspacePath });
      await expect(manager.disposeWorkspace({ workspacePath })).resolves.toBeUndefined();
      const secondClient = await manager.getClient({ workspacePath });

      expect(disposeAndWaitSpy).toHaveBeenCalledTimes(2);
      expect(secondClient).not.toBe(firstClient);
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      disposeAndWaitSpy.mockRestore();
      await manager.disposeAllAndWait();
    }
  });

  it("重启单个 workspace 后 runtime identity 会变化", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-runtime-"));
    createdDirs.push(workspacePath);
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: workspacePath,
      }),
    });

    await manager.getClient({ workspacePath });
    const firstIdentity = await manager.getRuntimeIdentity({ workspacePath });
    const repeatedIdentity = await manager.getRuntimeIdentity({
      workspacePath,
    });
    await manager.disposeWorkspace({ workspacePath });
    await manager.getClient({ workspacePath });
    const secondIdentity = await manager.getRuntimeIdentity({ workspacePath });

    expect(repeatedIdentity.identity).toBe(firstIdentity.identity);
    expect(secondIdentity.identity).not.toBe(firstIdentity.identity);
    expect(secondIdentity.generation).toBeGreaterThan(firstIdentity.generation);

    manager.disposeAll();
  });

  // M5 ③-2（CLI 重连重订）：进程换代要广播 onRuntimeRestarted，v4 订阅方据此重订；
  // 首次拉起（generation=1）不广播，避免启动期误触发无意义的重订。
  it("进程换代（generation>1）广播 onRuntimeRestarted，首次拉起不广播", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-restart-evt-"));
    createdDirs.push(workspacePath);
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: workspacePath,
      }),
    });
    const restarts: Array<{ workspaceKey: string; generation: number }> = [];
    const availableGenerations: number[] = [];
    manager.onRuntimeLifecycle((event) => {
      if (event.state === "available" && manager.getExistingClient({ workspacePath })) {
        availableGenerations.push(event.runtimeIdentity.generation);
      }
    });
    manager.onRuntimeRestarted((event) => {
      restarts.push({
        workspaceKey: event.workspaceKey,
        generation: event.runtimeIdentity.generation,
      });
    });

    await manager.getClient({ workspacePath });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restarts).toEqual([]);
    expect(availableGenerations).toEqual([1]);

    await manager.disposeWorkspace({ workspacePath });
    await manager.getClient({ workspacePath });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restarts).toEqual([{ workspaceKey: workspacePath, generation: 2 }]);
    expect(availableGenerations).toEqual([1, 2]);

    manager.disposeAll();
  });

  it("换代进程 spawn 失败时不广播 onRuntimeRestarted", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-restart-failed-"));
    createdDirs.push(workspacePath);
    let command: ZCodeAgentCommand = {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: workspacePath,
    };
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => command,
    });
    const restarts: number[] = [];
    manager.onRuntimeRestarted((event) => restarts.push(event.runtimeIdentity.generation));

    await manager.getClient({ workspacePath });
    await manager.disposeWorkspace({ workspacePath });
    command = {
      command: join(workspacePath, "missing-zcode-agent"),
      args: ["app-server", "--stdio"],
      cwd: workspacePath,
    };
    await manager.getClient({ workspacePath });
    await new Promise((resolve) => setImmediate(resolve));

    expect(restarts).toEqual([]);
    manager.disposeAll();
  });

  it("关闭发生在启动中时不会继续 spawn agent", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-dispose-"));
    createdDirs.push(workspacePath);
    const markerPath = join(workspacePath, "spawned.txt");
    const command = createDeferred<ZCodeAgentCommand>();
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => command.promise,
    });

    const starting = manager.getClient({ workspacePath });
    await Promise.resolve();
    await manager.disposeAllAndWait();

    command.resolve({
      command: process.execPath,
      args: [
        "-e",
        `
require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "spawned");
setInterval(() => {}, 1000);
`,
      ],
      cwd: workspacePath,
    });

    // Bugfix: app 关闭期间 warmup 仍可能卡在 command/env resolve。
    // disposeAllAndWait 之后不允许这个启动 promise 继续 spawn，否则会绕过关闭快照留下孤儿进程。
    await expect(starting).rejects.toThrow("ZCode agent process manager is disposed.");
    expect(existsSync(markerPath)).toBe(false);
  });

  it("protocol close 后仍回收 Host 已启动的全部 agent 进程", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-owned-"));
    createdDirs.push(workspacePath);
    const spawnedPids: number[] = [];
    const reporter = {
      onSpawn: vi.fn((event) => spawnedPids.push(event.pid)),
      onExit: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          "-e",
          `setTimeout(() => process.stdout.write("not-json\\n"), 50); setInterval(() => {}, 1000);`,
        ],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });

    try {
      const firstClient = await manager.getClient({ workspacePath });
      await new Promise<void>((resolve) => {
        const disposable = firstClient.onClose(() => {
          disposable.dispose();
          resolve();
        });
      });

      const secondClient = await manager.getClient({ workspacePath });
      await new Promise<void>((resolve) => {
        const disposable = secondClient.onClose(() => {
          disposable.dispose();
          resolve();
        });
      });

      expect(spawnedPids).toHaveLength(2);
      expect(new Set(spawnedPids).size).toBe(2);

      // 修复原因：protocol close 只表示该 client 不再可复用，不表示
      // OS 进程已退出。Host dispose 必须同时等待两代已启动进程完成回收。
      await manager.disposeAllAndWait();

      // 修复原因：进程树回收按 OS 存活状态完成，Node exit 事件及 stderr
      // 收尾后的生命周期上报可能稍晚投递；断言应等待上报，不能假定同步发生。
      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(2));
      expect(reporter.onExit.mock.calls.map(([event]) => event.pid).sort((a, b) => a - b)).toEqual(
        [...spawnedPids].sort((a, b) => a - b),
      );
      expect(reporter.onExit.mock.calls.map(([event]) => event.terminationKind)).toEqual([
        "unexpected",
        "unexpected",
      ]);
    } finally {
      manager.disposeAll();
      for (const pid of spawnedPids) {
        try {
          process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
        } catch {
          /* 测试兜底清理，进程已退出时忽略。 */
        }
      }
    }
  });

  it("app quit 会重试先前失败的进程树回收", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-manager-cleanup-retry-"));
    createdDirs.push(workspacePath);
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
        cwd: workspacePath,
      }),
    });

    const client = await manager.getClient({ workspacePath });
    const disposeAndWait = client.disposeAndWait.bind(client);
    let cleanupAttemptCount = 0;
    vi.spyOn(client, "disposeAndWait").mockImplementation(async () => {
      cleanupAttemptCount += 1;
      if (cleanupAttemptCount === 1) {
        throw new Error("simulated process tree residual");
      }
      await disposeAndWait();
    });

    try {
      // 修复原因：旧实现永久缓存失败的 cleanup Promise，app quit 再次等待时
      // 只会取得同一个 rejection，既不会 force 重试，也会提前释放退出边界。
      await manager.disposeAllAndWait();
      expect(cleanupAttemptCount).toBe(2);
    } finally {
      manager.disposeAll();
    }
  });

  it("未声明 ZCODE_RUNTIME_ENV 时默认以 production 启动 agent 子进程且不传 NODE_ENV", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-node-env-default-"));
    createdDirs.push(workspacePath);
    const nodeEnvPath = join(workspacePath, "node-env.txt");
    process.env.NODE_ENV = "development";
    delete process.env[ZCODE_RUNTIME_ENV_KEY];
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          "-e",
          `
require("node:fs").writeFileSync(${JSON.stringify(nodeEnvPath)}, JSON.stringify({
  nodeEnv: process.env.NODE_ENV || "<empty>",
  runtimeEnv: process.env.ZCODE_RUNTIME_ENV || "<empty>",
}));
setInterval(() => {}, 1000);
`,
        ],
        cwd: workspacePath,
      }),
    });

    try {
      await manager.getClient({ workspacePath });
      // 修复原因：前序进程树回收会在低负载余量环境中短暂占用 spawn/ps；
      // 这里验证的是子进程 env，不应使用 Vitest 默认 1 秒调度窗口制造时序失败。
      await vi.waitFor(() => expect(existsSync(nodeEnvPath)).toBe(true), {
        timeout: 5_000,
      });
      expect(JSON.parse(readFileSync(nodeEnvPath, "utf-8"))).toEqual({
        nodeEnv: "<empty>",
        runtimeEnv: "production",
      });
    } finally {
      manager.disposeAll();
    }
  });

  it("显式 ZCODE_RUNTIME_ENV=development 时保留 agent 子进程开发态", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-node-env-dev-"));
    createdDirs.push(workspacePath);
    const nodeEnvPath = join(workspacePath, "node-env.txt");
    delete process.env.NODE_ENV;
    process.env[ZCODE_RUNTIME_ENV_KEY] = "development";
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          "-e",
          `
require("node:fs").writeFileSync(${JSON.stringify(nodeEnvPath)}, JSON.stringify({
  nodeEnv: process.env.NODE_ENV || "<empty>",
  runtimeEnv: process.env.ZCODE_RUNTIME_ENV || "<empty>",
}));
setInterval(() => {}, 1000);
`,
        ],
        cwd: workspacePath,
      }),
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(existsSync(nodeEnvPath)).toBe(true), {
        timeout: 5_000,
      });
      expect(JSON.parse(readFileSync(nodeEnvPath, "utf-8"))).toEqual({
        nodeEnv: "<empty>",
        runtimeEnv: "development",
      });
    } finally {
      manager.disposeAll();
    }
  });

  it("通过生命周期 reporter 上报本地 agent spawn/exit", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-lifecycle-"));
    createdDirs.push(workspacePath);
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(7), 20);"],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(reporter.onSpawn).toHaveBeenCalledTimes(1));
      const spawnEvent = reporter.onSpawn.mock.calls[0]![0];
      expect(spawnEvent).toMatchObject({
        provider: "glm",
        workspacePath,
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(7), 20);"],
      });
      expect(spawnEvent.pid).toEqual(expect.any(Number));
      expect(spawnEvent.startedAt).toEqual(expect.any(Number));
      expect(spawnEvent.runtimeGeneration).toBe(1);
      expect(spawnEvent.runtimeInstanceId).toMatch(
        /^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(1));
      expect(reporter.onExit.mock.calls[0]![0]).toMatchObject({
        pid: spawnEvent.pid,
        provider: "glm",
        workspacePath,
        exitCode: 7,
        signal: null,
        endedAt: expect.any(Number),
        terminationKind: "unexpected",
        runtimeReady: false,
        runtimeGeneration: 1,
        runtimeInstanceId: spawnEvent.runtimeInstanceId,
        uptimeMs: expect.any(Number),
        stderrLineCount: 0,
      });
      expect(reporter.onError).not.toHaveBeenCalled();
    } finally {
      manager.disposeAll();
    }
  });

  it("真实 ProcessManager 只向实际 spawn 的 Agent 发送一次同一 runtimeIdentity", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-startup-identity-"));
    createdDirs.push(workspacePath);
    const markerPath = join(workspacePath, "startup-identity.jsonl");
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      cuaHostInstanceId: "host-real",
      commandResolver: () => ({
        command: process.execPath,
        cwd: workspacePath,
        args: [
          "-e",
          `
          const fs = require("node:fs");
          const readline = require("node:readline");
          const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
          readline.createInterface({ input: process.stdin }).on("line", (line) => {
            const request = JSON.parse(line);
            if (request.method === "startup/runtimeIdentity") {
              fs.appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(request.params) + "\\n");
              send({ id: request.id, result: { initialized: true, reused: false } });
              return;
            }
            send({ id: request.id, result: {} });
          });
          `,
        ],
      }),
      processLifecycleReporter: reporter,
    });

    try {
      const firstClient = await manager.getClient({ workspacePath });
      const secondClient = await manager.getClient({ workspacePath });
      expect(secondClient).toBe(firstClient);
      await firstClient.request("workspace/readState", {});
      await vi.waitFor(() => expect(reporter.onSpawn).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true));

      const startupFrames = readFileSync(markerPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const managedIdentity = await manager.getRuntimeIdentity({ workspacePath });
      const spawnIdentity = reporter.onSpawn.mock.calls[0]![0];
      expect(startupFrames).toHaveLength(1);
      expect(startupFrames[0]).toEqual({
        identity: {
          hostInstanceId: "host-real",
          runtimeInstanceId: spawnIdentity.runtimeInstanceId,
        },
      });
      expect(managedIdentity).toMatchObject({
        generation: spawnIdentity.runtimeGeneration,
        identity: expect.stringContaining(`:${spawnIdentity.pid}`),
        processId: spawnIdentity.pid,
        workspaceKey: workspacePath,
      });
      expect(manager.listManagedProcesses()).toHaveLength(1);
    } finally {
      await manager.disposeAllAndWait();
    }
  });

  it.each([1, 2])(
    "第 %i 代 startup ACK 延迟时不发布 available，放行后 listener 可立即读取同一 client",
    async (generation) => {
      const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-startup-gate-"));
      createdDirs.push(workspacePath);
      const requestMarkerPath = join(workspacePath, "startup-request.json");
      const ackGatePath = join(workspacePath, "startup-ack-gate");
      const manager = new ZCodeAgentProcessManager({
        cuaHostInstanceId: "host-real",
        commandResolver: () => ({
          command: process.execPath,
          cwd: workspacePath,
          args: [
            "-e",
            `
          const fs = require("node:fs");
          const readline = require("node:readline");
          const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
          readline.createInterface({ input: process.stdin }).on("line", (line) => {
            const request = JSON.parse(line);
            if (request.method === "startup/runtimeIdentity") {
              fs.writeFileSync(${JSON.stringify(requestMarkerPath)}, JSON.stringify(request.params));
              const timer = setInterval(() => {
                if (!fs.existsSync(${JSON.stringify(ackGatePath)})) return;
                clearInterval(timer);
                send({ id: request.id, result: { initialized: true, reused: false } });
              }, 5);
              return;
            }
            send({ id: request.id, result: {} });
          });
          `,
          ],
        }),
      });

      if (generation === 2) {
        writeFileSync(ackGatePath, "ack");
        await manager.getClient({ workspacePath });
        await manager.disposeWorkspace({ workspacePath });
        rmSync(ackGatePath);
        rmSync(requestMarkerPath);
      }
      const availableClients: Array<ReturnType<typeof manager.getExistingClient>> = [];
      const restartedClients: Array<ReturnType<typeof manager.getExistingClient>> = [];
      const restarted = vi.fn();
      manager.onRuntimeLifecycle((event) => {
        if (event.state === "available") {
          availableClients.push(manager.getExistingClient({ workspacePath }));
        }
      });
      manager.onRuntimeRestarted((event) => {
        restarted(event);
        restartedClients.push(manager.getExistingClient({ workspacePath }));
      });

      try {
        let firstSettled = false;
        const firstPromise = manager.getClient({ workspacePath }).finally(() => {
          firstSettled = true;
        });
        void firstPromise.catch(() => undefined);
        await vi.waitFor(() => expect(existsSync(requestMarkerPath)).toBe(true));

        let secondSettled = false;
        const secondPromise = manager.getClient({ workspacePath }).finally(() => {
          secondSettled = true;
        });
        void secondPromise.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);
        expect(manager.getExistingClient({ workspacePath })).toBeUndefined();
        expect(manager.listManagedProcesses()).toHaveLength(1);
        expect(availableClients).toEqual([]);
        expect(restarted).not.toHaveBeenCalled();

        writeFileSync(ackGatePath, "ack");
        const [firstClient, secondClient] = await Promise.all([firstPromise, secondPromise]);
        expect(secondClient).toBe(firstClient);
        expect(availableClients).toEqual([firstClient]);
        expect(manager.getExistingClient({ workspacePath })).toBe(firstClient);
        expect(restarted).toHaveBeenCalledTimes(generation - 1);
        expect(restartedClients).toEqual(generation === 2 ? [firstClient] : []);
        await expect(firstClient.request("workspace/readState", {})).resolves.toEqual({});
        expect(
          readFileSync(requestMarkerPath, "utf8").trim().split("\n").filter(Boolean),
        ).toHaveLength(1);
      } finally {
        await manager.disposeAllAndWait();
      }
    },
  );

  it("旧 Agent 明确不认识 startup 帧时保留普通聊天 client", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-startup-unknown-method-"));
    createdDirs.push(workspacePath);
    const manager = new ZCodeAgentProcessManager({
      cuaHostInstanceId: "host-real",
      commandResolver: () => ({
        command: process.execPath,
        cwd: workspacePath,
        args: [
          "-e",
          `
          const readline = require("node:readline");
          const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
          readline.createInterface({ input: process.stdin }).on("line", (line) => {
            const request = JSON.parse(line);
            if (request.method === "startup/runtimeIdentity") {
              send({ id: request.id, error: { code: -32601, message: "Method not found" } });
              return;
            }
            send({ id: request.id, result: { legacy: true } });
          });
          `,
        ],
      }),
    });

    try {
      const client = await manager.getClient({ workspacePath });
      await expect(client.request("workspace/readState", {})).resolves.toEqual({ legacy: true });
      expect(manager.listManagedProcesses()).toHaveLength(1);
    } finally {
      await manager.disposeAllAndWait();
    }
  });

  it("startup 身份冲突时关闭该 Agent，不允许复用旧 candidate 进程", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-startup-conflict-"));
    createdDirs.push(workspacePath);
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      cuaHostInstanceId: "host-real",
      commandResolver: () => ({
        command: process.execPath,
        cwd: workspacePath,
        args: [
          "-e",
          `
          const readline = require("node:readline");
          const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
          readline.createInterface({ input: process.stdin }).on("line", (line) => {
            const request = JSON.parse(line);
            if (request.method === "startup/runtimeIdentity") {
              send({ id: request.id, error: { code: -32600, message: "fault.startup.runtimeIdentityConflict" } });
            }
          });
          `,
        ],
      }),
      processLifecycleReporter: reporter,
    });
    const lifecycle = vi.fn();
    manager.onRuntimeLifecycle(lifecycle);

    try {
      await expect(manager.getClient({ workspacePath })).rejects.toThrow(
        "startup CUA identity initialization failed",
      );
      expect(manager.listManagedProcesses()).toEqual([]);
      expect(lifecycle).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(1));
      expect(reporter.onExit.mock.calls[0]![0]).toMatchObject({
        runtimeInstanceId: reporter.onSpawn.mock.calls[0]![0].runtimeInstanceId,
        terminationKind: "expected",
        terminationReason: "startup-identity",
      });
    } finally {
      await manager.disposeAllAndWait();
    }
  });

  it("startup 身份连续冲突达到阈值后熔断，冷却窗口内不再 spawn，过期后放行探测并清零", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-startup-breaker-"));
    createdDirs.push(workspacePath);
    // marker 存在时握手成功，不存在时返回冲突；测试用它在冷却过期后切换探测结果。
    const allowMarkerPath = join(workspacePath, "allow-identity");
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      cuaHostInstanceId: "host-real",
      startupIdentityFailureThreshold: 2,
      startupIdentityRetryCooldownMs: 5_000,
      commandResolver: () => ({
        command: process.execPath,
        cwd: workspacePath,
        args: [
          "-e",
          `
          const fs = require("node:fs");
          const readline = require("node:readline");
          const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
          readline.createInterface({ input: process.stdin }).on("line", (line) => {
            const request = JSON.parse(line);
            if (request.method === "startup/runtimeIdentity") {
              if (fs.existsSync(${JSON.stringify(allowMarkerPath)})) {
                send({ id: request.id, result: { initialized: true, reused: false } });
              } else {
                send({ id: request.id, error: { code: -32600, message: "fault.startup.runtimeIdentityConflict" } });
              }
              return;
            }
            send({ id: request.id, result: {} });
          });
          `,
        ],
      }),
      processLifecycleReporter: reporter,
    });

    // 冷却过期与清零用短冷却的第二实例验证，避免真实等待 5s 冷却窗。
    const probeReporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const probeManager = new ZCodeAgentProcessManager({
      cuaHostInstanceId: "host-real",
      startupIdentityFailureThreshold: 1,
      startupIdentityRetryCooldownMs: 50,
      commandResolver: () => ({
        command: process.execPath,
        cwd: workspacePath,
        args: [
          "-e",
          `
          const fs = require("node:fs");
          const readline = require("node:readline");
          const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
          readline.createInterface({ input: process.stdin }).on("line", (line) => {
            const request = JSON.parse(line);
            if (request.method === "startup/runtimeIdentity") {
              if (fs.existsSync(${JSON.stringify(allowMarkerPath)})) {
                send({ id: request.id, result: { initialized: true, reused: false } });
              } else {
                send({ id: request.id, error: { code: -32600, message: "fault.startup.runtimeIdentityConflict" } });
              }
              return;
            }
            send({ id: request.id, result: {} });
          });
          `,
        ],
      }),
      processLifecycleReporter: probeReporter,
    });

    try {
      // 连续两次冲突：各 spawn 一次并清理。
      await expect(manager.getClient({ workspacePath })).rejects.toThrow(
        "startup CUA identity initialization failed",
      );
      await expect(manager.getClient({ workspacePath })).rejects.toThrow(
        "startup CUA identity initialization failed",
      );
      await vi.waitFor(() => expect(reporter.onSpawn).toHaveBeenCalledTimes(2));

      // 阈值已到：冷却窗口内直接拒绝，且没有第三次 spawn。
      await expect(manager.getClient({ workspacePath })).rejects.toThrow(
        "circuit is open",
      );
      expect(reporter.onSpawn).toHaveBeenCalledTimes(2);

      // 第二实例单次失败即跳闸；冷却过期 + 握手可成功后放行探测，成功清零并返回可用 client。
      await expect(probeManager.getClient({ workspacePath })).rejects.toThrow(
        "startup CUA identity initialization failed",
      );
      await expect(probeManager.getClient({ workspacePath })).rejects.toThrow(
        "circuit is open",
      );
      expect(probeReporter.onSpawn).toHaveBeenCalledTimes(1);
      writeFileSync(allowMarkerPath, "");
      await new Promise((resolve) => setTimeout(resolve, 120));
      const client = await probeManager.getClient({ workspacePath });
      await expect(client.request("workspace/readState", {})).resolves.toEqual({});
      expect(probeReporter.onSpawn).toHaveBeenCalledTimes(2);
    } finally {
      await manager.disposeAllAndWait();
      await probeManager.disposeAllAndWait();
    }
  });

  it("协议帧损坏后即使回收重试也保留 protocol-close 根因", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-protocol-close-"));
    createdDirs.push(workspacePath);
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        // 测试只验证 protocol-close 根因；让 stdin EOF 可收尾，避免完整测试并发时
        // PowerShell/CIM 定向复核受系统负载影响，把该用例误变成 cleanup deadline 测试。
        args: [
          "-e",
          'process.stdout.write("invalid-ndjson\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(1));',
        ],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let cleanupAttemptCount = 0;

    try {
      const client = await manager.getClient({ workspacePath });
      const disposeAndWait = client.disposeAndWait.bind(client);
      vi.spyOn(client, "disposeAndWait").mockImplementation(async () => {
        cleanupAttemptCount += 1;
        if (cleanupAttemptCount === 1) {
          throw new Error("simulated protocol-close cleanup residual");
        }
        await disposeAndWait();
      });
      // Bug 根因：进程树回收包含有界 SIGTERM 等待窗口；全量并发单测下默认 1 秒
      // waitFor 会在真实 exit 事件到达前超时，造成仅在整套测试中出现的假失败。
      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });

      expect(reporter.onExit.mock.calls[0]![0]).toMatchObject({
        terminationKind: "unexpected",
        terminationReason: "protocol-close",
      });
      await vi.waitFor(() => expect(cleanupAttemptCount).toBe(2));
      expect(
        errorSpy.mock.calls.some((args) =>
          args.some((arg) => String(arg).includes("ZCode agent process cleanup failed")),
        ),
      ).toBe(false);
    } finally {
      errorSpy.mockRestore();
      await manager.disposeAllAndWait();
    }
  });

  it("观测超时保留真实 Agent，持续观测也不能阻止空闲回收", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-observation-"));
    createdDirs.push(workspacePath);
    const manager = new ZCodeAgentProcessManager({
      idleTimeoutMs: 250,
      commandResolver: () => ({
        command: process.execPath,
        cwd: workspacePath,
        args: [
          "-e",
          `
        require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
          const request = JSON.parse(line);
          if (request.method !== "process/childProcesses") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
        });
      `,
        ],
      }),
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const client = await manager.getClient({ workspacePath });
      await client.request("workspace/readState", {});
      const pid = manager.listManagedProcesses()[0]!.pid;
      await expect(
        client.request("process/childProcesses", {}, undefined, {
          lifecycle: "observation",
          timeoutMs: 40,
        }),
      ).rejects.toThrow("timed out");
      expect(client.isDisposed).toBe(false);
      expect(manager.listManagedProcesses()[0]!.pid).toBe(pid);
      await client.request("workspace/readState", {});
      timer = setInterval(() => {
        void client
          .request("process/childProcesses", {}, undefined, {
            lifecycle: "observation",
            timeoutMs: 5_000,
          })
          .catch(() => {});
      }, 20);
      await vi.waitFor(() => expect(client.isDisposed).toBe(true), { timeout: 2_000 });
    } finally {
      if (timer) clearInterval(timer);
      await manager.disposeAllAndWait();
    }
  });

  it("旧启动请求结清后，仍在迁移的 Agent 不进入空闲回收", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-migration-idle-"));
    createdDirs.push(workspacePath);
    const manager = new ZCodeAgentProcessManager({
      idleTimeoutMs: 30,
      commandResolver: () => ({
        command: process.execPath,
        cwd: workspacePath,
        args: [
          "-e",
          `
          const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
          const state = (phase, sequence) => send({method:"startup/storageState",params:{schemaVersion:1,attemptId:"a",databaseId:"db",databaseKind:"session",phase,sequence,elapsedMs:0}});
          let buffer = "";
          process.stdin.on("data", chunk => {
            buffer += chunk;
            const end = buffer.indexOf("\\n");
            if (end < 0) return;
            const request = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
            state("migrating",1);
            send({id:request.id,result:{}});
            setTimeout(()=>state("ready",2),150);
          });
        `,
        ],
      }),
    });
    try {
      const client = await manager.getClient({ workspacePath });
      await client.request("workspace/readState", {});
      await client.storageStartup.wait();
      expect(client.storageStartup.snapshot?.phase).toBe("ready");
      await vi.waitFor(() => expect(client.isDisposed).toBe(true));
    } finally {
      await manager.disposeAllAndWait();
    }
  });

  it("主动回收 workspace 时把 agent 退出标为 expected", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-lifecycle-expected-"));
    createdDirs.push(workspacePath);
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(reporter.onSpawn).toHaveBeenCalledTimes(1));
      await manager.disposeWorkspace({ workspacePath });
      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(1));

      expect(reporter.onExit.mock.calls[0]![0]).toMatchObject({
        terminationKind: "expected",
        terminationReason: "workspace-dispose",
        runtimeGeneration: 1,
      });
      expect(reporter.onExit.mock.calls[0]![0].stderrTail).toBeUndefined();
    } finally {
      manager.disposeAll();
    }
  });

  it("只把 ready 绑定到返回该 client 的当前 runtime", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-ready-identity-"));
    createdDirs.push(workspacePath);
    const reporter = {
      onSpawn: vi.fn(),
      onReady: vi.fn(),
      onExit: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });

    try {
      const retiredClient = await manager.getClient({ workspacePath });
      await manager.disposeWorkspace({ workspacePath });
      const currentClient = await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(reporter.onSpawn).toHaveBeenCalledTimes(2));

      manager.markReady({ workspacePath }, retiredClient);
      expect(reporter.onReady).not.toHaveBeenCalled();

      manager.markReady({ workspacePath }, currentClient);
      manager.markReady({ workspacePath }, currentClient);
      expect(reporter.onReady).toHaveBeenCalledTimes(1);
      expect(reporter.onReady.mock.calls[0]![0]).toMatchObject({
        runtimeGeneration: 2,
        runtimeInstanceId: reporter.onSpawn.mock.calls[1]![0].runtimeInstanceId,
      });
    } finally {
      await manager.disposeAllAndWait();
    }
  });

  it("agent 非零退出时生产日志保留脱敏且有界的 stderr 尾部", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-stderr-tail-"));
    createdDirs.push(workspacePath);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          "-e",
          `process.stderr.write("Error: simulated EPIPE token=super-secret key=sk-1234567890abcdefghijklmnopqrstuv\\n"); process.exit(1);`,
        ],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          expect.any(String),
          `ZCode agent process exited unexpectedly ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}`,
          expect.objectContaining({
            workspaceKey: workspacePath,
            code: 1,
            signal: null,
            stderr: {
              lineCount: 1,
              tail: ["Error: simulated EPIPE token=<redacted> key=sk-<redacted>"],
            },
          }),
        ),
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("super-secret");
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
        "sk-1234567890abcdefghijklmnopqrstuv",
      );
      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(1));
      expect(reporter.onExit.mock.calls[0]![0]).toMatchObject({
        terminationKind: "unexpected",
        stderrLineCount: 1,
        stderrTail: ["Error: simulated EPIPE token=<redacted> key=sk-<redacted>"],
      });
    } finally {
      manager.disposeAll();
      errorSpy.mockRestore();
    }
  });

  it("仅 fixed native launcher 把严格匹配的 cua-native 审计行提升为 info", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-cua-native-audit-"));
    createdDirs.push(workspacePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const nativeLine =
      '[cua-native] cell-loaded-code {"pid":83436,"verified":true,"identifier":"io.github.zclaudia.zody.cua-helper.node","cdhash":"3c57a9bb9f4e8b748ac80d60bc78cdde14767218","entitlementsEmpty":true}';
    const secretLine = '[cua-native] cell-spawned {"pid":1,"suspended":true,"secret":"raw-secret"}';
    const script = `process.stderr.write(${JSON.stringify(`${nativeLine}\n${secretLine}\n`)}); setTimeout(() => process.exit(0), 250);`;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", script],
        cwd: workspacePath,
        nativeLauncher: true,
      }),
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() =>
        expect(logSpy).toHaveBeenCalledWith(
          expect.any(String),
          "CUA native audit",
          nativeLine,
        ),
      );
      const auditLogCalls = logSpy.mock.calls.filter((call) => call[1] === "CUA native audit");
      expect(JSON.stringify(auditLogCalls)).not.toContain("raw-secret");
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      manager.disposeAll();
      logSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("ordinary CLI 不把 cua-native 形式 stderr 提升为 info", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-ordinary-cua-audit-"));
    createdDirs.push(workspacePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const line =
      '[cua-native] cell-resumed {"pid":83436}';
    const script = `process.stderr.write(${JSON.stringify(`${line}\n`)}); setTimeout(() => process.exit(0), 250);`;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", script],
        cwd: workspacePath,
      }),
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(logSpy).toHaveBeenCalled());
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.any(String),
        "CUA native audit",
        expect.anything(),
      );
    } finally {
      manager.disposeAll();
      logSpy.mockRestore();
    }
  });

  it.each([false, true, "expanded"])(
    "生产态存活进程即时转发异常且隔离 reporter 失败（%s）",
    async (failReporter) => {
      vi.stubEnv("NODE_ENV", "production");
      const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-exception-"));
      createdDirs.push(workspacePath);
      const diagnostic = {
        version: 1,
        errorId: "1f51b7dc-c52a-46ad-bc97-d2f984e6e3de",
        kind: "uncaughtException",
        origin: "uncaughtException",
        name: "Error",
        message:
          failReporter === "expanded"
            ? "token=a ".repeat(500)
            : "boom token=private key=sk-1234567890abcdefghijklmnopqrstuv",
        stack: "Error: boom\n    at run (C:\\repo\\cli.js:1:2)",
        occurredAt: Date.now(),
      };
      const frame = ZCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic) + "\n";
      const reporter = {
        onSpawn: vi.fn(),
        onExit: vi.fn(),
        onException: vi.fn((_event: RuntimeProcessExceptionEvent) => {
          if (failReporter === true) throw new Error("IPC unavailable");
        }),
      } satisfies RuntimeProcessLifecycleReporter;
      const manager = new ZCodeAgentProcessManager({
        commandResolver: () => ({
          command: process.execPath,
          cwd: workspacePath,
          args: [
            "-e",
            `process.stderr.write(${JSON.stringify(frame)}); setInterval(() => {}, 1000);`,
          ],
        }),
        processLifecycleReporter: reporter,
      });
      try {
        const client = await manager.getClient({ workspacePath });
        // Bugfix: vi.waitFor 默认 1s 超时只覆盖子进程 stderr 首帧的等待窗口，而本用例
        // 正常总耗时已 ~2.2s（spawn 真实 node 子进程占大头）。全量门禁高负载下
        // （2026-10-17 门禁第 3 轮该 it.each 用例以（false）变体偶发失败，同代码前后
        // 两轮全量均绿），spawn 排队会把首帧挤过 1s 窗口。与 vitest.config.ts
        // testTimeout 30s 及 workflowArtifactSidePane 版本步进器用例的放宽口径一致，
        // 只放宽本等待的上限，不改断言语义；it.each 三个变体共享此函数体。
        const exceptionForwardTimeoutMs = 5_000;
        await vi.waitFor(() => expect(reporter.onException).toHaveBeenCalledOnce(), {
          timeout: exceptionForwardTimeoutMs,
        });
        expect(reporter.onExit).not.toHaveBeenCalled();
        expect(await manager.getClient({ workspacePath })).toBe(client);
        expect(reporter.onException.mock.calls[0]?.[0]).toMatchObject({
          pid: reporter.onSpawn.mock.calls[0]?.[0].pid,
          runtimeInstanceId: reporter.onSpawn.mock.calls[0]?.[0].runtimeInstanceId,
          runtimeGeneration: 1,
          workspacePath,
          diagnostic: {
            ...diagnostic,
            message:
              failReporter === "expanded"
                ? "token=<redacted> ".repeat(500).slice(0, 4000)
                : "boom token=<redacted> key=sk-<redacted>",
          },
        });
        expect(
          hostResponseMessageSchema.safeParse({
            type: "agent-process-exception",
            ...reporter.onException.mock.calls[0]?.[0],
          }).success,
        ).toBe(true);
      } finally {
        await manager.disposeAllAndWait();
        vi.unstubAllEnvs();
      }
    },
  );

  it("生命周期 reporter 失败时不影响 agent 启动", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-lifecycle-safe-"));
    createdDirs.push(workspacePath);
    const reporter = {
      onSpawn: vi.fn(() => {
        throw new Error("reporter unavailable");
      }),
      onExit: vi.fn(),
      onError: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });

    try {
      await expect(manager.getClient({ workspacePath })).resolves.toBeTruthy();
      await vi.waitFor(() => expect(reporter.onSpawn).toHaveBeenCalledTimes(1));
    } finally {
      manager.disposeAll();
    }
  });

  it("生产日志记录 agent spawn 前的 command 和 cwd 可用性", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-spawn-preflight-"));
    createdDirs.push(workspacePath);
    const missingCommand = join(workspacePath, "missing-zcode-agent");
    const missingCwd = join(workspacePath, "missing-workspace");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: missingCommand,
        args: ["app-server", "--stdio"],
        cwd: missingCwd,
      }),
    });

    try {
      await manager.getClient({ workspacePath });

      await vi.waitFor(() =>
        expect(logSpy).toHaveBeenCalledWith(
          expect.any(String),
          "ZCode agent spawn preflight",
          expect.objectContaining({
            workspaceKey: workspacePath,
            spawnPreflight: expect.objectContaining({
              command: missingCommand,
              args: ["app-server", "--stdio"],
              cwd: missingCwd,
              cwdSource: "command",
              commandPathKind: "absolute",
              commandExists: false,
              cwdExists: false,
            }),
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          expect.any(String),
          "ZCode agent process error",
          expect.objectContaining({
            workspaceKey: workspacePath,
            errorMessage: expect.stringContaining("ENOENT"),
            spawnPreflight: expect.objectContaining({
              commandExists: false,
              cwdExists: false,
            }),
          }),
        ),
      );
    } finally {
      manager.disposeAll();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("非 active 历史 workspace 目录缺失时仅将 agent spawn cwd 兜底到 backing workspace", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-agent-fallback-cwd-"));
    createdDirs.push(rootDir);
    const workspacePath = join(rootDir, "missing-workspace");
    const fallbackCwd = join(rootDir, ".zcoder", "workspace", "default");
    const markerPath = join(rootDir, "effective-cwd.txt");
    mkdirSync(fallbackCwd, { recursive: true });
    const commandResolver = vi.fn(
      ({ workspacePath: requestedWorkspacePath }: { workspacePath: string }) => ({
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, process.cwd()); setInterval(() => {}, 1000);`,
        ],
        cwd: requestedWorkspacePath,
      }),
    );
    const manager = new ZCodeAgentProcessManager({
      commandResolver,
      spawnFallbackCwd: fallbackCwd,
    });

    try {
      await manager.getClient({ workspacePath });
      const runtimeIdentity = await manager.getRuntimeIdentity({
        workspacePath,
      });
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true));

      expect(realpathSync(readFileSync(markerPath, "utf-8"))).toBe(realpathSync(fallbackCwd));
      expect(runtimeIdentity.workspaceKey).toBe(workspacePath);
      expect(commandResolver).toHaveBeenCalledWith({
        workspacePath,
        workspaceKey: workspacePath,
      });
      expect(existsSync(workspacePath)).toBe(false);
    } finally {
      manager.disposeAll();
    }
  });

  it("显式自定义 cwd 与 workspace 不同时不使用 fallback cwd", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-agent-custom-cwd-"));
    createdDirs.push(rootDir);
    const workspacePath = join(rootDir, "missing-workspace");
    const fallbackCwd = join(rootDir, "ZCodeProject");
    const customCwd = join(rootDir, "custom-runtime-cwd");
    const markerPath = join(rootDir, "effective-cwd.txt");
    mkdirSync(fallbackCwd);
    mkdirSync(customCwd);
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, process.cwd()); setInterval(() => {}, 1000);`,
        ],
        cwd: customCwd,
      }),
      spawnFallbackCwd: fallbackCwd,
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true));
      expect(realpathSync(readFileSync(markerPath, "utf-8"))).toBe(realpathSync(customCwd));
    } finally {
      manager.disposeAll();
    }
  });

  it("通过生命周期 reporter 上报 agent spawn error", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-lifecycle-error-"));
    createdDirs.push(workspacePath);
    const missingCommand = join(workspacePath, "missing-zcode-agent");
    const reporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    } satisfies RuntimeProcessLifecycleReporter;
    const manager = new ZCodeAgentProcessManager({
      commandResolver: () => ({
        command: missingCommand,
        args: ["app-server", "--stdio"],
        cwd: workspacePath,
      }),
      processLifecycleReporter: reporter,
    });

    try {
      await manager.getClient({ workspacePath });
      await vi.waitFor(() => expect(reporter.onError).toHaveBeenCalledTimes(1));
      expect(reporter.onError.mock.calls[0]![0]).toMatchObject({
        pid: null,
        provider: "glm",
        workspacePath,
        command: missingCommand,
        args: ["app-server", "--stdio"],
        errorName: "Error",
        errorCode: "ENOENT",
        errorStack: expect.any(String),
        runtimeGeneration: 1,
        runtimeInstanceId: expect.stringMatching(/^agent-[0-9a-f-]{36}$/),
        occurredAt: expect.any(Number),
      });
      expect(reporter.onError.mock.calls[0]![0].errorMessage).toContain("ENOENT");
    } finally {
      manager.disposeAll();
    }
  });

  it("开发态 stdio tap 开启时用旁路 proxy 包装 agent 命令", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-stdio-tap-"));
    createdDirs.push(sandboxRoot);
    const tapScript = join(sandboxRoot, "scripts", "dev", "zody-stdio-tap.mjs");
    mkdirSync(dirname(tapScript), { recursive: true });
    writeFileSync(tapScript, "#!/usr/bin/env node\n");
    process.chdir(sandboxRoot);
    process.env[ZCODE_RUNTIME_ENV_KEY] = "development";
    setDataBaseDir(sandboxRoot);
    setZCodeStdioTapDevEnabled(true);

    const wrapped = wrapZCodeAgentCommandWithStdioTapDevProxy(
      {
        command: "zcode-agent",
        args: ["app-server", "--stdio"],
        cwd: "/repo/workspace",
        env: { CUSTOM_ENV: "1" },
      },
      "/repo/workspace",
    );

    expect(wrapped).toEqual({
      command: process.execPath,
      args: [
        realpathSync(tapScript),
        "--workspace-key",
        "/repo/workspace",
        "--log-dir",
        join(sandboxRoot, ".zody", "v2", "dev", "stdio-traffic"),
        "--",
        "zcode-agent",
        "app-server",
        "--stdio",
      ],
      cwd: "/repo/workspace",
      env: {
        CUSTOM_ENV: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
  });

  it.each(desktopSurfaceArgsCases)(
    "Desktop 自定义命令经 stdio tap proxy 后保留 $name 的参数",
    ({ input, expected }) => {
      const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-stdio-tap-surface-"));
      createdDirs.push(sandboxRoot);
      const tapScript = join(sandboxRoot, "scripts", "dev", "zody-stdio-tap.mjs");
      mkdirSync(dirname(tapScript), { recursive: true });
      writeFileSync(tapScript, "#!/usr/bin/env node\n");
      process.chdir(sandboxRoot);
      process.env[ZCODE_RUNTIME_ENV_KEY] = "development";
      process.env.ZCODE_AGENT_SERVER_COMMAND = "zcode-agent";
      process.env.ZCODE_AGENT_SERVER_ARGS_JSON = JSON.stringify(input);
      setDataBaseDir(sandboxRoot);
      setZCodeStdioTapDevEnabled(true);

      const command = resolveDefaultZCodeAgentCommand({
        presentationSurface: "desktop",
        workspacePath: "/repo/workspace",
        workspaceKey: "/repo/workspace",
      });
      expect(command).not.toBeNull();

      const wrapped = wrapZCodeAgentCommandWithStdioTapDevProxy(command!, "/repo/workspace");

      expect(wrapped.args).toEqual([
        realpathSync(tapScript),
        "--workspace-key",
        "/repo/workspace",
        "--log-dir",
        join(sandboxRoot, ".zody", "v2", "dev", "stdio-traffic"),
        "--",
        "zcode-agent",
        ...expected,
      ]);
    },
  );
});
