// E2E-F18-01（docs/plugin-ui-background-execution.md §12.8）：后台保留冒烟。
// 声明 `_meta.ui.backgroundRetention: true` 的 ui:// 页面在锚点（工具卡片）被虚拟列表
// 卸载后必须保留：webview 不销毁、隐藏执行表面（parking + display:block + opacity:0.001）、
// shell 内插件 iframe 仍挂载；锚点返回后复用同一 guest（webview src 不变，不重新握手）。
// 来源：上游 v3.17.1 a60ba6a7 F18 保留策略（本仓 spec 驱动差异：断言面为本仓承载层语义）。
import { skipOccupationOnboardingIfPresent } from "../../../helpers/occupation-onboarding.js";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
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
  PLUGIN_UI_RETENTION_TOOL_RETAINED,
  createPluginUiRetentionFixture,
  installAndEnableRetentionPluginThroughUi,
  readPluginUiGuestFrames,
  readPluginUiSurfaces,
} from "../../../helpers/plugin-ui-background-retention.js";

const CASE_TIMEOUT_MS = 300000;
/** 卡片卸载所需的填充 turn 数：每条回复约 80 行，3 条足以把工具 turn 推出虚拟窗口。 */
const FILL_TURNS = 15;

function fillText(index: number): string {
  return Array.from({ length: 20 }, (_, line) => `E2E_F18_01_FILL_LINE_${index}_${line}`).join(" ");
}

describe("E2E-F18-01 ui:// 声明页后台保留冒烟", () => {
  before(async () => {
    requirePluginManualReview();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("声明页锚点卸载后保留执行表面，锚点返回复用同一 guest", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    // ── 安装并启用带两态 ui:// 资源的插件 ──
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
    await capturePluginManualReview("E2E-F18-01", "installed");

    // ── 触发声明页：replay 伪造 tool_use，agent 真实调用 fixture MCP 工具 ──
    await prepareV4ConversationE2E();
    const runMarker = `E2E_F18_01_CASE_${Date.now()}`;
    await sendV4Prompt(
      `${runMarker}: Call ${PLUGIN_UI_RETENTION_TOOL_RETAINED} once with {"job":"a"}, then reply with exactly upstream-e2e-ok.`,
    );
    // 插件 MCP 工具按 build 模式裁决需要批准（PLM-LC-010 同款 approve 流程；
    // 不批准会在 60s 权限超时后被 deny，工具结果带 isError 不建插件 UI 页）。
    expect(await approveV4Permission()).toBe(true);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes("upstream-e2e-ok"),
      "Retained tool call did not reach the deterministic final response",
      90000,
    );

    // webview 挂载（prepareSandbox → Main registry → 句柄回 renderer → plane.mount）。
    await browser.waitUntil(async () => (await readPluginUiSurfaces()).length >= 1, {
      timeout: 60000,
      timeoutMsg: "声明页 webview 未挂载",
    });
    const mounted = await readPluginUiSurfaces();
    expect(mounted.length).toBe(1);
    const mountedSrc = mounted[0]!.src;
    expect(mountedSrc).toBeTruthy();
    expect(await readPluginUiGuestFrames()).toEqual([true]);
    expect(mounted[0]!.inParking).toBe(false);
    await capturePluginManualReview("E2E-F18-01", "retained-card-mounted");

    // ── 锚点卸载：填充 turn 把工具卡片推出虚拟窗口（页面只登出锚点，不销毁）──
    for (let index = 1; index <= FILL_TURNS; index += 1) {
      await sendV4Prompt(`E2E_F18_01_FILL_${index} ${fillText(index)}`);
      await waitForV4Pane(
        (snapshot) =>
          !snapshot.canStop && snapshot.timelineText.includes(`E2E_F18_01_FILL_LINE_${index}_19`),
        `填充 turn ${index} 未完成`,
        90000,
      );
    }
    await browser.waitUntil(async () => (await readPluginUiSurfaces()).length === 1, {
      timeout: 10000,
      timeoutMsg: "填充后 webview 数量异常",
    });
    const background = await readPluginUiSurfaces();
    expect(background.length).toBe(1);
    // 声明页离屏：隐藏执行表面（可执行、不接收输入），不是 display:none 的默认停驻。
    expect(background[0]!.src).toBe(mountedSrc);
    expect(background[0]!.inParking).toBe(true);
    expect(background[0]!.display).toBe("block");
    expect(background[0]!.opacity).toBe("0.001");
    expect(await readPluginUiGuestFrames()).toEqual([true]);
    await capturePluginManualReview("E2E-F18-01", "retained-background-surface");

    // ── 锚点返回侧证：滚回工具 turn，页面未被销毁重建（src 不变、guest 仍挂载）──
    // 工具 turn 是本会话最早的 turn。旧行按「最近三回合自动展开」规则被折叠，
    // 折叠行不再渲染插件卡片锚点（产品现状），E2E 不驱动展开交互；
    // 「返回后同 owner 复用」的重建语义（§12.2.8）由 managedPage/retention 单测覆盖。
    // 这里断言滚回后 webview 仍是同一实例（未重新 prepare/握手），并留人工 review 截图。
    await scrollV4TimelineToTop();
    await browser.pause(2000);
    const restored = await readPluginUiSurfaces();
    expect(restored.length).toBe(1);
    expect(restored[0]!.src).toBe(mountedSrc);
    expect(await readPluginUiGuestFrames()).toEqual([true]);
    await capturePluginManualReview("E2E-F18-01", "retained-anchor-restored");
  });
});
