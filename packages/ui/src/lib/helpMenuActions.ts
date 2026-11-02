import type { IPlatformService } from "@zody/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { ZODY_ISSUES_URL, ZODY_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

export interface HelpMenuActionHandlers {
  openIssueReport: () => Promise<void>;
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
}): HelpMenuActionHandlers {
  return {
    openIssueReport: async () => {
      platform.openExternal(ZODY_ISSUES_URL);
    },
    openProductDocs: () => {
      platform.openExternal(ZODY_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
