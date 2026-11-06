// R00 lexical evidence; no replacement decisions are inferred from a match.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const destination = process.argv[2] ?? "output/zody-rename-r00";
const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);
const excludedPrefix = "docs/plans/zody-rename-execution/";
const files = tracked.filter((file) => !file.startsWith(excludedPrefix));
const pattern =
  /@zcode\/[\w.-]+|__ZCODE_[A-Z0-9_]+__|ZCODE_[A-Z0-9_]+|zcode[-_:./][\w./:*+-]*|\.zcode(?:\/[\w./-]+)?|window\.zcode|__zcode\w*/gi;
function category(file, token) {
  if (file.includes("/frozen-candidate/") || file.includes("/reports/")) return "frozen-or-report";
  if (
    file.startsWith("docs/") ||
    file.startsWith("specs/") ||
    file.startsWith("apps/zcode-cli/docs/")
  )
    return "documentation";
  if (token.startsWith("@zcode/")) return "package-reference";
  if (/^(?:__)?ZCODE_/.test(token)) return "env-or-define";
  if (/builtin/i.test(token)) return "builtin";
  if (/artifact/i.test(token)) return "artifact";
  if (/plugin|gen-ui|sandbox|request-context/i.test(token)) return "plugin-candidate";
  if (/protocol|^zcode:|^__zcode|^window\.zcode/i.test(token)) return "wire-or-bridge-candidate";
  if (/^\.zcode|^zcode\.json$/i.test(token)) return "storage-or-source-candidate";
  return "other-review";
}
const grouped = new Map();
const raw = [];
for (const file of files) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (text.includes("\ufffd")) continue;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(pattern)) {
      const token = match[0],
        kind = category(file, token),
        key = JSON.stringify([file, kind, token]);
      const row = grouped.get(key) ?? { file, category: kind, token, count: 0, lines: [] };
      row.count++;
      if (row.lines.at(-1) !== i + 1) row.lines.push(i + 1);
      grouped.set(key, row);
      raw.push(JSON.stringify([file, i + 1, kind, token]));
    }
  }
}
await mkdir(destination, { recursive: true });
const rawData = raw.join("\n") + "\n";
await writeFile(`${destination}/matches.jsonl`, rawData);
const entries = [...grouped.values()];
const detailData = JSON.stringify(entries) + "\n";
await writeFile(`${destination}/grouped.json`, detailData);
const categoryCounts = {};
for (const entry of entries)
  categoryCounts[entry.category] = (categoryCounts[entry.category] ?? 0) + entry.count;
const result = {
  baseline: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  command: `node docs/plans/zody-rename-execution/scan-inventory.mjs ${destination}`,
  excludedPrefixes: [excludedPrefix],
  scannedTrackedFiles: files.length,
  occurrences: raw.length,
  groups: grouped.size,
  categoryCounts,
  rawEvidence: `${destination}/matches.jsonl`,
  rawSha256: createHash("sha256").update(rawData).digest("hex"),
  groupedEvidence: `${destination}/grouped.json`,
  groupedSha256: createHash("sha256").update(detailData).digest("hex"),
  limitations: "Lexical candidates only; not a replacement map or proof of complete call graphs.",
};
await writeFile(
  "docs/plans/zody-rename-execution/residual-inventory.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
