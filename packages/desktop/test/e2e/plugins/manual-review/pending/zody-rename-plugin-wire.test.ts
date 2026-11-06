import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import { createE2EReplayFixtureVariables } from "../../../helpers/e2e-runtime-paths.js";
import { DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY } from "../../../helpers/network-capture-proxy.js";
import { requirePluginManualReview } from "../../../helpers/plugin-management-lifecycle.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "../../../helpers/upstream-replay-server.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

/**
 * RENAME-PLUGIN-WIRE：插件 wire 双命名空间在真实 sandbox 中的副作用计数。
 *
 * 本文件由 R51 独占编写（唯一写者），R52/R53 只交付边界数据与断言需求：
 * - 已实现：Gen UI 页面的旧/新/迁移三态（window.zcode / window.zody 同一 API、
 *   `zcode:set_globals`/`zody:set_globals` 双名投影、保存一次、follow-up 一次、外链打开一次）。
 * - 待 R52 边界数据：MCP Apps 资源 `_meta` 双键等值与冲突（见文末 skip）。
 * - 待 R53 边界数据：CLI tool result 的 errorPresentation/CUA 双键读取（见文末 skip）。
 *
 * 边界：`zcode:globals`/`zody:globals` 由 alias 运行时（插件页）派发，Gen UI 页只收到
 * `set_globals` 族，因此 `:globals` 双名派发不在本用例覆盖范围（见 R51.md D 档）。
 *
 * 手势：宿主对 follow-up 与外链都要求沙箱内真实用户手势（guest `input-event` 标记、TTL 内一次消费），
 * 页面脚本不能自造。E2E 从 main process 向 guest 注入 mouseDown/mouseUp，页面只在收到手势后各执行一次。
 *
 * 执行状态：**未执行，归 R56**。R56 具备真实 Electron + 官方插件集后运行本用例；
 * 缺项按任务卡退回 R51（用例/fixture 缺项）或 R52/R53（边界数据缺项）。
 */

const CASE_NAME = "zody-rename-plugin-wire";
const CASE_ARTIFACT_DIR = join(process.cwd(), ".e2e-artifacts", "plugin-management", "rpl-wire");
const CASE_TIMEOUT_MS = 240_000;

interface WireVariant {
  /** 用例 marker；同时出现在用户 prompt 与 provider fixture 的 matcher 中。 */
  marker: string;
  /** Gen UI 片段文件名（lowercase-hyphenated，满足 genUiPathSchema）。 */
  file: string;
  title: string;
  /** 页面使用的别名入口：旧插件只认 zcode，新插件只认 zody，迁移插件用 zody（并与 zcode 同对象）。 */
  alias: "zcode" | "zody";
  /** 页面监听的 set_globals 事件名。 */
  events: ReadonlyArray<"zcode:set_globals" | "zody:set_globals">;
  /** 期望观察到的命名空间：旧插件只应看到旧名，新插件只应看到新名，迁移插件两者相等且都非零。 */
  listens: "legacy" | "canonical" | "both";
}

const VARIANTS: ReadonlyArray<WireVariant> = [
  {
    marker: "E2E_RENAME_PLUGIN_WIRE_OLD",
    file: "rename-wire-old.html",
    title: "Rename wire old plugin",
    alias: "zcode",
    events: ["zcode:set_globals"],
    listens: "legacy",
  },
  {
    marker: "E2E_RENAME_PLUGIN_WIRE_NEW",
    file: "rename-wire-new.html",
    title: "Rename wire new plugin",
    alias: "zody",
    events: ["zody:set_globals"],
    listens: "canonical",
  },
  {
    marker: "E2E_RENAME_PLUGIN_WIRE_MIGRATED",
    file: "rename-wire-migrated.html",
    title: "Rename wire migrated plugin",
    alias: "zody",
    events: ["zcode:set_globals", "zody:set_globals"],
    listens: "both",
  },
];

let replayServer: UpstreamReplayServer | null = null;
let genUiOutputRoot = "";
let genUiStateRoot = "";
let shellOpenExternal: Awaited<ReturnType<typeof browser.electron.mock>> | null = null;

