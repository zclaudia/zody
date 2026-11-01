import { describe, expect, it } from "vitest";
import { CdpTargetSessionMap } from "../src/browser-core/cdpTargetSessionMap.js";

describe("CdpTargetSessionMap", () => {
  it("maps child targetIds to stable Host sessionIds and never exposes sessionId on the wire", () => {
    const map = new CdpTargetSessionMap(() => "session-1");
    expect(map.resolveSessionId("attachment-a", "target-a")).toBe("session-1");
    expect(map.resolveSessionId("attachment-a", "target-a")).toBe("session-1");
    expect(map.resolveTargetId("session-1", "attachment-a")).toBe("target-a");
    // 同一 targetId 在其它 attachment 下不是同一个绑定。
    expect(map.resolveTargetId("session-1", "attachment-b")).toBeUndefined();
  });

  it("removes only the detached child target mapping", () => {
    let index = 0;
    const map = new CdpTargetSessionMap(() => `session-${++index}`);
    map.resolveSessionId("attachment-a", "target-a");
    map.resolveSessionId("attachment-a", "target-b");
    map.removeTarget("attachment-a", "target-a");
    expect(map.resolveTargetId("session-1", "attachment-a")).toBeUndefined();
    expect(map.resolveTargetId("session-2", "attachment-a")).toBe("target-b");
  });

  it("drops every child mapping when the attachment is invalidated", () => {
    let index = 0;
    const map = new CdpTargetSessionMap(() => `session-${++index}`);
    map.resolveSessionId("attachment-a", "target-a");
    map.resolveSessionId("attachment-a", "target-b");
    map.resolveSessionId("attachment-b", "target-c");
    map.removeAttachment("attachment-a");
    expect(map.size).toBe(1);
    expect(map.resolveTargetId("session-3", "attachment-b")).toBe("target-c");
  });
});
