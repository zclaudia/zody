import { describe, expect, it, vi } from "vitest";

import type { HelperHealth } from "@zody/zody-cua/broker";

import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { WindowsCuaHelperHost } from "../src/cua-permission-broker/windowsCuaDevHelperHost.js";
import {
  CONTROL_PROTOCOL,
  GHOST_CURSOR_OVERLAY_ARG,
  type WindowsCuaChild,
  type WindowsCuaChildProcessAdapter,
} from "../src/cua-permission-broker/windowsCuaHelperHostSupport.js";

// F12（上游 v3.17.1，a60ba6a7）：Windows 产品链 fork argv 末位必须恒开
// --ghost-cursor-overlay，对齐 macOS；漏传时 helper 侧 OverlayEnabled() 恒 false、
// agent 光标完全不渲染。本用例走真实 startGeneration 路径断言 argv，不 spawn 真实进程。
const SOCKET_PATH = "zcode-cua-broker-ghost-overlay-test.sock";
const HELPER_PID = 4242;

class FakeHelperChild implements WindowsCuaChild {
  readonly pid = HELPER_PID;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  killed = false;

  send(message: unknown): boolean {
    // 模拟 helper 收到 shutdown 控制消息后退出；sendShutdown 之后 terminate 的
    // first-wait 依赖 exit 事件收口，避免用 1s 超时掩盖同步语义。
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "shutdown"
    ) {
      queueMicrotask(() => this.emit("exit", 0));
    }
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  on(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: "message" | "exit", ...args: unknown[]): void {
    // 迭代快照，避免 listener 回调中增删监听影响本轮分发。
    const listeners = Array.from(this.listeners.get(event) ?? []);
    for (const listener of listeners) listener(...args);
  }
}

interface CapturingFork {
  adapter: WindowsCuaChildProcessAdapter;
  argvCalls: string[][];
}

function createCapturingFork(): CapturingFork {
  const argvCalls: string[][] = [];
  const adapter: WindowsCuaChildProcessAdapter = {
    fork(_command, argv, _options) {
      argvCalls.push([...argv]);
      const child = new FakeHelperChild();
      // fork 异步回报 ready 控制消息（socket/pid 与 host 铸造值一致）。
      queueMicrotask(() => {
        child.emit("message", {
          protocol: CONTROL_PROTOCOL,
          type: "ready",
          socketPath: SOCKET_PATH,
          pid: HELPER_PID,
        });
      });
      return child;
    },
  };
  return { adapter, argvCalls };
}

function createHost(capturingFork: CapturingFork): WindowsCuaHelperHost {
  const logger: ServiceLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return new WindowsCuaHelperHost({
    runtime: {
      root: "C:\\cua-helper",
      entryPath: "C:\\cua-helper\\entry.js",
      addonPath: "C:\\cua-helper\\ax_native.node",
      command: "node",
      commandEnv: {},
    },
    childProcess: capturingFork.adapter,
    mintSocketPath: () => SOCKET_PATH,
    healthProbe: async (): Promise<HelperHealth> => ({
      bundleId: "dev.zcode.cua-helper.test",
      pid: HELPER_PID,
    }),
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 5_000,
    logger,
  });
}

describe("WindowsCuaHelperHost ghost cursor overlay argv (F12)", () => {
  it("forks the helper with --ghost-cursor-overlay as the trailing argv", async () => {
    const capturingFork = createCapturingFork();
    const host = createHost(capturingFork);
    const handle = await host.start();
    try {
      expect(handle.socketPath).toBe(SOCKET_PATH);
      expect(capturingFork.argvCalls).toHaveLength(1);
      const argv = capturingFork.argvCalls[0];
      // 末位恒开 overlay：helper 侧按 argv 出现与否决定 OverlayEnabled()。
      expect(argv[argv.length - 1]).toBe(GHOST_CURSOR_OVERLAY_ARG);
      expect(argv[argv.length - 1]).toBe("--ghost-cursor-overlay");
      expect(argv).toEqual([
        "C:\\cua-helper\\entry.js",
        "--socket",
        SOCKET_PATH,
        "--parent-pid",
        String(process.pid),
        "--ghost-cursor-overlay",
      ]);
    } finally {
      await host.stop();
    }
  });
});
