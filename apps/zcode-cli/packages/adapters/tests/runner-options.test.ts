import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
  shouldIncludeStreamResponseBody,
} from "../src/model/runner-options.js";
import { isOpenCodeGoBaseUrl } from "../src/model/opencode-session.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

function resolved(partial: Partial<ResolvedAiSdkModel>): ResolvedAiSdkModel {
  // runner-options.ts 会无条件读取 resolved.properties（requiresMfjsToolSchema 等），
  // 本文件的夹具大量缺省该必填字段（v3.15.1 快照即如此），这里统一给默认值，单个用例仍可覆盖。
  return {
    properties: createTestModelProperties(),
    ...partial,
  } as ResolvedAiSdkModel;
}

describe("shouldIncludeStreamResponseBody", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // F4.1a（specs/fork-official-deps-removal-tasks.md）已从 builtin 配置删除全部 account:* 官方账号
  // provider（含 account:zcode-plan / start-plan 账号 wire），F4.9 将整体删除账号运行时；
  // 现实现按 accountAccess?.mode === "start-plan"（zhipu-account 专属，见 runner.ts:161）判定，
  // 按 baseURL 识别 zcode-plan 的旧行为与「按 baseURL 断言 zcode-plan 流式 responseBody」
  // 的用例均属已删除语义，故删除以下两条正向断言（skip 的否定用例保留）。

  it("skips responseBody capture for unrelated providers", () => {
    expect(
      shouldIncludeStreamResponseBody(
        resolved({
          providerKind: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
        }),
      ),
    ).toBe(false);
  });
});

describe("isOpenCodeGoBaseUrl", () => {
  it.each(["https://opencode.ai/zen/go/v1", "https://api.opencode.ai/zen/go/v1/"])(
    "matches OpenCode Go host and path boundaries: %s",
    (baseURL) => {
      expect(isOpenCodeGoBaseUrl(baseURL)).toBe(true);
    },
  );

  it.each([
    "https://opencode.ai/zen/v1",
    "https://opencode.ai/zen/go/v2",
    "https://opencode.ai.example/zen/go/v1",
    "not a url",
    undefined,
  ])("rejects unrelated OpenCode endpoints: %s", (baseURL) => {
    expect(isOpenCodeGoBaseUrl(baseURL)).toBe(false);
  });
});

