import { describe, expect, it } from "vitest";
import {
  buildCellEnvironment,
  resolveCellLaunch,
  resolveCellSnapshotLaunch,
} from "../src/subprocess-launch.js";
import { CELL_RUN_FLAG } from "../src/cell-protocol.js";

describe("subprocess cell launch", () => {
  it("keeps the ordinary launch unchanged and only adds --jitless on explicit request", () => {
    expect(
      resolveCellLaunch({
        execPath: "/signed/node",
        serverPath: "/sealed/server.mjs",
        sea: false,
      }),
    ).toEqual({
      command: "/signed/node",
      args: ["/sealed/server.mjs", CELL_RUN_FLAG],
    });

    expect(
      resolveCellLaunch({
        execPath: "/signed/node",
        serverPath: "/sealed/server.mjs",
        sea: false,
        jitless: true,
      }),
    ).toEqual({
      command: "/signed/node",
      args: ["--jitless", "/sealed/server.mjs", CELL_RUN_FLAG],
    });
  });

  it("uses the fixed stdin ESM snapshot launch regardless of server path", () => {
    expect(resolveCellSnapshotLaunch({ execPath: "/signed/node" })).toEqual({
      command: "/signed/node",
      args: ["--jitless", "--input-type=module", "-", CELL_RUN_FLAG],
    });
  });

  it("keeps SEA semantics and explicitly rejects jitless composition", () => {
    expect(
      resolveCellLaunch({
        execPath: "/signed/node",
        serverPath: "/sealed/server.mjs",
        sea: true,
      }),
    ).toEqual({
      command: "/signed/node",
      args: ["__zody-plugin-host", "/sealed/server.mjs", CELL_RUN_FLAG],
    });
    expect(() =>
      resolveCellLaunch({
        execPath: "/signed/node",
        serverPath: "/sealed/server.mjs",
        sea: true,
        jitless: true,
      }),
    ).toThrow(/not supported in SEA/);
  });

  it("strips NODE_OPTIONS and ZCODE credentials from the cell environment", () => {
    const env = buildCellEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/Users/test",
        NODE_OPTIONS: "--inspect=127.0.0.1:65531",
        NODE_PATH: "/tmp/node-path",
        ZCODE_CUA_PERMISSION_BROKER_TOKEN: "secret",
        ELECTRON_RUN_AS_NODE: "1",
      },
      "darwin",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("rejects a non-script server path when not running as SEA", () => {
    expect(() =>
      resolveCellLaunch({
        execPath: "/signed/node",
        serverPath: "/sealed/server.txt",
        sea: false,
      }),
    ).toThrow(/built \.js\/\.mjs server bundle/);
  });
});
