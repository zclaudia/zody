import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolvedRemoteSessionIdMock } = vi.hoisted(() => ({
  resolvedRemoteSessionIdMock: vi.fn<() => string | null>(),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    title,
    description,
    side,
  }: {
    children: unknown;
    title: string;
    description?: string;
    side?: string;
  }) =>
    createElement(
      "span",
      {
        "data-tooltip-title": title,
        "data-tooltip-description": description ?? "",
        "data-tooltip-side": side ?? "",
      },
      children,
    ),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/lucide.js", () => ({
  Smartphone: () => createElement("span", { "data-testid": "smartphone-icon" }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: resolvedRemoteSessionIdMock,
}));

vi.mock("@/hooks/useRemoteAccessStatus.js", () => ({
  useRemoteAccessStatus: () => ({ status: null, loading: false, refresh: async () => {} }),
}));

async function renderTriggerWithEnv(
  env: "test" | "production",
  options?: {
    featureEnabled?: boolean;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  },
) {
  vi.resetModules();
  vi.doMock("@zody/shared", () => ({ ZCODE_ENV: env }));

  const { WorkspaceWebRemoteControlTrigger } =
    await import("../src/WorkspaceWebRemoteControlTrigger.js");
  const { WebRemoteControlFeatureProvider } =
    await import("../src/WebRemoteControlFeatureProvider.js");

  const trigger = createElement(WorkspaceWebRemoteControlTrigger, {
    workspacePath: "/tmp/project",
    workspaceIdentity: options?.workspaceIdentity,
    remoteSessionId: options?.remoteSessionId,
  });

  return renderToStaticMarkup(
    typeof options?.featureEnabled === "boolean"
      ? createElement(WebRemoteControlFeatureProvider, { enabled: options.featureEnabled }, trigger)
      : trigger,
  );
}

afterEach(() => {
  resolvedRemoteSessionIdMock.mockReset();
  vi.resetModules();
});

describe("WorkspaceWebRemoteControlTrigger", () => {
  it("在 test 环境展示 Web 远程控制入口", async () => {
    const html = await renderTriggerWithEnv("test");

    expect(html).toContain("webRemoteControl.trigger");
  });

  it("在 production 环境展示 Web 远程控制入口", async () => {
    const html = await renderTriggerWithEnv("production");

    expect(html).toContain("webRemoteControl.trigger");
  });

  it("允许 root wiring 显式注入 Web 远程控制入口能力", async () => {
    const html = await renderTriggerWithEnv("production", {
      featureEnabled: true,
    });

    expect(html).toContain("webRemoteControl.trigger");
  });

  it("把入口名称和手机连接状态合并到同一个 tooltip", async () => {
    const html = await renderTriggerWithEnv("test");

    expect(html).toContain('data-tooltip-title="webRemoteControl.trigger"');
    expect(html).toContain('data-tooltip-description="webRemoteControl.triggerStatus.idle"');
    expect(html).not.toContain('data-tooltip-title="webRemoteControl.triggerStatus.idle"');
  });

  it("在按钮上方展示远程控制 tooltip", async () => {
    const html = await renderTriggerWithEnv("test");

    expect(html).toContain('data-tooltip-side="top"');
  });
});
