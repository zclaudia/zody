import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClosureVerificationError,
  sha256File,
  validateReviewConfig,
  validateSourceManifest,
} from "../scripts/lib/cua-driver-closure-core.mjs";
import { auditSourceFiles, scanCandidateTree } from "../scripts/lib/cua-driver-closure-source.mjs";
import {
  assertReconstructedTree,
  createSourcePatch,
  reconstructCandidateFromPatch,
} from "../scripts/lib/cua-driver-closure-patch.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function makeTempDir() {
  const directory = await mkdtemp(join(tmpdir(), "zody-cua-driver-closure-test-"));
  tempDirs.push(directory);
  return directory;
}

function sha(text: string | Buffer) {
  return createHash("sha256").update(text).digest("hex");
}

function reviewConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-review",
    revision: "a".repeat(40),
    sourceRoot: "libs/cua-driver/rust",
    sourceManifest: "source-manifest.json",
    expected: { selectedFiles: 2, changedFiles: 1, addedFiles: 1, candidateFiles: 3 },
    upstreamLicensePath: "LICENSE.md",
    allowedDelta: { modified: ["Cargo.toml"], added: ["vendor/core/LICENSE"], removed: [] },
    package: "cua-driver-sdk",
    target: "aarch64-apple-darwin",
    toolchain: { upstreamDeclared: "1.97.1", auditedVersion: "1.93.1" },
    licensePolicy: {
      selection: "driver-required-mit-core-and-audited-dependency-closure",
      automaticPolicyDecision: false,
      mplHandling: "record-materials-and-obligations-without-legal-determination",
    },
    ...overrides,
  };
}

function sourceManifest(
  entries: Array<{
    path: string;
    upstreamSha256?: string;
    candidateSha256: string;
    status: string;
  }>,
) {
  return {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-source-manifest",
    revision: "a".repeat(40),
    sourceRoot: "libs/cua-driver/rust",
    files: entries,
  };
}

async function writeTree(root: string, files: Record<string, string | Buffer>) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
}

