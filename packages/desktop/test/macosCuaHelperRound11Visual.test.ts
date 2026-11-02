import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  R9_TREE_SHA256,
  ROUND11_VISUAL_HEADER,
  ROUND11_VISUAL_STATICLIB,
  buildRound11Visual,
  prepareRound11Visual,
  runRound11VisualUnitTests,
} from "../scripts/lib/cua-helper-round11-visual.mjs";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;

describe("macOS CUA R11 private visual overlay", () => {
  it("copies and verifies the pinned R9 visual source before applying the fixed overlay", async () => {
    const manifest = await prepareRound11Visual();
    expect(manifest.status).toBe("pass");
    expect(manifest.source.treeSha256).toBe(R9_TREE_SHA256);
    expect(manifest.source.revisionPin).toBe(R9_TREE_SHA256);
    expect(manifest.source.files).toBe(776);
    expect(manifest.overlay.patchSha256).toMatch(SHA256);
    expect(manifest.derived.treeSha256).toMatch(SHA256);
    expect(manifest.derived.treeSha256).not.toBe(R9_TREE_SHA256);
    expect(manifest.lock.copiedSha256).toBe(manifest.lock.r9Sha256);
    expect(manifest.source.licenses["native/licenses/LICENSE-MIT"]).toMatch(
      SHA256,
    );

    const header = await readFile(ROUND11_VISUAL_HEADER, "utf8");
    for (const symbol of [
      "cua_r11_visual_start",
      "cua_r11_visual_wait",
      "cua_r11_visual_take_png",
      "cua_r11_visual_cancel",
      "cua_r11_visual_callback_resources_released",
      "cua_r11_visual_destroy",
      "cua_r11_visual_free_png",
    ]) {
      expect(header).toContain(symbol);
    }
    expect(header).toContain("cua_r11_visual_admit_fn");
    expect(header).not.toMatch(/bool\s+approved/);
    expect(header).not.toMatch(/request_window_capture/);

    const publicEntry = await readFile(
      `${manifest.derived.visualCrateRoot}/src/lib.rs`,
      "utf8",
    );
    expect(publicEntry).toContain("pub fn request_window_capture");
    expect(publicEntry).toContain("Err(VisualError::HostNotApproved)");
  }, 60_000);

  it("builds a locked offline static archive with the private C ABI", async () => {
    const manifest = await buildRound11Visual();
    expect(manifest.status).toBe("pass");
    expect(manifest.build.offline).toBe(true);
    expect(manifest.build.locked).toBe(true);
    expect(manifest.build.target).toBe("aarch64-apple-darwin");
    expect(manifest.artifact.architectures).toEqual(["arm64"]);
    expect(manifest.artifact.minimumMacOSVersion).toBe("14.2");
    expect(manifest.artifact.maxMemberMinOS).toBe("14.2");
    expect(manifest.artifact.swiftObjectMinOS).toEqual(["14.2"]);
    expect(manifest.artifact.sha256).toMatch(SHA256);
    expect(manifest.cargoTree.onlyR9AuditedPackages).toBe(true);

    const info = await stat(ROUND11_VISUAL_STATICLIB);
    expect(info.isFile()).toBe(true);

    for (const symbol of [
      "_cua_r11_visual_start",
      "_cua_r11_visual_wait",
      "_cua_r11_visual_take_png",
      "_cua_r11_visual_cancel",
      "_cua_r11_visual_callback_resources_released",
      "_cua_r11_visual_destroy",
      "_cua_r11_visual_free_png",
    ]) {
      expect(manifest.artifact.symbols).toContain(symbol);
    }

    const archive = await execFileAsync(
      "/usr/bin/ar",
      ["-t", ROUND11_VISUAL_STATICLIB],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(archive.stdout).toContain("CuaVisualCapture.o");
  }, 300_000);

  it("keeps cancellation separate from native callback resource release", async () => {
    const tests = await runRound11VisualUnitTests();
    expect(tests.status).toBe("pass");
    expect(tests.output).toContain("test result: ok");
    expect(tests.output).toContain(
      "cancel_after_a_completed_png_rejects_take_and_wait",
    );
    expect(tests.output).toContain(
      "callback_release_waits_for_worker_terminal_after_swift_release",
    );
    expect(tests.output).toContain(
      "cancel_wakes_a_wait_blocked_before_terminal",
    );
  }, 300_000);
});
