import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@zody/tui";
import type { UiLocale } from "@zody/i18n";
import type { Logger } from "@zody/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@zody/adapters/browser";
import type {
  createModelAdapter,
  createZCodeApp,
  CreateModelAdapterOptions,
  inspectZCodeSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectZCodeCustomCommand,
  InspectZodyCustomCommandOptions,
  InspectZodySkillOptions,
  listZCodeCustomCommands,
  ListZodyCustomCommandsOptions,
  loadZCodeCustomCommand,
  listZCodeSessions,
  listZCodeSkills,
  ListZodySessionsOptions,
  ListZodySkillsOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunZodyProtocolAgentOptions,
  prepareZCodeTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownZCodeTelemetry,
  ZodyAppOptions,
} from "@zody/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@zody/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  protocolLifecycle?: RunZodyProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createZCodeApp?: (
    options?: ZodyAppOptions,
  ) => Awaited<ReturnType<typeof createZCodeApp>> | ReturnType<typeof createZCodeApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createZCodeApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectZodySkillOptions) => ReturnType<typeof inspectZCodeSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectZodyCustomCommandOptions,
  ) => ReturnType<typeof inspectZCodeCustomCommand>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareZCodeTelemetryEnv?: typeof prepareZCodeTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListZodySessionsOptions) => ReturnType<typeof listZCodeSessions>;
  listCustomCommands?: (
    options: ListZodyCustomCommandsOptions,
  ) => ReturnType<typeof listZCodeCustomCommands>;
  loadCustomCommand?: (
    options: InspectZodyCustomCommandOptions,
  ) => ReturnType<typeof loadZCodeCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedZCodeSlashCommandName"];
  listSkills?: (options: ListZodySkillsOptions) => ReturnType<typeof listZCodeSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  runZCodeProtocolAgent?: (options?: RunZodyProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@zody/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownZCodeTelemetry?: typeof shutdownZCodeTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo" | "guarded";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createZCodeApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