describe("RENAME-PLUGIN-WIRE 插件 wire 双命名空间", () => {
  before(async function () {
    this.timeout(CASE_TIMEOUT_MS);
    requirePluginManualReview();
    const { appDataDir } = getE2EAppDataPaths();
    genUiOutputRoot = join(appDataDir, "visualizations");
    genUiStateRoot = join(appDataDir, "gen-ui-state");
    await mkdir(genUiOutputRoot, { recursive: true });
    // provider fixture 的 visualize 指令需要运行时的 Gen UI 输出根目录；同名 token 同时在
    // wdio 全局 replay server（只有 e2eRuntimeRoot）与 spec 级 server 中展开，本用例显式启动
    // spec 级 server 并覆盖 provider 回放环境变量，与 conversation-session 的 replay 用法一致。
    await mkdir(CASE_ARTIFACT_DIR, { recursive: true });
    replayServer = await startUpstreamReplayServer({
      artifactPath: join(CASE_ARTIFACT_DIR, `${CASE_NAME}.replay.json`),
      fixturePaths: [
        fileURLToPath(new URL("../../fixtures/upstream/common.json", import.meta.url)),
        fileURLToPath(
          new URL(
            "../../fixtures/upstream/plugin-management/zody-rename-plugin-wire.json",
            import.meta.url,
          ),
        ),
      ],
      fixtureVariables: {
        ...createE2EReplayFixtureVariables(),
        genUiOutputRoot: genUiOutputRoot.replaceAll("\\", "/"),
      },
    });
    process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
    process.env.E2E_PROVIDER_CAPTURE_PATH = replayServer.artifactPath;
    process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = replayServer.baseUrl;
    process.env.E2E_PROVIDER_EXPECTED_HOST = `${replayServer.host}:${replayServer.port}`;
    process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http";
    process.env.E2E_PROVIDER_RUNTIME_BASE_URL = replayServer.baseUrl;
    process.env.NO_PROXY = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
    process.env.no_proxy = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
    await prepareV4ConversationE2E();
    await Promise.all(
      VARIANTS.map((variant) =>
        writeFile(join(genUiOutputRoot, variant.file), buildFragment(variant), "utf8"),
      ),
    );
    // 外链经平台桥落到 main 的 shell.openExternal；mock 之后只断言打开次数与 URL。
    shellOpenExternal = await browser.electron.mock("shell", "openExternal");
    await shellOpenExternal.mockResolvedValue(undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await replayServer?.stop();
    replayServer = null;
    await clearAppData();
  });

  it("旧/新/迁移页面保存与 follow-up 各一次，外链恰打开一次，事件名按页面声明生效", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    let openedExpected = 0;
    for (const variant of VARIANTS) {
      openedExpected += 1;
      await sendV4Prompt(
        `${variant.marker}: 只回复一个 Gen UI 引用，不要解释。` +
          `可视化文件是 ${join(genUiOutputRoot, variant.file)}。`,
      );
      await waitForV4Pane(
        (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${variant.marker}_DONE`),
        `${variant.marker} turn 没有完成`,
        90_000,
      );

      // 页面挂载并在首个 globals 投影后保存一次；状态落盘是"页面已运行"的唯一事实来源。
      const saved = await waitForGenUiState(join(genUiOutputRoot, variant.file), 60_000);
      expect(saved.modelContent).toMatchObject({ marker: variant.marker, sameAlias: true });

      // 第一次真实手势：页面发送唯一一次 follow-up。
      expect(await gestureGuest(variant.marker)).toBe(true);
      const pane = await waitForV4Pane(
        (snapshot) => snapshot.timelineText.includes(`${variant.marker}_FOLLOWUP`),
        `${variant.marker} 的 Gen UI 页面没有发出 follow-up`,
        60_000,
      );
      expect(countOccurrences(pane.timelineText, `${variant.marker}_FOLLOWUP`)).toBe(1);

      // 第二次真实手势：页面打开一次外链（宿主每次操作独立消费一次手势）。
      expect(await gestureGuest(variant.marker)).toBe(true);
      const openUrl = openExternalUrl(variant);
      await browser.waitUntil(
        async () => {
          try {
            expect(shellOpenExternal).toHaveBeenCalledTimes(openedExpected);
            expect(shellOpenExternal).toHaveBeenCalledWith(openUrl);
            return true;
          } catch {
            return false;
          }
        },
        {
          timeout: 30_000,
          interval: 250,
          timeoutMsg: `${variant.marker} 的外链没有恰好打开一次: ${openUrl}`,
        },
      );

      const observed = saved.modelContent?.observed as
        | { legacy: number; canonical: number }
        | undefined;
      expect(observed).toBeDefined();
      if (variant.listens === "legacy") {
        // 旧插件只监听旧名：旧名有投影，新名即使被派发也不进入它的计数。
        expect(observed!.legacy).toBeGreaterThan(0);
        expect(observed!.canonical).toBe(0);
      } else if (variant.listens === "canonical") {
        expect(observed!.canonical).toBeGreaterThan(0);
        expect(observed!.legacy).toBe(0);
      } else {
        // 迁移插件同时监听两名：同一次投影各派发一次，计数相等且非零。
        expect(observed!.legacy).toBe(observed!.canonical);
        expect(observed!.legacy).toBeGreaterThan(0);
      }
    }
  });

  it.skip("MCP Apps 资源 _meta 双键等值与冲突可见（待 R52 边界数据，R56 执行）", () => {
    // R52 在报告中交付旧/新/迁移插件的资源 _meta 形状与冲突样例后，由 R51 汇总进本用例。
  });

  it.skip("CLI tool result errorPresentation/CUA 双键读取（待 R53 边界数据，R56 执行）", () => {
    // R53 在报告中交付 canonical/legacy/冲突的 tool result fixture 后，由 R51 汇总进本用例。
  });
});

function openExternalUrl(variant: WireVariant): string {
  return `https://example.com/rename-wire/${variant.file}`;
}

/**
 * 生成真实 Gen UI 片段：只使用页面侧别名 API 与页内 `set_globals` 事件。
 * 首个投影到达后用 microtask 汇总两名计数再保存，保证双名派发在同一同步栈内完成；
 * follow-up 与外链各等一次注入手势，不做超时兜底（避免用超时掩盖同步失败）。
 */
function buildFragment(variant: WireVariant): string {
  return `<div data-rename-wire="${variant.marker}">${variant.marker}</div>
<script>
(() => {
  const marker = ${JSON.stringify(variant.marker)};
  const alias = ${JSON.stringify(variant.alias)};
  const events = ${JSON.stringify(variant.events)};
  const openUrl = ${JSON.stringify(openExternalUrl(variant))};
  const observed = { legacy: 0, canonical: 0 };
  const api = window[alias];
  let savePromise = null;
  let gestures = 0;
  const payload = () => ({
    marker,
    alias,
    sameAlias: window.zody === window.zcode,
    observed: { legacy: observed.legacy, canonical: observed.canonical },
  });
  for (const name of events) {
    window.addEventListener(name, () => {
      if (name === "zcode:set_globals") observed.legacy += 1;
      else observed.canonical += 1;
      if (savePromise) return;
      // 同一次 update 内先派发旧名再派发新名；microtask 在两者都完成后才取计数。
      savePromise = Promise.resolve().then(() =>
        api.setWidgetState({ modelContent: payload(), privateContent: null }),
      );
    });
  }
  window.addEventListener("mousedown", () => {
    gestures += 1;
    if (gestures === 1) {
      if (!savePromise) return;
      void Promise.resolve(savePromise)
        .then(() =>
          api.sendFollowUpMessage({ prompt: marker + "_FOLLOWUP " + JSON.stringify(payload()) }),
        )
        .catch((error) => {
          document.title = "rename-wire-followup-error:" + String(error);
        });
    }
    if (gestures === 2) {
      api.openExternal({ href: openUrl });
    }
  });
})();
</script>`;
}

/**
 * 向持有该片段的 guest webContents 注入一次真实鼠标手势（main process 的 `input-event`
 * 会为沙箱登记一次性用户手势，宿主 follow-up / open-link 各消费一次）。
 */
async function gestureGuest(marker: string): Promise<boolean> {
  return browser.electron.execute(async (electron, expected: string) => {
    const guests = electron.webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "webview");
    for (const guest of guests) {
      try {
        const matched = await guest.executeJavaScript(
          `document.querySelector("[data-rename-wire]")?.getAttribute("data-rename-wire") === ${JSON.stringify(expected)}`,
          true,
        );
        if (matched !== true) continue;
      } catch {
        continue;
      }
      // 手势标记来自 guest 的真实 input-event；先聚焦再注入，避免后台窗口丢弃输入。
      guest.focus();
      guest.sendInputEvent({ type: "mouseDown", x: 8, y: 8, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: 8, y: 8, button: "left", clickCount: 1 });
      return true;
    }
    return false;
  }, marker);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForGenUiState(
  path: string,
  timeout: number,
): Promise<{ modelContent?: Record<string, unknown> }> {
  let latest: { modelContent?: Record<string, unknown> } | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readGenUiState(path);
      return latest !== null;
    },
    { timeout, interval: 500, timeoutMsg: `Gen UI 状态没有落盘: ${path}` },
  );
  if (!latest) throw new Error(`Gen UI 状态没有落盘: ${path}`);
  return latest;
}

/** Gen UI 状态按 scope 散列到子目录；按 target.path 精确匹配本次页面的记录。 */
async function readGenUiState(
  path: string,
): Promise<{ modelContent?: Record<string, unknown> } | null> {
  const entries = await readdir(genUiStateRoot, { recursive: true }).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(join(genUiStateRoot, entry), "utf8")) as {
      target?: { path?: string };
      state?: { modelContent?: Record<string, unknown> };
    };
    if (record.target?.path === path) return record.state ?? null;
  }
  return null;
}
