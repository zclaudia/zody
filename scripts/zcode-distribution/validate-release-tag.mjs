#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(tag))
  throw new Error(`Invalid release tag: ${tag ?? "<missing>"}`);
const rootPackage = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"),
);
const expected = `v${rootPackage.version}`;
if (tag !== expected)
  throw new Error(`Release tag ${tag} does not match root package version ${expected}`);
console.log(`Validated release tag ${tag}`);
