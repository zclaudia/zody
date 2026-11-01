import { describe, expect, it, vi } from "vitest";
import type { BrowserBackendDescriptor } from "@zcode/shared";
import {
  createBrowserControlRouter,
  type BrowserControlBackend,
} from "../src/host/browserControlRouter.js";

const IAB: BrowserBackendDescriptor = {
  id: "iab-1",
  generation: 1,
  type: "iab",
  name: "IAB",
  capabilities: {},
};
const EXTENSION: BrowserBackendDescriptor = {
  id: "extension:profile-1",
  generation: 4,
  type: "extension",
  name: "Chrome",
  capabilities: {},
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    workspaceKey: "workspace-1",
    workspacePath: "workspace-1",
    clientMode: "desktop-continuous" as const,
    sessionContext: "live" as const,
    ...overrides,
  };
}

function backend(
  descriptor: BrowserBackendDescriptor,
  owns: (browserId: string) => boolean,
): BrowserControlBackend & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({ ok: true, elapsedMs: 0 }));
  return {
    owns,
    list: async () => (descriptor.type === "extension" ? [descriptor] : [descriptor]),
    execute,
  };
}

describe("browser control router", () => {
  it("aggregates IAB and extension discovery", async () => {
    const router = createBrowserControlRouter({
      iab: backend(IAB, (id) => id.startsWith("iab:")),
      extension: backend(EXTENSION, (id) => id.startsWith("extension:")),
    });
    await expect(router.list(context())).resolves.toEqual([IAB, EXTENSION]);
  });

  it("does not expose extension to web-remote-replayable discovery", async () => {
    const router = createBrowserControlRouter({
      iab: backend(IAB, (id) => id.startsWith("iab:")),
      extension: backend(EXTENSION, (id) => id.startsWith("extension:")),
    });
    await expect(router.list(context({ clientMode: "web-remote-replayable" }))).resolves.toEqual([
      IAB,
    ]);
  });

  it("routes explicit browserIds only to their owner and never falls back", async () => {
    const iab = backend(IAB, (id) => id.startsWith("iab:"));
    const extension = backend(EXTENSION, (id) => id.startsWith("extension:"));
    const router = createBrowserControlRouter({ iab, extension });

    await router.execute(
      context({ browserId: EXTENSION.id, browserGeneration: EXTENSION.generation }),
      { method: "list" },
    );
    expect(extension.execute).toHaveBeenCalledOnce();
    expect(iab.execute).not.toHaveBeenCalled();

    const missing = await router.execute(context({ browserId: "cdp:other" }), {
      method: "list",
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    expect(iab.execute).not.toHaveBeenCalled();
  });

  it("keeps legacy browserId-less calls on IAB", async () => {
    const iab = backend(IAB, (id) => id.startsWith("iab:") || id === "legacy-iab");
    const extension = backend(EXTENSION, (id) => id.startsWith("extension:"));
    const router = createBrowserControlRouter({ iab, extension });
    await router.execute(context(), { method: "list" });
    expect(iab.execute).toHaveBeenCalledOnce();
    expect(extension.execute).not.toHaveBeenCalled();
  });
});
