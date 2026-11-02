const ARCHITECTURE_TOKEN_PATTERN = /^[A-Za-z0-9_]+$/;
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/;
const MAX_ENTITLEMENT_DEPTH = 32;
const MAX_ENTITLEMENT_NODES = 2048;

export function parseLipoArchitectures(stdout) {
  const tokens = String(stdout ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return { architectures: [], error: "lipo did not report any architectures" };
  }
  for (const token of tokens) {
    if (!ARCHITECTURE_TOKEN_PATTERN.test(token)) {
      return { architectures: [], error: `unrecognized lipo architecture token: ${token}` };
    }
  }
  return { architectures: [...new Set(tokens)].sort(), error: null };
}

export function parseVersionParts(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    return null;
  }
  const parts = value.split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    return null;
  }
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts;
}

export function versionsEqual(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) {
    return false;
  }
  return leftParts.every((part, index) => part === rightParts[index]);
}

function parseOtoolSections(stdout, fallbackArchitectures) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  const sections = new Map();
  const singleFallback =
    Array.isArray(fallbackArchitectures) && fallbackArchitectures.length === 1
      ? fallbackArchitectures[0]
      : null;
  let currentArchitecture = singleFallback;
  let currentCommand = null;
  let sawArchitectureHeader = false;

  const ensureSection = (architecture) => {
    if (!sections.has(architecture)) {
      sections.set(architecture, []);
    }
    return sections.get(architecture);
  };

  for (const line of lines) {
    const header = /^.*\(architecture ([^)]+)\):\s*$/.exec(line);
    if (header) {
      sawArchitectureHeader = true;
      currentArchitecture = header[1].trim();
      currentCommand = null;
      ensureSection(currentArchitecture);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "cmd LC_BUILD_VERSION") {
      if (!currentArchitecture) {
        continue;
      }
      currentCommand = {
        type: "build-version",
        platform: null,
        minimum: null,
        sdk: null,
      };
      ensureSection(currentArchitecture).push(currentCommand);
      continue;
    }
    if (trimmed === "cmd LC_VERSION_MIN_MACOSX") {
      if (!currentArchitecture) {
        continue;
      }
      currentCommand = {
        type: "version-min-macosx",
        platform: "1",
        minimum: null,
        sdk: null,
      };
      ensureSection(currentArchitecture).push(currentCommand);
      continue;
    }
    if (trimmed.startsWith("cmd ")) {
      currentCommand = null;
      continue;
    }
    if (!currentCommand) {
      continue;
    }

    const platform = /^platform\s+(\d+)\s*$/.exec(trimmed);
    if (platform) {
      currentCommand.platform = platform[1];
      continue;
    }
    const minimum =
      currentCommand.type === "build-version"
        ? /^minos\s+(\S+)\s*$/.exec(trimmed)
        : /^version\s+(\S+)\s*$/.exec(trimmed);
    if (minimum) {
      currentCommand.minimum = minimum[1];
      continue;
    }
    const sdk = /^sdk\s+(\S+)\s*$/.exec(trimmed);
    if (sdk) {
      currentCommand.sdk = sdk[1];
    }
  }

  if (!sawArchitectureHeader) {
    if (!singleFallback) {
      return {
        byArchitecture: {},
        errors: [
          "otool output has no architecture headers and lipo did not identify exactly one architecture",
        ],
      };
    }
  }

  const errors = [];
  const byArchitecture = {};
  for (const [architecture, commands] of sections.entries()) {
    const buildCommands = commands.filter((command) => command.type === "build-version");
    const legacyCommands = commands.filter((command) => command.type === "version-min-macosx");
    const nonMacBuild = buildCommands.find((command) => command.platform !== "1");
    if (nonMacBuild) {
      errors.push(
        `${architecture} LC_BUILD_VERSION is not macOS (platform ${nonMacBuild.platform ?? "unknown"})`,
      );
      continue;
    }
    const selected = buildCommands.length > 0 ? buildCommands : legacyCommands;
    if (selected.length === 0) {
      errors.push(`${architecture} has no LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX`);
      continue;
    }
    const minimums = [...new Set(selected.map((command) => command.minimum).filter(Boolean))];
    if (minimums.length !== 1) {
      errors.push(
        `${architecture} has ambiguous minimum macOS versions: ${minimums.join(", ") || "none"}`,
      );
      continue;
    }
    const sdks = [...new Set(selected.map((command) => command.sdk).filter(Boolean))];
    byArchitecture[architecture] = {
      minimumMacOSVersion: minimums[0],
      sdkVersion: sdks.length === 1 ? sdks[0] : null,
    };
  }

  return { byArchitecture, errors };
}

export function parseOtoolMinimumMacOs(stdout, fallbackArchitectures) {
  return parseOtoolSections(stdout, fallbackArchitectures);
}

export function parseCodesignDisplay(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  const authorities = [];
  let teamIdentifier = null;
  let identifier = null;
  let isAdhoc = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Signature=adhoc") {
      isAdhoc = true;
      continue;
    }
    if (trimmed.startsWith("Authority=")) {
      const value = trimmed.slice("Authority=".length).trim();
      if (value.length > 0) {
        authorities.push(value);
      }
      continue;
    }
    if (trimmed.startsWith("TeamIdentifier=")) {
      teamIdentifier = trimmed.slice("TeamIdentifier=".length).trim();
      continue;
    }
    if (trimmed.startsWith("Identifier=")) {
      identifier = trimmed.slice("Identifier=".length).trim();
    }
  }

  return {
    authorities,
    usableAuthorities: authorities.filter((authority) => authority !== "(unavailable)"),
    teamIdentifier,
    identifier,
    isAdhoc,
  };
}

export function parseDesignatedRequirement(stdout) {
  const match = /^\s*(?:#\s*)?designated\s*=>\s*(.+?)\s*$/mu.exec(String(stdout ?? ""));
  return match ? match[1] : null;
}

function stableValue(value, depth, budget) {
  budget.count += 1;
  if (budget.count > MAX_ENTITLEMENT_NODES) {
    throw new RangeError(`entitlements exceed ${MAX_ENTITLEMENT_NODES} nodes`);
  }
  if (depth > MAX_ENTITLEMENT_DEPTH) {
    throw new RangeError(`entitlements exceed depth ${MAX_ENTITLEMENT_DEPTH}`);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry, depth + 1, budget));
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = stableValue(value[key], depth + 1, budget);
    }
    return result;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value, 0, { count: 0 }));
}

export function entitlementsEqual(actual, expected) {
  try {
    return stableStringify(actual) === stableStringify(expected);
  } catch {
    return false;
  }
}
