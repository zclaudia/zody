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
    "../../../fixtures/fs/conversation-session/conversation-session-assistant-preview-cards/",
    import.meta.url,
  ),
);
const FILE_NAME = "产品 路线.pptx";

/**
 * 打开统一文件菜单并在同一渲染进程调用内完成点选（upstream v3.17.1 APC15，
 * 来源 SHA a60ba6a7 的 probe 边界思路 + 本仓 Electron E2E 输入通道适配）。
 *
 * 为什么不用 chromedriver 合成 click/performActions：它们走 CDP
 * Input.dispatchMouseEvent，只产生 mouse 事件、不产生 PointerEvent（2026-11-08
 * 实测 expanded 恒 false、菜单未挂载）；且「选中菜单项关闭一轮」之后合成
 * pointerdown 也会间歇失效（ArrowDown 前 expanded 仍 false）。因此这里在渲染进程
 * 内按 fallback 链派发事件：pointerdown（Radix 既定打开路径）→ 键盘 ArrowDown
 * （Radix 触发器的键盘打开路径）→ DOM click，打开后立刻在同一调用里点击首个
 * 直显项，避免跨 webdriver 步骤的元素句柄陈旧与菜单中途关闭的时序抖动。
 */
async function openFileMenuAndClickFirstDirect(title: string): Promise<{
  opened: boolean;
  via: string;
  directClicked: boolean;
  directCount: number;
  menuText: string;
}> {
  const result = (await browser.executeAsync(
    async (cardTitle: string, done: (value: unknown) => void) => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-preview-card-title="${cardTitle}"]`),
      ).filter((row) => row.isConnected);
      const row = rows.at(-1);
      if (!row)
        return done({
          opened: false,
          via: "row-missing",
          directClicked: false,
          directCount: 0,
          menuText: "",
        });
      const trigger = Array.from(
        row.querySelectorAll<HTMLButtonElement>(
          "button[aria-label='Choose app'], button[aria-label='选择打开方式']",
        ),
      ).at(-1);
      if (!trigger)
        return done({
          opened: false,
          via: "trigger-missing",
          directClicked: false,
          directCount: 0,
          menuText: "",
        });
      const openMenu = () =>
        document.querySelectorAll("[data-slot='dropdown-menu-content'][data-state='open']").length >
        0;
      const pointerOptions: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      };
      let via = "";
      trigger.dispatchEvent(new PointerEvent("pointerdown", pointerOptions));
      await wait(300);
      if (openMenu()) {
        via = "pointerdown";
      } else {
        trigger.focus();
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
        await wait(300);
        if (openMenu()) {
          via = "arrowdown";
        } else {
          trigger.click();
          await wait(300);
          via = openMenu() ? "domclick" : "none";
        }
      }
      if (!openMenu())
        return done({ opened: false, via, directClicked: false, directCount: 0, menuText: "" });
      const menu = document.querySelector<HTMLElement>(
        "[data-slot='dropdown-menu-content'][data-state='open']",
      );
      const directItems = Array.from(
        menu?.querySelectorAll<HTMLElement>("[data-file-application-direct]") ?? [],
      );
      directItems[0]?.click();
      await wait(300);
      done({
        opened: true,
        via,
        directClicked: directItems.length > 0,
        directCount: directItems.length,
        menuText: menu?.innerText ?? "",
      });
    },
    title,
  )) as {
    opened: boolean;
    via: string;
    directClicked: boolean;
    directCount: number;
    menuText: string;
  };
  return result;
}

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
      // 修复原因：probe 的 install 对已安装状态直接抛错（helpers/file-application-menu-probe），
      // 循环内每轮先恢复再重装，0/1/3/10 边界才能共用同一个 it()。
      const callsBefore = (await readFileApplicationMenuProbe()).length;
      const interaction = await openFileMenuAndClickFirstDirect(FILE_NAME);
      expect(interaction.opened).toBe(true);
      if (count === 0) {
        // 裁决 4：系统关联为空（probe 返回 0 应用）时回退静态编辑器菜单，菜单非空。
        expect(interaction.menuText.length).toBeGreaterThan(0);
        expect(interaction.directClicked).toBe(false);
      } else {
        // 前三直显 + 默认项占同一个名额；其余候选进「更多」子菜单（不占直显位）。
        expect(interaction.directCount).toBe(Math.min(3, count));
        expect(interaction.directClicked).toBe(true);
        // 选择默认项：经 renderer 分发后 probe 收到 applicationId + 目标路径。
        await browser.waitUntil(
          async () => (await readFileApplicationMenuProbe()).length === callsBefore + 1,
          { timeout: 15_000, timeoutMsg: "probe 没有收到打开分发" },
        );
        const calls = await readFileApplicationMenuProbe();
        expect(calls[calls.length - 1]!.applicationId).toBe(`apc-app-${count - 1}`);
        expect(calls[calls.length - 1]!.target.path).toBe(targetPath);
        expect(calls[calls.length - 1]!.target.pathKind).toBe("file");
      }
      await restoreFileApplicationMenuProbe().catch(() => undefined);
    }
  }).timeout(300_000);
});
