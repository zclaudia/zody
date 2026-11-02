import { describe, expect, it } from "vitest";
import type { SeatbeltProfileInput } from "../../scripts/d06-policy.js";
import {
  buildD06Round5Profile,
  describeRound5ProfileDelta,
} from "../../scripts/d06-round5-profile.js";

const base: SeatbeltProfileInput = {
  nodePath: "/Users/example/.local/node/bin/node",
  bundlePath: "/private/tmp/d06-root/server.mjs",
  canaryRoot: "/private/tmp/d06-root",
  docsDir: "/private/tmp/d06-root/docs",
  docsFile: "/private/tmp/d06-root/docs/api.json",
  clientDir: "/private/tmp/d06-root/docs",
  clientFile: "/private/tmp/d06-root/browser-client.mjs",
  browserSocketPath: "/private/tmp/d06-root/browser.sock",
};

describe("D06 round 5 profile delta", () => {
  it("adds only exact literal reads and metadata ancestors", () => {
    const profile = buildD06Round5Profile(base, [
      { path: "/private/tmp/d06-root/native/probe.node", reason: "native probe" },
      {
        path: "/Users/example/.local/share/node_modules/koffi/build/koffi.node",
        reason: "fixed FFI probe",
      },
    ]);
    expect(profile.text).toContain("(deny default)");
    expect(profile.text).toContain('(literal "/private/tmp/d06-root/native/probe.node")');
    expect(profile.text).toContain(
      '(literal "/Users/example/.local/share/node_modules/koffi/build/koffi.node")',
    );
    expect(profile.text).not.toContain('(subpath "/Users/example")');
    expect(profile.text).not.toContain('(subpath "/private/tmp/d06-root")');
    expect(profile.text).not.toContain("file-write");
    expect(profile.text.match(/network-outbound/gu)).toHaveLength(1);
    expect(profile.delta.readLiterals).toHaveLength(2);
    expect(profile.delta.writeLiterals).toEqual([]);
    expect(profile.delta.metadataAncestors).toContain("/Users/example/.local/share/node_modules");
    expect(describeRound5ProfileDelta(profile.delta)).toContain(
      "file-read* literal /private/tmp/d06-root/native/probe.node",
    );
  });

  it("deduplicates exact reads and rejects relative paths or /", () => {
    const profile = buildD06Round5Profile(base, [
      { path: "/private/tmp/d06-root/native/probe.node", reason: "native probe" },
      { path: "/private/tmp/d06-root/native/probe.node", reason: "duplicate" },
    ]);
    expect(profile.delta.readLiterals).toEqual(["/private/tmp/d06-root/native/probe.node"]);
    expect(() =>
      buildD06Round5Profile(base, [{ path: "native/probe.node", reason: "relative" }]),
    ).toThrow(/absolute/u);
    expect(() => buildD06Round5Profile(base, [{ path: "/", reason: "root" }])).toThrow(
      /root read/u,
    );
  });
});
