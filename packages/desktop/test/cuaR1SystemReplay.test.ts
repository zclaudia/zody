import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isSystemFaultRefusal } from "./e2e/helpers/cua-r1-system-state.js";

describe("R1 system probe result classification (synthetic unit evidence only)", () => {
  it("finishes the sleep fault cell after its actual reply without holding a tool across human recovery", async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(
          "packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-cua-r1-system-state.json",
        ),
        "utf8",
      ),
    );
    const code = fixture.fixtures.find((item: { id: string }) => item.id === "r1-system-sleep")
      .response.toolUse.input.code as string;
    let reads = 0;
    const saved: Array<Record<string, unknown>> = [];
    const pending = runInNewContext(
      `(async () => { ${code.slice(code.indexOf("const phase='sleep';"))} })()`,
      {
        control: async (name: string) => (name === "ack-sleep-0.json" ? { continue: true } : null),
        agent: {
          computerUse: {
            computer: {
              get_app_state: async () =>
                ++reads === 1
                  ? "AX window state TARGET"
                  : {
                      code: "element_unavailable",
                      message: "Computer use observation failed",
                      action_sent: false,
                      dispatch_status: "not_sent",
                    },
            },
          },
        },
        f: { pid: 1, targetWindow: 2, targetMarker: "TARGET", siblingMarker: "SIBLING" },
        directory: "/controlled",
        join: (...parts: string[]) => parts.join("/"),
        writeFile: async (_path: string, text: string) => {
          saved.push(JSON.parse(text));
        },
        rename: async () => {},
        nodeRepl: { write: () => {} },
        pause: async () => {},
      },
    );
    await expect(pending).resolves.toBeUndefined();
    expect(reads).toBe(2);
    expect(saved.at(-1)).toMatchObject({
      index: 1,
      error: true,
      mode: "returned-error",
      targetSeen: false,
      siblingSeen: false,
    });
  });
  it("requires an observed system fault and currently unavailable guard for a zero-body refusal", () => {
    const result = {
      received: true,
      error: true,
      mode: "returned-error",
      method: "get_app_state",
      actionSent: false,
      dispatchStatus: "not_sent",
      brokerCode: "element_unavailable",
      targetSeen: false,
      siblingSeen: false,
    };
    expect(isSystemFaultRefusal(result, "locked", true)).toBe(true);
    expect(isSystemFaultRefusal(result, "unknown", true)).toBe(true);
    expect(isSystemFaultRefusal(result, "allowed", true)).toBe(false);
    expect(isSystemFaultRefusal(result, "unknown", false)).toBe(false);
    expect(isSystemFaultRefusal({ ...result, targetSeen: true }, "locked", true)).toBe(false);
    expect(isSystemFaultRefusal({ ...result, siblingSeen: true }, "locked", true)).toBe(false);
    expect(isSystemFaultRefusal({ ...result, actionSent: true }, "locked", true)).toBe(false);
    expect(isSystemFaultRefusal({ ...result, received: false }, "locked", true)).toBe(false);
  });
  it("recognizes the raw API's returned native error without inventing a thrown SDK error", async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(
          "packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-cua-r1-system-state.json",
        ),
        "utf8",
      ),
    );
    const code = fixture.fixtures.find(
      (item: { response: { toolUse?: unknown } }) => item.response.toolUse,
    ).response.toolUse.input.code as string;
    const begin = code.indexOf("const text=typeof value");
    const end = code.indexOf("}catch(error)", begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const parse = (value: unknown) =>
      runInNewContext(`let result; ${code.slice(begin, end)}; result;`, {
        value,
        f: { targetMarker: "TARGET", siblingMarker: "SIBLING" },
      }) as Record<string, unknown>;
    const native = {
      code: "element_unavailable",
      message: "Read-only observation failed",
      action_sent: false,
      dispatch_status: "not_sent",
    };
    const publicError = { ...native, message: "Computer use observation failed" };
    for (const value of [
      native,
      JSON.stringify(native),
      publicError,
      JSON.stringify(publicError),
    ]) {
      const result = parse(value);
      expect(result.error).toBe(true);
      expect(result.mode).toBe("returned-error");
      expect(result.nativeError).toEqual(typeof value === "string" ? JSON.parse(value) : value);
      expect(result.targetSeen).toBe(false);
      expect(result.siblingSeen).toBe(false);
    }
    expect(parse("AX window state TARGET")).toMatchObject({
      error: false,
      full: true,
      targetSeen: true,
      siblingSeen: false,
    });
    expect(parse({ ...native, message: "SIBLING" }).mode).not.toBe("returned-error");
    expect(parse({ ...native, extra: "SIBLING" }).mode).not.toBe("returned-error");
    expect(parse({ ...native, action_sent: true }).mode).not.toBe("returned-error");
  });
});
