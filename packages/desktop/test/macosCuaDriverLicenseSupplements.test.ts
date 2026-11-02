import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveLicenseMaterials,
  auditLicenseClosure,
  summarizeLicenseMaterials,
} from "../scripts/lib/cua-driver-closure-licenses.mjs";
import {
  detectLicenseIdentifiers,
  isStrictLicenseMaterialPath,
} from "../scripts/lib/cua-driver-closure-license-text.mjs";

const REVISION = "2d2f99228d4d2508dc6fcc84c176b296e146714a";
const COMMIT = "4fc083f1c6d6784577e38b0ee8dbd344481e2fd2";
const CHECKSUM = "1".repeat(64);
const tempDirs: string[] = [];

const MIT_TEXT = `MIT License

Copyright (c) 2025 Example

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const MPL_TEXT = await readFile(
  new URL("../../../scripts/license-texts/MPL-2.0.txt", import.meta.url),
  "utf8",
);
const ISC_TEXT = await readFile(
  new URL("../../../scripts/license-texts/ISC.txt", import.meta.url),
  "utf8",
);

const MIT0_TEXT = `MIT No Attribution

Copyright 2024 Example

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const BSD0_TEXT = `Copyright (C) Example

Permission to use, copy, modify, and/or distribute this software for
any purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

const UNLICENSE_TEXT = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>
`;

