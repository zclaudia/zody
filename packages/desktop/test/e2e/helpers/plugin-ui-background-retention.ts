import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  DEFAULT_PLUGIN_MARKETPLACES,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
} from "@zody/shared";
import { clickTestIdByDom, getE2EAppDataPaths } from "./desktop-app.js";
import {
  clickPluginControl,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginList,
} from "./plugin-management-lifecycle.js";

/**
 * F18⑤（上游 a60ba6a7 / docs/plugin-ui-background-execution.md §12.8）：
 * 带 `_meta.ui.backgroundRetention` 两态 `ui://` 资源的插件 MCP fixture。
 * 与 plugin-runtime-env-agent 同构（本地目录市场 + 手写 stdio JSON-RPC server），
 * 额外暴露 resources/read（HTML + 资源级 `_meta`）与带 `_meta.ui.resourceUri` 的工具，
 * 使真实产品链路（agent display 投影 → renderer prepareSandbox → Main registry →
 * 句柄 resourceMeta → 保留策略）完整可达。
 */

export const PLUGIN_UI_RETENTION_MARKETPLACE_ID = "e2e-plugin-ui-retention-market";
export const PLUGIN_UI_RETENTION_NAME = "e2e-plugin-ui-retention";
export const PLUGIN_UI_RETENTION_ID = `${PLUGIN_UI_RETENTION_NAME}@${PLUGIN_UI_RETENTION_MARKETPLACE_ID}`;
export const PLUGIN_UI_RETENTION_SERVER = "retention-demo";
export const PLUGIN_UI_RETENTION_URI_RETAINED = "ui://e2e-plugin-ui-retention/retained";
export const PLUGIN_UI_RETENTION_URI_PLAIN = "ui://e2e-plugin-ui-retention/plain";
/** 工具命名空间形态：mcp__plugin_<pluginName>_<serverKey>__<toolName>（与 PLM-LC-010 先例一致）。 */
export const PLUGIN_UI_RETENTION_TOOL_RETAINED = `mcp__plugin_${PLUGIN_UI_RETENTION_NAME}_${PLUGIN_UI_RETENTION_SERVER}__retained_app`;
export const PLUGIN_UI_RETENTION_TOOL_PLAIN = `mcp__plugin_${PLUGIN_UI_RETENTION_NAME}_${PLUGIN_UI_RETENTION_SERVER}__plain_app`;
export const PLUGIN_UI_RETENTION_TOOL_SLOW = `mcp__plugin_${PLUGIN_UI_RETENTION_NAME}_${PLUGIN_UI_RETENTION_SERVER}__slow_retained_app`;
export const PLUGIN_UI_RETENTION_RESULT_MARKER = "E2E_PLUGIN_UI_RETENTION_APP_READY";
export const PLUGIN_UI_RETENTION_SLOW_DONE_MARKER = "E2E_PLUGIN_UI_RETENTION_SLOW_DONE";
/** slow 工具挂起时长：覆盖「调用进行中」观察窗，又远小于 case 超时。 */
export const PLUGIN_UI_RETENTION_SLOW_DELAY_MS = 8000;

export interface PluginUiRetentionFixture {
  marketplaceRoot: string;
}

export async function createPluginUiRetentionFixture(): Promise<PluginUiRetentionFixture> {
  const { homeDir } = getE2EAppDataPaths();
  await primeDefaultPluginMarketplacesForE2E(homeDir);
  const marketplaceRoot = join(homeDir, "fixtures", PLUGIN_UI_RETENTION_MARKETPLACE_ID);
  const pluginRoot = join(marketplaceRoot, "plugins", PLUGIN_UI_RETENTION_NAME);
  await rm(marketplaceRoot, { force: true, recursive: true });

  // guest 必须完成 app-bridge ui/initialize 握手，否则 host 在 60s 后按
  // "plugin-ui: ui/initialize handshake timed out" 进入 error 并回收页面。
  // 与 mcp-apps-host-e2e.mjs 同款：esbuild 把 @modelcontextprotocol/ext-apps 的
  // App 入口 bundle 成内联脚本嵌进 ui:// HTML（沙箱 iframe 无模块加载通道）。
  const guestScripts = await buildRetentionGuestScripts();

  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    name: PLUGIN_UI_RETENTION_NAME,
    version: "1.0.0",
    description:
      "E2E fixture: ui:// plugin resources with two-state backgroundRetention declaration",
    mcpServers: {
      [PLUGIN_UI_RETENTION_SERVER]: {
        type: "stdio",
        command: "node",
        args: ["${ZCODE_PLUGIN_ROOT}/server.mjs"],
      },
    },
  });
  await writeText(join(pluginRoot, "server.mjs"), buildRetentionServerSource(guestScripts));
  await writeJson(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: PLUGIN_UI_RETENTION_MARKETPLACE_ID,
    description: "E2E Plugin UI Background Retention Market",
    plugins: [
      {
        name: PLUGIN_UI_RETENTION_NAME,
        version: "1.0.0",
        description:
          "E2E fixture: ui:// plugin resources with two-state backgroundRetention declaration",
        source: `./plugins/${PLUGIN_UI_RETENTION_NAME}`,
      },
    ],
  });

  return { marketplaceRoot };
}

