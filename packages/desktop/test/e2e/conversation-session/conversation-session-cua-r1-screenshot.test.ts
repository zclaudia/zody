import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { clearAppData } from "../helpers/desktop-app.js";
import { readUpstreamToolResultFromRequest } from "../helpers/conversation-session-network.js";
import type { E2ENetworkCaptureArtifact } from "../helpers/network-capture-proxy.js";
import { waitCall } from "../helpers/cua-r1-lifecycle.js";
import {
  CUA_SCREENSHOT_MODEL,
  CUA_SCREENSHOT_PROVIDER,
  seedCuaScreenshotProvider,
} from "../helpers/cua-screenshot-provider.js";
import { clickR1AllowOnce, readR1PermissionDialog } from "../helpers/cua-r1-dialog.js";
import { parseR1IdentityRows, r1IdentityMatches } from "../helpers/cua-r1-receipt.js";
import { screenshotEvidence } from "../helpers/cua-screenshot-evidence.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import {
  createE2EReplayFixtureVariables,
  resolveE2ERuntimePath,
} from "../helpers/e2e-runtime-paths.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "../helpers/upstream-replay-server.js";
import { selectRegistryProviderModelById } from "../helpers/upstream-provider.js";
import {
  denyV4PermissionWithFeedback,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const NAME = "conversation-session-cua-r1-screenshot";
const RUNTIME = resolveE2ERuntimePath("cua-r1");
let server: UpstreamReplayServer;
let captured: E2ENetworkCaptureArtifact | undefined;
let evidence = "";
let targetPid = 0;
let targetWindow = 0;
const receipts: Record<string, unknown> = {};
const seenCalls = new Set<string>();
let allowSession: string | null = null;
let allowReadRequestId: string | null = null;

describe("CUA signed candidate screenshot isolation", () => {
  before(async function () {
    this.timeout(120_000);
    const binary = process.env.ZODY_E2E_PACKAGED_APP_PATH?.trim();
    const manifest = process.env.ZODY_CUA_R1_FIXTURE_MANIFEST?.trim();
    evidence = process.env.ZODY_CUA_R1_EVIDENCE_DIR?.trim() ?? "";
    if (
      process.platform !== "darwin" ||
      !binary ||
      !isAbsolute(binary) ||
      binary.startsWith("/Applications/") ||
      !manifest ||
      !isAbsolute(manifest) ||
      !isAbsolute(evidence)
    )
      throw new Error(
        "Requires Darwin, independent packaged candidate, absolute fixture manifest and evidence directory",
      );
    const fixture = JSON.parse(await readFile(manifest, "utf8"));
    if (
      !Number.isSafeInteger(fixture.pid) ||
      fixture.pid <= 0 ||
      !Number.isSafeInteger(fixture.targetWindow) ||
      fixture.targetWindow <= 0 ||
      fixture.targetMarker !== "E2E_R1_TARGET_BODY" ||
      fixture.siblingMarker !== "E2E_R1_SIBLING_BODY"
    )
      throw new Error("Invalid fixture manifest");
    process.kill(fixture.pid, 0);
    targetPid = fixture.pid;
    targetWindow = fixture.targetWindow;
    await mkdir(RUNTIME, { recursive: true });
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(RUNTIME, "manifest.json"), JSON.stringify(fixture), { mode: 0o600 });
    server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve(evidence, "replay.json"),
      artifactWriter: async (_path, artifact) => {
        captured = artifact as E2ENetworkCaptureArtifact;
      },
      fixtureVariables: createE2EReplayFixtureVariables(),
      fixturePaths: [
        resolve(process.cwd(), "test/e2e/fixtures/upstream/common.json"),
        resolve(process.cwd(), `test/e2e/fixtures/upstream/conversation-session/${NAME}.json`),
      ],
    });
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: () => seedCuaScreenshotProvider(server.baseUrl),
    });
    await prepareV4ConversationE2E({ skipProvider: true });
  });
  after(async () => {
    await server?.stop();
    if (evidence)
      await writeFile(
        resolve(evidence, "screenshot-receipts.json"),
        JSON.stringify(receipts, null, 2),
        { mode: 0o600 },
      );
    await clearAppData();
  });
  for (const kind of ["deny", "allow", "read"] as const) {
    it(`independent screenshot ${kind}`, async function () {
      this.timeout(180_000);
      const receipt = {
        executed: true,
        passed: false,
        readConfirmations: 0,
        screenshotConfirmations: 0,
        resultReceived: false,
        readDefaultDeny: false,
        defaultDeny: false,
        targetIdentityMatched: false,
        deniedContentAbsent: false,
        siblingContentAbsent: false,
        image: { valid: false, width: 0, height: 0, imageCount: 0 },
        sameSession: false,
        distinctReadRequest: false,
        noTree: false,
      };
      receipts[kind] = receipt;
      if (kind !== "read") await startNewV4Draft();
      if (kind === "read") {
        const current = (await getV4PaneSnapshot()).sessionId;
        receipt.sameSession = Boolean(allowSession && current === allowSession);
        expect(receipt.sameSession).toBe(true);
      }
      await selectRegistryProviderModelById(CUA_SCREENSHOT_MODEL, {
        providerId: CUA_SCREENSHOT_PROVIDER,
        providerName: "CUA R1 fixture",
        includePlainModelFallback: false,
      });
      const marker = `E2E_CUA_SHOT_${kind.toUpperCase()}`;
      await sendV4PromptAndWaitAccepted(
        `${marker}: run the controlled fixture.`,
        marker,
        "Screenshot submission was not accepted",
      );
      const id = await waitCall(seenCalls);
      const session = (await getV4PaneSnapshot()).sessionId;
      if (kind === "allow") {
        if (!session || session === "draft") throw new Error("Allow session not resolved");
        allowSession = session;
      }
      if (kind === "read") {
        receipt.sameSession = Boolean(allowSession && session === allowSession);
        expect(receipt.sameSession).toBe(true);
      }
      let seenRead = false;
      let seenScreenshot = false;
      await browser.waitUntil(
        async () => {
          const dialog = await readR1PermissionDialog();
          if (dialog.kind === "node") {
            await clickR1AllowOnce("node");
            return false;
          }
          if (dialog.kind === "read" && !seenRead) {
            if (!r1IdentityMatches(dialog.identity, targetPid, targetWindow))
              throw new Error("Read identity mismatch");
            if (!dialog.requestId) throw new Error("Read request ID missing");
            if (kind === "allow") allowReadRequestId = dialog.requestId;
            if (kind === "read") {
              receipt.distinctReadRequest = Boolean(
                allowReadRequestId && dialog.requestId !== allowReadRequestId,
              );
              expect(receipt.distinctReadRequest).toBe(true);
            }
            receipt.readDefaultDeny = await browser.execute(
              () =>
                document
                  .querySelector(
                    '[data-cua-confirm-kind="read"] [role="option"][aria-selected="true"]',
                  )
                  ?.getAttribute("data-permission-option-kind") === "rejectOnce",
            );
            expect(receipt.readDefaultDeny).toBe(true);
            seenRead = true;
            receipt.readConfirmations++;
            if (kind === "read") expect(await denyV4PermissionWithFeedback("")).toBe(true);
            else await clickR1AllowOnce("read", dialog.requestId ?? undefined);
            return false;
          }
          if (dialog.kind === "other" && seenRead && kind !== "read" && !seenScreenshot) {
            // 截图卡必须包含目标详情，避免将其他权限卡误当作截图授权。
            const card = await browser.execute(() => {
              const lists = Array.from(
                document.querySelectorAll<HTMLElement>('[role="listbox"]'),
              ).filter((list) =>
                ["Permission required", "需要权限"].includes(list.getAttribute("aria-label") ?? ""),
              );
              if (lists.length !== 1 || document.querySelector('[data-cua-confirm-kind="read"]'))
                return null;
              const root = lists[0]?.parentElement?.parentElement?.parentElement;
              const rows = Array.from(
                root?.querySelectorAll('[data-cua-screenshot-confirm-target="true"] dl dt') ?? [],
              ).map((dt): [string, string] => [
                (dt.textContent ?? "").trim(),
                dt.nextElementSibling?.tagName === "DD"
                  ? (dt.nextElementSibling.textContent ?? "").trim()
                  : "",
              ]);
              const selected = lists[0]?.querySelector('[role="option"][aria-selected="true"]');
              return {
                rows,
                defaultDeny: selected?.getAttribute("data-permission-option-kind") === "rejectOnce",
              };
            });
            if (
              !card ||
              !r1IdentityMatches(parseR1IdentityRows(card.rows), targetPid, targetWindow)
            )
              throw new Error("Screenshot identity mismatch");
            receipt.targetIdentityMatched = true;
            receipt.defaultDeny = card.defaultDeny;
            expect(card.defaultDeny).toBe(true);
            seenScreenshot = true;
            receipt.screenshotConfirmations++;
            if (kind === "deny") expect(await denyV4PermissionWithFeedback("")).toBe(true);
            else {
              const clicked = await browser.execute(() => {
                const lists = Array.from(
                  document.querySelectorAll<HTMLElement>('[role="listbox"]'),
                ).filter((list) =>
                  ["Permission required", "需要权限"].includes(
                    list.getAttribute("aria-label") ?? "",
                  ),
                );
                if (lists.length !== 1) return false;
                const list = lists[0];
                const option = list?.querySelector<HTMLButtonElement>(
                  '[data-permission-option-kind="allowOnce"]',
                );
                if (!option) return null;
                const selected = option.getAttribute("aria-selected") === "true";
                option.click();
                return selected;
              });
              expect(clicked).not.toBeNull();
              if (!clicked) {
                await browser.waitUntil(
                  () =>
                    browser.execute(
                      () =>
                        document
                          .querySelector(
                            '[role="listbox"] [data-permission-option-kind="allowOnce"]',
                          )
                          ?.getAttribute("aria-selected") === "true",
                    ),
                  {
                    timeout: 10_000,
                    timeoutMsg: "Screenshot allow option did not become selected",
                  },
                );
                expect(
                  await browser.execute(() => {
                    const option = document.querySelector<HTMLButtonElement>(
                      '[role="listbox"] [data-permission-option-kind="allowOnce"][aria-selected="true"]',
                    );
                    if (!option) return false;
                    option.click();
                    return true;
                  }),
                ).toBe(true);
              }
            }
            return false;
          }
          return Boolean(
            captured?.records.some((record) =>
              readUpstreamToolResultFromRequest(record.requestJson, id),
            ),
          );
        },
        {
          timeout: 120_000,
          interval: 250,
          timeoutMsg: "Permission sequence or real tool result did not arrive",
        },
      );
      await waitForV4TimelineContaining(`${marker}_DONE`, 60_000);
      const result = captured?.records
        .map((record) => readUpstreamToolResultFromRequest(record.requestJson, id))
        .find(Boolean);
      receipt.resultReceived = Boolean(result);
      if (kind === "deny") {
        // 截图链拒绝由签名 Helper 关闭 authority；此处核验真实错误，不能伪装成 AX 的结构化拒绝。
        expect(result?.isError).toBe(true);
        expect(result?.content).toContain("cua_native_capture_closed:remote-close");
        expect(result?.content).not.toContain("E2E_R1_TARGET_BODY");
        expect(result?.content).not.toContain("E2E_R1_SIBLING_BODY");
      } else {
        expect(result?.content).toContain(
          `CUA_SHOT_${kind === "read" ? "READ_DENIED" : kind.toUpperCase()}_OK`,
        );
      }
      const images =
        captured?.records.map((record) => screenshotEvidence(record.requestJson, id)) ?? [];
      receipt.image =
        images.find((image) => image.valid) ??
        images.find((image) => image.imageCount > 0) ??
        receipt.image;
      expect(receipt.image.valid).toBe(kind === "allow");
      if (kind !== "allow") expect(receipt.image.imageCount).toBe(0);
      if (kind === "read") {
        expect(result?.content).not.toContain("AX window state");
        expect(result?.content).not.toContain("E2E_R1_TARGET_BODY");
        expect(result?.content).not.toContain("E2E_R1_SIBLING_BODY");
        receipt.noTree = true;
      }
      receipt.deniedContentAbsent = kind !== "allow";
      receipt.siblingContentAbsent = true;
      expect(receipt.readConfirmations).toBe(1);
      expect(receipt.screenshotConfirmations).toBe(kind === "read" ? 0 : 1);
      receipt.passed = true;
    });
  }
});
