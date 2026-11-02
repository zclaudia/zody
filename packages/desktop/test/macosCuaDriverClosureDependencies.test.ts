import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditRegistryCache,
  deriveClosureGates,
  parseCargoTree,
  toolchainDelta,
  toolchainDeltaFromProbe,
} from "../scripts/lib/cua-driver-closure-dependencies.mjs";
import {
  archiveLicenseMaterials,
  classifyLicenseExpression,
  summarizeLicenseMaterials,
} from "../scripts/lib/cua-driver-closure-licenses.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function sha(text: string | Buffer) {
  return createHash("sha256").update(text).digest("hex");
}

const TREE = [
  "cua-driver-sdk v0.37.0 (/tmp/source/crates/cua-driver-sdk)|default",
  "serde v1.0.0|default,derive",
  "serde v1.0.0 (*)",
  "build-helper v2.0.0 (/tmp/source/build-helper)|",
  "cua-driver-sdk v0.37.0 (/tmp/source/crates/cua-driver-sdk) (*)",
].join("\n");

describe("macOS CUA Driver closure dependency audit", () => {
  it("counts the actual unique target graph instead of lock entries", () => {
    const parsed = parseCargoTree(TREE);
    expect(parsed.packages).toHaveLength(3);
    expect(parsed.packages.find((entry) => entry.name === "serde")).toMatchObject({
      version: "1.0.0",
      features: ["default", "derive"],
    });
    expect(parsed.packages.find((entry) => entry.name === "cua-driver-sdk")?.path).toContain(
      "/tmp/source/crates/cua-driver-sdk",
    );
    expect(() => parseCargoTree(`${TREE}\nmystery dependency line`)).toThrow(
      /unrecognized cargo tree line/,
    );
    expect(() => parseCargoTree("")).toThrow(/did not contain a package graph/);
  });

  it("fails closed on source tampering, checksum drift and missing cache source", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-driver-closure-cache-test-"));
    tempDirs.push(root);
    const cacheDir = join(root, "registry", "cache", "index");
    const stagingDir = join(root, "staging", "serde-1.0.0");
    const sourceDir = join(root, "registry", "src", "index", "serde-1.0.0");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    const manifest = '[package]\nname="serde"\nversion="1.0.0"\n';
    await writeFile(join(stagingDir, "Cargo.toml"), manifest);
    await writeFile(join(sourceDir, "Cargo.toml"), manifest);
    const archivePath = join(cacheDir, "serde-1.0.0.crate");
    execFileSync("tar", ["-czf", archivePath, "-C", join(root, "staging"), "serde-1.0.0"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const archive = await readFile(archivePath);
    await writeFile(join(sourceDir, "Cargo.toml"), '[package]\nname="serde"\nversion="1.0.0"\n');
    const lockPackages = [
      {
        name: "serde",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        checksum: sha(archive),
      },
    ];
    const graph = parseCargoTree(TREE).packages;
    await expect(
      auditRegistryCache({ graph, lockPackages, cargoHome: root, workRoot: root }),
    ).resolves.toMatchObject({
      checked: 1,
      status: "pass",
    });
    await writeFile(join(sourceDir, "Cargo.toml"), "tampered\n");
    await expect(
      auditRegistryCache({ graph, lockPackages, cargoHome: root, workRoot: root }),
    ).rejects.toThrow(/source does not match archive/);
    await rm(join(root, "registry", "src"), { recursive: true, force: true });
    await expect(
      auditRegistryCache({ graph, lockPackages, cargoHome: root, workRoot: root }),
    ).rejects.toThrow(/missing cached source/);
  });

  it("blocks when the archive contains Cargo.lock but the unpacked source omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-driver-closure-cache-lock-test-"));
    tempDirs.push(root);
    const cacheDir = join(root, "registry", "cache", "index");
    const stagingDir = join(root, "staging", "serde-1.0.0");
    const sourceDir = join(root, "registry", "src", "index", "serde-1.0.0");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    const manifest = '[package]\nname="serde"\nversion="1.0.0"\n';
    await writeFile(join(stagingDir, "Cargo.toml"), manifest);
    await writeFile(join(stagingDir, "Cargo.lock"), "# locked\n");
    await writeFile(join(sourceDir, "Cargo.toml"), manifest);
    const archivePath = join(cacheDir, "serde-1.0.0.crate");
    execFileSync("tar", ["-czf", archivePath, "-C", join(root, "staging"), "serde-1.0.0"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const archive = await readFile(archivePath);
    const lockPackages = [
      {
        name: "serde",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        checksum: sha(archive),
      },
    ];
    const graph = parseCargoTree(TREE).packages;
    await expect(
      auditRegistryCache({ graph, lockPackages, cargoHome: root, workRoot: root }),
    ).rejects.toMatchObject({
      code: "cache-source-drift",
      message: expect.stringContaining("missing=Cargo.lock"),
    });
  });

  it("records MPL as materials awaiting review, never as an MIT policy failure", () => {
    const classification = classifyLicenseExpression("MPL-2.0");
    expect(classification).toMatchObject({
      policy: "obligations-review-required",
      requiresReview: true,
    });
    expect(JSON.stringify(classification)).not.toMatch(/forbidden|not-mit|policy-rejected/i);

    const summary = summarizeLicenseMaterials([
      { package: "uniffi 0.31.0", expression: "MPL-2.0", files: [] },
      {
        package: "serde 1.0.0",
        expression: "MIT OR Apache-2.0",
        files: [{ path: "LICENSE-MIT", sha256: "0".repeat(64) }],
      },
    ]);
    expect(summary.status).toBe("blocked");
    expect(summary.reviewRequired).toContain("uniffi 0.31.0");
    expect(summary.missingMaterials).toContain("uniffi 0.31.0");
    expect(summary).toMatchObject({
      gateMeaning: "license-expression-and-material-inventory-only",
      legalConclusion: "not-made",
      productAdoption: "blocked",
    });
    expect(summarizeLicenseMaterials([]).status).toBe("blocked");
  });

  it("rejects unsafe license archive labels and relative paths before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-driver-closure-license-archive-test-"));
    tempDirs.push(root);
    const outputDir = join(root, "out");
    await mkdir(outputDir, { recursive: true });
    const file = { path: "../escape/LICENSE", sha256: sha("MIT\n") };
    await expect(
      archiveLicenseMaterials({
        summary: { entries: [{ package: "unsafe@1.0.0", files: [file] }] },
        packageRoots: [{ package: "unsafe@1.0.0", root, label: "../escape" }],
        outputDir,
      }),
    ).rejects.toThrow(/unsafe license archive label/);

    const safeRoot = await mkdtemp(
      join(tmpdir(), "zody-cua-driver-closure-license-archive-safe-test-"),
    );
    tempDirs.push(safeRoot);
    await expect(
      archiveLicenseMaterials({
        summary: {
          entries: [
            {
              package: "unsafe@1.0.0",
              files: [{ path: "safe/../../escape/LICENSE", sha256: sha("MIT\n") }],
            },
          ],
        },
        packageRoots: [{ package: "unsafe@1.0.0", root: safeRoot, label: "safe" }],
        outputDir,
      }),
    ).rejects.toThrow(/unsafe license archive path/);
  });

  it("blocks product adoption for a toolchain delta while preserving source-only exit 0", () => {
    const gates = deriveClosureGates({
      source: { status: "pass" },
      dependencies: { status: "pass" },
      licenses: { status: "blocked" },
      toolchain: toolchainDelta({ upstreamDeclared: "1.97.1", auditedVersion: "1.93.1" }),
    });
    expect(gates.productAdoption).toBe("blocked");
    expect(deriveClosureGates({}).productAdoption).toBe("blocked");
    expect(
      deriveClosureGates({
        source: { status: "pass" },
        dependencies: { status: "pass" },
        licenses: { status: "pass" },
        toolchain: { status: "pass" },
      }),
    ).toMatchObject({ evidenceComplete: true, productAdoption: "blocked", exitCode: 0 });
    expect(deriveClosureGates({ source: { status: "fail" } })).toMatchObject({
      productAdoption: "blocked",
      exitCode: 1,
    });
    expect(gates.exitCode).toBe(0);
    expect(toolchainDelta({ upstreamDeclared: "1.97.1", auditedVersion: "1.93.1" })).toMatchObject({
      status: "blocked",
      exactMatch: false,
    });
  });

  it("reports the rustc probe version instead of a missing release field", () => {
    const delta = toolchainDeltaFromProbe({
      upstreamDeclared: "1.97.1",
      toolchain: { rustc: { version: "1.93.1", commit: "abcdef" } },
    });
    expect(delta).toMatchObject({
      auditedVersion: "1.93.1",
      auditedCommit: "abcdef",
      exactMatch: false,
      status: "blocked",
    });
  });
});
