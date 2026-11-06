/**
 * slashCommandHelpers — 纯函数辅助工具，供 SlashCommandPlugin.tsx 使用
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { AgentSummary, Locale, SkillSummary, ZodySlashCommand } from "@zody/shared";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
} from "./lib/promptInputTriggers.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined 表示新建草稿，决定 Skill catalog authority。 */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App 层本地命令（如 `/side`）。命令目录仍以 CLI catalog 为权威；这里只允许渲染层
   * 追加"选中即执行 UI 行为"的命令，不参与发送，也不写回 CLI 命令列表。
   */
  appCommands?: readonly AppSlashCommand[];
}

/** App 层斜杠命令：选中即执行 UI 行为（不插入 mention、不发送）。 */
export interface AppSlashCommand {
  /** 命令值（不含 `/`），如 "side"。 */
  value: string;
  /** 本地化描述，直接展示在 `/` 面板。 */
  description: string;
  /** 额外搜索关键词；应同时包含中英文别名，保证两种输入习惯都能搜索到。 */
  keywords?: readonly string[];
  /**
   * 恢复类命令（来源 a60ba6a7，F27 /reload）：合并命令面板时屏蔽 CLI catalog 同名命令，
   * 保证该命令永远由 App 层本地截获，绝不回落到 CLI/模型。
   */
  recovery?: boolean;
  /**
   * 选中命令后立即执行的 UI 行为。返回 false 表示执行失败——typed 提交路径
   * （如输入 `/reload` 后回车）据此保留草稿不清空输入，供用户直接重试。
   */
  run: () => void | boolean | Promise<void | boolean>;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * 合并 CLI slash commands 与 App 层命令为 `/` 面板建议列表（F27 从 SlashCommandPlugin
 * 提取为纯函数以便单测）。规则（来源 a60ba6a7 适配）：
 * - 普通命令：CLI catalog 同名优先（保持既有「App 命令不遮蔽 CLI」语义）；
 * - recovery 命令：反过来屏蔽 CLI 同名命令——`/reload` 必须始终本地截获，不进模型输入；
 * - excludedCommandNames 对两类命令都生效。
 */
export function mergeCommandSuggestions(params: {
  cliCommands: readonly ZodySlashCommand[];
  appCommands?: readonly AppSlashCommand[];
  excludedCommandNames?: readonly string[];
}): PromptInputSuggestionItem[] {
  const excluded = new Set((params.excludedCommandNames ?? []).map(normalizeSlashCommandValue));
  // recovery 类 App 命令优先于 CLI 同名命令，避免本地恢复入口被 CLI catalog 遮蔽。
  const recoveryNames = new Set(
    (params.appCommands ?? [])
      .filter((command) => command.recovery)
      .map((command) => normalizeSlashCommandValue(command.value)),
  );
  const cliSuggestions = buildSlashSuggestions([...params.cliCommands]).filter(
    (item) => !excluded.has(item.value) && !recoveryNames.has(item.value),
  );
  // App 层命令追加在 CLI catalog 之后展示；CLI 已提供同名命令时以 CLI 为准，避免遮蔽。
  const cliValues = new Set(cliSuggestions.map((item) => item.value));
  const appSuggestions = buildAppSlashCommandSuggestions(params.appCommands ?? []).filter(
    (item) => !cliValues.has(item.value) && !excluded.has(item.value),
  );
  return [...cliSuggestions, ...appSuggestions];
}

/**
 * `/side` 门禁：草稿态没有父 session 可挂 child，辅助对话自身不允许再开辅助对话，
 * 只读与手机 viewport 与固定入口保持一致地隐藏。
 */
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

export function normalizeSlashCommandValue(name: string): string {
  // ZCode Agent 在远端可能直接返回 "/init" 作为命令名。
  // UI 的 value 需要去掉前导斜杠，否则插入 markdown 时会变成 "//init"，并影响 / 面板匹配。
  return name.trim().replace(/^\/+/, "");
}

export function buildSlashSuggestions(commands: ZodySlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // UI 曾同时维护内建白名单、GLM `/goal` fallback 和 v4 追加目录，
    // CLI catalog 丢失时仍会显示部分命令，掩盖 `/init` 与自定义命令缺失。命令发现
    // 统一以 CLI protocol catalog 为权威，UI 不再追加命令或维护内建白名单。
    if (!value) {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

export function replaceActiveSlashToken(
  textBeforeCursor: string,
  textAfterCursor: string,
  replacementToken: string,
) {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger || activeTrigger.trigger !== "/") {
    return null;
  }

  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    replacementToken,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);
  return {
    cursorOffset: prefix.length + replacementToken.length + 1,
    text: `${prefix}${replacementToken} ${suffix}`,
  };
}

export function getTextAroundCursor() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