const OBJC2_POINTER_TEXT = `# License

The licensing of these crates is a bit complicated:
- The crates \`objc2\`, \`block2\`, \`objc2-foundation\` and \`objc2-encode\` are
  [currently][#23] licensed under [the MIT license][MIT].
- All other crates are trio-licensed under the [Zlib], [Apache-2.0] or [MIT]
  license, at your option.

[#23]: https://github.com/madsmtm/objc2/issues/23
[MIT]: https://opensource.org/license/MIT
[Zlib]: https://zlib.net/zlib_license.html
[Apache-2.0]: https://www.apache.org/licenses/LICENSE-2.0
`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function sha(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function temp(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function write(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function workspaceFixture({ actualLicense = "MIT", text = MIT_TEXT } = {}) {
  const root = await temp("zody-cua-license-workspace-");
  const candidate = join(root, "full-source");
  const packageRoot = join(candidate, "crates", "demo");
  const workspaceManifest = `[workspace]\nmembers = ["crates/demo"]\n\n[workspace.package]\nversion = "1.0.0"\nlicense = "${actualLicense}"\nrepository = "https://github.com/example/demo"\n`;
  const packageManifest = `[package]\nname = "demo"\nversion.workspace = true\nlicense.workspace = true\n`;
  await write(join(candidate, "Cargo.toml"), workspaceManifest);
  await write(join(packageRoot, "Cargo.toml"), packageManifest);
  await write(join(candidate, "src", "copying.rs"), "fn copying() {}\n");
  await write(join(candidate, ".github", "workflows", "copyrights.yml"), "name: copyrights\n");
  const supplements = join(root, "supplements");
  const textPath = join(supplements, "texts", "LICENSE.md");
  await write(textPath, text);
  const manifestPath = join(supplements, "manifest.json");
  const entry = {
    name: "demo",
    version: "1.0.0",
    lockChecksum: null,
    cargoTomlSha256: sha(packageManifest),
    cargoVcsSha1: null,
    cargoVcsInfoSha256: null,
    source: {
      repo: "https://github.com/example/demo",
      commit: REVISION,
      path: "LICENSE.md",
    },
    text: { path: "texts/LICENSE.md", sha256: sha(text), bytes: Buffer.byteLength(text) },
    relation: {
      kind: "workspace-root-license",
      licenseExpression: actualLicense,
      workspaceCargoTomlSha256: sha(workspaceManifest),
      evidence: "crates/demo/Cargo.toml uses license.workspace; workspace.package.license applies",
    },
  };
  const manifest = {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-license-supplements",
    sourceRevision: REVISION,
    entries: [entry],
  };
  await write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packageRoots = [
    {
      package: "demo@1.0.0",
      root: packageRoot,
      label: "source/crates/demo",
      expression: "MIT",
      workspaceRootLicenseApplicable: true,
    },
  ];
  return {
    root,
    candidate,
    packageRoot,
    manifestPath,
    manifest,
    entry,
    packageRoots,
    textPath,
    workspaceManifest,
    packageManifest,
  };
}

async function registryFixture() {
  const root = await temp("zody-cua-license-registry-");
  const packageRoot = join(root, "registry", "dep-2.0.0");
  const manifest = `[package]\nname = "dep"\nversion = "2.0.0"\nlicense = "MPL-2.0"\nrepository = "https://github.com/example/dep"\n`;
  await write(join(packageRoot, "Cargo.toml"), manifest);
  await write(
    join(packageRoot, ".cargo_vcs_info.json"),
    `${JSON.stringify({ git: { sha1: COMMIT }, path_in_vcs: "crates/dep" }, null, 2)}\n`,
  );
  const vcsInfo = await readFile(join(packageRoot, ".cargo_vcs_info.json"));
  const supplements = join(root, "supplements");
  await write(join(supplements, "texts", "MPL-2.0"), MPL_TEXT);
  const manifestPath = join(supplements, "manifest.json");
  const entry = {
    name: "dep",
    version: "2.0.0",
    lockChecksum: CHECKSUM,
    cargoTomlSha256: sha(manifest),
    cargoVcsSha1: COMMIT,
    cargoVcsInfoSha256: sha(vcsInfo),
    source: {
      repo: "https://github.com/example/dep",
      commit: COMMIT,
      path: "crates/dep/LICENSE",
    },
    text: { path: "texts/MPL-2.0", sha256: sha(MPL_TEXT), bytes: Buffer.byteLength(MPL_TEXT) },
    relation: {
      kind: "package-root-license",
      licenseExpression: "MPL-2.0",
      evidence: "crates/dep/LICENSE is the package root license for the locked crate",
    },
  };
  const manifestFile = {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-license-supplements",
    sourceRevision: REVISION,
    entries: [entry],
  };
  await write(manifestPath, `${JSON.stringify(manifestFile, null, 2)}\n`);
  return {
    root,
    packageRoot,
    manifestPath,
    entry,
    packageRoots: [
      {
        package: "dep@2.0.0",
        root: packageRoot,
        label: "registry/dep-2.0.0",
        expression: null,
      },
    ],
    lockPackages: [
      {
        name: "dep",
        version: "2.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        checksum: CHECKSUM,
      },
    ],
  };
}

describe("macOS CUA Driver license supplements", () => {
  it("recognizes complete MIT-0, 0BSD, Unlicense and curly-quote MIT bodies", () => {
    expect(detectLicenseIdentifiers(MIT0_TEXT)).toContain("MIT-0");
    expect(detectLicenseIdentifiers(BSD0_TEXT)).toContain("0BSD");
    expect(detectLicenseIdentifiers(UNLICENSE_TEXT)).toContain("Unlicense");
    expect(isStrictLicenseMaterialPath("UNLICENSE")).toBe(true);
    expect(isStrictLicenseMaterialPath("LICENSE-0BSD")).toBe(true);
    expect(detectLicenseIdentifiers(MIT_TEXT.replaceAll('"', "“"))).toContain("MIT");

    const iscIdentifiers = detectLicenseIdentifiers(ISC_TEXT);
    expect(iscIdentifiers).toContain("ISC");
    expect(iscIdentifiers).not.toContain("0BSD");
    const bsdIdentifiers = detectLicenseIdentifiers(BSD0_TEXT);
    expect(bsdIdentifiers).toContain("0BSD");
    expect(bsdIdentifiers).not.toContain("ISC");
  });

  it("does not treat pointer files or truncated/cross-matched text as complete bodies", () => {
    expect(isStrictLicenseMaterialPath("LICENSE.md")).toBe(true);
    expect(detectLicenseIdentifiers(OBJC2_POINTER_TEXT)).toEqual([]);
    const truncated = MPL_TEXT.slice(0, MPL_TEXT.indexOf("3. Responsibilities"));
    expect(detectLicenseIdentifiers(truncated)).toEqual([]);
    expect(
      detectLicenseIdentifiers(MIT_TEXT.slice(0, MIT_TEXT.indexOf("THE SOFTWARE IS PROVIDED"))),
    ).not.toContain("MIT");
    expect(
      detectLicenseIdentifiers(MIT0_TEXT.slice(0, MIT0_TEXT.indexOf("IN NO EVENT"))),
    ).not.toContain("MIT-0");
    expect(
      detectLicenseIdentifiers(ISC_TEXT.slice(0, ISC_TEXT.indexOf("THE SOFTWARE IS PROVIDED"))),
    ).not.toContain("ISC");
    expect(
      detectLicenseIdentifiers(BSD0_TEXT.slice(0, BSD0_TEXT.indexOf("THE SOFTWARE IS PROVIDED"))),
    ).not.toContain("0BSD");
  });

  it("keeps fixed objc2 pointer notices as provenance instead of license bodies", async () => {
    const supplements = new URL(
      "../native/macos-cua-driver-closure/license-supplements/",
      import.meta.url,
    );
    const provenance = JSON.parse(
      await readFile(new URL("notices/provenance.json", supplements), "utf8"),
    );
    expect(provenance.records).toHaveLength(4);
    expect(
      provenance.records.flatMap((record: { packages: string[] }) => record.packages),
    ).toHaveLength(13);
    for (const record of provenance.records) {
      expect(record.licenseBody).toBe(false);
      const text = await readFile(new URL(record.textPath, supplements), "utf8");
      expect(Buffer.byteLength(text)).toBe(1339);
      expect(record.sha256).toBe(sha(text));
      expect(detectLicenseIdentifiers(text)).toEqual([]);
    }

    const treeBytes = await readFile(
      new URL("notices/objc2-7b1abfd-license-tree.json", supplements),
    );
    const tree = JSON.parse(treeBytes.toString("utf8"));
    expect(tree.sha256).toBe("a6685e9b30da4c2b9ed807e8344d7248447daf1d5ab5b7af4fa3755545f96a4d");
    expect(tree.licensePaths).toHaveLength(6);
    expect(
      tree.licensePaths.filter((entry: { path: string }) => entry.path.endsWith("/LICENSE.md")),
    ).toHaveLength(1);
    expect(
      tree.licensePaths.filter((entry: { path: string }) => /\.(?:rs|stderr)$/.test(entry.path)),
    ).toHaveLength(5);
    const seven = provenance.records.find(
      (record: { commit: string }) => record.commit === "7b1abfd750a2cacaea71d6a56ecfb83cb7de560b",
    );
    expect(seven.treeEvidence).toMatchObject({
      sha256: sha(treeBytes),
      tarballSha256: tree.sha256,
      finding: expect.stringContaining("license-named file inventory found no complete body"),
    });

    const otherTreeBytes = await readFile(
      new URL("notices/objc2-other-license-trees.json", supplements),
    );
    const otherTrees = JSON.parse(otherTreeBytes.toString("utf8"));
    expect(otherTrees).toHaveLength(3);
    for (const otherTree of otherTrees) {
      expect(otherTree.licensePaths).toHaveLength(3);
      expect(
        otherTree.licensePaths.filter((entry: { path: string }) =>
          entry.path.endsWith("/LICENSE.md"),
        ),
      ).toHaveLength(1);
      expect(
        otherTree.licensePaths.filter((entry: { path: string }) => entry.path.endsWith(".rs")),
      ).toHaveLength(2);
      const record = provenance.records.find(
        (candidate: { commit: string }) => candidate.commit === otherTree.commit,
      );
      expect(record.treeEvidence).toMatchObject({
        sha256: sha(otherTreeBytes),
        tarballSha256: otherTree.sha256,
        finding: expect.stringContaining("license-named file inventory found no complete body"),
      });
    }
  });

  it("keeps notice-only, legacy and partial OR/AND coverage blocked", () => {
    const notice = summarizeLicenseMaterials(
      [
        {
          package: "notice@1.0.0",
          expression: "MIT",
          files: [
            {
              path: "registry/notice@1.0.0/COPYING",
              sha256: "a".repeat(64),
              bytes: 281,
              licenseIdentifiers: [],
              materialKind: "notice",
              sourceKind: "package",
            },
          ],
        },
      ],
      null,
    );
    expect(notice.missingMaterials).toEqual(["notice@1.0.0"]);
    expect(notice.status).toBe("blocked");

    const mitFile = {
      path: "registry/pkg/LICENSE-MIT",
      sha256: "b".repeat(64),
      bytes: MIT_TEXT.length,
      licenseIdentifiers: ["MIT"],
      materialKind: "license" as const,
      sourceKind: "package" as const,
    };
    for (const [name, expression] of [
      ["or-pkg", "MIT OR Apache-2.0"],
      ["and-pkg", "MIT AND Apache-2.0"],
    ]) {
      const summary = summarizeLicenseMaterials(
        [{ package: `${name}@1.0.0`, expression, files: [mitFile] }],
        null,
      );
      expect(summary.missingMaterials).toEqual([]);
      expect(summary.status).toBe("blocked");
      expect(summary.incompleteCoverage).toContainEqual(
        expect.objectContaining({
          package: `${name}@1.0.0`,
          coverage: "partial",
          coveredTokens: ["MIT"],
          uncoveredTokens: ["Apache-2.0"],
        }),
      );
    }

    const legacy = summarizeLicenseMaterials(
      [
        {
          package: "legacy@1.0.0",
          expression: "MIT",
          files: [{ path: "registry/legacy@1.0.0/LICENSE", sha256: "c".repeat(64), bytes: 10 }],
        },
      ],
      null,
    );
    expect(legacy.missingMaterials).toEqual(["legacy@1.0.0"]);
    expect(legacy.status).toBe("blocked");
    expect(legacy.entries[0].materialCoverage.legacyUnknown).toBe(true);
    expect(legacy.missingMaterialDetails[0].reason).toMatch(/legacy coverage/i);
  });

  it("rejects code/config lookalikes and token-only text as license material", async () => {
    expect(isStrictLicenseMaterialPath("src/copying.rs")).toBe(false);
    expect(isStrictLicenseMaterialPath(".github/workflows/copyrights.yml")).toBe(false);
    expect(isStrictLicenseMaterialPath("LICENSE-MIT")).toBe(true);
    expect(detectLicenseIdentifiers("MIT OR Apache-2.0")).toEqual([]);

    const fixture = await workspaceFixture({ text: "MIT OR Apache-2.0\n" });
    await expect(
      auditLicenseClosure({
        packageRoots: fixture.packageRoots,
        upstreamLicense: null,
        workRoot: fixture.root,
        supplementsManifestPath: fixture.manifestPath,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/text|license|bytes/i);
  });

  it("accepts a verified workspace root license and records coverage", async () => {
    const fixture = await workspaceFixture();
    const summary = await auditLicenseClosure({
      packageRoots: fixture.packageRoots,
      upstreamLicense: null,
      workRoot: fixture.root,
      supplementsManifestPath: fixture.manifestPath,
      sourceRevision: REVISION,
    });
    expect(summary.status).toBe("pass");
    expect(summary.missingMaterials).toEqual([]);
    expect(summary.entries[0]).toMatchObject({
      missingMaterials: false,
      supplementalFiles: [{ bytes: 1064 }],
    });
    expect(summary.entries[0].materialCoverage).toMatchObject({
      textPresent: true,
      sourceKinds: ["supplement"],
      coverage: "full",
    });
    expect(summary.materialCoverage).toMatchObject({
      packagesWithText: 1,
      supplementalFileCount: 1,
    });
    expect(summary.supplementalTextSources[0]).toMatchObject({
      package: "demo@1.0.0",
      commit: REVISION,
      relation: "workspace-root-license",
    });
  });

  it("fails closed on checksum, package, version and commit drift", async () => {
    const fixture = await registryFixture();
    const base = {
      packageRoots: fixture.packageRoots,
      upstreamLicense: null,
      workRoot: fixture.root,
      supplementsManifestPath: fixture.manifestPath,
      sourceRevision: REVISION,
    };
    await expect(
      auditLicenseClosure({
        ...base,
        lockPackages: [{ ...fixture.lockPackages[0], checksum: "2".repeat(64) }],
      }),
    ).rejects.toThrow(/checksum/i);
    await expect(
      auditLicenseClosure({
        ...base,
        lockPackages: [{ ...fixture.lockPackages[0], name: "other" }],
      }),
    ).rejects.toThrow(/lock|package/i);
    await expect(auditLicenseClosure(base)).rejects.toThrow(/lockPackages|checksum/i);
    await expect(
      auditLicenseClosure({
        ...base,
        lockPackages: fixture.lockPackages,
        sourceRevision: "3".repeat(40),
      }),
    ).rejects.toThrow(/source revision|revision/i);
  });

  it("binds workspace package version and frozen registry VCS metadata", async () => {
    const workspace = await workspaceFixture();
    const changedWorkspace = workspace.workspaceManifest.replace(
      'version = "1.0.0"',
      'version = "9.9.9"',
    );
    await write(join(workspace.candidate, "Cargo.toml"), changedWorkspace);
    await write(
      workspace.manifestPath,
      `${JSON.stringify(
        {
          ...workspace.manifest,
          entries: [
            {
              ...workspace.entry,
              relation: {
                ...workspace.entry.relation,
                workspaceCargoTomlSha256: sha(changedWorkspace),
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: workspace.packageRoots,
        upstreamLicense: null,
        workRoot: workspace.root,
        supplementsManifestPath: workspace.manifestPath,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/workspace package version/i);

    const vcsDrift = await registryFixture();
    await write(
      join(vcsDrift.packageRoot, ".cargo_vcs_info.json"),
      `${JSON.stringify({ git: { sha1: COMMIT }, path_in_vcs: "other/dep" }, null, 2)}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: vcsDrift.packageRoots,
        upstreamLicense: null,
        workRoot: vcsDrift.root,
        supplementsManifestPath: vcsDrift.manifestPath,
        lockPackages: vcsDrift.lockPackages,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/VCS metadata hash/i);

    const commitDrift = await registryFixture();
    await write(
      commitDrift.manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "zody-cua-driver-closure-license-supplements",
          sourceRevision: REVISION,
          entries: [
            {
              ...commitDrift.entry,
              source: { ...commitDrift.entry.source, commit: "f".repeat(40) },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: commitDrift.packageRoots,
        upstreamLicense: null,
        workRoot: commitDrift.root,
        supplementsManifestPath: commitDrift.manifestPath,
        lockPackages: commitDrift.lockPackages,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/commit mismatch/i);

    const repoDrift = await registryFixture();
    await write(
      repoDrift.manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "zody-cua-driver-closure-license-supplements",
          sourceRevision: REVISION,
          entries: [
            {
              ...repoDrift.entry,
              source: { ...repoDrift.entry.source, repo: "https://github.com/example/other" },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: repoDrift.packageRoots,
        upstreamLicense: null,
        workRoot: repoDrift.root,
        supplementsManifestPath: repoDrift.manifestPath,
        lockPackages: repoDrift.lockPackages,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/repository mismatch/i);
  });

  it("rejects text hash drift and unknown or duplicate package entries", async () => {
    const fixture = await workspaceFixture();
    await write(fixture.textPath, `${MIT_TEXT}\nchanged`);
    await expect(
      auditLicenseClosure({
        packageRoots: fixture.packageRoots,
        upstreamLicense: null,
        workRoot: fixture.root,
        supplementsManifestPath: fixture.manifestPath,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/text.*hash|hash.*text|bytes/i);

    const duplicate = await workspaceFixture();
    await write(
      duplicate.manifestPath,
      `${JSON.stringify({ ...duplicate.manifest, entries: [duplicate.entry, duplicate.entry] }, null, 2)}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: duplicate.packageRoots,
        upstreamLicense: null,
        workRoot: duplicate.root,
        supplementsManifestPath: duplicate.manifestPath,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/duplicate/i);

    const unknown = await workspaceFixture();
    await write(
      unknown.manifestPath,
      `${JSON.stringify({ ...unknown.manifest, entries: [{ ...unknown.entry, name: "missing" }] }, null, 2)}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: unknown.packageRoots,
        upstreamLicense: null,
        workRoot: unknown.root,
        supplementsManifestPath: unknown.manifestPath,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/unknown|not in graph/i);
  });

  it("rejects symlinked text and paths escaping the supplements root", async () => {
    const escape = await workspaceFixture();
    const outside = join(escape.root, "outside-LICENSE");
    await write(outside, MIT_TEXT);
    await write(
      escape.manifestPath,
      `${JSON.stringify({ ...escape.manifest, entries: [{ ...escape.entry, text: { ...escape.entry.text, path: "../outside-LICENSE" } }] }, null, 2)}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: escape.packageRoots,
        upstreamLicense: null,
        workRoot: escape.root,
        supplementsManifestPath: escape.manifestPath,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/safe relative path|escape/i);

    const linked = await workspaceFixture();
    const linkPath = join(linked.root, "supplements", "texts", "linked-LICENSE");
    await symlink(linked.textPath, linkPath);
    await write(
      linked.manifestPath,
      `${JSON.stringify({ ...linked.manifest, entries: [{ ...linked.entry, text: { ...linked.entry.text, path: "texts/linked-LICENSE" } }] }, null, 2)}\n`,
    );
    await expect(
      auditLicenseClosure({
        packageRoots: linked.packageRoots,
        upstreamLicense: null,
        workRoot: linked.root,
        supplementsManifestPath: linked.manifestPath,
        sourceRevision: REVISION,
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it("keeps MPL materials pending review and archives supplemental text", async () => {
    const fixture = await registryFixture();
    const summary = await auditLicenseClosure({
      packageRoots: fixture.packageRoots,
      upstreamLicense: null,
      workRoot: fixture.root,
      supplementsManifestPath: fixture.manifestPath,
      lockPackages: fixture.lockPackages,
      sourceRevision: REVISION,
    });
    expect(summary.status).toBe("blocked");
    expect(summary.missingMaterials).toEqual([]);
    expect(summary.reviewRequired).toContain("dep@2.0.0");
    expect(summary.entries[0]).toMatchObject({
      reviewRequired: true,
      materialCoverage: { textPresent: true },
    });
    expect(summary.productAdoption).toBe("blocked");

    const outputDir = join(fixture.root, "out");
    await mkdir(outputDir, { recursive: true });
    const archive = await archiveLicenseMaterials({
      summary,
      packageRoots: fixture.packageRoots,
      outputDir,
    });
    expect(archive.fileCount).toBe(1);
    const index = JSON.parse(await readFile(join(outputDir, archive.indexPath), "utf8"));
    const archived = join(outputDir, index.entries[0].supplementalFiles[0].archivePath);
    expect(await readFile(archived, "utf8")).toBe(MPL_TEXT);
  });

  it("preserves the legacy summary when no supplements manifest is provided", async () => {
    const fixture = await workspaceFixture();
    const summary = await auditLicenseClosure({
      packageRoots: fixture.packageRoots,
      upstreamLicense: null,
      workRoot: fixture.root,
    });
    expect(summary.status).toBe("blocked");
    expect(summary.missingMaterials).toEqual(["demo@1.0.0"]);
    expect(summary.entries[0].supplementalFiles).toBeUndefined();
    expect(summary.supplementalTextSources).toBeUndefined();
    expect(summarizeLicenseMaterials([], null).status).toBe("blocked");
  });
});
