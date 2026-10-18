import { describe, expect, it } from "vitest";

describe("app launch coordinator", () => {
  it("首个 renderer ready 立即消费启动 gate", async () => {
    const { createAppLaunchCoordinator } = await import("../src/main/appLaunchCoordinator.js");
    const gate = {
      consumeCalls: 0,
      consume() {
        this.consumeCalls += 1;
        return true;
      },
    };

    const coordinator = createAppLaunchCoordinator(gate);

    expect(coordinator.onRendererReady({ rendererId: 1 })).toBe(true);
    expect(gate.consumeCalls).toBe(1);
  });

  it("gate 已消费后其它 renderer ready 不重复上报启动", async () => {
    const { createAppLaunchCoordinator } = await import("../src/main/appLaunchCoordinator.js");
    const gate = {
      consumed: false,
      consume() {
        if (this.consumed) {
          return false;
        }
        this.consumed = true;
        return true;
      },
    };

    const coordinator = createAppLaunchCoordinator(gate);

    expect(coordinator.onRendererReady({ rendererId: 1 })).toBe(true);
    expect(coordinator.onRendererReady({ rendererId: 2 })).toBe(false);
  });
});
