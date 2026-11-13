import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { waitR1OldReferenceResult } from "./cua-r1-old-reference.js";
import { listToolCallBlocks } from "./conversation-session-tool.js";
import { clickR1AllowOnce, readR1PermissionDialog } from "./cua-r1-dialog.js";
import {
  inspectR1LifecycleFailure,
  r1LifecycleOrder,
  r1IdentityMatches,
  validateR1FreshFixture,
  type R1Fixture,
} from "./cua-r1-receipt.js";
import type { UpstreamToolResultSnapshot } from "./conversation-session-network.js";
import {
  waitForV4TimelineContaining,
} from "./v4-conversation.js";

const exec = promisify(execFile);
const TOOL = "mcp__node_repl__js";
export type Context = {
  fixture: R1Fixture;
  manifestPath: string;
  runtimeManifest: string;
  latestResult: (id: string) => UpstreamToolResultSnapshot | null;
  receipt: Record<string, unknown>;
};

export async function waitCall(seen: Set<string>) {
  let id = "";
  await browser.waitUntil(
    async () => {
      id =
        (await listToolCallBlocks()).find(
          (x) => x.toolName === TOOL && x.toolCallId && !seen.has(x.toolCallId),
        )?.toolCallId ?? "";
      return Boolean(id);
    },
    { timeout: 60_000, timeoutMsg: "R1 lifecycle tool call missing" },
  );
  seen.add(id);
  return id;
}
export async function waitRead(fixture: R1Fixture, seen: Set<string>) {
  let id = "";
  let nodeClicked = false;
  let error = "";
  await browser.waitUntil(
    async () => {
      const d = await readR1PermissionDialog();
      if (d.kind === "node" && !nodeClicked) {
        await clickR1AllowOnce("node");
        nodeClicked = true;
      }
      if (d.kind !== "read" || !d.requestId || seen.has(d.requestId))
        return false;
      id = d.requestId;
      if (
        !r1IdentityMatches(d.identity, fixture.pid, fixture.targetWindow) ||
        d.allowAlways ||
        d.fullAccess ||
        !/Read window content|读取窗口内容/.test(d.text)
      )
        error = "Invalid R1 read target";
      return true;
    },
    { timeout: 60_000, timeoutMsg: "R1 lifecycle read request missing" },
  );
  if (error) throw new Error(error);
  seen.add(id);
  return id;
}
export async function result(ctx: Context, id: string) {
  let value: UpstreamToolResultSnapshot | null = null;
  await browser.waitUntil(
    () => {
      value = ctx.latestResult(id);
      return Boolean(value);
    },
    { timeout: 60_000, timeoutMsg: "R1 lifecycle provider result missing" },
  );
  return value!;
}
export function assertFull(
  value: UpstreamToolResultSnapshot,
  fixture: R1Fixture,
) {
  const text = value.content;
  if (
    value.isError ||
    !text.includes("AX window state") ||
    !text.includes(fixture.targetMarker) ||
    text.includes(fixture.siblingMarker) ||
    !text.includes("R1_FULL_OK")
  )
    throw new Error("R1 lifecycle full result invalid");
}
async function command(path: string, args: string[]) {
  const output = await exec(path, args, { timeout: 10_000, maxBuffer: 4096 });
  const value = JSON.parse(output.stdout) as {
    ok?: boolean;
    launchDate?: number;
  };
  if (value.ok !== true) throw new Error("R1 fixture control rejected");
  return value;
}
export async function inspectR1FixtureLaunch(fixture: R1Fixture) {
  const control = process.env.ZODY_CUA_R1_FIXTURE_CONTROL ?? "";
  const executable = process.env.ZODY_CUA_R1_FIXTURE_EXECUTABLE ?? "";
  if (
    !isAbsolute(control) ||
    !isAbsolute(executable) ||
    resolve(control) !== control ||
    resolve(executable) !== executable
  )
    throw new Error("R1 lifecycle control paths required");
  const info = await command(control, [
    "inspect",
    String(fixture.pid),
    executable,
  ]);
  if (
    typeof info.launchDate !== "number" ||
    !Number.isFinite(info.launchDate) ||
    info.launchDate <= 0
  )
    throw new Error("R1 fixture launch date unavailable");
  return info.launchDate;
}

