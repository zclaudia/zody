// Prepare case-owned source files for MF08. No Android device or Downloads folder is touched.
// Run: pnpm exec tsx packages/desktop/test/e2e/mobile-remote/manual-review/pending/prepare-mobile-download-fixture.mjs
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const outputDir = resolve(
  repoRoot,
  ".tmp/mobile-remote-p8-push/desktop-home/ZodyProject/MF08-fixtures",
);
const maxBytes = 16 * 1024 * 1024;
const rangeBytes = 1024 * 1024;

function makePayload(size, seed) {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    // Deterministic, non-text bytes exercise binary preservation and range boundaries.
    bytes[index] = (index * 31 + (index >>> 8) * 17 + seed) & 0xff;
  }
  return bytes;
}

const cases = [
  { name: "MF08-中文 文件名.bin", size: rangeBytes + 173, seed: 29 },
  { name: "MF08-limit-16MiB.bin", size: maxBytes, seed: 71 },
  { name: "MF08-over-limit-16MiB-plus-1.bin", size: maxBytes + 1, seed: 113 },
];

await mkdir(outputDir, { recursive: true });
const files = [];
for (const item of cases) {
  const bytes = makePayload(item.size, item.seed);
  const path = resolve(outputDir, item.name);
  await writeFile(path, bytes);
  files.push({
    name: item.name,
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    expectedSave: bytes.byteLength <= maxBytes,
  });
}

const manifest = {
  caseId: "MF08",
  workspacePath: outputDir,
  maxSaveBytes: maxBytes,
  rangeBytes,
  files,
  cleanup:
    "Remove only files whose names start with MF08- from this case-owned workspace and Downloads.",
};
await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
