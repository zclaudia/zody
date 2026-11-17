const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createWriteBarrier } = require("./write_electron_barrier.cjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("only the actual matching one-use release commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r2-electron-barrier-"));
  try {
    const barrier = createWriteBarrier(dir, 200);
    const waiting = barrier.wait();
    let p;
    for (let i = 0; i < 30; i++) {
      try {
        p = JSON.parse(await readFile(join(dir, "write-pending.json"), "utf8"));
        break;
      } catch {
        await pause(2);
      }
    }
    assert.equal(p.nonce, barrier.nonce);
    assert.equal(p.sequence, 1);
    await writeFile(join(dir, "write-release.json"), JSON.stringify(p));
    assert.equal(await waiting, true);
    assert.equal(await barrier.wait(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("wrong nonce and boolean sequence cannot release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r2-electron-barrier-"));
  try {
    const b = createWriteBarrier(dir, 30);
    await writeFile(
      join(dir, "write-release.json"),
      JSON.stringify({ nonce: b.nonce, sequence: true }),
    );
    assert.equal(await b.wait(), false);
    await writeFile(
      join(dir, "write-release.json"),
      JSON.stringify({ nonce: "wrong", sequence: 2 }),
    );
    assert.equal(await b.wait(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