/**
 * 安装并启用两态资源插件。修复依据（2026-11-08 实测）：PLM-LC-010 时代的「detail 页
 * plugin-store-enabled-switch」随设置页改版漂移——商店目录形态的详情卡在安装后不渲染
 * enabled 开关（item.info 缺失）；本仓当前真实入口是已安装列表行内的
 * `plugin-settings-enabled-switch`（PluginsSection.tsx）。因此这里不打开详情页，
 * 直接在商店卡片上安装，然后回到已安装行完成启用。
 */
export async function installAndEnableRetentionPluginThroughUi(): Promise<void> {
  // 修复依据（2026-11-08 实测）：添加本地来源后 UI 已自动停在个人市场分区（aria-pressed=true），
  // 无条件点击会撞上标题元素被拦截；只有未激活时才切个人分区。
  const personalActive = await browser.execute(() => {
    const segment = document.querySelector<HTMLElement>(
      '[data-testid="plugin-store-segment-personal"]',
    );
    return segment?.getAttribute("aria-pressed") === "true";
  });
  if (!personalActive) {
    await clickPluginControl("plugin-store-segment-personal");
  }
  await waitForPluginCard(PLUGIN_UI_RETENTION_ID, 30000);
  await clickPluginControl("plugin-store-install", { pluginId: PLUGIN_UI_RETENTION_ID });
  // 已安装条出现 = 安装落库（后端 installPlugin 完成、商店投影合并）；再进「管理已安装」
  // 视图操作行内启用开关（plugin-settings-* 行只在管理视图渲染，不在商店列表）。
  await waitForPluginControl(
    "plugin-store-installed-item",
    { pluginId: PLUGIN_UI_RETENTION_ID },
    120000,
  );
  await clickPluginControl("plugin-store-manage-open");
  await waitForPluginControl(
    "plugin-settings-plugin-row",
    { pluginId: PLUGIN_UI_RETENTION_ID },
    30000,
  );
  const rowEnabled = async () =>
    browser.execute(
      (id, pluginId) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => candidate.dataset.testid === id && candidate.dataset.pluginId === pluginId,
        );
        return element?.getAttribute("data-state") === "checked";
      },
      "plugin-settings-enabled-switch",
      PLUGIN_UI_RETENTION_ID,
    );
  await waitForPluginControl(
    "plugin-settings-enabled-switch",
    { pluginId: PLUGIN_UI_RETENTION_ID },
    30000,
  );
  if (!(await rowEnabled())) {
    await clickPluginControl("plugin-settings-enabled-switch", {
      pluginId: PLUGIN_UI_RETENTION_ID,
    });
  }
  await waitUntilPluginList(
    (list) => list.plugins.some((plugin) => plugin.id === PLUGIN_UI_RETENTION_ID && plugin.enabled),
    `Plugin enabled state did not become true: ${PLUGIN_UI_RETENTION_ID}`,
  );
  // 会话断言前必须离开设置页（prepareV4ConversationE2E 的 waitForDefaultWorkspaceReady
  // 只认主界面工作区视图；与 PLM-LC-010 的 settings back 先例一致）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const settingsVisible = await browser.execute(
      (pageId) => Boolean(document.querySelector(`[data-testid="${pageId}"]`)),
      TID_SETTINGS_PAGE,
    );
    if (!settingsVisible) break;
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await browser.pause(500);
  }
}

/** renderer DOM 里的插件 UI 页面观察点（真实产品锚点/承载层语义，无测试专用钩子）。 */
export interface PluginUiSurfaceObservation {
  src: string | null;
  inParking: boolean;
  display: string | null;
  opacity: string | null;
}

