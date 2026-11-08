/* eslint-disable max-lines -- APC16 pending spec：另存为经 native Save As 原样落盘（≤50 MiB 路径）。 */
import { copyFile, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronMock } from "@wdio/electron-types";
import { DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";

/**
 * APC16（catalog 2026-11-07 accepted）：统一文件菜单「另存为」分块读取防截断。
 * 预置含中文空格路径的本机文件卡（≤50 MiB），下拉执行「另存为」后目标字节与源
 * 一致（尺寸/内容）；取消是正常结果且不弹提示。native Save As 对话框按 MIG08 的
 * 既有模式 mock `dialog.showSaveDialog`（不驱动真实 GUI 对话框）。
 * >50 MiB 限额、1 MiB 分块边界与读取期间变更由 packages/ui/test focused tests
 * 守住，不进窗口 E2E（docs/ui/file-open-apps.md E2E 剪枝）。
 * pending：待人工 review 与 fixture 合同定稿后 promote（e2e-case-lifecycle）。
 */
const CASE_MARKER = "E2E_APC16_SAVE_AS_CHUNKED_COPY";
const CASE_ROOT = join(DEFAULT_WORKSPACE, "apc16-save-as");
const OFFICE_FIXTURE_ROOT = fileURLToPath(
  new URL(
    "../fixtures/fs/conversation-session/conversation-session-assistant-preview-cards/",
    import.meta.url,
  ),
);
const FILE_NAME = "产品 路线.pptx";

/**
 * Radix DropdownMenu 由 pointerdown 打开；chromedriver 的合成 click/performActions
 * 走 CDP Input.dispatchMouseEvent，只产生 mouse 事件、不产生 PointerEvent（2026-11-08
 * 本轮实测：expanded 恒 false、菜单未挂载），因此直接在触发器上派发 PointerEvent。
 * 另：一轮「选中菜单项关闭」之后，合成 pointerdown 会间歇性不再展开（ArrowDown 前
 * expanded 仍 false；同轮首轮正常），键盘 ArrowDown 是 Radix 触发器的既定打开路径，
 * 作为第二次尝试；两者都失败才算环境异常。
 */
async function pointerClickDropdownTrigger(title: string): Promise<void> {
  const result = (await browser.executeAsync(
    async (cardTitle: string, done: (value: unknown) => void) => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-preview-card-title="${cardTitle}"]`),
      ).filter((row) => row.isConnected);
      const row = rows.at(-1);
      if (!row) return done({ ok: false, reason: "row-missing" });
      const trigger = Array.from(
        row.querySelectorAll<HTMLButtonElement>(
          "button[aria-label='Choose app'], button[aria-label='选择打开方式']",
        ),
      ).at(-1);
      if (!trigger) return done({ ok: false, reason: "trigger-missing" });
      const isOpen = () =>
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
      trigger.dispatchEvent(new PointerEvent("pointerdown", pointerOptions));
      await wait(300);
      if (isOpen()) return done({ ok: true, via: "pointerdown" });
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      await wait(300);
      done({ ok: isOpen(), via: "arrowdown" });
    },
    title,
  )) as { ok: boolean; via?: string; reason?: string };
  if (!result.ok) {
    throw new Error(`统一文件菜单没有打开: ${JSON.stringify(result)}`);
  }
}

/** 保存对话框固定回落的临时目标（不弹真实 GUI，由 electron mock 提供）。 */
function savedCopyPath(tag: string): string {
  return join(tmpdir(), `zody-e2e-apc16-${tag}-${Date.now()}.pptx`);
}

async function clickSaveAsMenuItem(): Promise<boolean> {
  // 与 APC14/15 相同的 DOM 点击方式：React 合成事件吃真实 click()。
  return browser.execute(() => {
    const menu = document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]');
    if (!menu) return false;
    const item = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']")).find(
      (candidate) => /另存为|Save as/i.test(candidate.textContent ?? ""),
    );
    item?.click();
    return Boolean(item);
  });
}

async function toastTextsInclude(pattern: RegExp): Promise<boolean> {
  return browser.execute((regexSource) => {
    const regex = new RegExp(regexSource, "i");
    // toast 渲染进 body portal；没有稳定 testid，按可见文本扫描。
    return Array.from(document.querySelectorAll<HTMLElement>("div.fixed")).some((node) =>
      regex.test(node.textContent ?? ""),
    );
  }, pattern.source);
}

describe("APC16 unified file menu save-as chunked copy", () => {
  let showSaveDialogMock: ElectronMock | null = null;

  beforeEach(async () => {
    await prepareV4ConversationE2E();
    await rm(CASE_ROOT, { recursive: true, force: true });
    await mkdir(CASE_ROOT, { recursive: true });
    await copyFile(join(OFFICE_FIXTURE_ROOT, "sample.pptx"), join(CASE_ROOT, FILE_NAME));
    showSaveDialogMock = await browser.electron.mock("dialog", "showSaveDialog");
  });

  afterEach(async () => {
    // ElectronMock 无逐实例 restore；与 MIG08 相同用 restoreAllMocks 收尾。
    await browser.electron.restoreAllMocks();
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  it("另存为写出与源一致的字节；取消不落盘也不提示", async () => {
    const relativePath = `${CASE_ROOT.split(DEFAULT_WORKSPACE)[1]!.slice(1)}/${FILE_NAME}`;
    await sendV4Prompt(
      `${CASE_MARKER}: mention the file ${relativePath} in the final reply, then output ${CASE_MARKER}_DONE.`,
    );
    await waitForV4AssistantMessageContaining(`${CASE_MARKER}_DONE`, 90_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${CASE_MARKER}_DONE`),
      "APC16 turn 没有完成",
      90_000,
    );

    const row = await browser.$(`[data-preview-card-title="${FILE_NAME}"]`);
    await row.waitForDisplayed({ timeout: 60_000 });
    const sourcePath = await realpath(join(CASE_ROOT, FILE_NAME));

    // ---- 保存：mock 对话框回落到临时目标，等待目标字节与源一致。----
    const targetPath = savedCopyPath("saved");
    await showSaveDialogMock!.mockResolvedValueOnce({ canceled: false, filePath: targetPath });
    await pointerClickDropdownTrigger(FILE_NAME);
    const menu = await browser.$('[data-slot="dropdown-menu-content"][data-state="open"]');
    await menu.waitForDisplayed();
    expect(await clickSaveAsMenuItem()).toBe(true);

    const sourceBytes = await readFile(sourcePath);
    await browser.waitUntil(
      async () => {
        try {
          return (await readFile(targetPath)).byteLength === sourceBytes.byteLength;
        } catch {
          return false;
        }
      },
      { timeout: 30_000, timeoutMsg: "另存为没有在超时内写出目标副本" },
    );
    expect(await readFile(targetPath)).toEqual(sourceBytes);
    // 成功提示可见（docs/ui/file-open-apps.md：成功统一提示已保存）。
    await browser.waitUntil(async () => await toastTextsInclude(/已保存|Saved/), {
      timeout: 10_000,
      timeoutMsg: "另存为成功后没有出现已保存提示",
    });
    // toast 3 秒自动消失；取消断言的是「取消不产生新提示」，先等成功提示退场，
    // 避免把上一阶段的「已保存」误判为取消后出现。
    await browser.waitUntil(async () => !(await toastTextsInclude(/已保存|Saved/)), {
      timeout: 10_000,
      timeoutMsg: "另存为成功提示没有在超时内消失",
    });
    await browser.keys("Escape");

    // ---- 取消：正常结果，不落盘、不弹提示。----
    const canceledTarget = savedCopyPath("canceled");
    await showSaveDialogMock!.mockResolvedValueOnce({ canceled: true, filePath: "" });
    await pointerClickDropdownTrigger(FILE_NAME);
    await menu.waitForDisplayed();
    expect(await clickSaveAsMenuItem()).toBe(true);
    await browser.pause(1_500);
    let canceledFileExists = true;
    try {
      await readFile(canceledTarget);
    } catch {
      canceledFileExists = false;
    }
    expect(canceledFileExists).toBe(false);
    expect(await toastTextsInclude(/已保存|另存为失败|Save as failed|Saved/)).toBe(false);
  }).timeout(300_000);
});
