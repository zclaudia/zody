export const D06_GATE = "blocked" as const;
export const D06_EXPECTED_NODE = "24.14.0";
export const D06_DENIAL_CODES = new Set(["EACCES", "EPERM"]);

export const D06_BLOCKED_SCOPE = [
  "native-addon-and-ffi",
  "debugger-attach",
  "real-browser-integration",
  "sea-runtime",
  "descendant-abort-reclamation",
] as const;

// 只加入 Node 24.14.0 在本机启动所必需的系统读面；根目录仅允许目录本身，
// 不允许 subpath("/")。这是已实测的 dyld/Node 初始化需求，不是全盘读取授权。
export const D06_FIXED_READ_PATHS = [
  "/System/Library",
  "/usr/lib",
  "/dev/null",
  "/dev/urandom",
  "/dev/random",
] as const;

export interface SeatbeltProfileInput {
  nodePath: string;
  bundlePath: string;
  canaryRoot: string;
  docsDir: string;
  docsFile: string;
  clientDir: string;
  clientFile: string;
  browserSocketPath: string;
}

export interface SeatbeltAllowEntry {
  operation:
    | "process-exec"
    | "file-read*"
    | "file-read-metadata"
    | "sysctl-read"
    | "network-outbound";
  match: "literal" | "subpath" | "unix-socket";
  path?: string;
  reason: string;
}