export async function readPluginUiSurfaces(): Promise<PluginUiSurfaceObservation[]> {
  return browser.execute(() => {
    const views = Array.from(document.querySelectorAll('[data-testid="plugin-ui-webview"]'));
    return views.map((view) => {
      const container = view.closest<HTMLElement>("[data-sandbox-page-root]");
      const style = container ? getComputedStyle(container) : null;
      return {
        src: view.getAttribute("src"),
        inParking: Boolean(container && container.closest("[data-sandbox-page-parking]")),
        display: style ? style.display : null,
        opacity: style ? style.opacity : null,
      };
    });
  });
}

/** 每个 webview 的 shell 里插件 iframe 是否仍挂载（guest 未 teardown 的直接证据）。 */
export async function readPluginUiGuestFrames(): Promise<boolean[]> {
  const frames = (await browser.executeAsync(
    // webview.executeJavaScript 是 Electron 宿主元素 API；沙箱 guest 本体跨源不可读，
    // 这里只验证受信 shell 里插件 iframe 的存在性（mount/unmount 的承载语义）。
    (done: (result: boolean[]) => void) => {
      const views = Array.from(document.querySelectorAll('[data-testid="plugin-ui-webview"]'));
      void Promise.all(
        views.map(async (view) => {
          try {
            return Boolean(
              await (
                view as unknown as { executeJavaScript(script: string): Promise<unknown> }
              ).executeJavaScript("Boolean(document.querySelector('iframe'))"),
            );
          } catch {
            return false;
          }
        }),
      ).then(
        (results) => done(results),
        () => done([]),
      );
    },
  )) as boolean[];
  return frames;
}

async function primeDefaultPluginMarketplacesForE2E(homeDir: string): Promise<void> {
  // 与 plugin-runtime-env-agent.ts 同款：默认市场必须标记为已加载，否则设置页会并发 clone
  // GitHub 官方市场并占住插件协议请求，本地市场添加弹窗无法收尾。
  const path = join(homeDir, ".zody", "cli", "plugins", "known_marketplaces.json");
  const { readFile } = await import("node:fs/promises");
  let existing: Array<Record<string, unknown> & { id: string; pluginCount?: number }> = [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { marketplaces?: unknown };
    if (Array.isArray(parsed.marketplaces))
      existing = parsed.marketplaces.filter(
        (record): record is Record<string, unknown> & { id: string; pluginCount?: number } =>
          typeof record === "object" &&
          record !== null &&
          typeof (record as { id?: unknown }).id === "string",
      );
  } catch {
    existing = [];
  }
  const now = new Date().toISOString();
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const marketplace of DEFAULT_PLUGIN_MARKETPLACES) {
    const current = byId.get(marketplace.id);
    byId.set(marketplace.id, {
      ...(current ?? {
        addedAt: now,
        id: marketplace.id,
        name: marketplace.name,
        source: marketplace.source.includes(":")
          ? { source: "url", url: marketplace.source }
          : { repo: marketplace.source, source: "github" },
      }),
      lastUpdated: current?.lastUpdated ?? now,
      pluginCount: Math.max(1, current?.pluginCount ?? marketplace.pluginCount),
    });
  }
  await writeJson(path, { version: 1, marketplaces: [...byId.values()] });
}

