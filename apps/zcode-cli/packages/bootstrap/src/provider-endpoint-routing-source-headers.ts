import { arch as readOsArch, release as readOsRelease } from "node:os";
import {
  buildZCodeSourceHeadersFromContext,
  resolveRuntimeZCodeEnv,
  ZCODE_APP_VERSION_ENV,
} from "@zcode/shared";
import type { ModelProviderSourceTitle } from "./model-config.js";

interface CreateProviderEndpointRoutingSourceHeadersOptions {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  sourceTitle?: ModelProviderSourceTitle;
}

export async function createProviderEndpointRoutingSourceHeaders(
  options: CreateProviderEndpointRoutingSourceHeadersOptions = {},
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  // fork（F2.10）：设备标识 X-Device-Mid 停发，不再读取 telemetry-state.json；
  // HTTP-Referer / X-Title 默认不发（构建期可配置）。
  return buildZCodeSourceHeadersFromContext({
    appVersion: env[ZCODE_APP_VERSION_ENV] ?? options.appVersion,
    arch: readOsArch(),
    clientLanguage: resolveClientLanguage(),
    clientTimezone: resolveClientTimezone(),
    osVersion: readOsRelease(),
    platform: process.platform,
    releaseChannel: resolveRuntimeZCodeEnv(env),
    sourceTitle: options.sourceTitle ?? "cli",
  });
}

function resolveClientLanguage(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function resolveClientTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
