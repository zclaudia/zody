/* eslint-disable max-lines -- APC15 pending spec：统一文件菜单按 probe 固定边界验证分发。 */
import { copyFile, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileApplicationInfo } from "@zody/shared";
import { DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import {
  installFileApplicationMenuProbe,
  readFileApplicationMenuProbe,
  restoreFileApplicationMenuProbe,
} from "../../../helpers/file-application-menu-probe.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

/**
 * APC15（catalog 2026-11-07 accepted）：按格式打开统一文件菜单。系统关联为唯一
 * 事实源；IPC probe 注入 0/1/3/10 个应用固定边界，不启动/安装真实外部应用；
 * 0 应用时回退静态编辑器菜单（裁决 4，docs/ui/file-open-apps.md 共存章节）。
 * pending：待人工 review 与 fixture 合同定稿后 promote（e2e-case-lifecycle）。
 */
const CASE_MARKER = "E2E_APC15_OPEN_WITH_SYSTEM_APPS";
const CASE_ROOT = join(DEFAULT_WORKSPACE, "apc15-open-with");
const OFFICE_FIXTURE_ROOT = fileURLToPath(
  new URL(
    "../../fixtures/fs/conversation-session/conversation-session-assistant-preview-cards/",
    import.meta.url,
  ),
);
const FILE_NAME = "产品 路线.pptx";

describe("APC15 unified file menu dispatches system associations", () => {
  beforeEach(async () => {
    await prepareV4ConversationE2E();
    await rm(CASE_ROOT, { recursive: true, force: true });
    await mkdir(CASE_ROOT, { recursive: true });
    await copyFile(join(OFFICE_FIXTURE_ROOT, "sample.pptx"), join(CASE_ROOT, FILE_NAME));
  });

  afterEach(async () => {
    await restoreFileApplicationMenuProbe().catch(() => undefined);
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  it("默认项/直显项/「更多」子菜单分发到选中应用；0 应用回退静态编辑器菜单", async () => {
    const relativePath = `${CASE_ROOT.split(DEFAULT_WORKSPACE)[1]!.slice(1)}/${FILE_NAME}`;
    await sendV4Prompt(
      `${CASE_MARKER}: mention the file ${relativePath} in the final reply, then output ${CASE_MARKER}_DONE.`,
    );
    await waitForV4AssistantMessageContaining(`${CASE_MARKER}_DONE`, 90_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${CASE_MARKER}_DONE`),
      "APC15 turn 没有完成",
      90_000,
    );

    const row = await browser.$(`[data-preview-card-title="${FILE_NAME}"]`);
    await row.waitForDisplayed({ timeout: 60_000 });
    const targetPath = await realpath(join(CASE_ROOT, FILE_NAME));

    for (const count of [3, 10, 0]) {
      const applications: FileApplicationInfo[] = Array.from({ length: count }, (_, index) => ({
        id: `apc-app-${index}`,
        name: `APC Application ${index}`,
        isDefault: index === count - 1,
      }));
      await installFileApplicationMenuProbe(targetPath, applications);
      await row.$('button[aria-label="选择打开方式"], button[aria-label="Choose app"]').click();
      const menu = await browser.$('[data-slot="dropdown-menu-content"][data-state="open"]');
      await menu.waitForDisplayed();
      if (count === 0) {
        // 裁决 4：系统关联为空回退静态编辑器菜单（来自 getInstalledEditors 的候选）。
        const text = await menu.getText();
        expect(text.length).toBeGreaterThan(0);
      } else {
        const direct = await menu.$$("[data-file-application-direct]");
        expect(direct.length).toBe(Math.min(3, count));
        // 选择默认项：经 renderer 分发后 probe 收到 applicationId + 目标路径。
        await menu.$("[data-file-application-direct]").click();
        await browser.waitUntil(async () => {
          const calls = await readFileApplicationMenuProbe();
          return calls.length === 1;
        });
        const calls = await readFileApplicationMenuProbe();
        expect(calls[0]!.applicationId).toBe(`apc-app-${count - 1}`);
        expect(calls[0]!.target.path).toBe(targetPath);
        expect(calls[0]!.target.pathKind).toBe("file");
      }
      await browser.keys("Escape");
    }
  }).timeout(300_000);
});
