import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CustomCommandContent,
  ExecutionPort,
  ExecutionResult,
  PluginLoadOutcome,
  PluginMetadata,
} from "@zody/contracts";
import { resolvePluginRuntimeFeatures } from "../src/app/plugin-runtime-features.js";
import { resolveBuiltInNodeReplMcpServers } from "../src/app/built-in-node-repl.js";
import { writeOfficialPluginRuntimeManifest } from "../src/app/official-plugin-runtime.js";
import { expandCustomCommandShellSyntax } from "../src/custom-command-shell-expansion.js";

function plugin(id: string, enabled: boolean, rootPath = "/tmp/plugin"): PluginMetadata {
  const [name = id, marketplace = "test"] = id.split("@");
  return {
    commandRootCount: 0,
    components: [],
    dataPath: "/tmp/plugin-data",
    declaredMcpServerNames: [],
    enabled,
    hookDetails: [],
    id,
    manifestPath: `${rootPath}/.zcode-plugin/plugin.json`,
    marketplace,
    mcpServerNames: [],
    name,
    rootPath,
    skillCount: 0,
    skillRootCount: 0,
    source: "official",
  };
}

function outcome(plugins: PluginMetadata[]): Pick<PluginLoadOutcome, "plugins"> {
  return { plugins };
}

describe("resolvePluginRuntimeFeatures", () => {
  it("enables browser-use without exposing the legacy core node_repl tools", () => {
    expect(
      resolvePluginRuntimeFeatures(outcome([plugin("browser-use@zcode-plugins-official", true)])),
    ).toEqual({
      browserUse: true,
      browserDocumentationRoot: "/tmp/plugin/docs",
    });
  });

  it("exposes only the stateless modern node_repl runtime, served from the host root", () => {
    const enabledServers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: outcome([
        plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
        plugin("browser-use@zcode-plugins-official", true),
      ]),
      workingDirectory: "/workspace",
    });
    expect(enabledServers.node_repl).toMatchObject({
      command: process.execPath,
      cwd: "/workspace",
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ZODY_PLUGIN_ROOT: "/tmp/plugin",
        ZCODE_PLUGIN_ROOT: "/tmp/plugin",
      },
      timeoutMs: 600_000,
      isolation: "workspace",
      protocolVersion: "2026-07-28",
      type: "stdio",
    });
    // R55：两套 root 必须同源，且 node_repl 不是插件 MCP，不注入插件 ID/NAME/DATA。
    const env = nodeReplEnv(enabledServers);
    expect(env?.ZODY_PLUGIN_ROOT).toBe(env?.ZCODE_PLUGIN_ROOT);
    expect(env).not.toHaveProperty("ZODY_PLUGIN_ID");
    expect(env).not.toHaveProperty("ZODY_PLUGIN_NAME");
    expect(env).not.toHaveProperty("ZODY_PLUGIN_DATA");
    // 产物来自宿主自己的 root，不再来自 browser-use 的 root。
    expect(
      enabledServers.node_repl?.type === "stdio"
        ? enabledServers.node_repl.args?.at(-1)
        : undefined,
    ).toBe("/tmp/host/dist/mcp/server.js");
    expect(enabledServers.browser_use).toBeUndefined();
  });

  it("does not register node_repl when the shared host is missing", () => {
    // 宿主缺失只能安全地不注册：没有宿主可跑，绝不回退到某个插件包里的旧产物。
    expect(
      resolveBuiltInNodeReplMcpServers({
        pluginOutcome: outcome([plugin("browser-use@zcode-plugins-official", true)]),
        workingDirectory: "/workspace",
      }),
    ).toEqual({});
  });

  it("serves Computer Use without the Browser Use package", () => {
    // 回归（2026-09-11）：宿主产物过去只从 browser-use 的 rootPath 取，browser-use 包缺失时
    // 即便 CUA 启用也拿不到宿主。三个包独立后两个能力对称。
    const servers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: outcome([
        plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
        plugin("computer-use@zcode-plugins-official", true, "/tmp/cua-plugin"),
      ]),
      workingDirectory: "/workspace",
    });
    expect(servers.node_repl).toMatchObject({
      env: { ZODY_CUA_PLUGIN_ROOT: "/tmp/cua-plugin" },
      type: "stdio",
    });
    // browser-use 不在时不注入它的 root，宿主据此知道浏览器那半边不可用。
    expect(
      servers.node_repl?.type === "stdio" ? servers.node_repl.env?.ZCODE_PLUGIN_ROOT : undefined,
    ).toBeUndefined();
    expect(
      servers.node_repl?.type === "stdio" ? servers.node_repl.env?.ZODY_PLUGIN_ROOT : undefined,
    ).toBeUndefined();
  });

  it("enables the CUA SDK without registering core node_repl tools", () => {
    expect(
      resolvePluginRuntimeFeatures(outcome([plugin("computer-use@zcode-plugins-official", true)])),
    ).toEqual({ computerUse: true });
  });

  // 回归：browser-use 关闭后 node_repl 仍然被注册，宿主照样拉起 stdio 子进程，
  // mcp__node_repl__js 等 3 个高权限工具照样进模型工具池（线上日志实证：
  // runtimeFeatureBrowserUse=false 且用户 MCP 配置为 0 时，mcp.startup 仍 serverCount=1 / toolCount=3）。
  // 根因是这里只判断「browser-use 包存在」，漏掉了 plugin.enabled；
  // 而同一份 pluginOutcome 在 resolvePluginRuntimeFeatures 里是判断 enabled 的，两条路径语义分叉。
  it("does not register node_repl when the browser-use plugin is disabled", () => {
    expect(
      resolveBuiltInNodeReplMcpServers({
        pluginOutcome: outcome([
          plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
          plugin("browser-use@zcode-plugins-official", false),
        ]),
        workingDirectory: "/workspace",
      }),
    ).toEqual({});
  });

  it("keeps the shared host and CUA runtime roots separate", () => {
    const servers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: outcome([
        plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
        plugin("browser-use@zcode-plugins-official", false, "/tmp/browser-plugin"),
        plugin("computer-use@zcode-plugins-official", true, "/tmp/cua-plugin"),
      ]),
      workingDirectory: "/workspace",
    });

    // browser-use 已停用：只注入 CUA 的 root，两个领域各自独立。
    expect(servers.node_repl).toMatchObject({
      env: { ZODY_CUA_PLUGIN_ROOT: "/tmp/cua-plugin" },
      type: "stdio",
    });
    expect(
      servers.node_repl?.type === "stdio" ? servers.node_repl.env?.ZCODE_PLUGIN_ROOT : undefined,
    ).toBeUndefined();
  });

  it("does not register node_repl when the browser-use plugin is absent", () => {
    expect(
      resolveBuiltInNodeReplMcpServers({
        pluginOutcome: outcome([plugin("browser@third-party", true)]),
        workingDirectory: "/workspace",
      }),
    ).toEqual({});
  });

  // node_repl 的注册开关必须和 browserUse runtime feature 同源，避免以后再次分叉出
  // 「工具在、bridge 不在」或「bridge 在、工具不在」的半开状态。
  it("keeps node_repl registration in sync with the browserUse runtime feature", () => {
    for (const enabled of [true, false]) {
      const pluginOutcome = outcome([
        plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
        plugin("browser-use@zcode-plugins-official", enabled),
      ]);
      const hasNodeRepl =
        resolveBuiltInNodeReplMcpServers({ pluginOutcome, workingDirectory: "/workspace" })
          .node_repl !== undefined;
      expect(hasNodeRepl).toBe(resolvePluginRuntimeFeatures(pluginOutcome).browserUse === true);
    }
  });

  it("keeps browser-use disabled for disabled or non-official plugins", () => {
    expect(
      resolvePluginRuntimeFeatures(outcome([plugin("browser-use@zcode-plugins-official", false)])),
    ).toEqual({});
    expect(resolvePluginRuntimeFeatures(outcome([plugin("browser@third-party", true)]))).toEqual(
      {},
    );
  });
});