export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  for (const [name, value] of Object.entries(input)) {
    if (!value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  }
  const readLiterals = [
    "/",
    input.nodePath,
    input.bundlePath,
    input.canaryRoot,
    input.docsDir,
    input.docsFile,
    input.clientDir,
    input.clientFile,
    "/dev/null",
    "/dev/urandom",
    "/dev/random",
  ];
  const readSubpaths = ["/System/Library", "/usr/lib"];
  const ancestorLiterals = collectAncestorDirectories([
    input.nodePath,
    input.bundlePath,
    input.canaryRoot,
    input.docsFile,
    input.clientFile,
    input.browserSocketPath,
  ]);
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${quote(input.nodePath)}))`,
    `(allow file-read* ${[...readLiterals.map((path) => `(literal ${quote(path)})`), ...readSubpaths.map((path) => `(subpath ${quote(path)})`)].join(" ")})`,
    `(allow file-read-metadata ${ancestorLiterals.map((path) => `(literal ${quote(path)})`).join(" ")})`,
    "(allow sysctl-read)",
    `(allow network-outbound (remote unix-socket (path ${quote(input.browserSocketPath)})))`,
    "",
  ].join("\n");
}

export function describeSeatbeltAllowlist(input: SeatbeltProfileInput): SeatbeltAllowEntry[] {
  const entries: SeatbeltAllowEntry[] = [
    {
      operation: "process-exec",
      match: "literal",
      path: input.nodePath,
      reason: "fixed cell runtime",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: "/",
      reason: "Node 24.14 startup path lookup",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: input.nodePath,
      reason: "fixed cell runtime",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: input.bundlePath,
      reason: "built node_repl cell bundle",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: input.canaryRoot,
      reason: "temporary canary directory itself/enumeration",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: input.docsDir,
      reason: "synthetic docs directory itself/enumeration",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: input.docsFile,
      reason: "synthetic docs read allowance",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: input.clientDir,
      reason: "synthetic client directory itself/enumeration",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: input.clientFile,
      reason: "synthetic client import allowance",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: "/dev/null",
      reason: "Node device initialization",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: "/dev/urandom",
      reason: "Node random initialization",
    },
    {
      operation: "file-read*",
      match: "literal",
      path: "/dev/random",
      reason: "Node random initialization",
    },
    {
      operation: "file-read*",
      match: "subpath",
      path: "/System/Library",
      reason: "macOS system libraries",
    },
    {
      operation: "file-read*",
      match: "subpath",
      path: "/usr/lib",
      reason: "macOS dynamic libraries",
    },
    ...collectAncestorDirectories([
      input.nodePath,
      input.bundlePath,
      input.canaryRoot,
      input.docsFile,
      input.clientFile,
      input.browserSocketPath,
    ]).map((path) => ({
      operation: "file-read-metadata" as const,
      match: "literal" as const,
      path,
      reason: "literal ancestor directory needed for realpath/lstat only",
    })),
    { operation: "sysctl-read", match: "literal", reason: "Node runtime startup" },
    {
      operation: "network-outbound",
      match: "unix-socket",
      path: input.browserSocketPath,
      reason: "synthetic Browser bridge fixture only",
    },
  ];
  return entries;
}

export type D06Expectation = "allowed" | "denied";
export type D06ObservedOutcome = "allowed" | "denied" | "error" | "crashed" | "blocked";

export interface D06Observation {
  outcome: D06ObservedOutcome;
  code?: string | null;
  causeCode?: string | null;
  detail?: string;
  checks?: Record<string, boolean>;
  raw?: unknown;
}

export interface D06CaseResult {
  id: string;
  group: "fork" | "seatbelt";
  expected: D06Expectation;
  status: "passed" | "failed" | "blocked";
  reason: string;
  observed: D06Observation;
  durationMs: number;
  command?: string[];
}

export interface D06FailureTestResult {
  id: string;
  expected: "startup-rejected-no-execution";
  status: "passed" | "failed" | "blocked";
  reason: string;
  command: string[];
  canary: { beforeSha256: string; afterSha256: string; unchanged: boolean };
  rejection?: string;
  durationMs: number;
}

export function judgeObservation(
  expected: D06Expectation,
  observed: D06Observation,
): { status: "passed" | "failed" | "blocked"; reason: string } {
  if (observed.outcome === "blocked") {
    return { status: "blocked", reason: observed.detail ?? "environment blocked execution" };
  }
  const failedChecks = Object.entries(observed.checks ?? {}).filter(([, ok]) => !ok);
  if (failedChecks.length > 0) {
    return {
      status: "failed",
      reason: `check failed: ${failedChecks.map(([name]) => name).join(", ")}`,
    };
  }
  if (expected === "allowed") {
    return observed.outcome === "allowed"
      ? { status: "passed", reason: "observed allowed as expected" }
      : {
          status: "failed",
          reason: `expected allowed, observed ${observed.outcome}${suffix(observed)}`,
        };
  }
  if (observed.outcome !== "denied") {
    return {
      status: "failed",
      reason: `expected denial, observed ${observed.outcome}${suffix(observed)}`,
    };
  }
  const code = observed.code ?? observed.causeCode ?? "";
  if (!D06_DENIAL_CODES.has(code)) {
    return {
      status: "failed",
      reason: `expected EPERM/EACCES denial, observed code=${code || "none"}`,
    };
  }
  return { status: "passed", reason: `observed ${code} denial` };
}

export function isKnownMaskedModuleFailure(observed: {
  outcome?: unknown;
  code?: unknown;
  causeCode?: unknown;
}): boolean {
  if (observed.outcome === "denied") {
    return (
      D06_DENIAL_CODES.has(String(observed.code ?? "")) ||
      D06_DENIAL_CODES.has(String(observed.causeCode ?? ""))
    );
  }
  return observed.outcome === "error" && observed.code === "ERR_MODULE_NOT_FOUND";
}

export function decideExit(cases: readonly D06CaseResult[]): {
  status: "satisfied" | "failed" | "blocked";
  exitCode: 0 | 1 | 2;
} {
  if (cases.length === 0) return { status: "blocked", exitCode: 2 };
  if (cases.some((item) => item.status === "failed")) return { status: "failed", exitCode: 1 };
  if (cases.some((item) => item.status === "blocked")) return { status: "blocked", exitCode: 2 };
  return { status: "satisfied", exitCode: 0 };
}

export function decideFailureTests(tests: readonly D06FailureTestResult[]): {
  status: "satisfied" | "failed" | "blocked";
  exitCode: 0 | 1 | 2;
} {
  if (tests.length === 0) return { status: "failed", exitCode: 1 };
  if (tests.some((item) => item.status === "failed")) return { status: "failed", exitCode: 1 };
  if (tests.some((item) => item.status === "blocked")) return { status: "blocked", exitCode: 2 };
  return { status: "satisfied", exitCode: 0 };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function collectAncestorDirectories(paths: readonly string[]): string[] {
  const ancestors = new Set<string>();
  for (const path of paths) {
    let current = path;
    while (current !== "/") {
      current = current.slice(0, current.lastIndexOf("/")) || "/";
      if (current !== "/") ancestors.add(current);
    }
  }
  return [...ancestors].sort();
}

function suffix(observed: D06Observation): string {
  const code = observed.code ?? observed.causeCode;
  return `${code ? ` code=${code}` : ""}${observed.detail ? `: ${observed.detail}` : ""}`;
}
