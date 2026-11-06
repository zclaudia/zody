import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import {
  addMarketplaceSourceThroughUi,
  clickPluginControl,
  getPluginList,
  installMarketplacePluginThroughAgent,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  uninstallPluginThroughUi,
  updateMarketplaceThroughAgent,
  waitForPluginCard,
} from "../../../helpers/plugin-management-lifecycle.js";

/**
 * RENAME-PLUGIN-INSTALL：真实宿主下 manifest 三态发现、市场安装/更新/重装与内置插件 seed。
 *
 * 本文件由 R54 独占编写（唯一写者）：只消费 R54 spec 的 S1/S2/S4 规则，不复制 R51 wire 用例。
 * - 已实现：仅旧清单 / 新旧并存（取新）/ 新清单非法（失败不回退）三态安装、
 *   市场安装→更新→重装、内置官方插件首次 seed 的 `.zody-plugin` 重渲染与旧字节保留。
 * - 待 R56 执行：升级首跑重渲染的 E2E 版（需在宿主启动前预置旧缓存，或具备 Host 重启能力）；
 *   R54 已在 `official-plugin-runtime.test.ts` 与 bootstrap `plugins.test.ts` 用单测/集成测试证明同一闭环。
 *
 * 边界：MCP Apps / Gen UI 面的旧新命名断言属于 RENAME-PLUGIN-WIRE（R51 用例），本文件不复制。
 * 执行状态：**未执行，归 R56**。缺 fixture 或脚本退回 R54，不由 R56 越界补实现。
 */

const MARKETPLACE_ID = "zody-rename-install-market";
const LEGACY_ONLY_NAME = "zody-rename-legacy-only";
const BOTH_FORMATS_NAME = "zody-rename-both-formats";
const INVALID_CANONICAL_NAME = "zody-rename-invalid-canonical";
const OFFICIAL_DOCUMENTS_PLUGIN_ID = "documents@zcode-plugins-official";
const CASE_TIMEOUT_MS = 240_000;

