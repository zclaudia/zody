import { ZCODE_DATA_ROOT_DIR_NAME, type ZCodeProvider } from "@zcode/shared";

type SkillSourceType = "glm" | "unknown";

export function resolveSkillSourceType(skillPath: string): SkillSourceType {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  // fork 数据隔离：家目录级数据根改为 .zcoder，避免与正式版 ZCode 共用；
  // workspace 级技能仍在 `/.zcode/skills/`，因此两个前缀都算原生来源。
  if (
    normalized.includes("/.zcode/skills/") ||
    normalized.includes(`/${ZCODE_DATA_ROOT_DIR_NAME}/skills/`)
  ) {
    return "glm";
  }
  if (normalized.includes(`/${ZCODE_DATA_ROOT_DIR_NAME}/cli/plugins/cache/`)) {
    return "glm";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^glm:/;

function isZcodeSkill(skill: { id?: string; path: string; scope?: string }): boolean {
  return (
    // plugin skill 的真实路径在 CLI plugin cache 下，不在 `.zcode/skills`。
    // 服务层已用 scope 标记来源，前端过滤时要放行，否则 `/` 和 `$` 面板会漏掉插件技能。
    skill.scope === "plugin" ||
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    resolveSkillSourceType(skill.path) === "glm"
  );
}

export function filterSkillsForProvider<T extends { path: string; id?: string; scope?: string }>(
  skills: T[],
  _legacyProvider: ZCodeProvider,
): T[] {
  return skills.filter(isZcodeSkill);
}
