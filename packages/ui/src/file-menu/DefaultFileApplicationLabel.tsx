import type { ReactNode } from "react";
import type { FileApplicationInfo } from "@zody/shared";
import { ExternalLinkIcon } from "lucide-react";
import { FileApplicationIcon } from "@/file-menu/FileApplicationIcon.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";

/**
 * 已知默认应用才展示其身份（SHA a60ba6a7）；中性系统动作不能借用首个候选或
 * 历史选择的图标。application 缺席（空关联/未查询）时渲染中性「使用默认应用
 * 打开」标签（ExternalLinkIcon），供主按钮与菜单空态共用。
 */
export function DefaultFileApplicationLabel({
  application,
  children,
}: {
  application?: FileApplicationInfo | null;
  children?: ReactNode;
}) {
  const { intl } = useZodyIntl();
  const label =
    children ??
    intl.formatMessage(
      { id: application ? "fileActions.openInApplication" : "chat.previewCards.openDefaultApp" },
      application ? { application: application.name } : undefined,
    );
  return (
    <>
      {application ? (
        <FileApplicationIcon applicationId={application.id} iconDataUrl={application.iconDataUrl} />
      ) : (
        <ExternalLinkIcon aria-hidden="true" className="size-4" />
      )}
      {/* 应用名称较长时保持单行，避免一个汉字被挤成第二行；完整动作仍可通过 title 查看。 */}
      <span
        className="min-w-0 flex-1 truncate"
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
    </>
  );
}
