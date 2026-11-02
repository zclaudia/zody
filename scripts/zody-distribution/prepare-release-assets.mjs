#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { assessReleaseAssets, verifyCliArchiveChecksum } from "./release-assets.mjs";
import { readVerifiedNotices } from "../third-party-notices.mjs";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const version = option("--version");
await readVerifiedNotices(root, { requireComplete: true });
const input = resolve(option("--input"));
const output = resolve(option("--output"));
const names = await readdir(input);
const failures = assessReleaseAssets(
  [...names, "SHA256SUMS.txt", "THIRD-PARTY-NOTICES.md", "RELEASE_NOTES.md"],
  version,
);
if (failures.length) throw new Error(`Incomplete release candidate:\n${failures.join("\n")}`);
await mkdir(output, { recursive: true });
const checksumLines = [];
for (const name of names.filter((entry) => entry.endsWith(".tar.gz"))) {
  const data = await readFile(resolve(input, name));
  const sidecar = await readFile(resolve(input, `${name}.sha256`), "utf8");
  verifyCliArchiveChecksum(name, data, sidecar);
}
for (const name of names) {
  const file = resolve(input, name);
  const digest = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  checksumLines.push(`${digest}  ${name}`);
  await copyFile(file, resolve(output, basename(name)));
}
for (const file of ["THIRD-PARTY-NOTICES.md", "RELEASE_NOTES.md"]) {
  await copyFile(
    resolve(root, file === "RELEASE_NOTES.md" ? "docs/releases/zody-0.1.0.md" : file),
    resolve(output, file),
  );
  checksumLines.push(
    `${createHash("sha256")
      .update(await readFile(resolve(output, file)))
      .digest("hex")}  ${file}`,
  );
}
await writeFile(resolve(output, "SHA256SUMS.txt"), `${checksumLines.sort().join("\n")}\n`);
console.log(`Prepared ${checksumLines.length} checksummed release files in ${output}`);