export async function refreshR1Fixture(
  original: R1Fixture,
  manifestPath: string,
  runtimeManifest: string,
  launch: number,
) {
  const currentLaunch = await inspectR1FixtureLaunch(original);
  const control = process.env.ZODY_CUA_R1_FIXTURE_CONTROL!;
  const candidate = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const probe = JSON.parse(
    (
      await exec(
        resolve(dirname(control), "fixture-preflight"),
        [manifestPath],
        {
          timeout: 10_000,
        },
      )
    ).stdout,
  ) as unknown;
  const afterLaunch = await inspectR1FixtureLaunch(original);
  const after = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const fresh = validateR1FreshFixture(
    original,
    candidate,
    probe,
    launch,
    currentLaunch,
  );
  const stable = validateR1FreshFixture(
    original,
    after,
    probe,
    launch,
    afterLaunch,
  );
  if (!fresh || !stable || fresh.targetWindow !== stable.targetWindow)
    throw new Error("R1 current fixture validation failed");
  await writeFile(runtimeManifest, JSON.stringify(fresh), { mode: 0o600 });
  return fresh;
}

export async function runR1Rebuild(ctx: Context) {
  const control = process.env.ZODY_CUA_R1_FIXTURE_CONTROL ?? "";
  const executable = process.env.ZODY_CUA_R1_FIXTURE_EXECUTABLE ?? "";
  if (
    !isAbsolute(control) ||
    !isAbsolute(executable) ||
    resolve(control) !== control ||
    resolve(executable) !== executable
  )
    throw new Error("R1 lifecycle control paths required");
  const seen = new Set<string>();
  const reads = new Set<string>();
  const first = await waitCall(seen);
  const r1 = await waitRead(ctx.fixture, reads);
  await clickR1AllowOnce("read", r1);
  assertFull(await result(ctx, first), ctx.fixture);
  ctx.receipt.firstFull = true;
  const second = await waitCall(seen);
  const r2 = await waitRead(ctx.fixture, reads);
  const pendingAt = performance.now();
  const inspected = await command(control, [
    "inspect",
    String(ctx.fixture.pid),
    executable,
  ]);
  if (
    typeof inspected.launchDate !== "number" ||
    !Number.isFinite(inspected.launchDate) ||
    inspected.launchDate <= 0
  )
    throw new Error("R1 fixture launch date unavailable");
  await command(control, [
    "rebuild",
    String(ctx.fixture.pid),
    executable,
    String(inspected.launchDate),
  ]);
  ctx.receipt.rebuildSent = true;
  ctx.receipt.rebuildSentAt = performance.now();
  let fresh: R1Fixture | undefined;
  await browser.waitUntil(
    async () => {
      const next = JSON.parse(
        await readFile(ctx.manifestPath, "utf8"),
      ) as R1Fixture;
      if (
        next.pid !== ctx.fixture.pid ||
        next.siblingWindow !== ctx.fixture.siblingWindow ||
        next.targetWindow === ctx.fixture.targetWindow ||
        next.targetWindow === next.siblingWindow ||
        !Number.isSafeInteger(next.targetWindow) ||
        next.targetWindow <= 0 ||
        next.fixtureKind !== "explicit-ax-content-v1" ||
        next.targetMarker !== ctx.fixture.targetMarker ||
        next.siblingMarker !== ctx.fixture.siblingMarker
      )
        return false;
      fresh = next;
      return true;
    },
    { timeout: 10_000, timeoutMsg: "R1 replacement manifest missing" },
  );
  const check = await command(control, [
    "inspect",
    String(ctx.fixture.pid),
    executable,
  ]);
  if (check.launchDate !== inspected.launchDate || !fresh)
    throw new Error("R1 fixture incarnation changed");
  const probe = JSON.parse(
    (
      await exec(
        resolve(dirname(control), "fixture-preflight"),
        [ctx.manifestPath],
        {
          timeout: 10_000,
        },
      )
    ).stdout,
  ) as {
    pid: number;
    hidden: boolean;
    launchDatePresent: boolean;
    windowIDs: Array<{
      windowID: number;
      boundsValid: boolean;
      layer: number;
      onscreen: boolean;
    }>;
  };
  if (
    probe.pid !== fresh.pid ||
    probe.hidden ||
    !probe.launchDatePresent ||
    probe.windowIDs.length !== 2 ||
    ![fresh.targetWindow, fresh.siblingWindow].every((id) =>
      probe.windowIDs.some(
        (w) =>
          w.windowID === id && w.boundsValid && w.layer === 0 && w.onscreen,
      ),
    )
  )
    throw new Error("R1 replacement preflight failed");
  Object.assign(ctx.receipt, {
    replacementObserved: true,
    replacementObservedAt: performance.now(),
    oldWindow: ctx.fixture.targetWindow,
    newWindow: fresh.targetWindow,
    siblingWindow: fresh.siblingWindow,
  });
  await writeFile(
    resolve(dirname(ctx.runtimeManifest), "replacement-manifest.json"),
    JSON.stringify(fresh),
    { mode: 0o600 },
  );
  if (
    !r1LifecycleOrder([
      pendingAt,
      ctx.receipt.rebuildSentAt as number,
      ctx.receipt.replacementObservedAt as number,
    ])
  )
    throw new Error("R1 rebuild ordering invalid");
  ctx.receipt.pendingAt = pendingAt;
  await clickR1AllowOnce("read", r2);
  ctx.receipt.oldCardAllowedAt = performance.now();
  if (
    !r1LifecycleOrder([
      ctx.receipt.replacementObservedAt as number,
      ctx.receipt.oldCardAllowedAt as number,
    ])
  )
    throw new Error("R1 old card ordering invalid");
  const oldPending = inspectR1LifecycleFailure(
    await result(ctx, second),
    ctx.fixture,
    2,
  );
  ctx.receipt.oldPending = oldPending;
  if (!oldPending.ok) throw new Error("R1 pending old window was not rejected");
  const third = await waitCall(seen);
  const { result: thirdResult, unexpectedRead } =
    await waitR1OldReferenceResult({
      callId: third,
      seenReads: reads,
      readDialog: readR1PermissionDialog,
      allowNode: () => clickR1AllowOnce("node"),
      latestResult: ctx.latestResult,
    });
  const oldAgain = inspectR1LifecycleFailure(thirdResult, ctx.fixture, 3);
  Object.assign(ctx.receipt, { oldAgain, unexpectedRead });
  if (unexpectedRead || !oldAgain.ok)
    throw new Error("R1 old window was not rejected before confirmation");
  const fourth = await waitCall(seen);
  const r4 = await waitRead(fresh, reads);
  await clickR1AllowOnce("read", r4);
  assertFull(await result(ctx, fourth), fresh);
  Object.assign(ctx.receipt, {
    newFull: true,
    newFullAt: performance.now(),
    distinctReadRequests: reads.size === 3,
  });
  if (
    reads.size !== 3 ||
    !r1LifecycleOrder([
      ctx.receipt.oldCardAllowedAt as number,
      ctx.receipt.newFullAt as number,
    ])
  )
    throw new Error("R1 rebuild read ordering invalid");
  await waitForV4TimelineContaining("E2E_CUA_R1_REBUILD_DONE", 60_000);
  ctx.receipt.finalObserved = true;
  return fresh;
}
