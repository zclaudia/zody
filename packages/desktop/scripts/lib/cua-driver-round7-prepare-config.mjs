import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { failure, scanTree } from "./cua-driver-round7-prepare-source.mjs";

function section(text, name) {
  const marker = `[${name}]`;
  const start = text.indexOf(marker);
  if (start === -1) failure(`missing Cargo.toml section ${marker}`);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function stringArray(sectionText, key) {
  const match = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(sectionText);
  if (!match) failure(`missing ${key} array in Cargo.toml`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function dependency(sectionText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*=\\s*\\{([^\\n]*)\\}\\s*$`, "m").exec(sectionText);
  return match ? match[1] : null;
}

function requireCoreDependency(sectionText, label) {
  const line = dependency(sectionText, "cua-driver-core");
  if (!line) failure(`${label} must depend on cua-driver-core explicitly`);
  if (!/default-features\s*=\s*false/.test(line)) {
    failure(`${label} must set cua-driver-core default-features = false`);
  }
  const features = /features\s*=\s*\[([^\]]*)\]/.exec(line)?.[1] ?? "";
  const names = [...features.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  if (names.length !== 1 || names[0] !== "yaml") {
    failure(`${label} must select exactly the yaml core feature`);
  }
}

export async function assertCandidateDependencyPolicy(sourceRoot) {
  const rootCargo = await readFile(join(sourceRoot, "Cargo.toml"), "utf8");
  const workspace = section(rootCargo, "workspace");
  if (stringArray(workspace, "members").includes("../harness")) {
    failure("root workspace still includes ../harness");
  }
  const workspacePackage = section(rootCargo, "workspace.package");
  if (!/^version\s*=\s*"0\.37\.0"/m.test(workspacePackage)) {
    failure("candidate workspace version must remain 0.37.0");
  }

  const coreCargo = await readFile(join(sourceRoot, "crates/cua-driver-core/Cargo.toml"), "utf8");
  const coreFeatures = section(coreCargo, "features");
  const coreDefault = stringArray(coreFeatures, "default");
  if (coreDefault.length !== 1 || coreDefault[0] !== "yaml") {
    failure(`core default features must be [yaml], found [${coreDefault.join(", ")}]`);
  }
  if (!/^rego\s*=\s*\[\s*"dep:regorus"\s*\]/m.test(coreFeatures)) {
    failure("core must retain the rego feature definition");
  }
  if (!/^script\s*=\s*\[\s*"dep:rquickjs"\s*\]/m.test(coreFeatures)) {
    failure("core must retain the script feature definition");
  }

  const contractCargo = await readFile(
    join(sourceRoot, "crates/cua-driver-contract/Cargo.toml"),
    "utf8",
  );
  const contractDependencies = section(contractCargo, "dependencies");
  const contractUniffi = dependency(contractDependencies, "uniffi");
  if (!contractUniffi || !/optional\s*=\s*true/.test(contractUniffi)) {
    failure("contract uniffi dependency must be optional");
  }
  const contractFeatures = section(contractCargo, "features");
  const contractDefault = stringArray(contractFeatures, "default");
  if (contractDefault.length !== 0) failure("contract default features must be empty");
  if (!/^uniffi\s*=\s*\[\s*"dep:uniffi"\s*\]/m.test(contractFeatures)) {
    failure("contract must define the uniffi pass-through feature");
  }

  const sdkCargo = await readFile(join(sourceRoot, "crates/cua-driver-sdk/Cargo.toml"), "utf8");
  const sdkDependencies = section(sdkCargo, "dependencies");
  requireCoreDependency(sdkDependencies, "SDK");
  const sdkUniffi = dependency(sdkDependencies, "uniffi");
  if (!sdkUniffi || !/optional\s*=\s*true/.test(sdkUniffi)) {
    failure("SDK uniffi dependency must be optional");
  }
  if (!dependency(sdkDependencies, "cua-driver-contract")) {
    failure("SDK must retain the contract dependency");
  }
  const sdkFeatures = section(sdkCargo, "features");
  const sdkDefault = stringArray(sdkFeatures, "default");
  if (sdkDefault.length !== 0) failure("SDK default features must be empty");
  const uniffiFeature = /^uniffi\s*=\s*\[([^\]]*)\]/m.exec(sdkFeatures)?.[1] ?? "";
  if (
    !uniffiFeature.includes('"dep:uniffi"') ||
    !uniffiFeature.includes('"cua-driver-contract/uniffi"')
  ) {
    failure("SDK uniffi feature must pass through contract/uniffi");
  }
  if (
    sdkCargo.includes("[dev-dependencies]") &&
    section(sdkCargo, "dev-dependencies").includes("uniffi")
  ) {
    failure("SDK dev-dependencies may not reactivate uniffi");
  }

  const platformCargo = await readFile(
    join(sourceRoot, "crates/platform-macos/Cargo.toml"),
    "utf8",
  );
  requireCoreDependency(section(platformCargo, "dependencies"), "platform-macos");
  const platformFeatures = section(platformCargo, "features");
  const platformDefault = stringArray(platformFeatures, "default");
  if (
    platformDefault.length !== 2 ||
    !platformDefault.includes("zody-dev-no-input") ||
    !platformDefault.includes("zody-strict-frame-gate")
  ) {
    failure("platform-macos must retain no-input and strict-frame defaults");
  }
  return {
    coreDefaultFeatures: coreDefault,
    uniffiDefault: false,
    platformDefaultFeatures: platformDefault,
  };
}

export async function assertUniffiFeatureGates(sourceRoot) {
  const { files } = await scanTree(sourceRoot);
  const rustFiles = files.filter(
    (file) =>
      file.path.endsWith(".rs") &&
      (file.path.startsWith("crates/cua-driver-contract/src/") ||
        file.path.startsWith("crates/cua-driver-sdk/src/")),
  );
  for (const file of rustFiles) {
    const lines = (await readFile(join(sourceRoot, file.path), "utf8")).split(/\r?\n/);
    let previous = "";
    lines.forEach((line, index) => {
      const legalCfgAttr = line.includes('cfg_attr(feature = "uniffi"');
      if (/^\s*#\[uniffi[:(]/.test(line) || (!legalCfgAttr && /derive\([^)]*uniffi::/.test(line))) {
        failure(`ungated uniffi attribute: ${file.path}:${index + 1}`);
      }
      if (line.includes("uniffi::") && !legalCfgAttr) {
        if (
          !/^\s*uniffi::setup_scaffolding!/.test(line) ||
          previous.trim() !== '#[cfg(feature = "uniffi")]'
        ) {
          failure(`ungated uniffi reference: ${file.path}:${index + 1}`);
        }
      }
      if (line.trim()) previous = line;
    });
  }
  return true;
}

export function assertGraphExclusions(graph, excludedPackages) {
  if (!Array.isArray(graph?.packages) || graph.packages.length === 0) {
    failure("cargo graph is empty");
  }
  const excluded = new Set(excludedPackages);
  const found = graph.packages
    .filter((entry) => excluded.has(entry.name))
    .map((entry) => `${entry.name}@${entry.version}`);
  if (found.length > 0) failure(`excluded packages remain in the graph: ${found.join(", ")}`);
  return true;
}
