import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { TID_V4_ROW_ATTACHMENTS } from "@zody/shared";
import { clearAppData, DEFAULT_WORKSPACE, ensureWorkspaceItemExpanded, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import { restartIntoWorkspace } from "../../../helpers/model-provider-restart.js";
import {
  getV4PaneSnapshot,
  pasteV4ComposerImageAttachment,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const MARKER = "R45 synthetic history text";

describe("R45 artifact media generation", () => {
  after(async () => { await clearAppData(); });

  it("reopens current media and preserves text and the historical reference", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await pasteV4ComposerImageAttachment("r45-synthetic.png");
    await sendV4Prompt(MARKER);
    await waitForV4TimelineContaining(MARKER, 45_000);
    await waitForV4Pane((s) => !s.canStop && Boolean(s.sessionId) && s.sessionId !== "draft", "session must settle", 45_000);
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("missing session");
    await restartIntoWorkspace();
    await ensureWorkspaceItemExpanded(DEFAULT_WORKSPACE);
    await selectV4TaskById(sessionId);
    await waitForV4TimelineContaining(MARKER, 60_000);
    await browser.waitUntil(() => clickUniqueMediaCard(), { timeout: 30_000, timeoutMsg: "current message must have exactly one media card" });
    await browser.waitUntil(() => hasBlobImage(), { timeout: 15_000, timeoutMsg: "current image did not resolve" });
    await browser.keys(["Escape"]);

    let rowId = "";
    let oldData = "";
    const dbPath = join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite");
    await restartIntoWorkspace({ afterElectronProcessExit: () => {
      // 必须是已存在的当前隔离 HOME 数据库；只读检查避免误创建空库。
      if (!statSync(dbPath).isFile()) throw new Error(`missing existing session database: ${dbPath}`);
      const readDb = new DatabaseSync(dbPath, { readOnly: true });
      let rows: Array<{ id: string; data: string }>;
      try {
        rows = readDb.prepare("select id, data from part where session_id = ?").all(sessionId) as Array<{ id: string; data: string }>;
      } finally { readDb.close(); }
      const expectedPrefix = `zody-artifact://${encodeURIComponent(sessionId)}/`;
      const matches = rows.map((row) => ({ row, part: JSON.parse(row.data) as { type?: unknown; mime?: unknown; url?: unknown; metadata?: { artifactUri?: unknown } } }))
        .filter(({ part }) => part.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/") && typeof part.url === "string" && part.url.startsWith(expectedPrefix) && part.metadata?.artifactUri === part.url);
      if (matches.length !== 1) throw new Error(`expected one canonical session image artifact, found ${matches.length}`);
      const { row, part } = matches[0]!;
      rowId = row.id;
      const oldUri = (part.url as string).replace("zody-artifact://", "zcode-artifact://");
      oldData = JSON.stringify({ ...part, url: oldUri, metadata: { ...part.metadata, artifactUri: oldUri } });
      const writeDb = new DatabaseSync(dbPath);
      try { writeDb.prepare("update part set data = ? where id = ? and session_id = ?").run(oldData, rowId, sessionId); }
      finally { writeDb.close(); }
    } });
    await ensureWorkspaceItemExpanded(DEFAULT_WORKSPACE);
    await selectV4TaskById(sessionId);
    await waitForV4TimelineContaining(MARKER, 60_000);
    if (!statSync(dbPath).isFile()) throw new Error(`session database disappeared: ${dbPath}`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select data from part where id = ? and session_id = ?").get(rowId, sessionId) as { data: string } | undefined;
      expect(row?.data).toBe(oldData);
    } finally { db.close(); }
    // 旧媒体不可读的异步终态与 Host/cache 调用由真实 runner 单独验证；此处不以即时无 blob 充当结果。
  });
});

async function clickUniqueMediaCard(): Promise<boolean> {
  return browser.execute((prefix, marker) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]"))
      .filter((row) => row.textContent?.includes(marker));
    if (rows.length !== 1) return false;
    const cards = rows[0]!.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"] [data-v4-user-input-media-attachment="true"]`);
    if (cards.length !== 1) return false;
    cards[0]!.click();
    return true;
  }, TID_V4_ROW_ATTACHMENTS, MARKER);
}
async function hasBlobImage(): Promise<boolean> {
  return browser.execute(() => Boolean(document.querySelector<HTMLImageElement>('[role="dialog"] img')?.src.startsWith("blob:")));
}
