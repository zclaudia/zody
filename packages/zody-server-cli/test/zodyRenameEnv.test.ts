import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { ServiceCollection } from "@zody/services";
import { createHttpServer } from "../../server/src/http.js";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledAgentWiring } from "../src/runtime/agentWiring.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("renamed agent child wiring", () => {
  it.each([
    ["/synthetic/new", undefined, true],
    [undefined, "/synthetic/old", false],
    ["/synthetic/new", "/synthetic/old", true],
    [undefined, undefined, false],
  ])("honors only the current explicit command", async (current, old, explicit) => {
    const dir = await mkdtemp(join(tmpdir(), "zody-wiring-matrix-"));
    dirs.push(dir);
    await writeFile(join(dir, "zody.cjs"), "// synthetic bundle\n");
    const result = await resolveBundledAgentWiring(dir, {
      ZODY_AGENT_SERVER_COMMAND: current,
      ZCODE_AGENT_SERVER_COMMAND: old,
    });
    if (explicit) expect(result).toBeNull();
    else {
      expect(result).toMatchObject({ ZODY_AGENT_SERVER_COMMAND: process.execPath });
      expect(
        JSON.parse((result as unknown as Record<string, string>).ZODY_AGENT_SERVER_ARGS_JSON!),
      ).toEqual([join(dir, "zody.cjs"), "app-server", "--stdio"]);
    }
  });
});

describe("HTTP entry authentication environment", () => {
  it.each([
    ["synthetic-new-token", undefined, true],
    [undefined, "synthetic-old-token", false],
    ["synthetic-new-token", "synthetic-old-token", true],
    [undefined, undefined, false],
  ])("selects the active token at startup", async (current, old, required) => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.stubEnv("ZODY_SERVER_AUTH_TOKEN", current);
    vi.stubEnv("ZCODE_SERVER_AUTH_TOKEN", old);
    const createServer = vi.fn((..._args: unknown[]) => undefined);
    vi.doMock("@zody/services/node", () => ({
      createLocalServices: () => ({}),
      getAppConfigDir: () => "/synthetic",
    }));
    vi.doMock("../../server/src/bundledZodyBuiltinProviderConfig.js", () => ({
      materializeBundledZodyBuiltinProviderConfig: async () => "/synthetic/provider",
      readBundledZodyBuiltinProviderConfig: () => "{}",
    }));
    vi.doMock("../../server/src/http.js", () => ({ createHttpServer: createServer }));
    try {
      await import("../../server/src/entry-http.js");
      await vi.waitFor(() => expect(createServer).toHaveBeenCalledOnce());
      const options = createServer.mock.calls[0]![2] as {
        authToken?: string;
        authRequired?: boolean;
      };
      expect(Boolean(options.authRequired)).toBe(required);
      expect(options.authToken).toBe(required ? "synthetic-new-token" : undefined);
      const server = createHttpServer(new ServiceCollection(), 0, options);
      try {
        if (!server.listening) await once(server, "listening");
        const address = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${address.port}/api/server-info`;
        expect((await fetch(url)).status).toBe(required ? 401 : 200);
        if (required) {
          expect((await fetch(`${url}?token=synthetic-old-token`)).status).toBe(401);
          expect((await fetch(`${url}?token=synthetic-new-token`)).status).toBe(200);
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      vi.doUnmock("@zody/services/node");
      vi.doUnmock("../../server/src/bundledZodyBuiltinProviderConfig.js");
      vi.doUnmock("../../server/src/http.js");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
