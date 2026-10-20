import { describe, expect, it } from "vitest";
import type { RemoteAccessStatus } from "@zcode/shared";
import { getRemoteAccessTriggerPresentation } from "@/WorkspaceWebRemoteControlTrigger.js";

const formatMessage = ({ id }: { id: string }) => id;

function makeStatus(overrides: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus {
  return {
    enabled: true,
    status: { status: "running" },
    gateway: { state: "online", backendId: "backend-1", epoch: 1 },
    ...overrides,
  };
}

describe("getRemoteAccessTriggerPresentation", () => {
  it("gateway online 且手机已连接时高亮，tooltip 说明已连接", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ status: { status: "active", mobileConnected: true } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toBe("text-success");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.connected");
  });

  it("gateway online 但还没有手机时同样高亮，tooltip 说明等待手机", () => {
    const presentation = getRemoteAccessTriggerPresentation(makeStatus(), formatMessage);

    expect(presentation.iconClassName).toBe("text-success");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.waiting");
  });

  it("gateway 连接中置灰", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ gateway: { state: "connecting" } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toBe("text-foreground-subtle");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.starting");
  });

  it.each(["unconfigured", "credential-invalid", "unreachable", "replaced"] as const)(
    "gateway 出错（%s）时置灰而不是报警色",
    (reason) => {
      const presentation = getRemoteAccessTriggerPresentation(
        makeStatus({ gateway: { state: "error", reason } }),
        formatMessage,
      );

      expect(presentation.iconClassName).toBe("text-foreground-subtle");
      expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.error");
    },
  );

  it("开关关闭时置灰，即使 gateway 状态残留 online", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ enabled: false, gateway: { state: "online", backendId: "b", epoch: 1 } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toBe("text-foreground-subtle");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.idle");
  });

  it("首个状态返回前按关闭处理", () => {
    const presentation = getRemoteAccessTriggerPresentation(null, formatMessage);

    expect(presentation.iconClassName).toBe("text-foreground-subtle");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.idle");
  });
});
