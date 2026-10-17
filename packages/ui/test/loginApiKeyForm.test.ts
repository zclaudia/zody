import { describe, expect, it } from "vitest";
import {
  buildLoginApiKeyDefaultModelPreferenceFromSelection,
  shouldShowLoginApiKeyLink,
} from "@/login/LoginApiKeyForm.helpers.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

// fork（F4.1b）：官方账号入口摘除后，LoginApiKeyForm 只承载通用 BYOK 模板引导。
// 原 zai/bigmodel 硬编码选择、providerFamilyDomain 写入、表单回填 helpers 已删除，
// 对应断言一并移除；官方入口不存在的渲染断言见 forkAccountEntryRemoval.test.tsx。

describe("LoginApiKeyForm BYOK helpers", () => {
  it("只有输入框为空且 provider 有 URL 时展示获取 API key 链接", () => {
    expect(shouldShowLoginApiKeyLink("", "https://z.ai/manage-apikey/apikey-list")).toBe(true);
    expect(shouldShowLoginApiKeyLink(" sk-login ", "https://z.ai/manage-apikey/apikey-list")).toBe(
      false,
    );
    expect(shouldShowLoginApiKeyLink("", undefined)).toBe(false);
  });

  it("新 Provider Runtime 从 Selection View 选择 API key 登录后的默认模型", () => {
    expect(
      buildLoginApiKeyDefaultModelPreferenceFromSelection(
        {
          revision: 3,
          providers: [
            {
              providerId: "bigmodel-api",
              config: {
                kind: "api",
                models: ["glm-5.3", "glm-5.2"],
              },
              models: [
                { modelId: "glm-5.3", config: {} },
                { modelId: "glm-5.2", config: {} },
              ],
            },
          ],
        },
        "bigmodel-api",
      ),
    ).toBe(encodeCustomModelValue("bigmodel-api", "glm-5.3"));
  });
});
