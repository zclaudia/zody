// Provider/network facts for the normal Host candidate build profile. The projection
// excludes credentials, headers, registry revisions, and other per-process instance data.
import { createHash } from "node:crypto";
import { NarrowResourceError } from "../macos-cua-narrow-resources-base.mjs";
import {
  canonicalJson,
  canonicalize,
  nonEmptyString,
  readJsonFile,
  record,
  stringArray,
} from "./normal-host-candidate-profile-values.mjs";

function projectProvider(providerValue) {
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

export function projectNormalHostProviderSnapshot(view) {
  const providers = Array.isArray(view?.providers) ? view.providers : [];
  return {
    schemaVersion: 1,
    providers: providers
      .map(projectProvider)
      .sort((left, right) =>
        String(left.providerId ?? "").localeCompare(String(right.providerId ?? "")),
      ),
  };
}

export function digestNormalHostProviderSnapshot(view) {
  return createHash("sha256")
    .update(canonicalJson(projectNormalHostProviderSnapshot(view)))
    .digest("hex");
}

export function normalizeNormalHostSelection(selection) {
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

export function normalizeNormalHostNetwork(input) {
  return {
    httpProxy: nonEmptyString(input?.httpProxy),
    noProxy: nonEmptyString(input?.noProxy),
    caCertPath: nonEmptyString(input?.caCertPath),
  };
}

export function digestNormalHostNetwork(input) {
  return createHash("sha256")
    .update(canonicalJson(normalizeNormalHostNetwork(input)))
    .digest("hex");
}

export async function readProviderProfile(providerProfilePath) {
  const parsed = await readJsonFile(providerProfilePath, "providerProfile");
  const view = parsed.providerSettingsView ?? parsed.view ?? parsed;
  const rawSelection = parsed.selection ?? parsed.preferredSelection;
  const selection = normalizeNormalHostSelection(rawSelection);
  if (!selection) {
    throw new NarrowResourceError(
      "providerProfile-selection",
      "providerProfile.selection must contain providerId/modelId",
    );
  }
  const revisionSha256 = digestNormalHostProviderSnapshot(view);
  return { revisionSha256, selection };
}

export async function readNetworkProfile(networkProfilePath) {
  const parsed = await readJsonFile(networkProfilePath, "networkProfile");
  const network = normalizeNormalHostNetwork(parsed);
  return { ...network, digestSha256: digestNormalHostNetwork(network) };
}
