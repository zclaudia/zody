import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import {
  addMarketplaceSourceThroughAgent,
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  getPluginOverview,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "../../../helpers/plugin-management-lifecycle.js";
import {
  PLUGIN_READ_SCHEDULING_ID,
  PLUGIN_READ_SCHEDULING_MARKETPLACE_ID,
  PLUGIN_READ_WARM_ID,
  PLUGIN_READ_WARM_SKILL_NAME,
  createPluginReadSchedulingMarketplace,
  startStalledPluginDownloadServer,
  type StalledPluginDownloadServer,
} from "../../../helpers/plugin-storage-read-scheduling.js";

const READ_TIMEOUT_MS = 10000;
const INSTALL_TIMEOUT_MS = 180000;

// I06 桌面证据：安装 A 挂在 zip 下载时仍持有 per-storageRoot 写闸门，
// 与之无关的 list/overview/describe 必须在阈值内返回已提交状态。
describe("PLM-LC-024 插件读投影绕过挂起安装", () => {
  let stalled: StalledPluginDownloadServer | undefined;

  after(async () => {
    await stalled?.release();
    stalled = undefined;
    await clearAppData();
  });

  it("长安装挂起下载时 list/overview/详情仍返回已提交状态", async function () {
    this.timeout(INSTALL_TIMEOUT_MS);
    requirePluginManualReview();

    const { homeDir } = getE2EAppDataPaths();
    stalled = await startStalledPluginDownloadServer();
    const fixture = createPluginReadSchedulingMarketplace({
      e2eHomeDir: homeDir,
      server: stalled,
    });
    const added = await addMarketplaceSourceThroughAgent(fixture.marketplaceRoot);
    expect(added.marketplace?.id).toBe(PLUGIN_READ_SCHEDULING_MARKETPLACE_ID);

    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_READ_SCHEDULING_ID, 60000);
    await waitForPluginCard(PLUGIN_READ_WARM_ID, 60000);

    // 从卡片直接安装：不先打开详情，避免 describe 提前触发 zip 下载。
    await clickPluginControl("plugin-store-install", { pluginId: PLUGIN_READ_SCHEDULING_ID });
    // 下载请求到达即证明安装已进入长写并持有存储写闸门。
    await stalled.waitForDownload(30000);

    const overviewStartedAt = Date.now();
    const overview = await getPluginOverview();
    expect(Date.now() - overviewStartedAt).toBeLessThan(READ_TIMEOUT_MS);
    expect(
      overview.installedPlugins.some((plugin) => plugin.id === PLUGIN_READ_SCHEDULING_ID),
    ).toBe(false);

    const listStartedAt = Date.now();
    const list = await getPluginList();
    expect(Date.now() - listStartedAt).toBeLessThan(READ_TIMEOUT_MS);
    expect(list.plugins.some((plugin) => plugin.id === PLUGIN_READ_SCHEDULING_ID)).toBe(true);

    // 已提交 manifest + 本地目录源的详情读取同样是纯读，不得排在安装之后。
    await openPluginCard(PLUGIN_READ_WARM_ID);
    await waitForPluginControl(
      "plugin-store-component-section",
      { componentKind: "skill" },
      READ_TIMEOUT_MS,
    );
    expect(await hasWarmSkill()).toBe(true);
    await capturePluginManualReview("PLM-LC-024", "read-during-stalled-install");

    // 释放挂起的下载：安装进入失败终态并释放写闸门，安装态不得出现半成品。
    await stalled.release();
    stalled = undefined;
    await waitForPluginControl("plugin-store-error", {}, 60000);
    await capturePluginManualReview("PLM-LC-024", "install-failure-terminal");
    await waitUntilPluginOverview(
      (current) =>
        !current.installedPlugins.some((plugin) => plugin.id === PLUGIN_READ_SCHEDULING_ID),
      "Stalled install must not commit an installed record",
      60000,
    );
  });
});

async function hasWarmSkill(): Promise<boolean> {
  return browser.execute((skillName) => {
    const section = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (candidate) =>
        candidate.dataset.testid === "plugin-store-component-section" &&
        candidate.dataset.componentKind === "skill",
    );
    return section?.textContent?.includes(skillName) === true;
  }, PLUGIN_READ_WARM_SKILL_NAME);
}
