// 窄 CUA 资源身份验证：只用系统 tools 读取 Info.plist、Mach-O 架构和 codesign 输出。
// 不自行解析 Mach-O/CMS；证书 leaf 由 codesign 提取后直接做摘要。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  CANDIDATE_HOST_LAUNCH_ENV,
  REPO_ROOT,
} from "./macos-cua-narrow-resources-constants.mjs";
import { NarrowResourceError, sha1Bytes, sha256Bytes } from "./macos-cua-narrow-resources-base.mjs";

const execFileAsync = promisify(execFile);

async function defaultRun(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: null,
      timeout: options.timeoutMs ?? 180_000,
      maxBuffer: 64 * 1024 * 1024,
      env: options.env ?? process.env,
    });
    return {
      code: 0,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout?.toString("utf8") ?? "",
      stderr: error.stderr?.toString("utf8") ?? "",
    };
  }
}

export function assertNoCandidateHostLaunchSeam(env = process.env) {
  const value = env[CANDIDATE_HOST_LAUNCH_ENV];
  if (typeof value === "string" && value.trim()) {
    throw new NarrowResourceError(
      "candidate-host-launch-forbidden",
      `${CANDIDATE_HOST_LAUNCH_ENV} is a candidate Host compile/launch seam and must not be set for cua-narrow resource assembly`,
    );
  }
}

function parseCodesignDisplay(output) {
  const line = (pattern) => output.match(pattern)?.[1]?.trim();
  const flagsMatch = output.match(/flags=0x([0-9a-f]+)(?:\(([^)]*)\))?/i);
  const flags = flagsMatch ? Number.parseInt(flagsMatch[1], 16) : null;
  return {
    identifier: line(/^Identifier=(.+)$/m),
    cdhash: line(/^CDHash=(.+)$/m),
    authority: line(/^Authority=(.+)$/m),
    signature: line(/^Signature=(.+)$/m),
    flags,
    hardenedRuntime: Boolean(flags && flags & 0x10000),
    adhoc: /Signature=adhoc|flags=.*\badhoc\b/i.test(output),
  };
}

// `codesign -d -r-` 单独输出 designated requirement；`-d --verbose=4` 不包含 DR。
function parseDesignatedRequirement(output) {
  return output.match(/^\s*designated\s*=>\s*(.+)$/m)?.[1]?.trim() ?? null;
}

function hasEntitlementKeys(output) {
  return /<key>\s*[^<]+\s*<\/key>/.test(output);
}

