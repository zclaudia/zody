import { resolve } from "node:path";

export const supportedDistributionTargets = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "linux-x64",
]);

const numericIdentifier = "(?:0|[1-9]\\d*)";
const nonNumericPrereleaseIdentifier = "(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+";
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericPrereleaseIdentifier})`;
const distributionVersionPattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);

export const nodeTargetForDistribution = (target) => target.replace(/^win32-/u, "win-");

export const archiveNameForTarget = (target, version) => {
  assertDistributionTarget(target);
  assertDistributionVersion(version);
  return `zody-cli-${version}-${target}.tar.gz`;
};

export function assertDistributionVersion(version) {
  if (typeof version !== "string" || !distributionVersionPattern.test(version)) {
    throw new Error("Invalid distribution version; expected a SemVer version.");
  }
  return version;
}

export function assertDistributionTarget(target) {
  if (!supportedDistributionTargets.includes(target)) {
    throw new Error(
      `Unsupported target "${target}". Supported targets: ${supportedDistributionTargets.join(", ")}`,
    );
  }
}

export function parseDistributionArgs(argv) {
  const options = {
    all: false,
    help: false,
    outDir: undefined,
    skipBuild: false,
    version: undefined,
  };
  const selected = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      if (arg.includes("=")) return { index, value: arg.slice(arg.indexOf("=") + 1) };
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      return { index: index + 1, value };
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--target" || arg.startsWith("--target=")) {
      const parsed = readValue();
      assertDistributionTarget(parsed.value);
      selected.push(parsed.value);
      index = parsed.index;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      const parsed = readValue();
      options.version = assertDistributionVersion(parsed.value);
      index = parsed.index;
    } else if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const parsed = readValue();
      options.outDir = resolve(parsed.value);
      index = parsed.index;
    } else {
      throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
    }
  }

  const targets = options.all ? [...supportedDistributionTargets] : selected;
  if (!options.help && !targets.length) {
    throw new Error("Select a target with --target <target> or --all.");
  }
  options.targets = [...new Set(targets)];
  return options;
}
