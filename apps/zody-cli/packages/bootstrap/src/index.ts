// Bootstrap public API surface.

export * from "./app/create-app.js";
export type { CuaControlSessionOptions } from "./app/cua-runtime-control.js";
export type { CuaNativeAuthorityCompositionOptions } from "./app/cua-runtime-native-authority.js";
export type {
  CuaNativeCaptureExpectation,
  CuaNativeCaptureOnceOptions,
  CuaNativeCaptureRuntimeOptions,
  CuaNodeReplMcpPortFactory,
  CuaNodeReplMcpPortFactoryInput,
} from "./app/cua-runtime-native-capture.js";
export type {
  ListZodySessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunZodyProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  ZodyApp,
  ZodyAppOptions,
  ZodyModelOption,
} from "./app/types.js";
export {
  inspectZCodeCustomCommand,
  listZCodeCustomCommands,
  loadZCodeCustomCommand,
} from "./custom-commands.js";
export type {
  InspectZodyCustomCommandOptions,
  ListZodyCustomCommandsOptions,
  ZodyCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addZCodePluginMarketplace,
  getZCodePluginsOverview,
  installZCodeMarketplacePlugin,
  listZCodePlugins,
  removeZCodePluginMarketplace,
  resolveZCodePlugins,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
  updateZCodeMarketplacePlugin,
  updateZCodePluginMarketplace,
  validateZCodePluginPath,
} from "./plugins.js";
export type {
  AddZodyMarketplaceOptions,
  InstallZodyMarketplacePluginOptions,
  ListZodyPluginsOptions,
  RemoveZodyMarketplaceOptions,
  ResolveZodyPluginsOptions,
  SetZodyPluginEnabledOptions,
  SetZodyPluginEnabledResult,
  UninstallZodyMarketplacePluginOptions,
  UpdateZodyMarketplaceOptions,
  UpdateZodyMarketplacePluginOptions,
  ValidateZodyPluginPathOptions,
  ZodyAvailablePluginData,
  ZodyInstalledPluginData,
  ZodyMarketplaceSummaryData,
  ZodyMarketplaceUpdateData,
  ZodyPluginInstallData,
  ZodyPluginUpdateData,
  ZodyPluginsOverviewData,
} from "./plugins.js";
export { runZCodeProtocolAgent } from "./zody-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./zody-protocol/session-mapper.js";
export { prepareZCodeTelemetryEnv, shutdownZCodeTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listZCodeSessions, resolveLatestSession } from "./sessions.js";
export { inspectZCodeSkill, listZCodeSkills } from "./skills.js";
export type {
  InspectZodySkillOptions,
  ListZodySkillsOptions,
  ZodySkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";
