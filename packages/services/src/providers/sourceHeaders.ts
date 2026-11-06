import { version as readOsVersion } from "node:os";
import {
  buildZodySourceHeadersFromContext,
  normalizeZodySourceHeaderValue,
  ZODY_ENV,
  ZODY_VERSION,
} from "@zody/shared";

interface ZodySourceHeaderOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  osVersion?: string;
  platform?: NodeJS.Platform;
  releaseChannel?: string;
}

function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
  return normalizeZodySourceHeaderValue(value);
}

function resolveClientLanguage(): string {
  return normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale) ?? "unknown";
}

function resolveClientTimezone(): string {
  return (
    normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "unknown"
  );
}

export function buildZodySourceHeaders(
  options: ZodySourceHeaderOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const appVersion = normalizePrintableHeaderValue(options.appVersion ?? ZODY_VERSION);
  const releaseChannel = normalizePrintableHeaderValue(options.releaseChannel ?? ZODY_ENV);
  const clientLanguage =
    normalizePrintableHeaderValue(options.clientLanguage) ?? resolveClientLanguage();
  const clientTimezone =
    normalizePrintableHeaderValue(options.clientTimezone) ?? resolveClientTimezone();
  const osVersion = normalizePrintableHeaderValue(options.osVersion ?? readOsVersion());

  // fork（F2.10）：设备标识 X-Device-Mid 停发，不再读取 telemetry-state.json。
  return buildZodySourceHeadersFromContext({
    appVersion,
    arch,
    clientLanguage,
    clientTimezone,
    osVersion,
    platform,
    releaseChannel,
    sourceTitle: "electron",
  });
}
