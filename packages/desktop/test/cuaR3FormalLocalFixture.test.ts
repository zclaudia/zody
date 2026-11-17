import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertFormalFixtureOnscreen } from "./e2e/helpers/cua-r3-formal-local.js";

describe("formal local SDK fixture never replays the one write", () => {
  async function execute(failWrite: boolean) {
    const fixture = JSON.parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "e2e/fixtures/upstream/conversation-session/conversation-session-cua-r3-formal-local.json",
        ),
        "utf8",
      ),
    );
    const code = fixture.fixtures.find(
      (r: { response: { toolUse?: unknown } }) => r.response.toolUse,
    ).response.toolUse.input.code as string;
    const f = {
      pid: 100,
      targetWindow: 200,
      targetMarker: "E2E_R2_TARGET_BODY",
      siblingMarker: "E2E_R2_SIBLING_BODY",
    };
    let reads = 0,
      writes = 0,
      images = 0;
    const computer = {
      get_app_state: async (options: { include_screenshot?: boolean }) => {
        reads++;
        if (!options.include_screenshot)
          return [
            f.targetMarker,
            JSON.stringify({ title: "R2 Press", index: 1, actions: ["AXPress"] }),
          ].join("\n");
        return {
          content: [
            { type: "image", mimeType: "image/png", data: "offline-only" },
            { type: "text", text: f.targetMarker },
          ],
          structuredContent: {
            state_id: "2",
            app: { pid: f.pid },
            window: { window_id: f.targetWindow },
            elements: [{ title: f.targetMarker }],
          },
        };
      },
      left_click: async (options: { return_state: string }) => {
        writes++;
        expect(options.return_state).toBe("none");
        if (failWrite) throw new Error("possibly_sent");
        return { action_sent: true, dispatch_status: "sent", state_sync_status: "not_requested" };
      },
    };
    const loadModule = async (name: string) => {
      if (name === "node:path" || name === "node:url") return import(name);
      if (name === "node:fs/promises") return { readFile: async () => JSON.stringify(f) };
      if (name.endsWith("/scripts/computer-use-client.mjs"))
        return { setupComputerUseRuntime: async () => undefined };
      throw new Error("Unexpected offline fixture import");
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction(
      "loadModule",
      "process",
      "agent",
      "nodeRepl",
      code.replace(/\bimport\s*\(/g, "loadModule("),
    );
    const outcome = run(
      loadModule,
      { env: { ZODY_CUA_PLUGIN_ROOT: "/offline-sdk" } },
      { computerUse: { computer } },
      {
        emitImage: async () => {
          images++;
        },
        write: () => undefined,
      },
    );
    if (failWrite) await expect(outcome).rejects.toThrow("possibly_sent");
    else await outcome;
    return { reads, writes, images };
  }
  it("has exactly one none write and one screenshot composition", async () =>
    expect(await execute(false)).toEqual({ reads: 2, writes: 1, images: 1 }));
  it("stops immediately on an uncertain write without screenshot or retry", async () =>
    expect(await execute(true)).toEqual({ reads: 1, writes: 1, images: 0 }));
});

describe("formal fixture visibility before SDK", () => {
  const target = { pid: 100, targetWindow: 200, siblingWindow: 201 };
  const visible = [200, 201].map((id) => ({ id, pid: 100, layer: 0, onscreen: true }));
  it("admits both exact visible layer-zero fixture windows", () =>
    expect(() => assertFormalFixtureOnscreen(visible, target)).not.toThrow());
  it("rejects OptionAll rows that exist but are offscreen", () =>
    expect(() =>
      assertFormalFixtureOnscreen(
        visible.map((r) => ({ ...r, onscreen: null })),
        target,
      ),
    ).toThrow("not onscreen"));
  it("rejects a missing sibling rather than reusing its stale ID", () =>
    expect(() => assertFormalFixtureOnscreen(visible.slice(0, 1), target)).toThrow("not onscreen"));
});
