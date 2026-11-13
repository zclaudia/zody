import { readCuaV4SessionPhase } from "./cua-v4-session-phase.js";
import { listToolCallBlocks } from "./conversation-session-tool.js";
import { clickR1AllowOnce, readR1PermissionDialog } from "./cua-r1-dialog.js";
import { r1LifecycleOrder } from "./cua-r1-receipt.js";
import { assertFull, result, waitCall, waitRead, type Context } from "./cua-r1-lifecycle.js";
import {
  getV4PaneSnapshot,
  sendV4PromptAndWaitAccepted,
  setV4ElectronWindowSize,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "./v4-conversation.js";

export async function runR1Stop(ctx: Context, noContinuation: (id: string) => boolean) {
  const calls = new Set<string>();
  const reads = new Set<string>();
  const first = await waitCall(calls);
  const request = await waitRead(ctx.fixture, reads);
  const pendingAt = performance.now();
  const initialSession = (await getV4PaneSnapshot()).sessionId;
  if (!initialSession || initialSession === "draft")
    throw new Error("R1 Stop session not materialized");
  const defaultDeny = await browser.execute((expectedId) => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('[data-cua-confirm-kind="read"]'),
    );
    const card = cards.find(
      (item) => item.getAttribute("data-permission-request-id") === expectedId,
    );
    return Boolean(
      card?.querySelector('[data-permission-option-kind="rejectOnce"][aria-selected="true"]'),
    );
  }, request);
  if (!defaultDeny) throw new Error("R1 read card default deny missing");
  ctx.receipt.defaultDeny = true;
  const originalSize =
    process.env.ZODY_CUA_R1_NARROW === "1"
      ? await browser.execute(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }))
      : null;
  if (originalSize) {
    await setV4ElectronWindowSize(480, 800);
    ctx.receipt.narrowSize = await browser.execute(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }
  const pane = await $('[data-testid="v4-session-pane-workspace-main"]');
  const card = await pane.$(
    `[data-cua-confirm-kind="read"][data-permission-request-id="${request}"]`,
  );
  if (!(await card.isDisplayed())) throw new Error("R1 read card is not in the current pane");
  const candidates = await pane.$$('[data-testid="v4-stop"]');
  const visible = [];
  for (const candidate of candidates) {
    if (await candidate.isDisplayed()) visible.push(candidate);
  }
  if (
    visible.length !== 1 ||
    !(await visible[0]!.isEnabled()) ||
    !(await visible[0]!.isClickable())
  )
    throw new Error("R1 Stop is not uniquely user accessible");
  const activation = process.env.ZODY_CUA_R1_KEYBOARD;
  if (activation === "enter" || activation === "space" || activation === "tab-enter") {
    if (activation === "tab-enter") {
      const focusTrace: Array<{
        tag: string;
        role: string | null;
        testId: string | null;
      }> = [];
      for (let i = 0; i < 40; i++) {
        if (await browser.execute((element) => document.activeElement === element, visible[0]))
          break;
        focusTrace.push(
          await browser.execute(() => ({
            tag: document.activeElement?.tagName ?? "",
            role: document.activeElement?.getAttribute("role") ?? null,
            testId: document.activeElement?.getAttribute("data-testid") ?? null,
          })),
        );
        ctx.receipt.focusTrace = focusTrace;
        await browser.keys("Tab");
      }
    } else {
      await browser.execute((element) => element?.focus(), visible[0]);
    }
    const focused = await browser.execute(
      (element) => document.activeElement === element,
      visible[0],
    );
    if (!focused) throw new Error("R1 Stop did not receive keyboard focus");
    await browser.keys(activation === "space" ? " " : "Enter");
  } else {
    await visible[0]!.click();
  }
  if (originalSize) await setV4ElectronWindowSize(originalSize.width, originalSize.height);
  ctx.receipt.narrowViewport = Boolean(originalSize);
  ctx.receipt.stopClicked = !activation;
  ctx.receipt.stopActivatedBy = activation || "webdriver-click";
  ctx.receipt.stopClickedAt = performance.now();
  let terminal = "";
  let clear = false;
  let leak = false;
  await browser.waitUntil(
    async () => {
      const d = await readR1PermissionDialog();
      clear = d.kind !== "read" || d.requestId !== request;
      const block = (await listToolCallBlocks()).find((x) => x.toolCallId === first);
      terminal = block?.status ?? "";
      leak = Boolean(
        block?.text.includes(ctx.fixture.targetMarker) ||
        block?.text.includes(ctx.fixture.siblingMarker) ||
        block?.text.includes("AX window state") ||
        block?.text.includes("AX window diff"),
      );
      return clear && terminal === "stopped";
    },
    {
      timeout: 60_000,
      timeoutMsg: "R1 Stop did not clear card and terminate tool",
    },
  );
  await waitForV4Pane((s) => !s.canStop, "R1 Stop did not end running", 60_000);
  let sessionPhase: Awaited<ReturnType<typeof readCuaV4SessionPhase>> = null;
  await browser.waitUntil(
    async () => {
      sessionPhase = await readCuaV4SessionPhase(initialSession);
      return sessionPhase === "completedInterrupted";
    },
    {
      timeout: 60_000,
      timeoutMsg: "R1 Stop session phase remained active or unavailable",
    },
  );
  ctx.receipt.sessionPhase = sessionPhase;
  const old = ctx.latestResult(first);
  const content = old?.content ?? "";
  const clean =
    !leak &&
    !content.includes(ctx.fixture.targetMarker) &&
    !content.includes(ctx.fixture.siblingMarker) &&
    !content.includes("AX window state") &&
    !content.includes("AX window diff");
  Object.assign(ctx.receipt, {
    cardCleared: clear,
    terminationObservedAt: performance.now(),
    terminal,
    oldOutputClean: clean,
    noContinuation: noContinuation(first),
  });
  ctx.receipt.pendingAt = pendingAt;
  if (
    !r1LifecycleOrder([
      pendingAt,
      ctx.receipt.stopClickedAt as number,
      ctx.receipt.terminationObservedAt as number,
    ])
  )
    throw new Error("R1 Stop ordering invalid");
  if (!clean || !noContinuation(first)) throw new Error("R1 stopped call leaked or continued");
  await sendV4PromptAndWaitAccepted(
    "E2E_CUA_R1_RESUME: run the controlled observation fixture.",
    "E2E_CUA_R1_RESUME",
    "R1 resume submission not accepted",
  );
  ctx.receipt.resumeAccepted = true;
  const resumedSession = (await getV4PaneSnapshot()).sessionId;
  ctx.receipt.sameSession = resumedSession === initialSession;
  if (!ctx.receipt.sameSession) throw new Error("R1 Stop resumed a different session");
  const next = await waitCall(calls);
  const r2 = await waitRead(ctx.fixture, reads);
  const resumedDefaultDeny = await browser.execute((expectedId) => {
    const card = Array.from(
      document.querySelectorAll<HTMLElement>('[data-cua-confirm-kind="read"]'),
    ).find((item) => item.getAttribute("data-permission-request-id") === expectedId);
    return Boolean(
      card?.querySelector('[data-permission-option-kind="rejectOnce"][aria-selected="true"]'),
    );
  }, r2);
  if (!resumedDefaultDeny) throw new Error("R1 resumed read card default deny missing");
  ctx.receipt.resumedDefaultDeny = true;
  await clickR1AllowOnce("read", r2);
  assertFull(await result(ctx, next), ctx.fixture);
  Object.assign(ctx.receipt, {
    newFull: true,
    newFullAt: performance.now(),
    distinctReadRequests: reads.size === 2,
  });
  if (
    reads.size !== 2 ||
    !r1LifecycleOrder([
      ctx.receipt.terminationObservedAt as number,
      ctx.receipt.newFullAt as number,
    ])
  )
    throw new Error("R1 Stop read ordering invalid");
  await waitForV4TimelineContaining("E2E_CUA_R1_RESUME_DONE", 60_000);
  ctx.receipt.finalObserved = true;
  // 中文原因：恢复之前的快照无法证明恢复后旧卡和历史仍安全；取消历史可以存在，
  // 此处只检查精确旧调用的终态及内容，不把取消记录误判为模型续跑。
  const oldAfterResume = (await listToolCallBlocks()).find((block) => block.toolCallId === first);
  const providerAfterResume = ctx.latestResult(first)?.content ?? "";
  const noOldContent = (text: string) =>
    !text.includes(ctx.fixture.targetMarker) &&
    !text.includes(ctx.fixture.siblingMarker) &&
    !text.includes("AX window state") &&
    !text.includes("AX window diff");
  const afterResume = Boolean(
    oldAfterResume &&
    oldAfterResume.status === "stopped" &&
    noOldContent(oldAfterResume.text) &&
    noOldContent(providerAfterResume),
  );
  ctx.receipt.afterResume = afterResume;
  if (!afterResume) throw new Error("R1 stopped call changed or leaked after resume");
}
