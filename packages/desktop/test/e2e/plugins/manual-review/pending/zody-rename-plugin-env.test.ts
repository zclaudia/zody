import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import {
  addMarketplaceSourceThroughUi,
  clickPluginControl,
  getPluginList,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  setPluginEnabledThroughUi,
  waitForPluginCard,
} from "../../../helpers/plugin-management-lifecycle.js";
import { prepareV4ConversationE2E, sendV4Prompt } from "../../../helpers/v4-conversation.js";

/**
 * RENAME-PLUGIN-ENV：真实宿主下插件子进程、hook 与模板展开的两套身份 env。
 *
 * 本文件由 R55 独占编写（唯一写者）：只消费 R55 spec 的 §S1–§S3，不复制 R51 wire 用例，
 * 也不重复 `plugin-runtime-env-agent-projection` 的 secret env/agent 投影场景。
 * - MCP 子进程：manifest 故意用伪造身份预占两套键；`${ZODY_PLUGIN_ROOT}` 模板必须展开，
 *   服务器才能启动并写出身份报告；最终两套值必须等于真实插件上下文。
 * - hook：SessionStart 命令路径同样使用 `${ZODY_PLUGIN_ROOT}`，脚本写出的两套值必须同源。
 * - 外部/ manifest 冲突：伪造值不得出现在任一组；普通自定义 env 保留。
 *
 * 执行状态：**未执行，归 R56**。本用例不消费上游模型响应（case fixture
 * `providerRequestPolicy: "none"`），只等待 MCP 初始化与 SessionStart hook 落盘。
 * 缺 fixture 或脚本退回 R55，不由 R56 越界补实现。
 */

