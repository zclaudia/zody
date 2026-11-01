import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(packageRoot, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  absWorkingDir: packageRoot,
  entryPoints: {
    "service-worker": "src/service-worker.ts",
    offscreen: "src/offscreen.ts",
    popup: "src/popup.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  outdir,
  sourcemap: false,
  logLevel: "warning",
});

for (const file of ["manifest.json", "popup.html", "offscreen.html"]) {
  await cp(join(packageRoot, file), join(outdir, file));
}

const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
const keyDer = Buffer.from(manifest.key, "base64");
const { createHash } = await import("node:crypto");
const hash = createHash("sha256").update(keyDer).digest("hex").slice(0, 32);
const extensionId = [...hash]
  .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  .join("");

if (!existsSync(join(outdir, "service-worker.js"))) {
  throw new Error("extension build did not emit service-worker.js");
}

console.log(`[browser-extension] built ${outdir}`);
console.log(`[browser-extension] extension id: ${extensionId}`);