export async function readLeafCertificateDer(path, deps = {}) {
  if (deps.readLeafCertificateDer) return deps.readLeafCertificateDer(path);
  const run = deps.run ?? defaultRun;
  const directory = await mkdtemp(join(tmpdir(), "zody-cua-narrow-cert-"));
  try {
    const prefix = join(directory, "leaf");
    const result = await run("/usr/bin/codesign", [
      "-d",
      `--extract-certificates=${prefix}`,
      path,
    ]);
    if (result.code !== 0) {
      throw new NarrowResourceError(
        "narrow-signature-invalid",
        `cannot extract certificates for ${path}`,
        { code: result.code, stderr: result.stderr.slice(-2_000) },
      );
    }
    let der;
    try {
      der = await readFile(`${prefix}0`);
    } catch {
      throw new NarrowResourceError(
        "narrow-signature-invalid",
        `codesign did not write the leaf certificate for ${path}`,
      );
    }
    if (der.length === 0) {
      throw new NarrowResourceError(
        "narrow-signature-invalid",
        `codesign wrote an empty leaf certificate for ${path}`,
      );
    }
    return { der, sha256: sha256Bytes(der), sha1: sha1Bytes(der) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyCodeIdentity({
  path,
  label,
  expectedIdentifier,
  expectedDesignatedRequirement,
  expectedLeafSha256,
  expectedLeafSha1,
  expectedCdhash,
  deps = {},
}) {
  const run = deps.run ?? defaultRun;
  const readLeaf = deps.readLeafCertificateDer ?? readLeafCertificateDer;
  const displayResult = await run("/usr/bin/codesign", ["-d", "--verbose=4", path]);
  if (displayResult.code !== 0) {
    throw new NarrowResourceError(
      "narrow-signature-invalid",
      `${label} cannot be inspected by codesign`,
      { code: displayResult.code, stderr: displayResult.stderr.slice(-2_000) },
    );
  }
  const display = parseCodesignDisplay(`${displayResult.stdout}${displayResult.stderr}`);
  if (display.identifier !== expectedIdentifier) {
    throw new NarrowResourceError(
      "narrow-identity-mismatch",
      `${label} identifier mismatch`,
      { actual: display.identifier, expected: expectedIdentifier },
    );
  }

  const requirementResult = await run("/usr/bin/codesign", ["-d", "-r-", path]);
  if (requirementResult.code !== 0) {
    throw new NarrowResourceError(
      "narrow-signature-invalid",
      `${label} designated requirement cannot be inspected`,
      { code: requirementResult.code, stderr: requirementResult.stderr.slice(-2_000) },
    );
  }
  const designatedRequirement = parseDesignatedRequirement(
    `${requirementResult.stdout}${requirementResult.stderr}`,
  );
  if (designatedRequirement !== expectedDesignatedRequirement) {
    throw new NarrowResourceError(
      "narrow-designated-requirement-mismatch",
      `${label} designated requirement mismatch`,
      { actual: designatedRequirement, expected: expectedDesignatedRequirement },
    );
  }
  if (display.adhoc) {
    throw new NarrowResourceError("narrow-signature-invalid", `${label} is ad-hoc signed`);
  }
  if (!display.hardenedRuntime) {
    throw new NarrowResourceError(
      "narrow-signature-invalid",
      `${label} is missing hardened runtime`,
    );
  }
  if (expectedCdhash && display.cdhash !== expectedCdhash) {
    throw new NarrowResourceError(
      "narrow-identity-mismatch",
      `${label} CDHash mismatch`,
      { actual: display.cdhash, expected: expectedCdhash },
    );
  }

  const verifyResult = await run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    `-R=${expectedDesignatedRequirement}`,
    path,
  ]);
  if (verifyResult.code !== 0) {
    throw new NarrowResourceError(
      "narrow-signature-invalid",
      `${label} does not satisfy strict signature verification`,
      { code: verifyResult.code, stderr: verifyResult.stderr.slice(-2_000) },
    );
  }

  const entitlementResult = await run("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    ":-",
    path,
  ]);
  if (entitlementResult.code !== 0) {
    throw new NarrowResourceError(
      "narrow-signature-invalid",
      `${label} entitlements cannot be inspected`,
    );
  }
  if (hasEntitlementKeys(entitlementResult.stdout)) {
    throw new NarrowResourceError(
      "narrow-entitlements",
      `${label} carries entitlements; cua-narrow only accepts the fixed empty-entitlement identity`,
    );
  }

  const leaf = await readLeaf(path, deps);
  if (leaf.sha256 !== expectedLeafSha256 || leaf.sha1 !== expectedLeafSha1) {
    throw new NarrowResourceError(
      "narrow-identity-mismatch",
      `${label} leaf certificate does not match the fixed local-self-signed certificate`,
      { actualSha256: leaf.sha256, expectedSha256: expectedLeafSha256 },
    );
  }

  return {
    identifier: display.identifier,
    designatedRequirement,
    cdhash: display.cdhash,
    leafSha256: leaf.sha256,
    leafSha1: leaf.sha1,
    hardenedRuntime: true,
    entitlementsEmpty: true,
  };
}

export async function readInfoPlist(appPath, deps = {}) {
  if (deps.readInfoPlist) return deps.readInfoPlist(appPath);
  const run = deps.run ?? defaultRun;
  const result = await run("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    join(appPath, "Contents", "Info.plist"),
  ]);
  if (result.code !== 0) {
    throw new NarrowResourceError(
      "narrow-helper-mismatch",
      `cannot read Helper Info.plist: ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

export async function verifyMachO(path, { label, requireMinimumMacOS, deps = {} }) {
  const run = deps.run ?? defaultRun;
  const lipo = await run("/usr/bin/lipo", ["-archs", path]);
  if (lipo.code !== 0) {
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      `${label} cannot be inspected by lipo`,
      { code: lipo.code, stderr: lipo.stderr.slice(-2_000) },
    );
  }
  // 只接受 thin arm64；universal 不能在 manifest 里被谎报成 arm64。
  const architectures = lipo.stdout.trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      `${label} is not a thin arm64 binary`,
      { architectures },
    );
  }
  const otool = await run("/usr/bin/otool", ["-l", path]);
  if (otool.code !== 0) {
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      `${label} cannot be inspected by otool`,
      { code: otool.code, stderr: otool.stderr.slice(-2_000) },
    );
  }
  const minos = [...otool.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm)].map((match) => match[1]);
  if (requireMinimumMacOS && (minos.length === 0 || minos.some((value) => value !== "14.2"))) {
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      `${label} minimum macOS is not 14.2`,
      { minos },
    );
  }
  return { architectures, minos };
}