function nodeReplEnv(servers: ReturnType<typeof resolveBuiltInNodeReplMcpServers>) {
  const server = servers.node_repl;
  return server?.type === "stdio" ? server.env : undefined;
}

describe("official plugin runtime identity env (R55)", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("writes both identity groups from one plugin context and overrides manifest env", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-plugin-runtime-identity-"));
    cleanups.push(root);
    const manifestPath = join(root, ".zody-plugin", "plugin.json");
    await mkdir(join(root, ".zody-plugin"), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          mcpServers: {
            "browser-use": {
              args: [],
              command: "old-node",
              env: {
                CUSTOM_KEEP: "kept",
                ZODY_FORGED: "/forged-zody-root",
                ZCODE_PLUGIN_ID: "forged@evil",
                ZCODE_PLUGIN_ROOT: "/forged-zcode-root",
                ZODY_PLUGIN_ID: "forged@evil",
                ZODY_PLUGIN_ROOT: "/forged-zody-root",
              },
            },
          },
          name: "browser-use",
        },
        null,
        2,
      )}\n`,
    );
    process.argv[1] = join(root, "zody.cjs");

    writeOfficialPluginRuntimeManifest({ pluginName: "browser-use", rootPath: root });

    const rendered = JSON.parse(await readFile(manifestPath, "utf8")) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    const env = rendered.mcpServers["browser-use"]?.env ?? {};
    expect(env).toMatchObject({
      CUSTOM_KEEP: "kept",
      ELECTRON_RUN_AS_NODE: "1",
      ZCODE_PLUGIN_ID: "browser-use@zcode-plugins-official",
      ZCODE_PLUGIN_NAME: "browser-use",
      ZCODE_PLUGIN_ROOT: root,
      ZODY_PLUGIN_ID: "browser-use@zcode-plugins-official",
      ZODY_PLUGIN_NAME: "browser-use",
      ZODY_PLUGIN_ROOT: root,
    });
    // R55：两套身份必须逐键同源；seed 阶段没有 dataPath，不伪造 DATA。
    expect(env.ZODY_PLUGIN_ID).toBe(env.ZCODE_PLUGIN_ID);
    expect(env.ZODY_PLUGIN_ROOT).toBe(env.ZCODE_PLUGIN_ROOT);
    expect(env.ZODY_PLUGIN_DATA).toBeUndefined();
    expect(env.ZCODE_PLUGIN_DATA).toBeUndefined();
  });
});

describe("custom command shell expansion identity env (R55)", () => {
  const pluginContext = {
    dataPath: "/tmp/plugin-data",
    id: "policy@example",
    name: "Policy",
    rootPath: "/tmp/policy-plugin",
  };

  function customCommand(
    content: string,
    options: { plugin?: typeof pluginContext; source?: "plugin" | "zcode" },
  ): CustomCommandContent {
    const source = options.source ?? "plugin";
    return {
      bytesRead: content.length,
      content,
      metadata: {
        allowedTools: [],
        description: "identity env check",
        disableNonInteractive: false,
        frontmatterKeys: [],
        name: "identity-env",
        path: "/tmp/commands/identity-env.md",
        ...(options.plugin ? { plugin: options.plugin } : {}),
        rootPath: "/tmp/commands",
        scope: source === "plugin" ? "project" : "user",
        skills: [],
        source,
      },
      sizeBytes: content.length,
      truncated: false,
    };
  }

  function completedResult(): ExecutionResult {
    const now = new Date();
    return {
      cancelled: false,
      completedAt: now,
      durationMs: 1,
      exitCode: 0,
      startedAt: now,
      status: "completed",
      stderr: { bytes: 0, text: "", truncated: false },
      stdout: { bytes: 2, text: "ok", truncated: false },
      timedOut: false,
    };
  }

  it("injects both identity groups so ZODY plugin templates expand in the shell", async () => {
    let capturedRequest: Parameters<ExecutionPort["run"]>[0] | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return completedResult();
      },
    };
    const content = '```!\necho "${ZODY_PLUGIN_ROOT}/a" "${ZODY_PLUGIN_DATA}/b"\n```';

    const output = await expandCustomCommandShellSyntax({
      command: customCommand(content, { plugin: pluginContext }),
      content,
      executionPort,
      sessionId: "session-1",
      workingDirectory: "/workspace",
    });

    expect(output).toBe("ok");
    expect(capturedRequest?.env?.set).toMatchObject({
      CLAUDE_PLUGIN_DATA: pluginContext.dataPath,
      CLAUDE_PLUGIN_ROOT: pluginContext.rootPath,
      ZCODE_PLUGIN_DATA: pluginContext.dataPath,
      ZCODE_PLUGIN_ID: pluginContext.id,
      ZCODE_PLUGIN_NAME: pluginContext.name,
      ZCODE_PLUGIN_ROOT: pluginContext.rootPath,
      ZODY_PLUGIN_DATA: pluginContext.dataPath,
      ZODY_PLUGIN_ID: pluginContext.id,
      ZODY_PLUGIN_NAME: pluginContext.name,
      ZODY_PLUGIN_ROOT: pluginContext.rootPath,
    });
    const envSet = capturedRequest?.env?.set ?? {};
    expect(envSet.ZODY_PLUGIN_ROOT).toBe(envSet.ZCODE_PLUGIN_ROOT);
    expect(envSet.ZODY_PLUGIN_DATA).toBe(envSet.ZCODE_PLUGIN_DATA);

    // 宿主继承环境里的冲突值被 overlay 覆盖（set 后写入），两套组都不能被分别改写。
    const merged = {
      ZCODE_PLUGIN_ROOT: "/host/zcode-root",
      ZODY_PLUGIN_ROOT: "/host/zody-root",
      ...envSet,
    };
    expect(merged.ZODY_PLUGIN_ROOT).toBe(pluginContext.rootPath);
    expect(merged.ZCODE_PLUGIN_ROOT).toBe(pluginContext.rootPath);
  });

  it("rejects ZODY plugin templates without a plugin context instead of expanding empty", async () => {
    const content = '```!\necho "${ZODY_PLUGIN_ROOT}/a"\n```';
    await expect(
      expandCustomCommandShellSyntax({
        command: customCommand(content, { source: "zcode" }),
        content,
        executionPort: {
          async run() {
            return completedResult();
          },
        },
        sessionId: "session-1",
        workingDirectory: "/workspace",
      }),
    ).rejects.toThrow(/requires a plugin context: ZODY_PLUGIN_ROOT/);
  });
});
