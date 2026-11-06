import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renameElectronHelperBundles } from "../scripts/lib/cua-desktop-candidate-app-files.mjs";
import {
  NORMAL_HOST_CANDIDATE_BUNDLE_ID,
  NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
  NORMAL_HOST_CANDIDATE_PACKAGE_NAME,
  rewriteNormalHostCandidateAppIdentity,
} from "../scripts/lib/normal-host-candidate-profile.mjs";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zody-normal-host-helper-identity-"));
  createdRoots.push(root);
  return root;
}

function writePlist(path: string, values: Record<string, string>): void {
  const entries = Object.entries(values)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("\n");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n${entries}\n</dict></plist>\n`,
  );
}

function createHelperBundle(frameworksDir: string, name: string): void {
  const executablePath = join(frameworksDir, `${name}.app`, "Contents", "MacOS", name);
  mkdirSync(join(executablePath, ".."), { recursive: true });
  const executable = Buffer.alloc(16);
  executable.writeUInt32BE(0xfeedfacf, 0);
  writeFileSync(executablePath, executable);
  writePlist(join(frameworksDir, `${name}.app`, "Contents", "Info.plist"), {
    CFBundleExecutable: name,
    CFBundleIdentifier: `io.github.zclaudia.zody.helper.${name}`,
    CFBundleName: name,
    CFBundleDisplayName: name,
  });
}

function readPlistString(path: string, key: string): string {
  return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path], {
    encoding: "utf8",
  }).trim();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("normal Host candidate Chromium helper identity", () => {
  it.skipIf(process.platform !== "darwin")(
    "renames all four existing shell helpers and preserves native identities",
    async () => {
      const root = createRoot();
      const appBundle = join(root, NORMAL_HOST_CANDIDATE_DISPLAY_NAME + ".app");
      const contentsDir = join(appBundle, "Contents");
      const frameworksDir = join(contentsDir, "Frameworks");
      const sourceApplicationName = "Zody Preview";
      const sourceNames = [
        "Zody Preview Helper",
        "Zody Preview Helper (GPU)",
        "Zody Preview Helper (Renderer)",
        "Zody Preview Helper (Plugin)",
      ];
      for (const sourceName of sourceNames) createHelperBundle(frameworksDir, sourceName);

      const frameworkVersionsDir = join(frameworksDir, "Electron Framework.framework", "Versions");
      mkdirSync(join(frameworkVersionsDir, "A"), { recursive: true });
      execFileSync("ln", ["-s", "A", join(frameworkVersionsDir, "Current")]);
      const frameworkLink = join(frameworkVersionsDir, "Current");
      const frameworkLinkTarget = readlinkSync(frameworkLink);

      const nativeHelperPath = join(
        contentsDir,
        "Resources",
        "cua-helper",
        "CUA Helper.app",
        "Contents",
        "MacOS",
        "cua-helper",
      );
      mkdirSync(join(nativeHelperPath, ".."), { recursive: true });
      writeFileSync(nativeHelperPath, "fixed-native-helper-bytes");
      const nativeHelperSha256 = sha256File(nativeHelperPath);

      const infoPlistPath = join(contentsDir, "Info.plist");
      writePlist(infoPlistPath, {
        CFBundleIdentifier: "io.github.zclaudia.zody.preview",
        CFBundleName: sourceApplicationName,
        CFBundleDisplayName: sourceApplicationName,
      });
      const packageJsonPath = join(contentsDir, "Resources", "package.json");
      mkdirSync(join(packageJsonPath, ".."), { recursive: true });
      writeFileSync(packageJsonPath, JSON.stringify({ name: "@zody/desktop" }));

      const identity = await rewriteNormalHostCandidateAppIdentity({
        infoPlistPath,
        packageJsonPath,
        frameworksDir,
        sourceApplicationName,
      });

      expect(identity.chromiumHelpers).toHaveLength(4);
      for (const [index, sourceName] of sourceNames.entries()) {
        const suffix = sourceName.slice(sourceApplicationName.length + 1);
        const targetName = `${NORMAL_HOST_CANDIDATE_DISPLAY_NAME} ${suffix}`;
        expect(existsSync(join(frameworksDir, `${sourceName}.app`))).toBe(false);
        expect(existsSync(join(frameworksDir, `${targetName}.app`))).toBe(true);
        expect(
          existsSync(join(frameworksDir, `${targetName}.app`, "Contents", "MacOS", targetName)),
        ).toBe(true);
        expect(
          readPlistString(
            join(frameworksDir, `${targetName}.app`, "Contents", "Info.plist"),
            "CFBundleExecutable",
          ),
        ).toBe(targetName);
        expect(identity.chromiumHelpers[index]).toMatchObject({
          from: `${sourceName}.app`,
          to: `${targetName}.app`,
        });
      }

      expect(readPlistString(infoPlistPath, "CFBundleIdentifier")).toBe(
        NORMAL_HOST_CANDIDATE_BUNDLE_ID,
      );
      expect(readPlistString(infoPlistPath, "CFBundleName")).toBe(
        NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
      );
      expect(JSON.parse(readFileSync(packageJsonPath, "utf8"))).toMatchObject({
        name: NORMAL_HOST_CANDIDATE_PACKAGE_NAME,
      });
      expect(lstatSync(frameworkLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(frameworkLink)).toBe(frameworkLinkTarget);
      expect(sha256File(nativeHelperPath)).toBe(nativeHelperSha256);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps the existing Electron Helper rename path working",
    async () => {
      const root = createRoot();
      const frameworksDir = join(root, "Frameworks");
      const sourceNames = [
        "Electron Helper",
        "Electron Helper (GPU)",
        "Electron Helper (Renderer)",
        "Electron Helper (Plugin)",
      ];
      for (const sourceName of sourceNames) createHelperBundle(frameworksDir, sourceName);

      const renamed = await renameElectronHelperBundles(frameworksDir, "Old Candidate");

      expect(renamed).toHaveLength(4);
      for (const [index, sourceName] of sourceNames.entries()) {
        const suffix = sourceName.slice("Electron ".length);
        const targetName = `Old Candidate ${suffix}`;
        expect(existsSync(join(frameworksDir, `${sourceName}.app`))).toBe(false);
        expect(existsSync(join(frameworksDir, `${targetName}.app`))).toBe(true);
        expect(renamed[index]).toMatchObject({
          from: `${sourceName}.app`,
          to: `${targetName}.app`,
        });
      }
    },
  );
});
