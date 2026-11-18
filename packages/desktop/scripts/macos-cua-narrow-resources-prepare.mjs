#!/usr/bin/env node
// 从已验证的 desktop-session signed app 生成 cua-narrow 内容清单，并复制受控 stage。
// 只读固定 identity pins；不签名、不安装证书、不请求 TCC、不激活 Host。
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_IDENTITY_PINS_PATH,
  DEFAULT_OUTPUT_ROOT,
  NARROW_MANIFEST_KIND,
  NARROW_TARGET,
} from "./macos-cua-narrow-resources-constants.mjs";
import { createNarrowManifest } from "./macos-cua-narrow-resources.mjs";
import { resolveIdentityProfileName } from "./macos-cua-narrow-identity-profile.mjs";

export function usage() {
  return `Usage: node packages/desktop/scripts/macos-cua-narrow-resources-prepare.mjs \\
  --app <absolute signed Zody CUA Desktop Session.app> \\
  --native-build-manifest <absolute desktop-session build-manifest.json> \\
  [--output <absolute output root>] [--replace] \\
  [--identity-profile local-self-signed|developer-id] [--identity-pins <absolute path>]

Local identity defaults to the R11 pins. Developer ID requires explicit pins and the configured repository trust root.
This command verifies and copies existing signed material; it never signs or notarizes.`;
}

export function parsePrepareArgs(argv) {
  const values = new Map();
  let replace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--replace") {
      replace = true;
      continue;
    }
    if (name === "--help" || name === "-h") return { help: true };
    if (!name.startsWith("--")) throw new Error(`Unknown argument: ${name}`);
    if (
      ![
        "--app",
        "--native-build-manifest",
        "--output",
        "--identity-profile",
        "--identity-pins",
      ].includes(name)
    )
      throw new Error(`Unknown argument: ${name}`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const absolute = (name, fallback) => {
    const value = values.get(name)?.trim() ?? fallback;
    if (!value) throw new Error(`${name} is required`);
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return resolve(value);
  };
  const identityProfile = resolveIdentityProfileName(values.get("--identity-profile"));
  if (identityProfile === "developer-id" && !values.has("--identity-pins"))
    throw new Error("developer-id requires explicit --identity-pins");
  return {
    help: false,
    appPath: absolute("--app"),
    nativeBuildManifestPath: absolute("--native-build-manifest"),
    outputRoot: absolute("--output", DEFAULT_OUTPUT_ROOT),
    identityProfile,
    pinsPath: absolute("--identity-pins", DEFAULT_IDENTITY_PINS_PATH),
    replace,
  };
}

function summarize(prepared) {
  const { manifest } = prepared;
  return {
    status: manifest.status,
    kind: NARROW_MANIFEST_KIND,
    manifestPath: prepared.manifestPath,
    stageAppPath: prepared.stageAppPath,
    target: NARROW_TARGET,
    sourceAppPath: manifest.source.appPath,
    treeSha256: manifest.tree.treeSha256,
    signedBinarySha256: manifest.identity.signedBinarySha256,
    nativeUnsignedBinarySha256: manifest.identity.nativeUnsignedBinarySha256,
    identity: {
      helperIdentifier: manifest.identity.helperIdentifier,
      nodeIdentifier: manifest.identity.nodeIdentifier,
      leafSha256: manifest.identity.leafSha256,
      leafSha1: manifest.identity.leafSha1,
      designatedRequirement: manifest.identity.designatedRequirement,
      nodeDesignatedRequirement: manifest.identity.nodeDesignatedRequirement,
      nodeCdhash: manifest.identity.nodeCdhash,
    },
    resources: {
      entries: manifest.audit.entries,
      auxiliaryResources: manifest.audit.auxiliaryResources,
      licenses: manifest.audit.licenses,
    },
    restrictions: manifest.restrictions,
  };
}

async function main() {
  const options = parsePrepareArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const prepared = await createNarrowManifest(options);
  console.log(JSON.stringify(summarize(prepared), null, 2));
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  main().catch((error) => {
    console.error(`[macos-cua-narrow-resources] ${error instanceof Error ? error.message : error}`);
    if (error?.code) console.error(`[macos-cua-narrow-resources] code=${error.code}`);
    process.exit(1);
  });
}
