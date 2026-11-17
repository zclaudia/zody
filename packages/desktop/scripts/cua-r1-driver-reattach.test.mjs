import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sameR1ProcessIdentity,
  r1LoopbackDebugger,
  reattachR1Driver,
} from "./lib/cua-r1-driver-reattach.mjs";
test("debugger binding accepts only exact loopback host and port", () => {
  for (const address of ["localhost:9222", "127.0.0.1:9222"])
    assert.equal(r1LoopbackDebugger(address).port, "9222");
  for (const address of [
    undefined,
    "http://localhost:9222",
    "localhost:0",
    "localhost:65536",
    "localhost:9222/path",
    "user@localhost:9222",
    "192.0.2.1:9222",
    "localhost:9222?x",
  ])
    assert.throws(() => r1LoopbackDebugger(address));
});
test("rebind requires the original live process birth identity", () => {
  const original = { ok: true, pid: 100, launchDate: 12345.25 };
  assert.equal(sameR1ProcessIdentity(original, { ...original }, 100), true);
  const kernel = { ...original, launchDate: [12345, 250000] };
  assert.equal(sameR1ProcessIdentity(kernel, { ...kernel }, 100), true);
  for (const current of [
    { ...original, pid: 101 },
    { ...original, launchDate: 12345.26 },
    { ...original, ok: false },
    null,
  ])
    assert.equal(sameR1ProcessIdentity(original, current, 100), false);
  for (const launchDate of [null, 0, NaN, [], [12345, -1], [12345, 1_000_000]])
    assert.equal(
      sameR1ProcessIdentity({ ...original, launchDate }, { ...original, launchDate }, 100),
      false,
    );
});
test("changed process fails before transport or client mutation", async () => {
  const browser = { sessionId: "original", capabilities: {}, options: {} };
  await assert.rejects(
    reattachR1Driver({
      browser,
      binding: {
        pid: 100,
        identity: { ok: true, pid: 100, launchDate: 12345 },
        debuggerAddress: "untrusted:9999",
      },
      inspectProcess: async () => ({ ok: true, pid: 100, launchDate: 12346 }),
    }),
    /candidate changed/,
  );
  assert.equal(browser.sessionId, "original");
});
