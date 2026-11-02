import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRound11Helper } from "../scripts/lib/cua-helper-round11-build.mjs";

const execFileAsync = promisify(execFile);

interface Round11BuildManifest {
  status: string;
  signing: { performed: boolean };
  artifact: {
    absolutePath: string;
    sha256: string;
    architectures: string[];
    minimumMacOSVersion: string;
  };
  leaseTest: { absolutePath: string; sha256: string };
}

async function runBinary(
  path: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(path, args, { encoding: "utf8", timeout: 15_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("macOS CUA R11 helper lease skeleton", () => {
  let build: Round11BuildManifest;

  beforeAll(async () => {
    build = (await buildRound11Helper()) as Round11BuildManifest;
  }, 180_000);

  it("builds the unsigned app and an independent lease-test binary", async () => {
    expect(build.status).toBe("pass");
    expect(build.signing.performed).toBe(false);
    expect(build.artifact.architectures).toEqual(["arm64"]);
    expect(build.artifact.minimumMacOSVersion).toBe("14.2");
    expect(build.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(build.leaseTest.sha256).toMatch(/^[0-9a-f]{64}$/);

    const appInfo = await stat(build.artifact.absolutePath);
    expect(appInfo.isFile()).toBe(true);
    const leaseInfo = await stat(build.leaseTest.absolutePath);
    expect(leaseInfo.isFile()).toBe(true);
  });

  it("rejects the unsigned helper during preflight before any capture entry", async () => {
    const result = await runBinary(build.artifact.absolutePath, ["--preflight"]);
    expect(result.code).not.toBe(0);
    const report = JSON.parse(result.stdout.trim()) as {
      status: string;
      reason?: string;
      signature?: {
        pinConfigured: boolean;
        adhoc: boolean;
        forbiddenEntitlementsPresent: boolean;
      };
      captureEntry: boolean;
    };
    expect(report.status).toBe("blocked");
    expect(report.captureEntry).toBe(false);
    expect(report.signature?.pinConfigured).toBe(false);
    expect(report.signature?.forbiddenEntitlementsPresent).toBe(false);
    expect(["signing-pin-missing", "unsigned-or-adhoc"]).toContain(report.reason);
  });

  it("serializes two real processes on the fixed per-UID machine lock without unlinking it", async () => {
    const lockPath = `/tmp/io.github.zclaudia.zody.cua.machine.${process.geteuid()}.lock`;
    const holder = spawn(build.leaseTest.absolutePath, ["hold", "1500"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        holder.once("exit", (code, signal) => resolve({ code, signal }));
        holder.once("error", reject);
      },
    );
    let holderOutput = "";
    holder.stdout?.on("data", (chunk: string | Buffer) => {
      holderOutput += chunk.toString();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const poll = () => {
          if (holderOutput.includes("\"status\":\"held\"")) return resolve();
          if (Date.now() > deadline) return reject(new Error("lease holder did not acquire"));
          setTimeout(poll, 20);
        };
        poll();
      });

      const inodeBefore = await stat(lockPath);
      const blocked = await runBinary(build.leaseTest.absolutePath, ["probe"]);
      expect(blocked.code).toBe(2);
      expect(blocked.stdout).toContain("\"status\":\"busy\"");

      const exit = await exited;
      expect(exit.code).toBe(0);

      const acquired = await runBinary(build.leaseTest.absolutePath, ["probe"]);
      expect(acquired.code).toBe(0);
      expect(acquired.stdout).toContain("\"status\":\"acquired\"");

      const inodeAfter = await stat(lockPath);
      expect(inodeAfter.ino).toBe(inodeBefore.ino);
      expect(inodeAfter.dev).toBe(inodeBefore.dev);
    } finally {
      if (holder.exitCode === null) holder.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  });
});
