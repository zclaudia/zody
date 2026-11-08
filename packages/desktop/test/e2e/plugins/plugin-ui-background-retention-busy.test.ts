// E2E-F18-02（docs/plugin-ui-background-execution.md §12.8）：忙时不回收。
// 声明页离屏（回收条件 armed：锚点卸载即登出可见性）后，同插件进行中的工具调用
// （slow_retained_app 挂起 8s）期间与完成后：页面保留（webview src 不变、执行表面
// 仍在）、慢调用的结果完整投递（回合终态由 final fixture 的 SLOW_DONE 前置保证）。
// 覆盖面登记（如实）：claim 层保留（后台 ≤4 拒绝预占）与结果投递完整性在 E2E 覆盖；
// 页面本地 busy 与 Agent 端 busy（pins ∪ uiSetExecutionActive，onlyIfIdle closed:false）
// 的拒绝路径由单测覆盖（packages/ui/src/plugin-ui/app/pluginUiBackgroundRetention.test.ts、
// pluginUiPageManager.test.ts），E2E 不注入时钟/不驱动 guest 内调用（避免为测试改产品代码）。
// 来源：上游 v3.17.1 a60ba6a7 F18。
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import { clearAppData } from "../helpers/desktop-app.js";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";
import {
  addMarketplaceSourceThroughUi,
  capturePluginManualReview,
  openPluginSettings,
  requirePluginManualReview,
  waitUntilPluginOverview,
} from "../helpers/plugin-management-lifecycle.js";
import {
  PLUGIN_UI_RETENTION_MARKETPLACE_ID,
  PLUGIN_UI_RETENTION_SLOW_DELAY_MS,
  PLUGIN_UI_RETENTION_TOOL_RETAINED,
  PLUGIN_UI_RETENTION_TOOL_SLOW,
  createPluginUiRetentionFixture,
  installAndEnableRetentionPluginThroughUi,
  readPluginUiSurfaces,
} from "../helpers/plugin-ui-background-retention.js";

const CASE_TIMEOUT_MS = 300000;
const FILL_TURNS = 15;

function fillText(index: number): string {
  return Array.from({ length: 20 }, (_, line) => `E2E_F18_02_FILL_LINE_${index}_${line}`).join(" ");
}

describe("E2E-F18-02 ui:// 声明页忙时不回收", () => {
  before(async () => {
    requirePluginManualReview();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("离屏声明页在同插件慢调用进行中与完成后保留，慢调用结果完整投递", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    const fixture = await createPluginUiRetentionFixture();
    await skipOccupationOnboardingIfPresent();
    await openPluginSettings();
    await addMarketplaceSourceThroughUi(fixture.marketplaceRoot);
    await waitUntilPluginOverview(
      (overview) =>
        overview.marketplaces.some(
          (marketplace) => marketplace.id === PLUGIN_UI_RETENTION_MARKETPLACE_ID,
        ),
      "Plugin UI retention marketplace was not persisted after the UI submission",
      60000,
    );
    // 个人市场分区里的卡片直装 + 已安装行启用（分区激活与安装入口的修复依据见 helper 注释）。
    await installAndEnableRetentionPluginThroughUi();

    // ── 第一页：声明页挂载后立刻离屏（回收条件 armed）──
    await prepareV4ConversationE2E();
    const runMarker = `E2E_F18_02_CASE_${Date.now()}`;
    await sendV4Prompt(
      `${runMarker}: Call ${PLUGIN_UI_RETENTION_TOOL_RETAINED} once with {"job":"a"}, then reply with exactly upstream-e2e-ok.`,
    );
    // 插件 MCP 工具按 build 模式裁决需要批准（deny 会把工具结果置 isError，不建页面）。
    expect(await approveV4Permission()).toBe(true);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes("upstream-e2e-ok"),
      "First retained tool call did not reach the deterministic final response",
      90000,
    );
    await browser.waitUntil(async () => (await readPluginUiSurfaces()).length >= 1, {
      timeout: 60000,
      timeoutMsg: "声明页 webview 未挂载",
    });
    const mounted = await readPluginUiSurfaces();
    expect(mounted.length).toBe(1);
    const retainedSrc = mounted[0]!.src;

    for (let index = 1; index <= FILL_TURNS; index += 1) {
      await sendV4Prompt(`E2E_F18_02_FILL_${index} ${fillText(index)}`);
      await waitForV4Pane(
        (snapshot) =>
          !snapshot.canStop && snapshot.timelineText.includes(`E2E_F18_02_FILL_LINE_${index}_19`),
        `填充 turn ${index} 未完成`,
        90000,
      );
    }
    const background = await readPluginUiSurfaces();
    expect(background.length).toBe(1);
    expect(background[0]!.src).toBe(retainedSrc);
    expect(background[0]!.inParking).toBe(true);
    expect(background[0]!.display).toBe("block");
    expect(background[0]!.opacity).toBe("0.001");

    // ── 慢调用：slow_retained_app 挂起 8s；挂起期间离屏声明页必须保留 ──
    await sendV4Prompt(
      `${runMarker}_SLOW: Call ${PLUGIN_UI_RETENTION_TOOL_SLOW} once with {"job":"slow"}, then reply with exactly upstream-e2e-ok.`,
    );
    expect(await approveV4Permission()).toBe(true);
    // 工具结果文本不直接渲染在时间线（折叠为工具行标题）；结果完整投递以回合终态判定：
    // final fixture 只在慢调用 tool_result（含 SLOW_DONE marker）进入请求体后才应答。
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes("upstream-e2e-ok"),
      "慢调用回合未收束（结果未完整投递）",
      PLUGIN_UI_RETENTION_SLOW_DELAY_MS * 2 + 60000,
    );

    // 慢调用完成且回合收束后：原声明页（按 src 匹配）仍保留，未销毁重建。
    const after = await readPluginUiSurfaces();
    const retained = after.find((surface) => surface.src === retainedSrc);
    expect(retained).toBeDefined();
    expect(retained!.inParking).toBe(true);
    expect(retained!.display).toBe("block");
    await capturePluginManualReview("E2E-F18-02", "retained-survives-slow-call");
  });
});
