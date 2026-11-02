import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GUIDE_SKILLS = [
  "diagnosing-commands",
  "diagnosing-hooks",
  "diagnosing-mcp",
  "diagnosing-plugins",
  "diagnosing-skills",
  "zcode-configuration-guide",
] as const;

const SKILLS_ROOT = fileURLToPath(new URL("../../zcode-guide-plugin/skills/", import.meta.url));

describe("bundled Zody guide path contract", () => {
  it("directs user writes to ~/.zody and project writes to .zody only", async () => {
    const skills = await Promise.all(
      GUIDE_SKILLS.map(
        async (name) =>
          [name, await readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8")] as const,
      ),
    );

    for (const [name, content] of skills) {
      expect(content, name).toContain("write user-level Zody configuration under `~/.zody/`");
      expect(content, name).toContain("new project configuration/resources under `.zody/`");
      expect(content, name).toContain("read-only legacy fallback");
      expect(content, name).toContain("`.agents/`");
      expect(content, name).toContain("`.zcode-plugin/plugin.json`");
      expect(content, name).not.toContain("~/.zcode");
    }

    const configurationGuide = skills.find(([name]) => name === "zcode-configuration-guide")?.[1];
    expect(configurationGuide).toContain("`<repo>/.zody/skills/`");
    expect(configurationGuide).toContain("`<repo>/.zody/commands/`");
    expect(configurationGuide).toContain("`<repo>/.zody/config.json`");
    expect(configurationGuide).toContain(
      "existing `<repo>/.zcode/config.json` is legacy read-only",
    );
  });
});
