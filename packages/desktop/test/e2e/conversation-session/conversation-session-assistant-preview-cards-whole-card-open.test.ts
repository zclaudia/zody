/* eslint-disable max-lines -- APC14 pending spec：整卡打开链路复用 formal APC 的 fixture 布置。 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TID_PREVIEW_PANE } from "@zody/shared";
import { DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";

/**
 * APC14（catalog 2026-11-07 accepted）：I15 整卡打开。卡片主体（铺满卡片的透明按钮）
 * 与右侧主按钮执行同一预览动作，各点一次互不双触发；不可预览态整卡 disabled。
 * 契约：docs/ui/assistant-preview-cards.md「Whole-card open (I15)」。
 * pending：待人工 review 与 fixture 合同定稿后 promote（e2e-case-lifecycle）。
 */
const CASE_MARKER = "E2E_APC14_WHOLE_CARD_OPEN";
const CASE_ROOT = join(DEFAULT_WORKSPACE, "apc14-whole-card");
const OFFICE_FIXTURE_ROOT = fileURLToPath(
  new URL(
    "../fixtures/fs/conversation-session/conversation-session-assistant-preview-cards/",
    import.meta.url,
  ),
);
const DOCX_NAME = "产品 路线.pptx";

interface BodyClickResult {
  clicked: boolean;
  disabled: boolean;
}

async function clickPreviewCardPrimary(title: string): Promise<BodyClickResult> {
  return browser.execute((expectedTitle) => {
    const row = document.querySelector<HTMLElement>(`[data-preview-card-title="${expectedTitle}"]`);
    const openLabels = new Set(["Open", "打开"]);
    const button = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => openLabels.has((candidate.textContent ?? "").trim()),
    );
    button?.click();
    return { clicked: Boolean(button), disabled: Boolean(button?.disabled) };
  }, title);
}

async function clickPreviewCardBody(title: string): Promise<BodyClickResult> {
  return browser.execute((expectedTitle) => {
    const row = document.querySelector<HTMLElement>(`[data-preview-card-title="${expectedTitle}"]`);
    const overlay = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => (button.getAttribute("aria-label") ?? "").endsWith(expectedTitle),
    );
    overlay?.click();
    return { clicked: Boolean(overlay), disabled: Boolean(overlay?.disabled) };
  }, title);
}

describe("APC14 Assistant Preview Cards whole-card open", () => {
  beforeEach(async () => {
    await prepareV4ConversationE2E();
    await rm(CASE_ROOT, { recursive: true, force: true });
    await mkdir(CASE_ROOT, { recursive: true });
    await copyFile(join(OFFICE_FIXTURE_ROOT, "sample.pptx"), join(CASE_ROOT, DOCX_NAME));
  });

  afterEach(async () => {
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  it("主按钮与整卡先后各点击一次，打开同一个 Preview Pane 目标且不双触发", async () => {
    const relativePath = `${CASE_ROOT.split(DEFAULT_WORKSPACE)[1]!.slice(1)}/${DOCX_NAME}`;
    await sendV4Prompt(
      `${CASE_MARKER}: mention the file ${relativePath} in the final reply, then output ${CASE_MARKER}_DONE.`,
    );
    await waitForV4AssistantMessageContaining(`${CASE_MARKER}_DONE`, 90_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${CASE_MARKER}_DONE`),
      "APC14 turn 没有完成",
      90_000,
    );

    const row = await browser.$(`[data-preview-card-title="${DOCX_NAME}"]`);
    await row.waitForDisplayed({ timeout: 60_000 });

    // 主按钮打开 Preview Pane。
    const primary = await clickPreviewCardPrimary(DOCX_NAME);
    expect(primary.clicked).toBe(true);
    expect(primary.disabled).toBe(false);
    const pane = await browser.$(`[data-testid="${TID_PREVIEW_PANE}"]`);
    await pane.waitForDisplayed({ timeout: 60_000 });

    // 整卡点击执行同一预览动作；不出现第二个 Preview 目标（同一 pane 复用）。
    const body = await clickPreviewCardBody(DOCX_NAME);
    expect(body.clicked).toBe(true);
    expect(body.disabled).toBe(false);
    const panes = await browser.$$(`[data-testid="${TID_PREVIEW_PANE}"]`);
    expect(panes.length).toBe(1);
  }).timeout(240_000);
});