describe("macOS CUA Driver closure source audit", () => {
  it("rejects unsafe review paths before reading any source", () => {
    expect(() => validateReviewConfig(reviewConfig({ sourceRoot: "../cua" }))).toThrow(
      ClosureVerificationError,
    );
    expect(() =>
      validateReviewConfig(
        reviewConfig({ allowedDelta: { modified: [], added: ["../escape"], removed: [] } }),
      ),
    ).toThrow(/safe relative path/);
  });

  it("requires exact manifest counts and explicit removed files", () => {
    const manifest = sourceManifest([
      {
        path: "Cargo.toml",
        upstreamSha256: sha("a"),
        candidateSha256: sha("b"),
        status: "modified",
      },
      {
        path: "src/lib.rs",
        upstreamSha256: sha("c"),
        candidateSha256: sha("c"),
        status: "unchanged",
      },
      { path: "vendor/core/LICENSE", candidateSha256: sha("MIT\n"), status: "added" },
    ]);
    expect(() => validateSourceManifest(manifest, reviewConfig())).not.toThrow();
    expect(() =>
      validateSourceManifest({ ...manifest, files: manifest.files.slice(0, 1) }, reviewConfig()),
    ).toThrow(/count/);
    expect(() =>
      validateReviewConfig(
        reviewConfig({
          expected: { selectedFiles: 2, changedFiles: 1, addedFiles: 0, candidateFiles: 1 },
          allowedDelta: { modified: ["Cargo.toml"], added: [], removed: ["removed.rs"] },
        }),
      ),
    ).toThrow(/removals are not supported/);
  });

  it("rejects unknown additions, missing files and symlink escape", async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      "Cargo.toml": "candidate\n",
      "src/lib.rs": "same\n",
      "vendor/core/LICENSE": "MIT\n",
      "unexpected.txt": "unknown\n",
    });
    const manifest = sourceManifest([
      {
        path: "Cargo.toml",
        upstreamSha256: sha("upstream\n"),
        candidateSha256: sha("candidate\n"),
        status: "modified",
      },
      {
        path: "src/lib.rs",
        upstreamSha256: sha("same\n"),
        candidateSha256: sha("same\n"),
        status: "unchanged",
      },
      { path: "vendor/core/LICENSE", candidateSha256: sha("MIT\n"), status: "added" },
    ]);
    const blobs = new Map([
      ["Cargo.toml", Buffer.from("upstream\n")],
      ["src/lib.rs", Buffer.from("same\n")],
    ]);
    await expect(
      auditSourceFiles({
        config: reviewConfig(),
        manifest,
        candidateRoot: root,
        readBlob: async (path: string) => blobs.get(path) ?? null,
      }),
    ).rejects.toThrow(/unexpected candidate file/);

    await rm(join(root, "unexpected.txt"));
    await rm(join(root, "src/lib.rs"));
    await symlink("Cargo.toml", join(root, "src/lib.rs"));
    await expect(scanCandidateTree(root)).rejects.toThrow(/symlink/);
  });

  it("rejects hash drift and changed files outside the reviewed allowlist", async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      "Cargo.toml": "candidate\n",
      "src/lib.rs": "drifted\n",
      "vendor/core/LICENSE": "MIT\n",
    });
    const manifest = sourceManifest([
      {
        path: "Cargo.toml",
        upstreamSha256: sha("upstream\n"),
        candidateSha256: sha("candidate\n"),
        status: "modified",
      },
      {
        path: "src/lib.rs",
        upstreamSha256: sha("same\n"),
        candidateSha256: sha("same\n"),
        status: "unchanged",
      },
      { path: "vendor/core/LICENSE", candidateSha256: sha("MIT\n"), status: "added" },
    ]);
    const blobs = new Map([
      ["Cargo.toml", Buffer.from("upstream\n")],
      ["src/lib.rs", Buffer.from("same\n")],
    ]);
    await expect(
      auditSourceFiles({
        config: reviewConfig(),
        manifest,
        candidateRoot: root,
        readBlob: async (path: string) => blobs.get(path) ?? null,
      }),
    ).rejects.toThrow(/hash drift/);
  });

  it("builds a self-contained patch and reconstructs the candidate exactly", async () => {
    const root = await makeTempDir();
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    const reconstructed = join(root, "reconstructed");
    await writeTree(baseline, {
      "Cargo.toml": 'members = ["old"]\n',
      "src/lib.rs": "pub fn value() -> u8 { 1 }\n",
    });
    await writeTree(candidate, {
      "Cargo.toml": 'members = ["new"]\n',
      "src/lib.rs": "pub fn value() -> u8 { 1 }\n",
      "vendor/core/LICENSE": "MIT\n",
    });
    const patchPath = join(root, "candidate.patch");
    await createSourcePatch({
      baselineRoot: baseline,
      candidateRoot: candidate,
      patchPath,
      workRoot: root,
    });
    const patch = await readFile(patchPath, "utf8");
    expect(patch).toContain("b/vendor/core/LICENSE");
    expect(patch).toContain("+MIT");
    const applied = await reconstructCandidateFromPatch({
      baselineRoot: baseline,
      patchPath,
      outputRoot: reconstructed,
      workRoot: root,
    });
    await assertReconstructedTree({
      reconstructed: applied,
      expectedEntries: new Map([
        ["Cargo.toml", { sha256: sha('members = ["new"]\n') }],
        ["src/lib.rs", { sha256: sha("pub fn value() -> u8 { 1 }\n") }],
        ["vendor/core/LICENSE", { sha256: sha("MIT\n") }],
      ]),
    });
    expect(await sha256File(join(reconstructed, "vendor/core/LICENSE"))).toBe(sha("MIT\n"));
    expect(await sha256File(join(reconstructed, "Cargo.toml"))).toBe(sha('members = ["new"]\n'));
  });
});
