// E2E-F18-04（docs/plugin-ui-background-execution.md §12.8）：声明两态对照。
// 同一插件两个 ui:// 资源变体：retained（_meta.ui.backgroundRetention: true）与
// plain（无该键）。锚点卸载后 retained 页保持隐藏执行表面（parking + display:block +
// opacity:0.001），plain 页为默认隐藏即停（display:none，无执行表面）。
// 这是 §12.2.1/§12.2.2 的即时可观察差异；plain 页 5 分钟定时器到点的 tryRecycle 裁决
// 在真实 E2E 中不可等待，由单测覆盖（pluginUiPageManager.test.ts 默认页回收族）。
// 来源：上游 v3.17.1 a60ba6a7 F18。
import { skipOccupationOnboardingIfPresent } from "../../../helpers/occupation-onboarding.js";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";
import {
  addMarketplaceSourceThroughUi,
  capturePluginManualReview,
  openPluginSettings,
  requirePluginManualReview,
  waitUntilPluginOverview,
} from "../../../helpers/plugin-management-lifecycle.js";
import {
  PLUGIN_UI_RETENTION_MARKETPLACE_ID,
  PLUGIN_UI_RETENTION_TOOL_PLAIN,
  PLUGIN_UI_RETENTION_TOOL_RETAINED,
  createPluginUiRetentionFixture,
  installAndEnableRetentionPluginThroughUi,
  readPluginUiSurfaces,
} from "../../../helpers/plugin-ui-background-retention.js";

const CASE_TIMEOUT_MS = 360000;
const FILL_TURNS = 15;

function fillText(tag: string, index: number): string {
  return Array.from({ length: 20 }, (_, line) => `E2E_F18_04_${tag}_LINE_${index}_${line}`).join(
    " ",
  );
}

async function fillTurns(tag: string): Promise<void> {
  for (let index = 1; index <= FILL_TURNS; index += 1) {
    await sendV4Prompt(`E2E_F18_04_${tag}_${index} ${fillText(tag, index)}`);
    await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && snapshot.timelineText.includes(`E2E_F18_04_${tag}_LINE_${index}_19`),
      `${tag} 填充 turn ${index} 未完成`,
      90000,
    );
  }
}

describe("E2E-F18-04 ui:// backgroundRetention 两态对照", () => {
  before(async () => {
    requirePluginManualReview();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("retained 离屏保留执行表面，plain 离屏默认隐藏即停", async function () {
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

    // ── retained 态：声明页挂载 → 离屏 → 执行表面 ──
    await prepareV4ConversationE2E();
    const runMarker = `E2E_F18_04_CASE_${Date.now()}`;
    await sendV4Prompt(
      `${runMarker}: Call ${PLUGIN_UI_RETENTION_TOOL_RETAINED} once with {"job":"retained"}, then reply with exactly upstream-e2e-ok.`,
    );
    // 插件 MCP 工具按 build 模式裁决需要批准（deny 会把工具结果置 isError，不建页面）。
    expect(await approveV4Permission()).toBe(true);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes("upstream-e2e-ok"),
      "Retained tool call did not reach the deterministic final response",
      90000,
    );
    await browser.waitUntil(async () => (await readPluginUiSurfaces()).length >= 1, {
      timeout: 60000,
      timeoutMsg: "retained 页 webview 未挂载",
    });
    const retainedMounted = await readPluginUiSurfaces();
    expect(retainedMounted.length).toBe(1);
    const retainedSrc = retainedMounted[0]!.src;

    await fillTurns("RET");
    const retainedBackground = await readPluginUiSurfaces();
    expect(retainedBackground.length).toBe(1);
    expect(retainedBackground[0]!.src).toBe(retainedSrc);
    expect(retainedBackground[0]!.inParking).toBe(true);
    // 声明页：隐藏执行表面（可执行、不接收输入）。
    expect(retainedBackground[0]!.display).toBe("block");
    expect(retainedBackground[0]!.opacity).toBe("0.001");
    await capturePluginManualReview("E2E-F18-04", "retained-execution-surface");

    // ── plain 态：未声明页挂载 → 离屏 → 默认隐藏即停（无执行表面）──
    await sendV4Prompt(
      `${runMarker}_PLAIN: Call ${PLUGIN_UI_RETENTION_TOOL_PLAIN} once with {"job":"plain"}, then reply with exactly upstream-e2e-ok.`,
    );
    expect(await approveV4Permission()).toBe(true);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes("upstream-e2e-ok"),
      "Plain tool call did not reach the deterministic final response",
      90000,
    );
    await browser.waitUntil(async () => (await readPluginUiSurfaces()).length >= 2, {
      timeout: 60000,
      timeoutMsg: "plain 页 webview 未挂载",
    });
    const bothMounted = await readPluginUiSurfaces();
    expect(bothMounted.length).toBe(2);
    const plainSurface = bothMounted.find((surface) => surface.src !== retainedSrc);
    expect(plainSurface).toBeDefined();
    expect(plainSurface!.inParking).toBe(false);
    await capturePluginManualReview("E2E-F18-04", "both-cards-mounted");

    await fillTurns("PLN");
    const bothBackground = await readPluginUiSurfaces();
    expect(bothBackground.length).toBe(2);
    // retained 页仍保留执行表面；plain 页回落默认隐藏即停（display:none）。
    const retainedAfter = bothBackground.find((surface) => surface.src === retainedSrc);
    const plainAfter = bothBackground.find((surface) => surface.src !== retainedSrc);
    expect(retainedAfter).toBeDefined();
    expect(retainedAfter!.inParking).toBe(true);
    expect(retainedAfter!.display).toBe("block");
    expect(retainedAfter!.opacity).toBe("0.001");
    expect(plainAfter).toBeDefined();
    expect(plainAfter!.inParking).toBe(true);
    expect(plainAfter!.display).toBe("none");
    await capturePluginManualReview("E2E-F18-04", "two-state-background-contrast");
  });
});
