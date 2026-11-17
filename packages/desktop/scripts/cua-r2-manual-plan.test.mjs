import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const path = new URL(
  "../test/e2e/fixtures/upstream/conversation-session/conversation-session-cua-r2-control.json",
  import.meta.url,
);
const fixture = JSON.parse(await readFile(path, "utf8"));
const calls = fixture.fixtures.filter((row) => row.response.toolUse);
const methods = ["left_click", "perform_action", "set_value"];
const modes = ["none", "compact", "full"];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("manual round contains exactly nine SDK calls and ends each chain at trial 2", () => {
  assert.equal(calls.length, 9);
  assert(!fixture.fixtures.some((row) => row.id.includes("deny")));
  for (const method of methods) {
    const rows = calls.filter((row) => row.id.startsWith(`cua-r2-${method}-call-`));
    assert.deepEqual(
      rows.map((row) => row.id),
      modes.map((_, i) => `cua-r2-${method}-call-${i}`),
    );
    const final = fixture.fixtures.find((row) => row.id === `cua-r2-${method}-final`);
    assert(final.match.bodyIncludes.includes(`toolu_cua_r2_${method}_2`));
  }
});

test("actual fixture cells execute none/compact/full once and reject missing return state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zody-r2-manual-plan-"));
  const previous = globalThis.agent;
  const previousMock = globalThis.__r2MockAgent;
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "cua-r2"));
    await writeFile(
      join(directory, "scripts/computer-use-client.mjs"),
      "export async function setupComputerUseRuntime({globals}) { globals.agent=globalThis.__r2MockAgent; }",
    );
    const manifest = { pid: 123, targetWindow: 456, siblingMarker: "E2E_SIBLING" };
    await writeFile(join(directory, "cua-r2/manifest.json"), JSON.stringify(manifest));
    for (const method of methods) {
      const observed = [];
      let omitState = false;
      const computer = {
        async get_app_state() {
          return JSON.stringify({
            index: 1,
            kind: "AXTextField",
            title: "R2 Press",
            actions: ["AXPress"],
          });
        },
        async [method](args) {
          observed.push(args);
          return {
            content: [
              {
                text: JSON.stringify({
                  action_sent: true,
                  dispatch_status: "sent",
                  state_sync_status: args.return_state === "none" ? "not_requested" : "synced",
                }),
              },
            ],
            ...(args.return_state !== "none" && !omitState
              ? {
                  structuredContent: {
                    state_id: "mock-state",
                    app: { pid: 123 },
                    window: { window_id: 456 },
                  },
                }
              : {}),
          };
        },
      };
      globalThis.__r2MockAgent = { computerUse: { computer } };
      const rows = calls.filter((row) => row.id.startsWith(`cua-r2-${method}-call-`));
      for (const [trial, row] of rows.entries()) {
        const code = row.response.toolUse.input.code.replaceAll("{{e2eRuntimeRoot}}", directory);
        const output = [];
        const run = () =>
          new AsyncFunction("process", "nodeRepl", code)(
            { env: { ZODY_CUA_PLUGIN_ROOT: directory } },
            { write: (value) => output.push(value) },
          );
        await run();
        assert.equal(observed.at(-1).return_state, modes[trial]);
        assert.deepEqual(observed.at(-1).app_ref, { pid: 123, window_id: 456 });
        assert.equal(observed.at(-1).target.index, 1);
        if (method === "set_value") assert.equal(observed.at(-1).value, `E2E_R2_VALUE_${trial}`);
        if (method === "perform_action") assert.equal(observed.at(-1).action, "AXPress");
        const payload = JSON.parse(output[0].slice("R2_RECEIPTS:".length));
        assert.equal(payload.kind, method);
        assert.equal(payload.trial, trial);
        assert.equal(payload.return_state, modes[trial]);
        if (trial > 0) {
          omitState = true;
          await assert.rejects(run, /R2_RETURN_STATE_MISSING/);
          omitState = false;
        }
      }
    }
  } finally {
    globalThis.agent = previous;
    globalThis.__r2MockAgent = previousMock;
    await rm(directory, { recursive: true, force: true });
  }
});
