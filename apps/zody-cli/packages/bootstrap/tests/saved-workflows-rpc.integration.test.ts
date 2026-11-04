import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { promises as fsPromises } from "node:fs";
import { ZodyProtocolAgentServer } from "../src/zody-protocol/server.js";
import { ZodyProtocolNdjsonConnection } from "../src/zody-protocol/transport.js";

describe("saved workflow real NDJSON protocol", () => {
  it("surfaces real publication race through NDJSON and preserves competitor bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zody-workflow-rpc-race-"));
    const legacy = join(cwd, ".zcode", "workflows", "race.dwf.ts"),
      canonical = join(cwd, ".zody", "workflows", "race.dwf.ts");
    const old = "/* zcode-workflow\ndescription: old\n*/\nreturn 42;\n";
    const input = new PassThrough(),
      output = new PassThrough();
    let written = "";
    output.on("data", (data: Buffer) => {
      written += data.toString("utf8");
    });
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await mkdir(join(cwd, ".zcode", "workflows"), { recursive: true });
      await writeFile(legacy, old);
      const actualLink = fsPromises.link;
      spy = vi.spyOn(fsPromises, "link").mockImplementationOnce(async (stage, target) => {
        await writeFile(target, "competitor", { flag: "wx" });
        await actualLink(stage, target);
      });
      const server = new ZodyProtocolAgentServer({
        cwd,
        version: "test",
        createZodyApp: () => {
          throw new Error("unexpected runtime");
        },
      });
      const connection = new ZodyProtocolNdjsonConnection({
        input,
        output,
        handleMessage: (message) => server.handleMessage(message),
      });
      connection.start();
      input.end(
        JSON.stringify({
          id: 1,
          method: "workflows/updateMeta",
          params: {
            workspace: { workspacePath: cwd, workspaceKey: cwd },
            name: "race",
            meta: { description: "new" },
          },
        }) + "\n",
      );
      await connection.waitForClose();
      expect(JSON.parse(written.trim())).toMatchObject({ id: 1, error: expect.any(Object) });
      expect(await readFile(canonical, "utf8")).toBe("competitor");
      expect(await readFile(legacy, "utf8")).toBe(old);
      expect(
        (await fsPromises.readdir(join(cwd, ".zody", "workflows"))).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);
    } finally {
      spy?.mockRestore();
      input.destroy();
      output.destroy();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("updates a legacy source to canonical and gets/lists it without rewriting history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zody-workflow-rpc-"));
    const legacy = join(cwd, ".zcode", "workflows", "review.dwf.ts");
    const canonical = join(cwd, ".zody", "workflows", "review.dwf.ts");
    const old = "/* zcode-workflow\ndescription: old\n*/\nreturn 42;\n";
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const previousHome = process.env.HOME,
      previousProfile = process.env.USERPROFILE;
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    const input = new PassThrough(),
      output = new PassThrough();
    let written = "";
    output.on("data", (data: Buffer) => {
      written += data.toString("utf8");
    });
    try {
      await mkdir(join(cwd, ".zcode", "workflows"), { recursive: true });
      await writeFile(legacy, old);
      const server = new ZodyProtocolAgentServer({
        cwd,
        version: "test",
        createZodyApp: () => {
          throw new Error("unexpected runtime");
        },
      });
      const connection = new ZodyProtocolNdjsonConnection({
        input,
        output,
        handleMessage: (message) => server.handleMessage(message),
      });
      connection.start();
      const workspace = { workspacePath: cwd, workspaceKey: cwd };
      input.end(
        [
          {
            id: 1,
            method: "workflows/updateMeta",
            params: { workspace, name: "review", meta: { description: "new" } },
          },
          { id: 2, method: "workflows/get", params: { workspace, name: "review" } },
          { id: 3, method: "workflows/list", params: { workspace } },
        ]
          .map((request) => JSON.stringify(request))
          .join("\n") + "\n",
      );
      await connection.waitForClose();
      const responses = written
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
      expect(responses[0].result).toEqual({ ok: true, path: canonical });
      expect(responses[1].result).toMatchObject({
        ok: true,
        path: canonical,
        meta: { description: "new" },
        script: "return 42;\n",
      });
      expect(JSON.stringify(responses[2].result)).toContain(canonical);
      expect(await readFile(canonical, "utf8")).toContain("/* zody-workflow\n");
      expect(sha(await readFile(legacy, "utf8"))).toBe(sha(old));
    } finally {
      input.destroy();
      output.destroy();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
