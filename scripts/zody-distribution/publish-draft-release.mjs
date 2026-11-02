#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  decideExistingAsset,
  assessReleaseAssets,
  rejectUnexpectedExistingAssets,
} from "./release-assets.mjs";
import { readVerifiedNotices } from "../third-party-notices.mjs";

const [directoryArg, tag] = process.argv.slice(2);
if (!directoryArg || !tag)
  throw new Error("Usage: publish-draft-release.mjs <asset-directory> <tag>");
const directory = resolve(directoryArg);
await readVerifiedNotices(resolve(import.meta.dirname, "../.."), { requireComplete: true });
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
const version = tag.replace(/^v/u, "");
const names = await readdir(directory);
const failures = assessReleaseAssets(names, version);
if (failures.length) throw new Error(`Incomplete release candidate:\n${failures.join("\n")}`);
const api = `https://api.github.com/repos/${repository}`;
const headers = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
};

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok)
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${url} failed (${response.status}): ${await response.text()}`,
    );
  return response.status === 204 ? null : response.json();
}

async function findOrCreateDraft() {
  const url = `${api}/releases/tags/${encodeURIComponent(tag)}`;
  const found = await fetch(url, { headers });
  if (found.ok) {
    const release = await found.json();
    if (!release.draft)
      throw new Error(`Release ${tag} is already published; refusing to replace assets`);
    return release;
  }
  if (found.status !== 404)
    throw new Error(`GitHub release lookup failed (${found.status}): ${await found.text()}`);
  return request(`${api}/releases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      name: `Zody ${version}`,
      draft: true,
      prerelease: true,
      body: "Zody preview candidate. Verify checksums and artifacts before manually publishing.",
    }),
  });
}

const release = await findOrCreateDraft();
const existing = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
rejectUnexpectedExistingAssets([...existing.keys()], names);
for (const name of names.sort()) {
  if (name === ".DS_Store") continue;
  const file = resolve(directory, name);
  if (!(await stat(file)).isFile()) continue;
  const bytes = await readFile(file);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const asset = existing.get(basename(file));
  if (asset) {
    decideExistingAsset({
      draft: release.draft,
      existingDigest: asset.digest,
      incomingDigest: digest,
    });
    console.log(`Already uploaded: ${name}`);
    continue;
  }
  const uploadUrl = release.upload_url.replace(/\{.*$/u, "");
  const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!response.ok)
    throw new Error(`Upload ${name} failed (${response.status}): ${await response.text()}`);
  console.log(`Uploaded: ${name}`);
}
console.log(`Draft release ready: ${release.html_url}`);