const MARKETPLACE_ID = "zody-rename-env-market";
const PLUGIN_NAME = "zody-rename-env-plugin";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_ID}`;
const FORGED_ROOT_ZODY = "/forged/zody-root";
const FORGED_ROOT_ZCODE = "/forged/zcode-root";
const FORGED_DATA = "/forged/plugin-data";
const FORGED_ID = "forged@evil-market";
const CASE_TIMEOUT_MS = 240_000;
const REPORT_TIMEOUT_MS = 90_000;

interface IdentityReport {
  CLAUDE_PLUGIN_DATA?: string;
  CLAUDE_PLUGIN_ROOT?: string;
  ZCODE_PLUGIN_DATA?: string;
  ZCODE_PLUGIN_ID?: string;
  ZCODE_PLUGIN_NAME?: string;
  ZCODE_PLUGIN_ROOT?: string;
  ZODY_PLUGIN_DATA?: string;
  ZODY_PLUGIN_ID?: string;
  ZODY_PLUGIN_NAME?: string;
  ZODY_PLUGIN_ROOT?: string;
}

describe("RENAME-PLUGIN-ENV 插件双组身份 env 与模板展开", () => {
  after(async () => {
    await clearAppData();
  });

  it("MCP 子进程与 hook 的两套身份同源，且 manifest 伪造值不生效", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    requirePluginManualReview();

    const marketplaceRoot = await seedEnvIdentityMarketplace();
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await addMarketplaceSourceThroughUi(marketplaceRoot);
    await waitForPluginCard(PLUGIN_ID, 60_000);
    await openPluginCard(PLUGIN_ID);
    await installPluginThroughUi(PLUGIN_ID);
    await setPluginEnabledThroughUi(PLUGIN_ID, true, "detail");

    const installed = (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_ID);
    const installedRoot = installed?.rootPath;
    expect(installedRoot).toBeTruthy();
    if (!installedRoot) return;

    // 新会话的首轮会先初始化插件 MCP 并触发 SessionStart hook；两者都不依赖模型响应。
    await prepareV4ConversationE2E();
    const marker = `E2E_ZODY_RENAME_PLUGIN_ENV_${Date.now()}`;
    await sendV4Prompt(`${marker}: reply with plugin-env-check`);

    const mcpReport = await waitForIdentityReport(join(installedRoot, "mcp-env.json"));
    const hookReport = await waitForIdentityReport(join(installedRoot, "hook-env.json"));

    // 模板 `${ZODY_PLUGIN_ROOT}` 未展开时 MCP/hook 脚本都不会执行，报告文件也不会出现。
    for (const report of [mcpReport, hookReport]) {
      expect(report.ZODY_PLUGIN_ROOT).toBe(installedRoot);
      expect(report.ZCODE_PLUGIN_ROOT).toBe(installedRoot);
      expect(report.CLAUDE_PLUGIN_ROOT).toBe(installedRoot);
      expect(report.ZODY_PLUGIN_ID).toBe(PLUGIN_ID);
      expect(report.ZCODE_PLUGIN_ID).toBe(PLUGIN_ID);
      expect(report.ZODY_PLUGIN_NAME).toBe(PLUGIN_NAME);
      expect(report.ZCODE_PLUGIN_NAME).toBe(PLUGIN_NAME);
      expect(report.ZODY_PLUGIN_DATA).toBe(report.ZCODE_PLUGIN_DATA);
      expect(report.ZODY_PLUGIN_DATA).toBe(report.CLAUDE_PLUGIN_DATA);
      expect(report.ZODY_PLUGIN_DATA).toBeTruthy();

      // manifest 用伪造身份预占两套键；权威上下文必须覆盖，任一组都不能被分别改写。
      expect(report.ZODY_PLUGIN_ROOT).not.toBe(FORGED_ROOT_ZODY);
      expect(report.ZCODE_PLUGIN_ROOT).not.toBe(FORGED_ROOT_ZCODE);
      expect(report.ZODY_PLUGIN_DATA).not.toBe(FORGED_DATA);
      expect(report.ZCODE_PLUGIN_DATA).not.toBe(FORGED_DATA);
      expect(report.ZODY_PLUGIN_ID).not.toBe(FORGED_ID);
      expect(report.ZCODE_PLUGIN_ID).not.toBe(FORGED_ID);
    }
  });
});

async function seedEnvIdentityMarketplace(): Promise<string> {
  const { homeDir } = getE2EAppDataPaths();
  const marketplaceRoot = join(homeDir, "fixtures", MARKETPLACE_ID);
  const pluginRoot = join(marketplaceRoot, "plugins", PLUGIN_NAME);

  await writeJson(join(pluginRoot, ".zody-plugin", "plugin.json"), {
    description: "E2E plugin env identity and template expansion fixture",
    hooks: "hooks/hooks.json",
    mcpServers: {
      "identity-verifier": {
        type: "stdio",
        command: "node",
        args: ["${ZODY_PLUGIN_ROOT}/mcp-server.mjs"],
        env: {
          E2E_KEEP_CUSTOM_ENV: "kept",
          ZCODE_PLUGIN_DATA: FORGED_DATA,
          ZCODE_PLUGIN_ID: FORGED_ID,
          ZCODE_PLUGIN_ROOT: FORGED_ROOT_ZCODE,
          ZODY_PLUGIN_DATA: FORGED_DATA,
          ZODY_PLUGIN_ID: FORGED_ID,
          ZODY_PLUGIN_ROOT: FORGED_ROOT_ZODY,
        },
      },
    },
    name: PLUGIN_NAME,
    version: "1.0.0",
  });
  await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: 'node "${ZODY_PLUGIN_ROOT}/report-hook-env.mjs"',
            },
          ],
          matcher: "startup",
        },
      ],
    },
  });
  await writeText(join(pluginRoot, "mcp-server.mjs"), buildMcpIdentityServer());
  await writeText(join(pluginRoot, "report-hook-env.mjs"), buildHookIdentityReporter());
  await writeJson(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    description: "E2E plugin env identity marketplace",
    name: MARKETPLACE_ID,
    plugins: [
      {
        description: "E2E plugin env identity fixture",
        name: PLUGIN_NAME,
        source: `./plugins/${PLUGIN_NAME}`,
        version: "1.0.0",
      },
    ],
  });
  return marketplaceRoot;
}

async function waitForIdentityReport(path: string): Promise<IdentityReport> {
  const deadline = Date.now() + REPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf-8")) as IdentityReport;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Plugin identity report was not written: ${path}`);
}

function identityKeysSource(): string {
  return [
    "const names = [",
    '  "CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT",',
    '  "ZCODE_PLUGIN_DATA", "ZCODE_PLUGIN_ID", "ZCODE_PLUGIN_NAME", "ZCODE_PLUGIN_ROOT",',
    '  "ZODY_PLUGIN_DATA", "ZODY_PLUGIN_ID", "ZODY_PLUGIN_NAME", "ZODY_PLUGIN_ROOT"',
    "];",
  ].join("\n");
}

function buildMcpIdentityServer(): string {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
${identityKeysSource()}
const report = Object.fromEntries(names.map((name) => [name, process.env[name]]));
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "mcp-env.json"), JSON.stringify(report, null, 2));
const input = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zody-rename-env-server", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    return;
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

function buildHookIdentityReporter(): string {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
${identityKeysSource()}
const report = Object.fromEntries(names.map((name) => [name, process.env[name]]));
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "hook-env.json"), JSON.stringify(report, null, 2));
process.exit(0);
`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}
