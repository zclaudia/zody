import { createHash } from "node:crypto";
import type { AppSettings, ModelSelection } from "@zody/shared";
import type {
  ModelSelectionView,
  ProviderSettingsView,
} from "../model-provider/providerFacadeServices.js";
import type { ZodyAgentNativeRuntimeStartupContext } from "./zodyAgentProcessManager.js";

/**
 * Provider registry revision is a process-local incrementing registry number, so it is not a
 * cross-process configuration identity. This digest is built only from public, non-secret
 * provider/model facts. Credentials and provider headers are deliberately excluded.
 */
export interface ZodyAgentNativeRuntimeProviderSnapshot {
  readonly schemaVersion: 1;
  readonly providers: readonly unknown[];
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map(nonEmptyString).filter((entry): entry is string => entry !== null);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectProvider(providerValue: unknown): unknown {
  const provider = record(providerValue);
  const config = record(provider.effectiveConfig);
  const api = record(config.api);
  const access = record(config.access);
  const models = Array.isArray(provider.models) ? provider.models : [];
  return {
    providerId: nonEmptyString(provider.providerId),
    templateId: nonEmptyString(provider.templateId),
    enabled: provider.enabled === true,
    executable: provider.executable === true,
    group: nonEmptyString(config.group),
    visibility: nonEmptyString(config.visibility),
    // Auth mode changes runtime assembly but must not project keys or header values.
    access:
      config.access == null
        ? null
        : access.type === "zhipu-account"
          ? {
              type: nonEmptyString(access.type),
              accountType: nonEmptyString(access.accountType),
              mode: nonEmptyString(access.mode),
              entitled: access.entitled === true,
            }
          : { type: nonEmptyString(access.type) },
    api:
      config.api == null
        ? null
        : {
            type: nonEmptyString(api.type),
            baseUrl: nonEmptyString(api.baseUrl),
          },
    builtinModelIds: stringArray(config.builtinModelIds),
    personalModelIds: stringArray(config.personalModelIds),
    modelOrder: stringArray(config.modelOrder),
    models: models
      .map((modelValue) => {
        const model = record(modelValue);
        return {
          modelId: nonEmptyString(model.modelId),
          kind: nonEmptyString(model.kind),
          builtin: model.builtin === true,
          enabled: model.enabled === true,
          executable: model.executable === true,
          selectable: model.selectable === true,
          config: canonicalize(model.effectiveConfig ?? null),
        };
      })
      .sort((left, right) => String(left.modelId ?? "").localeCompare(String(right.modelId ?? ""))),
  };
}

export function projectZCodeAgentNativeRuntimeProviderSnapshot(
  view: ProviderSettingsView,
): ZodyAgentNativeRuntimeProviderSnapshot {
  const providers = Array.isArray(view?.providers) ? view.providers : [];
  return {
    schemaVersion: 1,
    providers: providers
      .map(projectProvider)
      .sort((left, right) =>
        String((left as { providerId?: string | null }).providerId ?? "").localeCompare(
          String((right as { providerId?: string | null }).providerId ?? ""),
        ),
      ),
  };
}

export function digestZCodeAgentNativeRuntimeProviderSnapshot(view: ProviderSettingsView): string {
  return createHash("sha256")
    .update(canonicalJson(projectZCodeAgentNativeRuntimeProviderSnapshot(view)))
    .digest("hex");
}

export function normalizeZCodeAgentNativeRuntimeSelection(
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!selection) return null;
  const providerId = nonEmptyString(selection.providerId);
  const modelId = nonEmptyString(selection.modelId);
  if (!providerId || !modelId) return null;
  const reasoningLevel = nonEmptyString(selection.options?.reasoningLevel);
  return {
    providerId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export interface ZodyAgentNativeRuntimeNormalizedNetwork {
  readonly httpProxy: string | null;
  readonly noProxy: string | null;
  readonly caCertPath: string | null;
}

export function normalizeZCodeAgentNativeRuntimeNetwork(input: {
  readonly httpProxy?: string | null;
  readonly noProxy?: string | null;
  readonly caCertPath?: string | null;
}): ZodyAgentNativeRuntimeNormalizedNetwork {
  return {
    httpProxy: nonEmptyString(input.httpProxy),
    noProxy: nonEmptyString(input.noProxy),
    caCertPath: nonEmptyString(input.caCertPath),
  };
}

export function digestZCodeAgentNativeRuntimeNetwork(input: {
  readonly httpProxy?: string | null;
  readonly noProxy?: string | null;
  readonly caCertPath?: string | null;
}): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeZCodeAgentNativeRuntimeNetwork(input)))
    .digest("hex");
}

export function createZCodeAgentNativeRuntimeStartupContext(input: {
  readonly providerSettingsView: ProviderSettingsView;
  readonly modelSelectionView: Pick<ModelSelectionView, "preferredSelection">;
  readonly settings: Pick<AppSettings, "httpProxy" | "httpProxyNoProxy" | "httpProxyCaCertPath">;
}): ZodyAgentNativeRuntimeStartupContext {
  return {
    providerRevisionSha256: digestZCodeAgentNativeRuntimeProviderSnapshot(
      input.providerSettingsView,
    ),
    selection: normalizeZCodeAgentNativeRuntimeSelection(
      input.modelSelectionView.preferredSelection,
    ),
    network: normalizeZCodeAgentNativeRuntimeNetwork({
      httpProxy: input.settings.httpProxy,
      noProxy: input.settings.httpProxyNoProxy,
      caCertPath: input.settings.httpProxyCaCertPath,
    }),
  };
}