describe("RENAME-PLUGIN-INSTALL manifest 三态与安装升级", () => {
  after(async () => {
    await clearAppData();
  });

  it("仅旧清单、新旧并存与新清单非法三态安装", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    requirePluginManualReview();

    const fixture = await seedManifestMatrixMarketplace();
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await addMarketplaceSourceThroughUi(fixture.marketplaceRoot);
    await waitForPluginCard(`${LEGACY_ONLY_NAME}@${MARKETPLACE_ID}`, 60_000);

    // 仅旧清单：旧格式仍可安装。
    await openPluginCard(`${LEGACY_ONLY_NAME}@${MARKETPLACE_ID}`);
    await installPluginThroughUi(`${LEGACY_ONLY_NAME}@${MARKETPLACE_ID}`);
    const legacyInstalled = await installedPlugin(LEGACY_ONLY_NAME);
    expect(legacyInstalled?.version).toBe("1.0.0");
    expect(existsSync(join(legacyInstalled?.rootPath ?? "", ".zcode-plugin", "plugin.json"))).toBe(
      true,
    );

    // 新旧并存：取新清单的版本与描述，旧清单字段不可见。
    await openPluginCard(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`);
    await installPluginThroughUi(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`);
    const canonicalInstalled = await installedPlugin(BOTH_FORMATS_NAME);
    expect(canonicalInstalled?.version).toBe("2.0.0");

    // 新清单非法：安装失败且不回退旧清单，缓存不落盘。
    const invalid = await installMarketplacePluginThroughAgent(
      INVALID_CANONICAL_NAME,
      MARKETPLACE_ID,
    );
    expect(invalid.installedPlugins ?? []).toEqual([]);
    expect(invalid.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "plugin_manifest_invalid", severity: "error" }),
      ]),
    );
    expect(await installedPlugin(INVALID_CANONICAL_NAME)).toBeUndefined();
  });

  it("市场安装 → 更新 → 重装沿同一 manifest 优先规则", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    requirePluginManualReview();

    const fixture = await seedManifestMatrixMarketplace();
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await addMarketplaceSourceThroughUi(fixture.marketplaceRoot);
    await waitForPluginCard(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`, 60_000);
    await openPluginCard(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`);
    await installPluginThroughUi(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`);
    expect((await installedPlugin(BOTH_FORMATS_NAME))?.version).toBe("2.0.0");

    // 更新：只改新格式版本，再刷新市场并重装。
    await writeCanonicalManifest(fixture.bothFormatsRoot, { version: "2.1.0" });
    await updateMarketplaceThroughAgent(MARKETPLACE_ID);
    await installPluginThroughUi(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`);
    expect((await installedPlugin(BOTH_FORMATS_NAME))?.version).toBe("2.1.0");

    // 重装：卸载后再装回，仍读新格式。
    await uninstallPluginThroughUi(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`, true);
    await installPluginThroughUi(`${BOTH_FORMATS_NAME}@${MARKETPLACE_ID}`);
    const reinstalled = await installedPlugin(BOTH_FORMATS_NAME);
    expect(reinstalled?.version).toBe("2.1.0");
  });

  it("内置官方插件首次 seed 写新格式 manifest 并保留旧字节", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    const list = await getPluginList();
    const documents = list.plugins.find((plugin) => plugin.id === OFFICIAL_DOCUMENTS_PLUGIN_ID);
    const rootPath = documents?.rootPath;
    expect(rootPath).toBeTruthy();
    if (!rootPath) return;

    const canonical = await readFile(join(rootPath, ".zody-plugin", "plugin.json"), "utf8");
    const legacy = await readFile(join(rootPath, ".zcode-plugin", "plugin.json"), "utf8");
    // 新格式携带运行期重写后的隐藏命令；旧格式保持 seed 源字节（command 仍是源清单的 node）。
    expect(canonical).toContain("__zody-plugin-host");
    expect(legacy).not.toContain("__zody-plugin-host");
    expect(canonical).not.toBe(legacy);
  });

  it.skip("升级首跑：旧命令 manifest 重渲染到新路径（R54 单测已证明，E2E 需宿主重启前预置缓存）", () => {
    // R54 在 official-plugin-runtime.test.ts 与 bootstrap plugins.test.ts 证明：
    // 旧缓存只有 `.zcode-plugin/plugin.json` 且 marker 匹配时，慢路径把它渲染进
    // `.zody-plugin/plugin.json` 且旧字节不变。真实 E2E 需要在 Electron 启动前写入旧缓存
    // （wdio 启动钩子，非 R54 writeSet）或具备 Host 重启能力，归 R56 执行环境准备。
  });

  it.skip("MCP Apps / Gen UI 命名面（属 RENAME-PLUGIN-WIRE，不复制 R51 用例）", () => {
    // 安装后页面渲染与双命名空间断言由 R51 的 zody-rename-plugin-wire.test.ts 覆盖，
    // R56 在同一轮执行两个用例并在报告中交叉引用。
  });
});

interface ManifestMatrixFixture {
  bothFormatsRoot: string;
  marketplaceRoot: string;
}

async function seedManifestMatrixMarketplace(): Promise<ManifestMatrixFixture> {
  const { homeDir } = getE2EAppDataPaths();
  const marketplaceRoot = join(homeDir, "fixtures", "zody-rename-install-market");
  await rm(marketplaceRoot, { force: true, recursive: true });

  const legacyOnlyRoot = join(marketplaceRoot, "plugins", LEGACY_ONLY_NAME);
  await writeLegacyManifest(legacyOnlyRoot, { name: LEGACY_ONLY_NAME, version: "1.0.0" });
  await writeSkill(legacyOnlyRoot, "legacy-only");

  const bothFormatsRoot = join(marketplaceRoot, "plugins", BOTH_FORMATS_NAME);
  await writeCanonicalManifest(bothFormatsRoot, {
    name: BOTH_FORMATS_NAME,
    skills: "skills",
    version: "2.0.0",
  });
  await writeLegacyManifest(bothFormatsRoot, { name: BOTH_FORMATS_NAME, version: "1.0.0" });
  await writeSkill(bothFormatsRoot, "canonical-only");

  const invalidRoot = join(marketplaceRoot, "plugins", INVALID_CANONICAL_NAME);
  await mkdir(join(invalidRoot, ".zody-plugin"), { recursive: true });
  await writeFile(join(invalidRoot, ".zody-plugin", "plugin.json"), "{ not json");
  await writeLegacyManifest(invalidRoot, { name: INVALID_CANONICAL_NAME, version: "1.0.0" });
  await writeSkill(invalidRoot, "legacy-fallback");

  await writeJson(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    description: "E2E manifest priority marketplace",
    name: MARKETPLACE_ID,
    plugins: [
      {
        description: "Legacy-only manifest plugin",
        name: LEGACY_ONLY_NAME,
        source: `./plugins/${LEGACY_ONLY_NAME}`,
        version: "1.0.0",
      },
      {
        description: "Both manifest formats plugin",
        name: BOTH_FORMATS_NAME,
        source: `./plugins/${BOTH_FORMATS_NAME}`,
        version: "2.0.0",
      },
      {
        description: "Invalid new-format manifest plugin",
        name: INVALID_CANONICAL_NAME,
        source: `./plugins/${INVALID_CANONICAL_NAME}`,
        version: "1.0.0",
      },
    ],
  });

  return { bothFormatsRoot, marketplaceRoot };
}

async function installedPlugin(name: string) {
  const list = await getPluginList();
  return list.plugins.find((plugin) => plugin.id === `${name}@${MARKETPLACE_ID}`);
}

async function writeCanonicalManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeJson(join(pluginRoot, ".zody-plugin", "plugin.json"), {
    description: "canonical manifest",
    ...manifest,
  });
}

async function writeLegacyManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    description: "legacy manifest",
    ...manifest,
  });
}

async function writeSkill(pluginRoot: string, name: string): Promise<void> {
  const skillDir = join(pluginRoot, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture skill\n---\n\n# ${name}\n`,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