function buildRetentionPageHtml(kind: "RETAINED" | "PLAIN", guestScript: string): string {
  // 页面内容供人工 review 截图判读（rAF ticker 证明保留页在后台仍可执行；
  // 断言本身只依赖 renderer 承载层语义，不读取 guest 内部状态）。
  // guestScript 是 ext-apps App 的内联 bundle，负责完成 ui/initialize 握手。
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:monospace;padding:12px">
<div id="kind">E2E-PLUGIN-UI-${kind}-PAGE</div>
<div id="ticks">0</div>
<script>${guestScript.replaceAll("</script", "<\\/script")}</script>
</body></html>`;
}

async function buildRetentionGuestScripts(): Promise<{ retained: string; plain: string }> {
  const require = createRequire(import.meta.url);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const extApps = require.resolve("@modelcontextprotocol/ext-apps", {
    paths: [join(repoRoot, "packages/ui")],
  });
  const { build } = await import("esbuild");
  const bundle = async (kind: string) => {
    const result = await build({
      stdin: {
        contents: [
          `import { App } from "@modelcontextprotocol/ext-apps";`,
          `const app = new App({ name: "e2e-plugin-ui-retention-${kind}", version: "1.0.0" }, { tools: {} });`,
          `// 修复依据：ui/initialize 握手必须显式 connect()（host fixture widget.tsx 同款）；`,
          `// 只构造不连接会让 host 侧停在 mounted，60s 后按握手超时进入 error 并回收页面。`,
          `app.connect().catch((error) => {`,
          `  const el = document.getElementById("ticks");`,
          `  if (el) el.textContent = "connect-failed:" + String(error);`,
          `});`,
          `let n = 0;`,
          `const tick = () => { n += 1; const el = document.getElementById("ticks"); if (el) el.textContent = String(n); requestAnimationFrame(tick); };`,
          `requestAnimationFrame(tick);`,
        ].join("\n"),
        resolveDir: repoRoot,
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      alias: { "@modelcontextprotocol/ext-apps": extApps },
      logLevel: "warning",
    });
    return result.outputFiles[0]!.text;
  };
  const [retained, plain] = await Promise.all([bundle("retained"), bundle("plain")]);
  return { retained, plain };
}

function buildRetentionServerSource(guestScripts: { retained: string; plain: string }): string {
  return `#!/usr/bin/env node
// F18⑤ fixture：ui:// 两态资源 + 声明 resourceUri 的工具（手写 stdio JSON-RPC，无外部依赖）。
// resources/read 返回 text/html + 资源级 _meta：
//   retained 资源 _meta.ui.backgroundRetention = true（声明保留）
//   plain    资源无该键（默认隐藏即停）
import readline from "node:readline";
const RETAINED_URI = ${JSON.stringify(PLUGIN_UI_RETENTION_URI_RETAINED)};
const PLAIN_URI = ${JSON.stringify(PLUGIN_UI_RETENTION_URI_PLAIN)};
const RESULT_MARKER = ${JSON.stringify(PLUGIN_UI_RETENTION_RESULT_MARKER)};
const SLOW_DONE_MARKER = ${JSON.stringify(PLUGIN_UI_RETENTION_SLOW_DONE_MARKER)};
const SLOW_DELAY_MS = ${String(PLUGIN_UI_RETENTION_SLOW_DELAY_MS)};
const pages = {
  [RETAINED_URI]: { html: ${JSON.stringify(buildRetentionPageHtml("RETAINED", guestScripts.retained))}, meta: { ui: { backgroundRetention: true } } },
  [PLAIN_URI]: { html: ${JSON.stringify(buildRetentionPageHtml("PLAIN", guestScripts.plain))}, meta: { ui: {} } },
};
const input = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "e2e-plugin-ui-retention", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    const base = { inputSchema: { type: "object", properties: { job: { type: "string" }, delayed: { type: "boolean" } } }, annotations: { readOnlyHint: true } };
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { ...base, name: "retained_app", description: "Open the retained ui:// app page", _meta: { ui: { resourceUri: RETAINED_URI } } },
      { ...base, name: "plain_app", description: "Open the plain ui:// app page", _meta: { ui: { resourceUri: PLAIN_URI } } },
      { ...base, name: "slow_retained_app", description: "Open the retained ui:// app page after a slow tool round", _meta: { ui: { resourceUri: RETAINED_URI } } },
    ] } });
    return;
  }
  if (request.method === "tools/call") {
    const tool = request.params?.name ?? "";
    const job = String(request.params?.arguments?.job ?? "");
    const respondWith = (text) => send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }], structuredContent: { job, tool } } });
    if (tool === "retained_app" || tool === "plain_app") { respondWith(RESULT_MARKER + ":" + job); return; }
    if (tool === "slow_retained_app") { setTimeout(() => respondWith(SLOW_DONE_MARKER + ":" + job), SLOW_DELAY_MS); return; }
    respondWith("unknown-tool:" + tool);
    return;
  }
  if (request.method === "resources/read") {
    const uri = request.params?.uri ?? "";
    const page = pages[uri];
    if (!page) { send({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "Unknown resource " + uri } }); return; }
    send({ jsonrpc: "2.0", id: request.id, result: { contents: [{ uri, mimeType: "text/html", text: page.html, _meta: page.meta }] } });
    return;
  }
  if (request.method === "resources/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resources: Object.entries(pages).map(([uri, page]) => ({ uri, mimeType: "text/html", _meta: page.meta })) } });
    return;
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}
