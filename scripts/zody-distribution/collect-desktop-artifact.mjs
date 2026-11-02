#!/usr/bin/env node
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const [target, outputArg] = process.argv.slice(2);
if (!target || !outputArg)
  throw new Error("Usage: collect-desktop-artifact.mjs <target> <output-dir>");
const version = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"),
).version;
const dist = resolve(import.meta.dirname, "../../packages/desktop/dist");
const output = resolve(outputArg);
await mkdir(output, { recursive: true });
const accepted = /\.(?:dmg|zip|exe|AppImage|deb|rpm|pkg\.tar\.zst)$/u;
const files = (await readdir(dist, { withFileTypes: true })).filter(
  (entry) => entry.isFile() && accepted.test(entry.name),
);
if (!files.length) throw new Error(`No Desktop installer found in ${dist}`);
for (const entry of files) {
  const extension = entry.name.match(/(\.pkg\.tar\.zst|\.[^.]+)$/u)?.[0];
  const destination = `zody-desktop-${version}-${target}${extension}`;
  await copyFile(resolve(dist, entry.name), resolve(output, destination));
  console.log(`Collected ${destination}`);
}
