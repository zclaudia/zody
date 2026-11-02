import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  archiveNameForTarget,
  assertDistributionVersion,
  parseDistributionArgs,
  supportedDistributionTargets,
} from "./zody-distribution/targets.mjs";
import {
  assessReleaseAssets,
  decideExistingAsset,
  rejectUnexpectedExistingAssets,
  verifyCliArchiveChecksum,
} from "./zody-distribution/release-assets.mjs";
import { buildLaunchCommand } from "./zody-distribution/command.mjs";
import { seaBuildSteps } from "./zody-distribution/sea-build-steps.mjs";
import { waitForWebResponse } from "./zody-distribution/http-smoke.mjs";

test("CLI SEA packaging builds browser plugin runtime assets before collecting them", () => {
  assert.deepEqual(
    seaBuildSteps({
      cliRoot: "/repo/apps/zcode-cli/packages/cli",
      target: "darwin-arm64",
      nodeExecutable: "/tools/node",
    }),
    [
      { command: "pnpm", args: ["--filter", "@zcode/browser-use-plugin...", "build"] },
      {
        command: "/tools/node",
        args: [
          "/repo/apps/zcode-cli/packages/cli/scripts/build-sea.mjs",
          "--target",
          "darwin-arm64",
        ],
      },
    ],
  );
});

test("archive smoke invokes Windows command shims through cmd.exe without shell spawning", () => {
  const launch = buildLaunchCommand(
    "C:\\zody smoke\\bin\\zody.cmd",
    ["--workspace", "C:\\zody smoke\\workspace", "--no-token"],
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  );
  assert.equal(launch.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(launch.shell, false);
  assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(launch.args[3], /^call "C:\\zody smoke\\bin\\zody\.cmd"/u);
  assert.match(launch.args[3], /"C:\\zody smoke\\workspace"/u);
});

test("archive smoke directly invokes the executable on Unix", () => {
  assert.deepEqual(buildLaunchCommand("/tmp/zody/bin/zody", ["--version"], "linux"), {
    command: "/tmp/zody/bin/zody",
    args: ["--version"],
    shell: false,
  });
});

test("archive Web smoke retries the brief listener startup race", async () => {
  let attempts = 0;
  const response = await waitForWebResponse({ exitCode: null }, "http://127.0.0.1:1234/", [], {
    intervalMs: 0,
    timeoutMs: 100,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNREFUSED");
      return new Response("ready", { status: 200 });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test("Zody distribution only advertises the confirmed four CLI targets", () => {
  assert.deepEqual(supportedDistributionTargets, [
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "linux-x64",
  ]);
});

test("distribution arguments select one or all supported targets", () => {
  assert.deepEqual(parseDistributionArgs(["--target", "win32-x64"]).targets, ["win32-x64"]);
  assert.deepEqual(parseDistributionArgs(["--all"]).targets, supportedDistributionTargets);
  assert.throws(() => parseDistributionArgs(["--target", "linux-arm64"]), /Unsupported target/);
});

test("target archives use stable platform-specific names", () => {
  assert.equal(archiveNameForTarget("darwin-arm64", "0.1.0"), "zody-cli-0.1.0-darwin-arm64.tar.gz");
  assert.equal(archiveNameForTarget("win32-x64", "0.1.0"), "zody-cli-0.1.0-win32-x64.tar.gz");
});

test("distribution version validation rejects path traversal before output paths are built", () => {
  for (const version of ["../../", "0.1.0/../../outside", "0.1.0\\..\\..", "0.1.0 dev"]) {
    assert.throws(() => assertDistributionVersion(version), /Invalid distribution version/u);
    assert.throws(
      () => parseDistributionArgs(["--target", "darwin-arm64", "--version", version]),
      /Invalid distribution version/u,
    );
    assert.throws(
      () => archiveNameForTarget("darwin-arm64", version),
      /Invalid distribution version/u,
    );
  }
});

test("release asset set requires all desktop, CLI, Android, notes, and checksum files", () => {
  const names = [
    "zody-desktop-0.1.0-darwin-arm64.dmg",
    "zody-desktop-0.1.0-darwin-x64.dmg",
    "zody-desktop-0.1.0-win32-x64.exe",
    "zody-desktop-0.1.0-linux-x64.AppImage",
    ...supportedDistributionTargets.flatMap((target) => {
      const archive = `zody-cli-0.1.0-${target}.tar.gz`;
      return [archive, `${archive}.sha256`];
    }),
    "zody-android-0.1.0.apk",
    "SHA256SUMS.txt",
    "THIRD-PARTY-NOTICES.md",
    "RELEASE_NOTES.md",
  ];
  assert.deepEqual(assessReleaseAssets(names, "0.1.0"), []);
  assert.match(
    assessReleaseAssets(
      names.filter((name) => !name.includes("darwin-arm64")),
      "0.1.0",
    ).join("\n"),
    /darwin-arm64/,
  );
  assert.match(
    assessReleaseAssets([...names, "unexpected.zip"], "0.1.0").join("\n"),
    /unexpected release file/,
  );
});

test("draft retry skips identical assets and refuses to replace changed or published content", () => {
  assert.equal(
    decideExistingAsset({
      draft: true,
      existingDigest: "sha256:abc",
      incomingDigest: "sha256:abc",
    }),
    "skip",
  );
  assert.throws(
    () =>
      decideExistingAsset({
        draft: true,
        existingDigest: "sha256:abc",
        incomingDigest: "sha256:def",
      }),
    /refusing to replace/,
  );
  assert.throws(
    () =>
      decideExistingAsset({
        draft: false,
        existingDigest: "sha256:abc",
        incomingDigest: "sha256:abc",
      }),
    /already published/,
  );
  assert.throws(
    () => rejectUnexpectedExistingAssets(["old-installer.dmg"], ["new-installer.dmg"]),
    /stale assets/,
  );
});

test("release assembly verifies CLI archive sidecar hashes", () => {
  const bytes = Buffer.from("archive fixture");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    verifyCliArchiveChecksum("zody-cli.tar.gz", bytes, `${hash}  zody-cli.tar.gz`),
    hash,
  );
  assert.throws(
    () => verifyCliArchiveChecksum("zody-cli.tar.gz", bytes, `${"0".repeat(64)}  zody-cli.tar.gz`),
    /checksum mismatch/,
  );
  assert.throws(
    () => verifyCliArchiveChecksum("zody-cli.tar.gz", bytes, `${hash}  other.tar.gz`),
    /checksum mismatch/,
  );
});
