import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAuditArguments } from "../scripts/audit-macos-cua-driver-closure.mjs";
import {
  parseCargoMessages,
  runDriverBuild,
  selectSdkArtifacts,
} from "../scripts/lib/cua-driver-closure-prepare.mjs";
import { canExecuteBuild } from "../scripts/lib/cua-driver-closure-dependencies.mjs";
import {
  blockedItems,
  renderAuditReadme,
} from "../scripts/lib/cua-driver-closure-report-support.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("round 6 audit entry", () => {
  it("preserves the round 5 arguments and adds explicit round 6 options", () => {
    const parsed = parseAuditArguments([
      "--source-repo",
      "/fixed/cua",
      "--candidate-root",
      "/fixed/full-source",
      "--cargo-home",
      "/fixed/cargo-home",
      "--output-dir",
      "/fixed/out",
      "--rebuild-cache",
      "--toolchain-root",
      "/fixed/toolchain",
      "--toolchain-config",
      "/fixed/round6/toolchain.json",
      "--license-supplements",
      "/fixed/licenses.json",
      "--build-library",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({
      sourceRepo: "/fixed/cua",
      candidateRoot: "/fixed/full-source",
      cargoHome: "/fixed/cargo-home",
      outputDir: "/fixed/out",
      rebuildCache: true,
      toolchainRoot: "/fixed/toolchain",
      toolchainConfig: "/fixed/round6/toolchain.json",
      licenseSupplements: "/fixed/licenses.json",
      buildMode: "build-library",
    });
    expect(parsed.options.reviewConfig).toContain("review-config.json");
  });

  it("rejects conflicting build modes and missing values", () => {
    expect(
      parseAuditArguments([
        "--source-repo",
        "/a",
        "--candidate-root",
        "/b",
        "--cargo-home",
        "/c",
        "--output-dir",
        "/d",
        "--check-build",
        "--build-library",
      ]).error,
    ).toMatch(/mutually exclusive/);
    expect(parseAuditArguments(["--source-repo"]).error).toMatch(/missing value/);
    expect(
      parseAuditArguments([
        "--source-repo",
        "/a",
        "--candidate-root",
        "/b",
        "--cargo-home",
        "/c",
        "--output-dir",
        "/d",
        "--build-library",
      ]).error,
    ).toMatch(/explicit --toolchain-root/);
    expect(
      parseAuditArguments([
        "--source-repo",
        "/a",
        "--candidate-root",
        "/b",
        "--cargo-home",
        "/c",
        "--output-dir",
        "/d",
        "--toolchain-root",
        "/fixed/toolchain",
        "--build-library",
      ]).error,
    ).toMatch(/require --rebuild-cache/);
  });

  it("gates compilation on both registry and target graph closure", () => {
    expect(canExecuteBuild({ status: "pass" }, { status: "pass" })).toBe(true);
    expect(canExecuteBuild({ status: "blocked" }, { status: "pass" })).toBe(false);
    expect(canExecuteBuild({ status: "pass" }, { status: "blocked" })).toBe(false);
  });

  it("surfaces license material errors and partial coverage instead of zero counts", () => {
    const gate = (licenses: Record<string, unknown>) =>
      blockedItems({
        cache: null,
        dependencies: { status: "pass" },
        licenses: { status: "blocked", ...licenses },
        toolchain: { status: "pass" },
        build: null,
        gates: { productAdoption: "pass" },
      }).find((item) => item.gate === "licenses");
    expect(
      gate({
        error: { message: "supplement manifest checksum mismatch" },
        missingMaterials: [],
        reviewRequired: [],
        incompleteCoverage: [{ package: "serde" }],
      })?.reason,
    ).toBe("supplement manifest checksum mismatch");
    expect(
      gate({
        missingMaterials: [],
        reviewRequired: [],
        incompleteCoverage: [{ package: "serde" }, { package: "syn" }],
      })?.reason,
    ).toContain("2 have partial material coverage");
  });

  it("lists partial material coverage in the audit readme", () => {
    const readme = renderAuditReadme({
      generatedAt: "2026-01-01T00:00:00.000Z",
      revision: "rev",
      sourceRoot: "/src",
      source: { status: "pass", counts: { selected: 1, modified: 0, added: 0, candidate: 1 } },
      patch: { path: "patch.diff", sha256: "sha", reconstruction: "pass" },
      originalCache: null,
      reconstructedCache: null,
      dependencies: {
        lock: { entryCount: 1 },
        graph: { packageCount: 1, root: "cua-driver-sdk" },
        registry: { checked: 1, status: "pass" },
      },
      licenses: {
        packageCount: 3,
        missingMaterials: [],
        reviewRequired: [],
        incompleteCoverage: [{ package: "serde" }, { package: "syn" }],
        archive: { fileCount: 4 },
      },
      toolchain: { upstreamDeclared: "1.97.1", auditedVersion: "1.97.1", reason: "match" },
      build: null,
      gates: {
        source: "pass",
        dependencies: "pass",
        licenses: "blocked",
        toolchain: "pass",
        build: "not-requested",
        productAdoption: "blocked",
        exitCode: 0,
      },
      blockedItems: [],
    });
    expect(readme).toContain("部分材料覆盖 2");
  });

  it("keeps the cargo log and exit code when a build fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-r6-build-fail-"));
    tempDirs.push(root);
    const bin = join(root, "toolchain", "bin");
    await mkdir(bin, { recursive: true });
    const cargo = join(bin, "cargo");
    await writeFile(
      cargo,
      '#!/bin/sh\necho \'{"reason":"build-script-executed","package_id":"cua-driver-core 0.37.0 (path+file:///src)"}\'\necho boom >&2\nexit 7\n',
    );
    await chmod(cargo, 0o755);
    const result = await runDriverBuild({
      toolchain: {
        sysroot: join(root, "toolchain"),
        rustcPath: join(bin, "rustc"),
        cargoPath: cargo,
      },
      sourceRoot: root,
      cargoHome: join(root, "cargo-home"),
      tempRoot: join(root, "work"),
      mode: "build",
      target: "aarch64-apple-darwin",
      packageName: "cua-driver-sdk",
      packageVersion: "0.37.0",
      logPath: join(root, "build.log"),
    });
    expect(result).toMatchObject({ status: "fail", exitCode: 7 });
    expect(result.buildScripts).toEqual(["cua-driver-core 0.37.0 (path+file:///src)"]);
    expect(await readFile(join(root, "build.log"), "utf8")).toContain("boom");
  });

  it("records actual build-script and proc-macro execution plus artifact hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-r6-build-"));
    tempDirs.push(root);
    const target = join(root, "target");
    const artifact = join(target, "debug", "deps", "libcua_driver_sdk.rlib");
    const dynamic = join(target, "debug", "deps", "libcua_driver_sdk.dylib");
    await mkdir(join(artifact, ".."), { recursive: true });
    await writeFile(artifact, "rlib\n");
    await writeFile(dynamic, "dylib\n");
    const messages = [
      {
        reason: "build-script-executed",
        package_id: "cua-driver-core 0.37.0 (path+file:///src/cua-driver-core)",
        linked_libs: [],
        linked_paths: [],
      },
      {
        reason: "compiler-artifact",
        package_id: "serde_derive 1.0.228 (registry+https://github.com/rust-lang/crates.io-index)",
        target: { kind: ["proc-macro"], crate_types: ["proc-macro"] },
        filenames: [],
      },
      {
        reason: "compiler-artifact",
        package_id: "cua-driver-sdk 0.37.0 (path+file:///src/cua-driver-sdk)",
        target: {
          name: "cua_driver_sdk",
          kind: ["cdylib", "rlib"],
          crate_types: ["cdylib", "rlib"],
        },
        filenames: [artifact],
      },
      {
        reason: "compiler-artifact",
        package_id: "path+file:///src/crates/cua-driver-sdk#0.37.0",
        target: {
          name: "cua_driver_sdk",
          kind: ["cdylib", "rlib"],
          crate_types: ["cdylib", "rlib"],
        },
        filenames: [dynamic],
      },
    ];
    const parsed = await parseCargoMessages(
      messages.map((message) => JSON.stringify(message)).join("\n"),
      target,
    );
    expect(parsed.buildScripts).toEqual([
      "cua-driver-core 0.37.0 (path+file:///src/cua-driver-core)",
    ]);
    expect(parsed.compiledProcMacros).toEqual([
      "serde_derive 1.0.228 (registry+https://github.com/rust-lang/crates.io-index)",
    ]);
    const sdk = selectSdkArtifacts({
      artifacts: parsed.artifacts,
      packageName: "cua-driver-sdk",
      packageVersion: "0.37.0",
    });
    expect(sdk.map((entry) => entry.path).sort()).toEqual([
      "debug/deps/libcua_driver_sdk.dylib",
      "debug/deps/libcua_driver_sdk.rlib",
    ]);
    expect(parsed.artifacts[0]).toEqual(
      expect.objectContaining({
        packageId: expect.stringContaining("cua-driver-sdk"),
        identity: { name: "cua-driver-sdk", version: "0.37.0" },
        sha256: sha("dylib\n"),
      }),
    );
  });
});
