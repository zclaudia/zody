import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { clickR1AllowOnce } from "./cua-r1-dialog.js";
import { inspectR1FixtureLaunch, type Context } from "./cua-r1-lifecycle.js";

type Event = {
  pid: number;
  observationId: number;
  sequence: number;
  scopeDigest: string;
  event: string;
  reason?: string;
};
export function createR1DeliveryBarrier(ctx: Context, evidenceDir: string) {
  const run = dirname(ctx.manifestPath);
  let allowed: Event | undefined;
  let launch: number;
  const events = async (): Promise<Event[]> => {
    const directory = process.env.ZODY_LOG_DIR;
    if (!directory || !isAbsolute(directory))
      throw new Error("R1 worker-specific CLI log directory missing");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const logs = await Promise.all(
      names
        .filter((n) => /^zody-.*\.jsonl$/.test(n))
        .sort()
        .map((n) => readFile(resolve(directory, n), "utf8")),
    );
    return logs.flatMap((log) =>
      log
        .split("\n")
        .slice(0, -1)
        .flatMap((line) => {
          const entry = JSON.parse(line) as { message?: unknown };
          if (typeof entry.message !== "string" || !entry.message.startsWith("cua-read-delivery: "))
            return [];
          return [JSON.parse(entry.message.slice("cua-read-delivery: ".length)) as Event];
        }),
    );
  };
  const fixtureEvent = async (file: string) => {
    try {
      return JSON.parse(await readFile(resolve(run, file), "utf8")) as {
        pid: number;
        event: string;
        sequence: number;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    async verify() {
      const all = await events();
      await writeFile(
        resolve(evidenceDir, "read-delivery-events.json"),
        JSON.stringify(all, null, 2) + "\n",
        { flag: "wx" },
      );
      const old = all.filter(
        (e) =>
          e.pid === allowed?.pid &&
          e.observationId === allowed.observationId &&
          e.scopeDigest === allowed.scopeDigest,
      );
      if (
        !old.some((e) => e.event === "discarded") ||
        old.some((e) => ["accepted", "delivered"].includes(e.event))
      )
        throw new Error("R1 old scope delivered or did not discard");
      const resumed = all.filter(
        (e) => e.scopeDigest !== allowed?.scopeDigest && e.event === "delivered",
      );
      if (resumed.length !== 1) throw new Error("R1 new scope did not independently deliver");
      ctx.receipt.oldScopeDiscarded = true;
      ctx.receipt.oldScopeNeverAcceptedOrDelivered = true;
      ctx.receipt.newScopeDelivered = true;
    },
    async beforeStop(requestId: string) {
      launch = await inspectR1FixtureLaunch(ctx.fixture);
      if ((await events()).some((e) => e.event === "allowed"))
        throw new Error("R1 delivery needs an isolated read");
      await clickR1AllowOnce("read", requestId);
      await browser.waitUntil(
        async () => {
          allowed = (await events()).find((e) => e.event === "allowed");
          const entered = await fixtureEvent("gate-entered.json");
          return Boolean(
            allowed &&
            entered?.pid === ctx.fixture.pid &&
            entered.event === "after-body-before-window-recheck",
          );
        },
        { timeout: 10_000, interval: 20, timeoutMsg: "R1 actual AX read barrier not reached" },
      );
      ctx.receipt.allowedEvent = allowed;
      ctx.receipt.fixtureGate = await fixtureEvent("gate-entered.json");
    },
    async afterStop() {
      let revoked: Event | undefined;
      await browser.waitUntil(
        async () => {
          const current = await events();
          revoked = current.find(
            (e) =>
              e.pid === allowed?.pid &&
              e.observationId === allowed.observationId &&
              e.scopeDigest === allowed.scopeDigest &&
              e.event === "invalidated" &&
              e.reason === "owner-revoked" &&
              e.sequence > allowed.sequence,
          );
          if (
            current.some(
              (e) =>
                e.observationId === allowed?.observationId &&
                e.pid === allowed.pid &&
                ["accepted", "delivered"].includes(e.event),
            )
          )
            throw new Error("R1 body delivered before Stop");
          return Boolean(revoked);
        },
        { timeout: 1200, interval: 10, timeoutMsg: "R1 real authority revocation missing" },
      );
      // 中文原因：先观察唯一 authority 的真实撤销，再释放自有夹具的迟到 AX 回复；不把 UI 点击当撤销。
      if ((await inspectR1FixtureLaunch(ctx.fixture)) !== launch)
        throw new Error("R1 fixture identity changed");
      process.kill(ctx.fixture.pid, "SIGUSR1");
      await browser.waitUntil(async () => Boolean(await fixtureEvent("gate-released.json")), {
        timeout: 2000,
        interval: 10,
      });
      const released = await fixtureEvent("gate-released.json");
      ctx.receipt.revokedEvent = revoked;
      ctx.receipt.releasedGate = released;
      if (released?.pid !== ctx.fixture.pid || released.event !== "explicit-release")
        throw new Error("R1 gate timed out; not revocation evidence");
      ctx.receipt.authorityBeforeRelease = true;
      ctx.receipt.observedLateReplyKind =
        "AX metadata reply after captured local body; no late body-frame claim";
    },
  };
}
