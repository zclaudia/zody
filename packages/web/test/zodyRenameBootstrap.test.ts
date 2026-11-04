import { describe, expect, it, vi } from "vitest";
import {
  requireCompatibleServerInfo,
  resolveCompatibleWebBootstrap,
} from "../src/renameCompatibility.js";

describe("Web rename generation bootstrap", () => {
  it.each([undefined, 1, "2", null])("rejects incompatible server info %s", async (generation) => {
    await expect(
      requireCompatibleServerInfo(Response.json({ renameGeneration: generation })),
    ).rejects.toThrow(/incompatible/);
  });
  it("accepts only integer generation 2", async () => {
    await expect(
      requireCompatibleServerInfo(Response.json({ renameGeneration: 2 })),
    ).resolves.toEqual({ renameGeneration: 2 });
  });
  it.each(["", "?remote=remote-1"])(
    "checks no-store info before returning a URL for %s",
    async (search) => {
      const fetchImpl = vi.fn(async () =>
        Response.json({ renameGeneration: 1 }),
      ) as unknown as typeof fetch;
      await expect(
        resolveCompatibleWebBootstrap("ws://example.test", search, fetchImpl),
      ).rejects.toThrow(/incompatible/);
      expect(fetchImpl).toHaveBeenCalledWith("/api/server-info", { cache: "no-store" });
    },
  );
  it("preserves the remoteId URL after checking info", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ renameGeneration: 2 }),
    ) as unknown as typeof fetch;
    await expect(
      resolveCompatibleWebBootstrap("ws://example.test", "?remote=abc", fetchImpl),
    ).resolves.toEqual({ wsUrl: "ws://example.test/ws/remote/abc" });
  });
});
