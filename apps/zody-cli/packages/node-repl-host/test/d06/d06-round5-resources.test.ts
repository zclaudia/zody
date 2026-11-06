import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createD06Round5Workspace,
  isD06Round5CleanupError,
} from "../../scripts/d06-round5-resources.js";
import {
  runIntegrityPrecheck,
  snapshotResources,
  verifyThenExecute,
  verifyResourceManifest,
} from "../../scripts/d06-round5-manifest.js";
import { createD06Workspace } from "../../scripts/d06-resources.js";
import { createEvidence, finalize } from "../../scripts/d06-round5-evidence.js";

const roots: string[] = [];
const wrongHash = "0".repeat(64);

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "d06-round5-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("D06 round 5 resource integrity", () => {
  it("removes the base root when round 5 workspace setup fails", async () => {
    const base = await createD06Workspace();
    await writeFile(join(base.root, "round5"), "not-a-directory", "utf8");
    await expect(
      createD06Round5Workspace(
        { indexPath: "/nonexistent/index.js", nativePath: "/nonexistent/native.node" },
        async () => base,
      ),
    ).rejects.toThrow();
    await expect(access(base.root)).rejects.toThrow();
  });

  it("reports a failed setup cleanup instead of claiming removal", async () => {
    const base = await createD06Workspace();
    roots.push(base.root);
    await writeFile(join(base.root, "round5"), "not-a-directory", "utf8");
    const cleanupError = new Error("injected cleanup failure");
    let caught: unknown;
    try {
      await createD06Round5Workspace(
        { indexPath: "/nonexistent/index.js", nativePath: "/nonexistent/native.node" },
        async () => base,
        async () => {
          throw cleanupError;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isD06Round5CleanupError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({
      name: "D06Round5CleanupError",
      d06CleanupFailed: true,
      cleanupError,
    });

    const evidence = createEvidence();
    evidence.cleanup = { removed: false, error: "injected cleanup failure" };
    const result = finalize(evidence, {
      phase: "setup",
      error: "setup failed",
      code: null,
      blocked: false,
    });
    expect(result.cleanup).toEqual({ removed: false, error: "injected cleanup failure" });
    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.reason).toContain("cleanup failed");
  });

  it("accepts a fixed manifest before execution", async () => {
    const root = await createRoot();
    const file = join(root, "resource.txt");
    await writeFile(file, "trusted", "utf8");
    const manifest = await snapshotResources(root, [{ id: "resource", path: file }]);
    await expect(verifyResourceManifest(manifest)).resolves.toEqual([]);
  });

  it("rejects missing, hash mismatch, symlink and path escape entries", async () => {
    const root = await createRoot();
    const file = join(root, "resource.txt");
    const link = join(root, "resource-link.txt");
    const childRoot = join(root, "child-root");
    const outsideChildRoot = join(root, "outside-child-root.txt");
    await mkdir(childRoot);
    await writeFile(file, "trusted", "utf8");
    await writeFile(outsideChildRoot, "outside-child-root", "utf8");
    await symlink(file, link);
    const manifest = await snapshotResources(root, [{ id: "resource", path: file }]);
    const rootIssues = await verifyResourceManifest({
      root,
      entries: [
        { ...manifest.entries[0]!, id: "missing", path: join(root, "missing.txt") },
        { ...manifest.entries[0]!, id: "mismatch", sha256: wrongHash },
        { ...manifest.entries[0]!, id: "symlink", path: link },
      ],
    });
    const escapeIssues = await verifyResourceManifest({
      root: childRoot,
      entries: [
        { ...manifest.entries[0]!, id: "escape", path: outsideChildRoot, sha256: wrongHash },
      ],
    });
    expect([...rootIssues, ...escapeIssues].map((issue) => issue.issue).sort()).toEqual([
      "hash-mismatch",
      "missing",
      "path-escape",
      "symlink",
    ]);
  });

  it("rejects symlinked ancestor directories and invalid manifest shape", async () => {
    const root = await createRoot();
    const realDir = join(root, "real-dir");
    const linkedDir = join(root, "linked-dir");
    const file = join(realDir, "resource.txt");
    await mkdir(realDir);
    await writeFile(file, "trusted", "utf8");
    await symlink(realDir, linkedDir);
    const manifest = await snapshotResources(root, [{ id: "resource", path: file }]);
    const issues = await verifyResourceManifest({
      root,
      entries: [{ ...manifest.entries[0]!, path: join(linkedDir, "resource.txt") }],
    });
    expect(issues.map((issue) => issue.issue)).toContain("symlink");
    const invalid = await verifyResourceManifest({ root, entries: [] });
    expect(invalid.map((issue) => issue.issue)).toEqual(["empty-manifest"]);
    const duplicate = await verifyResourceManifest({
      root,
      entries: [manifest.entries[0]!, manifest.entries[0]!],
    });
    expect(duplicate.map((issue) => issue.issue).sort()).toEqual([
      "duplicate-id",
      "duplicate-path",
    ]);
    const badHash = await verifyResourceManifest({
      root,
      entries: [{ ...manifest.entries[0]!, sha256: "not-a-hash" }],
    });
    expect(badHash.map((issue) => issue.issue)).toEqual(["invalid-entry"]);
  });

  it("runs all counterexamples and detects tampering before execution", async () => {
    const root = await createRoot();
    const file = join(root, "resource.txt");
    await writeFile(file, "trusted", "utf8");
    const manifest = await snapshotResources(root, [{ id: "resource", path: file }]);
    const result = await runIntegrityPrecheck(root, manifest);
    expect(result.baseline).toEqual([]);
    expect(result.checks).toEqual({
      "manifest verified before execution": true,
      "missing rejected": true,
      "hash mismatch rejected": true,
      "symlink rejected": true,
      "path escape rejected": true,
      "tamper rejected": true,
      "tamper execute refused": true,
      "tamper canary unchanged": true,
    });
    expect(result.guard).toMatchObject({
      executed: false,
      executeCalls: 0,
      canaryUnchanged: true,
    });
  });

  it("refuses execution after tamper and leaves the canary untouched", async () => {
    const root = await createRoot();
    const asset = join(root, "asset.txt");
    const canary = join(root, "canary.txt");
    await writeFile(asset, "trusted-asset", "utf8");
    await writeFile(canary, "trusted-canary", "utf8");
    const manifest = await snapshotResources(root, [
      { id: "asset", path: asset },
      { id: "canary", path: canary },
    ]);
    await writeFile(asset, "tampered-asset", "utf8");
    let executed = false;
    const result = await verifyThenExecute(manifest, async () => {
      executed = true;
      await writeFile(canary, "executed", "utf8");
    });
    expect(result.executed).toBe(false);
    expect(executed).toBe(false);
    expect(result.issues.map((issue) => issue.issue)).toContain("hash-mismatch");
    await expect(
      import("node:fs/promises").then((fs) => fs.readFile(canary, "utf8")),
    ).resolves.toBe("trusted-canary");
  });
});
