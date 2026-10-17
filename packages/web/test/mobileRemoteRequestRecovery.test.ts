import { describe, expect, it } from "vitest";
import { createWebRemoteControlRelayRequestRecovery } from "../src/mobile-remote/requestRecovery.js";

describe("createWebRemoteControlRelayRequestRecovery", () => {
  it("shares one relay recovery across concurrent unavailable requests and retries each once", async () => {
    let recoverCount = 0;
    const attemptsByRequest = new Map<string, number>();
    const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(async () => {
      recoverCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const request = async (requestId: string) => {
      const attempts = attemptsByRequest.get(requestId) ?? 0;
      attemptsByRequest.set(requestId, attempts + 1);
      if (attempts === 0) {
        throw { reason: "gateway-unreachable" };
      }
      return requestId;
    };

    await expect(
      Promise.all([
        requestWithRelayRecovery(() => request("one")),
        requestWithRelayRecovery(() => request("two")),
      ]),
    ).resolves.toEqual(["one", "two"]);

    expect(recoverCount).toBe(1);
    expect(attemptsByRequest).toEqual(
      new Map([
        ["one", 2],
        ["two", 2],
      ]),
    );
  });
});
