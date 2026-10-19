import {
  ZCODE_AGENT_PROVIDER,
  ZCODE_COMMAND_AGENT_SOURCES,
  ZCODE_DATA_ROOT_DIR_NAME,
  type ZCodeProvider,
  type CommandAgentSource,
} from "@zcode/shared";

export const COMMAND_AGENT_SOURCES = [
  ...ZCODE_COMMAND_AGENT_SOURCES,
] as const satisfies readonly CommandAgentSource[];

export const COMMAND_AGENT_SOURCE_META: Record<
  CommandAgentSource,
  {
    labelId: string;
    provider: ZCodeProvider;
    pathHint: string;
  }
> = {
  zcodeAgent: {
    labelId: "settings.commands.source.zcodeAgent",
    // fork 数据隔离：家目录级数据根改为 .zcoder，避免与正式版 ZCode 共用。
    pathHint: `~/${ZCODE_DATA_ROOT_DIR_NAME}/commands`,
    provider: ZCODE_AGENT_PROVIDER,
  },
};
