import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCuaDesktopSession,
  parseArgs,
  resolveDesktopSessionIdentityPins,
} from "./build-cua-desktop-session.mjs";
import { pinsHeader } from "./lib/cua-desktop-session-pins.mjs";
import { expectedPins } from "./macos-cua-narrow-resources-test-fixtures.mjs";

test("CLI identity profile is explicit and rejects unknown values", () => {
  assert.equal(parseArgs([]).options.identityProfile, "local-self-signed");
  assert.equal(
    parseArgs(["--identity-profile", "developer-id"]).options.identityProfile,
    "developer-id",
  );
  assert.throws(() => parseArgs(["--identity-profile", "other"]), /identity.profile/i);
});

test("developer-id requires explicit configured pins before any build", async () => {
  await assert.rejects(
    resolveDesktopSessionIdentityPins({ identityProfile: "developer-id" }),
    /identity.pins/i,
  );
  await assert.rejects(
    buildCuaDesktopSession({ identityProfile: "developer-id", nodePath: "/missing/node" }),
    /identity.pins/i,
  );
  const dir = await mkdtemp(join(tmpdir(), "cua-identity-"));
  try {
    const path = join(dir, "pins.json");
    await writeFile(path, JSON.stringify(expectedPins()));
    await assert.rejects(
      resolveDesktopSessionIdentityPins({
        identityProfile: "developer-id",
        identityPinsPath: path,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy local pins remain usable and feed exact native header values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-identity-"));
  try {
    const path = join(dir, "pins.json");
    const expected = expectedPins();
    await writeFile(path, JSON.stringify(expected));
    const { identityPins } = await resolveDesktopSessionIdentityPins({ identityPinsPath: path });
    const header = pinsHeader({ nodeSha256: "a".repeat(64), entries: [], identityPins });
    for (const field of [
      "leafSha256",
      "designatedRequirement",
      "nodeIdentifier",
      "nodeLeafSha256",
      "nodeDesignatedRequirement",
      "nodeCdhash",
    ]) {
      assert.equal(identityPins[field], expected[field]);
      assert.ok(header.includes(expected[field].replaceAll('"', '\\"')), field);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
