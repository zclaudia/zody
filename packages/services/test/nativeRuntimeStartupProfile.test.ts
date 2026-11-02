import { describe, expect, it } from "vitest";
import {
  createZCodeAgentNativeRuntimeStartupContext,
  digestZCodeAgentNativeRuntimeNetwork,
  digestZCodeAgentNativeRuntimeProviderSnapshot,
  normalizeZCodeAgentNativeRuntimeNetwork,
  projectZCodeAgentNativeRuntimeProviderSnapshot,
} from "../src/zcode-agent/nativeRuntimeStartupProfile.js";

function providerView(
  revision = 7,
  modelEnabled = true,
  accessType: "api-key" | "zhipu-account" = "api-key",
  mode = "individual-coding-plan",
  apiKey = "must-not-be-in-snapshot",
) {
  return {
    revision,
    providerTemplates: [],
    providerOrder: ["deepseek-anthropic"],
    providers: [
      {
        providerId: "deepseek-anthropic",
        providerName: "DeepSeek",
        templateId: "anthropic",
        enabled: true,
        executable: true,
        effectiveConfig: {
          group: "standard-personal",
          visibility: "visible",
          access:
            accessType === "api-key"
              ? { type: "api-key", apiKey }
              : { type: "zhipu-account", accountType: "zai", mode, entitled: true },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://api.example.test",
            headers: { Authorization: "Bearer must-not-be-in-snapshot" },
          },
          builtinModelIds: ["deepseek-v3.2"],
          personalModelIds: [],
          modelOrder: ["deepseek-v3.2"],
        },
        effectiveBuiltinConfig: { access: { apiKey: "also-secret" } },
        personalConfig: { access: { apiKey: "also-secret" } },
        issues: [],
        models: [
          {
            kind: "candidate",
            modelId: "deepseek-v3.2",
            builtin: true,
            enabled: modelEnabled,
            executable: true,
            selectable: true,
            issues: [],
            effectiveBuiltinConfig: { enabled: true },
            effectiveConfig: {
              enabled: modelEnabled,
              properties: { contextWindow: 128000 },
              optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
            },
          },
        ],
      },
    ],
  } as const;
}

describe("native runtime startup profile", () => {
  it("uses a content digest instead of an instance registry revision", () => {
    const first = projectZCodeAgentNativeRuntimeProviderSnapshot(providerView(1));
    const second = projectZCodeAgentNativeRuntimeProviderSnapshot(providerView(999));
    expect(first).toEqual(second);
    expect(digestZCodeAgentNativeRuntimeProviderSnapshot(providerView(1))).toBe(
      digestZCodeAgentNativeRuntimeProviderSnapshot(providerView(999)),
    );
  });

  it("excludes credentials, headers, and other non-snapshot fields", () => {
    const snapshot = projectZCodeAgentNativeRuntimeProviderSnapshot(providerView());
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("must-not-be-in-snapshot");
    expect(serialized).not.toContain("also-secret");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("must-not-be-in-snapshot");
    expect(serialized).toContain('"access":{"type":"api-key"}');
    expect(serialized).toContain("https://api.example.test");
    expect(digestZCodeAgentNativeRuntimeProviderSnapshot(providerView(1, false))).not.toBe(
      digestZCodeAgentNativeRuntimeProviderSnapshot(providerView(1, true)),
    );
  });

  it("keeps credential rotation stable but changes on runtime auth mode", () => {
    expect(
      digestZCodeAgentNativeRuntimeProviderSnapshot(
        providerView(7, true, "api-key", undefined, "old-key"),
      ),
    ).toBe(
      digestZCodeAgentNativeRuntimeProviderSnapshot(
        providerView(8, true, "api-key", undefined, "rotated-key"),
      ),
    );
    expect(
      digestZCodeAgentNativeRuntimeProviderSnapshot(providerView(7, true, "api-key")),
    ).not.toBe(
      digestZCodeAgentNativeRuntimeProviderSnapshot(
        providerView(7, true, "zhipu-account", "individual-coding-plan"),
      ),
    );
    expect(
      digestZCodeAgentNativeRuntimeProviderSnapshot(
        providerView(7, true, "zhipu-account", "individual-coding-plan"),
      ),
    ).not.toBe(
      digestZCodeAgentNativeRuntimeProviderSnapshot(
        providerView(7, true, "zhipu-account", "team-coding-plan"),
      ),
    );
    const base = providerView();
    const changedTransport = {
      ...base,
      providers: [
        {
          ...base.providers[0],
          effectiveConfig: {
            ...base.providers[0].effectiveConfig,
            api: {
              ...base.providers[0].effectiveConfig.api,
              type: "openai-chat-completions" as const,
            },
          },
        },
      ],
    };
    expect(digestZCodeAgentNativeRuntimeProviderSnapshot(providerView())).not.toBe(
      digestZCodeAgentNativeRuntimeProviderSnapshot(changedTransport),
    );
  });

  it("reads selection and normalized network values from the existing public services", async () => {
    const context = await createZCodeAgentNativeRuntimeStartupContext({
      providerSettingsView: providerView(),
      modelSelectionView: {
        revision: 1,
        providers: [],
        preferredSelection: {
          providerId: " deepseek-anthropic ",
          modelId: " deepseek-v3.2 ",
          options: { reasoningLevel: " high " },
        },
      },
      settings: {
        httpProxy: " http://127.0.0.1:7890 ",
        httpProxyNoProxy: " localhost,127.0.0.1 ",
        httpProxyCaCertPath: " /tmp/zody-test-ca.pem ",
      },
    });

    expect(context).toEqual({
      providerRevisionSha256: digestZCodeAgentNativeRuntimeProviderSnapshot(providerView()),
      selection: {
        providerId: "deepseek-anthropic",
        modelId: "deepseek-v3.2",
        options: { reasoningLevel: "high" },
      },
      network: {
        httpProxy: "http://127.0.0.1:7890",
        noProxy: "localhost,127.0.0.1",
        caCertPath: "/tmp/zody-test-ca.pem",
      },
    });
    expect(
      normalizeZCodeAgentNativeRuntimeNetwork({
        httpProxy: "  ",
        noProxy: undefined,
        caCertPath: " ",
      }),
    ).toEqual({ httpProxy: null, noProxy: null, caCertPath: null });
    expect(
      digestZCodeAgentNativeRuntimeNetwork({
        httpProxy: " http://127.0.0.1:7890 ",
        noProxy: " localhost,127.0.0.1 ",
        caCertPath: " /tmp/zody-test-ca.pem ",
      }),
    ).toBe(
      digestZCodeAgentNativeRuntimeNetwork({
        httpProxy: "http://127.0.0.1:7890",
        noProxy: "localhost,127.0.0.1",
        caCertPath: "/tmp/zody-test-ca.pem",
      }),
    );
  });
});
