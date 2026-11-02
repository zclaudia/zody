import { describe, expect, it } from "vitest";
import { assertCommandOk, runBoundedCommand } from "../scripts/lib/cua-peer-diagnostic-command.mjs";

describe("macOS CUA R10 bounded command runner", () => {
  it("detects output overflow and never treats a truncated exit-0 child as success", async () => {
    const result = await runBoundedCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(65536)); setTimeout(() => process.exit(0), 50);"],
      { timeoutMs: 15_000, maxBuffer: 1024 },
    );
    expect(result.bufferOverflow).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
    expect(() => assertCommandOk(result, "overflow-probe")).toThrow(/buffer-overflow/);
  });

  it("keeps a small successful child command as ok", async () => {
    const result = await runBoundedCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 15_000,
      maxBuffer: 1024,
    });
    expect(result.bufferOverflow).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(assertCommandOk(result, "small-probe").stdout).toBe("ok");
  });
});