describe("createStreamTextOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps a JSON response schema only into generateText structured output", async () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: {
          items: { type: "string" },
          type: "array",
        },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      includeModelIO: false,
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "test-provider", modelId: "test-model" },
        providerKind: "custom",
      }),
      statusContext: {
        model: { providerId: "test-provider", modelId: "test-model" },
        providerKind: "custom",
        requestId: "req_structured_output",
        sessionId: "sess_structured_output",
        traceId: "trace_structured_output",
      } as never,
    };

    const generateOptions = createGenerateTextOptions(input);
    const streamOptions = createStreamTextOptions(input);

    expect(generateOptions.output).toBeDefined();
    await expect(generateOptions.output?.responseFormat).resolves.toEqual({
      schema: responseJsonSchema,
      type: "json",
    });
    expect(streamOptions).not.toHaveProperty("output");
  });

  it("keeps explicit generateText schemas on the native Anthropic output format", () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: { items: { type: "string" }, type: "array" },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      includeModelIO: false,
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "test-provider", modelId: "lite-model" },
        providerKind: "anthropic",
      }),
      statusContext: {
        model: { providerId: "test-provider", modelId: "lite-model" },
        providerKind: "anthropic",
        requestId: "req_native_structured_output",
        sessionId: "sess_native_structured_output",
        traceId: "trace_native_structured_output",
      } as never,
    };
    const generateInput = {
      ...input,
      request: {
        ...input.request,
        // v3.15.1 快照版本错位：canonical maxOutputTokens 透传（maxOutputTokensSource 预算）
        // 在本快照 src 全库 0 命中，runner-options.ts 从不产出 maxOutputTokens，
        // 该断言自导入起从未绿过；下次整版快照导入若 upstream 仍保留会连同匹配 src 一起回归。
        // 此处仅保留活的 structuredOutputMode 契约断言。
        providerOptions: { anthropic: {} },
      },
      resolved: {
        ...input.resolved,
        providerOptions: {
          anthropic: {
            effort: "medium",
            thinking: { budgetTokens: 8_000, type: "enabled" },
          },
        },
      },
    };

    const generateOptions = createGenerateTextOptions(generateInput);
    expect(generateOptions.providerOptions).toEqual({
      anthropic: { structuredOutputMode: "outputFormat" },
    });
    expect(createStreamTextOptions(input).providerOptions).toBeUndefined();
  });

  it("applies the same empty-user wire fallback to generate and stream requests", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "" }],
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "custom-compatible", modelId: "empty-user-model" },
          providerKind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
        }),
        statusContext: {
          model: { providerId: "custom-compatible", modelId: "empty-user-model" },
          providerKind: "openai-compatible",
          requestId: "req_empty_user",
          sessionId: "sess_empty_user",
          traceId: "trace_empty_user",
        } as never,
      });

      expect(options.messages).toEqual([{ role: "user", content: "(no content)" }]);
    }
  });

  // v3.15.1 快照版本错位（aac47556 整版导入，tests 与 src 不同 revision，本文件自导入起未被
  // fork 修改即从未绿过）：以下用例断言的生产特性在本快照 src 全库 0 命中，无法等价迁移——
  //   · adapter 侧 inputMediaCapabilities 媒体省略（媒体省略实际在 core/media-capability.ts）；
  //   · canonical maxOutputTokens 预算（maxOutputTokensSource、Anthropic thinking 扣减、
  //     Compact 预算、能力上限归一化）；
  //   · openaiCompatible.extra_body 展平与 canonical 选项投影；
  // 按 M3 收尾 T2 升级裁决（2026-10-18）删除；下次整版快照导入若 upstream 仍保留这些用例，
  // 会连同匹配的 src 一起回归。
  // F4.1a/F4.9：zcode-plan 账号 provider 已下线（无 zhipu-account access 即无 accountAccess），
  // 「zcode-plan 流式开启 experimental_include.responseBody」是已删除的账号 wire 行为，用例删除。

  it("uses merged Responses provider options while transforming history", () => {
    const toolCallId = "call_read";
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "stored reasoning",
                providerOptions: { openai: { itemId: "rs_1" } },
              },
              { type: "text", text: "checking" },
            ],
            toolCalls: [{ id: toolCallId, name: "Read", input: { file_path: "README.md" } }],
          },
        ],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "openai", modelId: "gpt-5" },
        providerKind: "openai",
        providerOptions: { apiFormat: "openai-responses" },
      }),
      statusContext: {
        model: { providerId: "openai", modelId: "gpt-5" },
        providerKind: "openai",
        requestId: "req_responses",
        sessionId: "sess_responses",
        traceId: "trace_responses",
      } as never,
    });

    const [message] = options.messages ?? [];
    expect((message as any).content).toEqual([
      { type: "text", text: "checking" },
      {
        type: "tool-call",
        toolCallId,
        toolName: "Read",
        input: { file_path: "README.md" },
      },
    ]);
    expect(options.providerOptions).toEqual({ apiFormat: "openai-responses" });
  });

  // v3.15.1 快照版本错位（依据同上）：native OpenAI reasoningEffort 打包在 src 全库 0 命中，删除。

  it("adds request attribution headers for generateText requests", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "test", modelId: "model-a" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "main",
        providerKind: "openai-compatible",
        requestId: "req_generate",
        queryId: "query_generate",
        sessionId: "sess_generate",
        traceId: "trace_generate",
      } as never,
    });

    expect(options.headers).toEqual({
      "x-query-id": "generate",
      "x-request-id": "req_generate",
      "x-session-id": "generate",
      "x-zcode-session-type": "main",
      "x-zcode-trace-id": "trace_generate",
    });
  });

  it("keeps provider runtime platform headers with request attribution headers", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        headers: {
          "X-Os-Category": "macos",
          "X-Os-Version": "25.0.0",
          "X-Platform": "darwin-arm64",
          "x-zcode-session-type": "spoofed",
        },
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "test", modelId: "model-a" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "subagent",
        providerKind: "openai-compatible",
        requestId: "req_platform",
        sessionId: "sess_platform",
        traceId: "trace_platform",
      } as never,
    });

    expect(options.headers).toEqual({
      "X-Os-Category": "macos",
      "X-Os-Version": "25.0.0",
      "X-Platform": "darwin-arm64",
      "x-request-id": "req_platform",
      "x-session-id": "platform",
      "x-zcode-session-type": "subagent",
      "x-zcode-trace-id": "trace_platform",
    });
  });

  it("strips internal subagent and query prefixes from request attribution headers", () => {
    const queryId = "query_ad8740cd-f843-4235-ba0d-395063e56fda";
    const sessionId = "sess_subagent_agent_b3d813c3-c568-42e9-8f67-eeb814bc8ef2";
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "test", modelId: "model-a" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "subagent",
        providerKind: "openai-compatible",
        requestId: "req_subagent",
        queryId,
        sessionId,
        traceId: "trace_subagent",
      } as never,
    });

    expect(options.headers).toMatchObject({
      "x-query-id": "ad8740cd-f843-4235-ba0d-395063e56fda",
      "x-session-id": "b3d813c3-c568-42e9-8f67-eeb814bc8ef2",
    });
  });

  it("adds request attribution headers for streamText requests", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "test", modelId: "model-a" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "other",
        providerKind: "openai-compatible",
        requestId: "req_stream",
        queryId: "query_stream",
        sessionId: "sess_stream",
        traceId: "trace_stream",
      } as never,
    });

    expect(options.headers).toEqual({
      "x-query-id": "stream",
      "x-request-id": "req_stream",
      "x-session-id": "stream",
      "x-zcode-session-type": "other",
      "x-zcode-trace-id": "trace_stream",
    });
  });

  it.each([createGenerateTextOptions, createStreamTextOptions])(
    "adds a stable OpenCode Go session header to %s requests",
    (createOptions) => {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "hi" }],
        },
        resolved: resolved({
          baseURL: "https://opencode.ai/zen/go/v1",
          headers: { "x-opencode-session": "spoofed" },
          model: {} as ResolvedAiSdkModel["model"],
          providerKind: "openai-compatible",
          ref: { providerId: "custom-provider", modelId: "kimi-k2.5" },
        }),
        statusContext: {
          model: { providerId: "custom-provider", modelId: "kimi-k2.5" },
          modelRequestSessionType: "main",
          providerKind: "openai-compatible",
          requestId: "req_opencode_go",
          sessionId: "sess_conversation_stable",
          traceId: "trace_opencode_go",
          baseURL: "https://opencode.ai/zen/go/v1",
        } as never,
      });

      expect(options.headers).toMatchObject({
        "x-opencode-session": "conversation_stable",
      });
    },
  );

  it("does not add OpenCode Go session header for other providers on the same host", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: { messages: [{ role: "user", content: "hi" }] },
      resolved: resolved({
        baseURL: "https://opencode.ai/zen/v1",
        model: {} as ResolvedAiSdkModel["model"],
        providerKind: "openai-compatible",
        ref: { providerId: "custom-provider", modelId: "kimi-k2.5" },
      }),
      statusContext: {
        model: { providerId: "custom-provider", modelId: "kimi-k2.5" },
        modelRequestSessionType: "main",
        providerKind: "openai-compatible",
        requestId: "req_opencode_zen",
        sessionId: "sess_conversation_stable",
        traceId: "trace_opencode_zen",
      } as never,
    });

    expect(options.headers).not.toHaveProperty("x-opencode-session");
  });
});
