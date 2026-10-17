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
  it("uses success styling when a phone is connected", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ status: { status: "active", mobileConnected: true } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-success");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.connected");
  });

  it("uses warning styling while the gateway is connected but no phone has joined", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ gateway: { state: "online", backendId: "backend-1", epoch: 1 } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-warning");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.waiting");
  });

  it("uses warning styling while the gateway is connecting", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ gateway: { state: "connecting" } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-warning");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.starting");
  });

  it("uses destructive styling when the gateway connection failed", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ gateway: { state: "error", reason: "credential-invalid" } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-destructive");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.error");
  });

  it("shows the idle state when remote access is disabled", () => {
    const presentation = getRemoteAccessTriggerPresentation(
      makeStatus({ enabled: false, gateway: { state: "disabled" } }),
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-foreground-subtle");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.idle");
  });

  it("shows the idle state before the first status arrives", () => {
    const presentation = getRemoteAccessTriggerPresentation(null, formatMessage);

    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.idle");
  });
});
