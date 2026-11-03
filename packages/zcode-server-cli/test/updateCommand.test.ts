import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { currentServerTarget } from "../src/runtime/manifest.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { ControlRequestError } from "../src/ipc/controlError.js";

const requestControl = vi.fn();
const prepareOnlineUpdate = vi.fn();

vi.mock("../src/ipc/controlClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ipc/controlClient.js")>();
  return { ...actual, requestControl };
});
vi.mock("../src/runtime/updatePreparation.js", () => ({ prepareOnlineUpdate }));

const { runUpdateCommand, runLocalArchiveUpdateCommand } =
  await import("../src/runtime/updateCommand.js");

const execFileAsync = promisify(execFile);

/** 构造带合法 runtime manifest 的 release archive；version 来自 archive 内容。 */
async function createTestReleaseArchive(root: string, version: string): Promise<string> {
  const archiveRoot = join(root, `zcode-server-${currentServerTarget()}`);
  await mkdir(join(archiveRoot, "runtime"), { recursive: true });
  await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
  await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
  await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
  await writeFile(join(archiveRoot, "runtime", "zcode.cjs"), "", "utf8");
  await writeFile(
    join(archiveRoot, "manifest.json"),
    JSON.stringify({
      product: "zcode-server",
      target: currentServerTarget(),
      appVersion: version,
      nodeVersion: "22.16.0",
      entrypoints: {
        cli: "runtime/server-cli.js",
        core: "runtime/server-core.js",
        agent: "runtime/zcode.cjs",
      },
      native: [],
    }),
    "utf8",
  );
  const archivePath = join(root, `release-${version}.tar.gz`);
  await execFileAsync("tar", ["-czf", archivePath, `zcode-server-${currentServerTarget()}`], {
    cwd: root,
  });
  return archivePath;
}

async function seedCurrentRelease(
  layout: ReturnType<typeof resolveServerLayout>,
  version: string,
): Promise<void> {
  const releases = new ReleaseManager(layout);
  await releases.ensure();
  const releaseDir = join(layout.releasesDir, `current-${version}`);
  await mkdir(releaseDir, { recursive: true });
  await releases.writePending({ version, releaseDir, target: currentServerTarget() });
  await releases.applyPending();
}

describe("runUpdateCommand cleanup errors", () => {
  const layout = resolveServerLayout("/tmp/zcode-update-command-test");

  beforeEach(() => {
    requestControl.mockReset();
    prepareOnlineUpdate.mockReset();
  });

  it("preserves the running-task guard when blocked-release cleanup fails", async () => {
    const discard = vi.fn().mockRejectedValue(new Error("pending release could not be removed"));
    prepareOnlineUpdate.mockResolvedValue({ status: "prepared", version: "4.0.0", discard });
    requestControl
      .mockResolvedValueOnce({ status: "ready", runningTaskCount: 0 })
      .mockResolvedValueOnce({ status: "blocked", runningTaskCount: 1 });

    await expect(runUpdateCommand([], {}, false, layout, vi.fn())).rejects.toThrow(
      "Running tasks require --force for update",
    );
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("preserves the running-task guard when apply cleanup fails", async () => {
    const discard = vi.fn().mockRejectedValue(new Error("release directory could not be removed"));
    prepareOnlineUpdate.mockResolvedValue({ status: "prepared", version: "4.0.0", discard });
    requestControl.mockResolvedValue({ status: "ready", runningTaskCount: 0 });
    const applyUpdate = vi
      .fn()
      .mockRejectedValue(new Error("Running tasks require --force for update"));

    await expect(runUpdateCommand([], {}, false, layout, applyUpdate)).rejects.toThrow(
      "Running tasks require --force for update",
    );
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("preserves a non-guard control error when cleanup fails", async () => {
    const discard = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    prepareOnlineUpdate.mockResolvedValue({ status: "prepared", version: "4.0.0", discard });
    requestControl
      .mockResolvedValueOnce({ status: "ready", runningTaskCount: 0 })
      .mockRejectedValueOnce(new Error("control socket unavailable"));

    await expect(runUpdateCommand([], {}, false, layout, vi.fn())).rejects.toThrow(
      "control socket unavailable",
    );
    expect(discard).toHaveBeenCalledTimes(1);
  });
});

describe("runLocalArchiveUpdateCommand downgrade gate", () => {
  beforeEach(() => {
    requestControl.mockReset();
    // daemon 离线：endpoint 不可达错误走本地事务路径。
    requestControl.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED /run/control.sock"), {
        code: "ECONNREFUSED",
      }),
    );
  });

  it("rejects an archive downgrade without --allow-downgrade and removes the pending release", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-update-archive-downgrade-"));
    const layout = resolveServerLayout(join(root, "server"));
    await seedCurrentRelease(layout, "3.3.0");
    const archivePath = await createTestReleaseArchive(root, "3.2.0");

    const error = await runLocalArchiveUpdateCommand(
      ["update", "--from-archive", archivePath],
      {},
      false,
      layout,
      vi.fn(),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlRequestError);
    expect((error as ControlRequestError).code).toBe("source-server-downgrade-unconfirmed");
    expect((error as Error).message).toContain("requires --allow-downgrade");
    // 拒绝时必须清理本次写入的 pending，且不写降级标记。
    await expect(readFile(layout.pendingFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(layout.downgradeMarkerFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // current 不变：没有被静默降级。
    expect((await new ReleaseManager(layout).readCurrent())?.version).toBe("3.3.0");
  });

  it("applies an archive downgrade with --allow-downgrade and records the marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-update-archive-downgrade-ok-"));
    const layout = resolveServerLayout(join(root, "server"));
    await seedCurrentRelease(layout, "3.3.0");
    const archivePath = await createTestReleaseArchive(root, "3.2.0");
    const output: string[] = [];

    const exit = await runLocalArchiveUpdateCommand(
      ["update", "--from-archive", archivePath, "--allow-downgrade"],
      { stdout: { write: (value) => output.push(value) } },
      false,
      layout,
      vi.fn(),
    );

    expect(exit).toBe(0);
    expect(output.join("")).toContain("3.2.0 updated");
    expect((await new ReleaseManager(layout).readCurrent())?.version).toBe("3.2.0");
    expect(JSON.parse(await readFile(layout.downgradeMarkerFile, "utf8"))).toMatchObject({
      fromVersion: "3.3.0",
    });
  });

  it("treats a first install from archive as installed rather than a downgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-update-archive-first-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archivePath = await createTestReleaseArchive(root, "3.2.0");
    const output: string[] = [];

    const exit = await runLocalArchiveUpdateCommand(
      ["update", "--from-archive", archivePath],
      { stdout: { write: (value) => output.push(value) } },
      true,
      layout,
      vi.fn(),
    );

    expect(exit).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      applied: true,
      installed: true,
      version: "3.2.0",
    });
    await expect(readFile(layout.downgradeMarkerFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires an absolute archive path", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-update-archive-relative-"));
    const layout = resolveServerLayout(join(root, "server"));
    await expect(
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", "relative.tar.gz"],
        {},
        false,
        layout,
        vi.fn(),
      ),
    ).rejects.toThrow(/must be an absolute path/);
  });
});
