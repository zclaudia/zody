import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import asar from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { packAppAsar } from "../scripts/lib/normal-host-candidate-asar.mjs";
import { createAppAsarManifestFacts } from "../scripts/lib/normal-host-candidate-output.mjs";
import {
  readMacosAsarIntegrity,
  refreshMacosAsarIntegrity,
} from "../scripts/macos-asar-integrity.mjs";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zody-macos-asar-integrity-"));
  createdRoots.push(root);
  return root;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createArchive(root: string, marker = "first"): Promise<string> {
  const sourceDir = join(root, "app-source");
  const archivePath = join(root, "app.asar");
  mkdirSync(join(sourceDir, "out", "main"), { recursive: true });
  mkdirSync(join(sourceDir, "node_modules", "node-pty", "prebuilds", "darwin-arm64"), {
    recursive: true,
  });
  writeFileSync(join(sourceDir, "package.json"), '{"main":"out/main/index.js"}\n');
  writeFileSync(join(sourceDir, "out", "main", "index.js"), `${marker}\n`);
  writeFileSync(
    join(sourceDir, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
    "native-helper",
  );
  await packAppAsar({
    sourceDir,
    appAsarPath: archivePath,
    targetPlatformKey: "darwin-arm64",
  });
  return archivePath;
}

function writeInfoPlist(infoPlistPath: string, hash = "0".repeat(64)): void {
  mkdirSync(join(infoPlistPath, ".."), { recursive: true });
  writeFileSync(
    infoPlistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>hash</key>
      <string>${hash}</string>
      <key>algorithm</key>
      <string>SHA256</string>
    </dict>
  </dict>
</dict>
</plist>
`,
  );
}

function readPlistValue(infoPlistPath: string, key: string): string {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :ElectronAsarIntegrity:Resources/app.asar:${key}`, infoPlistPath],
    { encoding: "utf8" },
  ).trim();
}

describe("macOS ASAR integrity", () => {
  it("hashes the exact raw header separately from the full archive", async () => {
    const root = createRoot();
    const archivePath = await createArchive(root);
    const integrity = await readMacosAsarIntegrity(archivePath);
    const rawHeader = asar.getRawHeader(archivePath);

    expect(integrity).toEqual({
      algorithm: "SHA256",
      headerBytes: Buffer.byteLength(rawHeader.headerString, "utf8"),
      headerSha256: sha256(Buffer.from(rawHeader.headerString, "utf8")),
      archiveBytes: statSync(archivePath).size,
      archiveSha256: sha256(readFileSync(archivePath)),
    });
    expect(integrity.headerSha256).not.toBe(integrity.archiveSha256);
  });

  it.skipIf(process.platform !== "darwin")(
    "replaces a stale plist hash after the final ASAR rewrite",
    async () => {
      const root = createRoot();
      const archivePath = await createArchive(root, "first");
      const infoPlistPath = join(root, "Fixture.app", "Contents", "Info.plist");
      writeInfoPlist(infoPlistPath);

      const first = await refreshMacosAsarIntegrity({ appAsarPath: archivePath, infoPlistPath });
      expect(readPlistValue(infoPlistPath, "hash")).toBe(first.headerSha256);
      expect(readPlistValue(infoPlistPath, "hash")).not.toBe(first.archiveSha256);

      await createArchive(root, "rewritten-after-pack");
      const second = await refreshMacosAsarIntegrity({ appAsarPath: archivePath, infoPlistPath });

      expect(second.headerSha256).not.toBe(first.headerSha256);
      expect(second.archiveSha256).not.toBe(first.archiveSha256);
      expect(readPlistValue(infoPlistPath, "hash")).toBe(second.headerSha256);
      expect(readPlistValue(infoPlistPath, "algorithm")).toBe("SHA256");
    },
  );

  it("fails closed for a missing or malformed archive", async () => {
    const root = createRoot();
    await expect(readMacosAsarIntegrity(join(root, "missing.asar"))).rejects.toMatchObject({
      code: "asar-integrity-missing-archive",
    });

    const malformedPath = join(root, "malformed.asar");
    writeFileSync(malformedPath, "not-an-asar");
    await expect(readMacosAsarIntegrity(malformedPath)).rejects.toMatchObject({
      code: "asar-integrity-invalid-header",
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "fails closed when the plist has no ASAR integrity entry",
    async () => {
      const root = createRoot();
      const archivePath = await createArchive(root);
      const infoPlistPath = join(root, "Fixture.app", "Contents", "Info.plist");
      mkdirSync(join(infoPlistPath, ".."), { recursive: true });
      writeFileSync(
        infoPlistPath,
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n`,
      );

      await expect(
        refreshMacosAsarIntegrity({ appAsarPath: archivePath, infoPlistPath }),
      ).rejects.toMatchObject({ code: "asar-integrity-plist-entry" });
    },
  );

  it("keeps candidate manifest archive and header digests explicit", () => {
    const facts = createAppAsarManifestFacts({
      entries: 3,
      integrity: {
        algorithm: "SHA256",
        headerBytes: 512,
        headerSha256: "a".repeat(64),
        archiveBytes: 4096,
        archiveSha256: "b".repeat(64),
      },
    });

    expect(facts).toEqual({
      entries: 3,
      algorithm: "SHA256",
      headerBytes: 512,
      headerSha256: "a".repeat(64),
      archiveBytes: 4096,
      archiveSha256: "b".repeat(64),
      embeddedIntegrityUpdated: true,
    });
    expect(facts).not.toHaveProperty("bytes");
    expect(facts).not.toHaveProperty("sha256");
  });

  it("refreshes formal Darwin integrity after ASAR rewrites and before afterSign", () => {
    const configSource = readFileSync(
      join(import.meta.dirname, "../electron-builder.config.js"),
      "utf8",
    );
    const injectIndex = configSource.indexOf(
      'runTimedAsync("afterPack:injectHoistedRuntimeModulesIntoAsar"',
    );
    const stripIndex = configSource.indexOf(
      'runTimedAsync("afterPack:stripPackagedSourcemapReferences"',
    );
    const refreshIndex = configSource.indexOf(
      'runTimedAsync("afterPack:refreshDarwinAsarIntegrity"',
    );
    const afterSignIndex = configSource.indexOf("afterSign: async");

    expect(injectIndex).toBeGreaterThan(-1);
    expect(stripIndex).toBeGreaterThan(injectIndex);
    expect(refreshIndex).toBeGreaterThan(stripIndex);
    expect(afterSignIndex).toBeGreaterThan(refreshIndex);
    expect(configSource.slice(afterSignIndex)).not.toContain("refreshDarwinAsarIntegrity");
  });

  it("keeps the candidate and formal builders on the shared refresh helper", () => {
    const candidateSource = readFileSync(
      join(import.meta.dirname, "../scripts/build-cua-normal-host-candidate.mjs"),
      "utf8",
    );
    const configSource = readFileSync(
      join(import.meta.dirname, "../electron-builder.config.js"),
      "utf8",
    );

    expect(candidateSource).toContain("refreshMacosAsarIntegrity");
    expect(configSource).toContain("refreshMacosAsarIntegrity");
    expect(existsSync(join(import.meta.dirname, "../scripts/macos-asar-integrity.mjs"))).toBe(true);
  });
});
