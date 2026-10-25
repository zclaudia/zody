// Verify one real APK Save original action against the Android Downloads collection.
// Open the target file's preview in the APK first, then run this with its fixture name.
// Usage: node run-mobile-download-mf08.mjs <fixture-name> [--device emulator-5554]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _android } from "playwright-core";

const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const fixtureDir = resolve(
  repoRoot,
  ".tmp/mobile-remote-p8-push/desktop-home/ZodyProject/MF08-fixtures",
);
const artifactDir = resolve(repoRoot, ".tmp/mobile-remote-p8-push/artifacts/mf08");
const manifest = JSON.parse(await readFile(resolve(fixtureDir, "manifest.json"), "utf8"));
const execFileAsync = promisify(execFile);
const oversizeError = "File exceeds the 16 MiB mobile save limit.";
const name = process.argv[2];
const deviceIndex = process.argv.indexOf("--device");
const deviceSerial = deviceIndex >= 0 ? process.argv[deviceIndex + 1] : "emulator-5554";
const item = manifest.files.find((candidate) => candidate.name === name);
assert.ok(item, `Unknown MF08 fixture: ${name ?? "(missing name)"}`);
assert.match(item.name, /^MF08-[\p{L}\p{N} ._-]+\.bin$/u);

let device;
let ownedDownloadUri;
let ownedDownloadId;
try {
  const devices = await _android.devices({ omitDriverInstall: true });
  device = devices.find((candidate) => candidate.serial() === deviceSerial);
  assert.ok(device, `Android device ${deviceSerial} is not connected`);
  const webView = await device.webView({ pkg: "io.github.zclaudia.zody.mobile" });
  const page = await webView.page();
  const query = async () =>
    (
      await device.shell(
        "content query --uri content://media/external/downloads --projection _id:_display_name:is_pending",
      )
    )
      .toString("utf8")
      .split(/\r?\n/);
  const header = page.locator('[data-testid="mobile-file-browser"] header');
  await header.waitFor();
  assert.ok(
    (await header.innerText()).includes(item.name),
    "APK must show the requested fixture preview",
  );
  const initialRows = await query();
  assert.ok(
    !initialRows.some((line) => line.includes(`_display_name=${item.name}`)),
    `Downloads already contains ${item.name}; preserve it and choose a clean case fixture name`,
  );
  await mkdir(artifactDir, { recursive: true });
  const screenshotPath = resolve(artifactDir, `${item.name}.png`);
  await page.screenshot({ path: screenshotPath });
  await page.getByRole("button", { name: "Save original" }).click();
  let row;
  if (item.expectedSave) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = await query();
      row = rows.find((line) => line.includes(`_display_name=${item.name}`));
      if (row?.includes("is_pending=0")) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  } else {
    // 超限会由 saveMobileOriginalFile 抛出确定错误，UI 将其展示为 toast。
    // 等到 toast 与 saving 状态都收敛后再断言 Downloads，避免把未触发/仍在处理误认为拒绝。
    await page
      .getByText(oversizeError, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector(
        '[data-testid="mobile-file-browser"] button[aria-label="Save original"]',
      );
      return button !== null && !button.disabled;
    });
    await page.screenshot({ path: screenshotPath });
    row = (await query()).find((line) => line.includes(`_display_name=${item.name}`));
  }
  if (row) {
    ownedDownloadId = row.match(/\b_id=(\d+)/)?.[1];
    assert.ok(ownedDownloadId, `Could not read MediaStore ID from: ${row}`);
    ownedDownloadUri = `content://media/external/downloads/${ownedDownloadId}`;
  }
  if (!item.expectedSave) {
    assert.equal(row, undefined, "Oversized file must be rejected without a Downloads artifact");
    process.stdout.write(
      `${JSON.stringify({ caseId: "MF08", device: deviceSerial, name: item.name, bytes: item.size, rejected: true, rejectionMessage: oversizeError, downloadsArtifact: false, screenshotPath }, null, 2)}\n`,
    );
  } else {
    assert.ok(row, `Downloads does not contain ${item.name}`);
    assert.ok(
      row.includes("is_pending=0"),
      "Downloads file did not finish committing to MediaStore",
    );
    assert.ok(ownedDownloadUri);
    // Playwright Android shell responses are bounded; use adb exec-out as a binary stream for 16 MiB fixtures.
    const { stdout: actual } = await execFileAsync(
      "adb",
      ["-s", deviceSerial, "exec-out", `content read --uri ${ownedDownloadUri}`],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
    );
    const sha256 = createHash("sha256").update(actual).digest("hex");
    assert.equal(actual.byteLength, item.size, "Downloads byte count differs from fixture");
    assert.equal(sha256, item.sha256, "Downloads SHA-256 differs from fixture");
    process.stdout.write(
      `${JSON.stringify({ caseId: "MF08", device: deviceSerial, name: item.name, bytes: actual.byteLength, sha256, uri: ownedDownloadUri, screenshotPath }, null, 2)}\n`,
    );
  }
} finally {
  if (ownedDownloadUri) {
    // 媒体库只允许 shell 身份删除该 URI；root UID 没有 package，app UID 缺少外部 provider 权限。
    // 切换到 Android shell UID 后只删除本次已记录的行 ID，避免触碰任何其他 Downloads 项。
    await device?.shell(`su 2000 content delete --uri ${ownedDownloadUri}`);
    const remainingRows = await device?.shell(
      "content query --uri content://media/external/downloads --projection _id:_display_name:is_pending",
    );
    assert.ok(
      !remainingRows
        ?.toString("utf8")
        .split(/\r?\n/)
        .some((line) => line.match(/\b_id=(\d+)/)?.[1] === ownedDownloadId),
      `Could not remove this run's Downloads artifact ${item.name}`,
    );
  }
  await device?.close();
}
