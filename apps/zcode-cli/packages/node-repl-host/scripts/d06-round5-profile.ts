import {
  buildSeatbeltProfile,
  collectAncestorDirectories,
  type SeatbeltProfileInput,
} from "./d06-policy.js";

export interface D06Round5ExtraRead {
  path: string;
  reason: string;
}

export interface D06Round5ProfileDelta {
  readLiterals: string[];
  metadataAncestors: string[];
  writeLiterals: never[];
}

export interface D06Round5Profile {
  text: string;
  delta: D06Round5ProfileDelta;
}

/**
 * Round 5 only adds exact file reads for the probe assets. It never adds a subpath for HOME,
 * workspace, temp root or network. Exact write additions are intentionally unsupported here.
 */
export function buildD06Round5Profile(
  input: SeatbeltProfileInput,
  extras: readonly D06Round5ExtraRead[],
): D06Round5Profile {
  const paths = extras.map((entry) => entry.path);
  for (const path of paths) {
    if (!path.startsWith("/")) throw new Error(`round5 extra read must be absolute: ${path}`);
    if (path === "/") throw new Error("round5 must not add a root read");
  }
  const uniqueReads = [...new Set(paths)];
  const metadataAncestors = collectAncestorDirectories(uniqueReads);
  const base = buildSeatbeltProfile(input);
  const additions = [
    ...(uniqueReads.length > 0
      ? [`(allow file-read* ${uniqueReads.map((path) => `(literal ${quote(path)})`).join(" ")})`]
      : []),
    ...(metadataAncestors.length > 0
      ? [
          `(allow file-read-metadata ${metadataAncestors
            .map((path) => `(literal ${quote(path)})`)
            .join(" ")})`,
        ]
      : []),
  ];
  return {
    text: `${base.trimEnd()}\n${additions.join("\n")}\n`,
    delta: { readLiterals: uniqueReads, metadataAncestors, writeLiterals: [] },
  };
}

export function describeRound5ProfileDelta(delta: D06Round5ProfileDelta): string[] {
  return [
    ...delta.readLiterals.map((path) => `file-read* literal ${path}`),
    ...delta.metadataAncestors.map((path) => `file-read-metadata literal ${path}`),
  ];
}

function quote(value: string): string {
  return JSON.stringify(value);
}
