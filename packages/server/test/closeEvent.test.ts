import { describe, expect, it } from "vitest";
import { createCloseEventController, resolveRemoteExitCode } from "../src/remote/closeEvent.js";

describe("close event controller", () => {
  it("先订阅后 fire 时应收到 close code", async () => {
    const controller = createCloseEventController();
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
      controller.fire(17);
    });
    expect(code).toBe(17);
  });

  it("先 fire 后订阅时应补发 close code", async () => {
    const controller = createCloseEventController();
    controller.fire(0);
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
    });
    expect(code).toBe(0);
  });

  it("只应 fire 一次，后续 fire 不覆盖首次结果", async () => {
    const controller = createCloseEventController();
    controller.fire(1);
    controller.fire(2);
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
    });
    expect(code).toBe(1);
  });
});

describe("resolveRemoteExitCode", () => {
  it("有真实退出码时应原样透传，不得用默认值掩盖", () => {
    expect(resolveRemoteExitCode(0, undefined)).toBe(0);
    expect(resolveRemoteExitCode(7, undefined)).toBe(7);
    // exit 已给出 status 时 signal 只是伴随信息，status 优先。
    expect(resolveRemoteExitCode(7, "SIGTERM")).toBe(7);
  });

  it("进程被信号杀死（code 为 null）时应按 shell 惯例返回 128+信号值", () => {
    expect(resolveRemoteExitCode(null, "SIGKILL")).toBe(137);
    expect(resolveRemoteExitCode(null, "SIGTERM")).toBe(143);
    expect(resolveRemoteExitCode(undefined, "SIGKILL")).toBe(137);
  });

  it("完全没有退出信息时应返回 255 而不是当作成功 0", () => {
    expect(resolveRemoteExitCode(null, undefined)).toBe(255);
    expect(resolveRemoteExitCode(undefined, undefined)).toBe(255);
    // 未知名目的信号同样没有可用退出码。
    expect(resolveRemoteExitCode(null, "NOT-A-REAL-SIGNAL")).toBe(255);
  });
});
