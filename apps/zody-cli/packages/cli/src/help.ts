import { getZodyCopy, type SupportedLocale, type UiLocale } from "@zody/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getZodyCopy(locale, detectedLocale).cli.help(version);
}
