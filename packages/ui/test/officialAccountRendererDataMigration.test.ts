// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { stripOfficialAccountSelectionsFromStorage } from "@/lib/officialAccountRendererDataMigration.js";

const V4_DRAFT_PREFIX = "zcode-v4-composer-drafts:v1:";
const RECENT_PREFIX = "zcode-model-selection-recent-v1";

describe("F4.1a 渲染端官方账号模型选择清理", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("composer 草稿中 account:* 的 modelSelection 剔除，草稿正文与其余字段保留", () => {
    const workspaceKey = encodeURIComponent("/repo/legacy");
    window.localStorage.setItem(
      `${V4_DRAFT_PREFIX}${workspaceKey}`,
      JSON.stringify({
        version: 1,
        scopes: {
          "session-1": {
            text: "未发送的草稿正文",
            mode: "build",
            modelSelection: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
          },
          "session-2": {
            text: "BYOK 草稿",
            modelSelection: { providerId: "personal-zai", modelId: "glm-5.3" },
          },
        },
      }),
    );

    const result = stripOfficialAccountSelectionsFromStorage();

    expect(result.cleanedDraftKeys).toBe(1);
    const file = JSON.parse(
      window.localStorage.getItem(`${V4_DRAFT_PREFIX}${workspaceKey}`)!,
    ) as { scopes: Record<string, { modelSelection?: unknown; text: string; mode?: string }> };
    expect(file.scopes["session-1"]).toEqual({ text: "未发送的草稿正文", mode: "build" });
    expect(file.scopes["session-2"]?.modelSelection).toEqual({
      providerId: "personal-zai",
      modelId: "glm-5.3",
    });
  });

  it("最近模型记录剔除 account:*；仅剩 modelSelection 的记录整键删除，有 mode 的保留 mode", () => {
    window.localStorage.setItem(
      `${RECENT_PREFIX}:/repo/legacy`,
      JSON.stringify({
        modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.2" },
        mode: "build",
      }),
    );
    window.localStorage.setItem(
      `${RECENT_PREFIX}:/repo/only-selection`,
      JSON.stringify({
        modelSelection: { providerId: "account:zai-team-coding-plan", modelId: "GLM-5.3" },
      }),
    );
    window.localStorage.setItem(
      `${RECENT_PREFIX}:/repo/byok`,
      JSON.stringify({
        modelSelection: { providerId: "personal-zai", modelId: "glm-5.3" },
        mode: "build",
      }),
    );

    const result = stripOfficialAccountSelectionsFromStorage();

    expect(result.cleanedRecentKeys).toBe(2);
    expect(window.localStorage.getItem(`${RECENT_PREFIX}:/repo/only-selection`)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(`${RECENT_PREFIX}:/repo/legacy`)!)).toEqual({
      mode: "build",
    });
    expect(JSON.parse(window.localStorage.getItem(`${RECENT_PREFIX}:/repo/byok`)!)).toEqual({
      modelSelection: { providerId: "personal-zai", modelId: "glm-5.3" },
      mode: "build",
    });
  });

  it("重复执行零命中（幂等），无 account 条目时不改写任何键", () => {
    const workspaceKey = encodeURIComponent("/repo/clean");
    const cleanDraft = JSON.stringify({
      version: 1,
      scopes: { s: { text: "正文", modelSelection: { providerId: "my-openai", modelId: "gpt" } } },
    });
    const cleanRecent = JSON.stringify({
      modelSelection: { providerId: "personal-zai", modelId: "glm-5.3" },
      mode: "build",
    });
    window.localStorage.setItem(`${V4_DRAFT_PREFIX}${workspaceKey}`, cleanDraft);
    window.localStorage.setItem(`${RECENT_PREFIX}:/repo/clean`, cleanRecent);

    const first = stripOfficialAccountSelectionsFromStorage();
    expect(first).toEqual({ cleanedDraftKeys: 0, cleanedRecentKeys: 0 });
    expect(window.localStorage.getItem(`${V4_DRAFT_PREFIX}${workspaceKey}`)).toBe(cleanDraft);
    expect(window.localStorage.getItem(`${RECENT_PREFIX}:/repo/clean`)).toBe(cleanRecent);

    // 清理过的键再次执行不再变化。
    window.localStorage.setItem(
      `${V4_DRAFT_PREFIX}${encodeURIComponent("/repo/legacy")}`,
      JSON.stringify({
        version: 1,
        scopes: {
          s: { text: "t", modelSelection: { providerId: "account:zai-start-plan", modelId: "m" } },
        },
      }),
    );
    expect(stripOfficialAccountSelectionsFromStorage().cleanedDraftKeys).toBe(1);
    const cleaned = window.localStorage.getItem(`${V4_DRAFT_PREFIX}${encodeURIComponent("/repo/legacy")}`);
    expect(stripOfficialAccountSelectionsFromStorage().cleanedDraftKeys).toBe(0);
    expect(window.localStorage.getItem(`${V4_DRAFT_PREFIX}${encodeURIComponent("/repo/legacy")}`)).toBe(
      cleaned,
    );
  });

  it("损坏的键跳过且不影响其他键清理", () => {
    window.localStorage.setItem(`${V4_DRAFT_PREFIX}${encodeURIComponent("/repo/broken")}`, "{broken");
    window.localStorage.setItem(
      `${V4_DRAFT_PREFIX}${encodeURIComponent("/repo/legacy")}`,
      JSON.stringify({
        version: 1,
        scopes: {
          s: { text: "t", modelSelection: { providerId: "account:zai-start-plan", modelId: "m" } },
        },
      }),
    );

    const result = stripOfficialAccountSelectionsFromStorage();

    expect(result.cleanedDraftKeys).toBe(1);
    expect(window.localStorage.getItem(`${V4_DRAFT_PREFIX}${encodeURIComponent("/repo/broken")}`)).toBe(
      "{broken",
    );
  });
});
