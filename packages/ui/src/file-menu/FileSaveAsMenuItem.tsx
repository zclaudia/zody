import { useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceOpenInEditorScope } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { fileSaveSuccessMessageId, saveFileCopy } from "@/file-menu/fileCopy.js";
import { logger } from "@/logger.js";

/**
 * 统一文件菜单的「另存为」项（upstream v3.17.1 file-menu，来源 SHA a60ba6a7）。
 * 读取由文件所属 workspace Host 的 stat/readFileRange 分块完成（≤50 MiB），
 * 见 docs/ui/file-open-apps.md「另存为」章节；saveFile 是唯一保存端口。
 */
interface Props extends WorkspaceOpenInEditorScope {
  path: string;
  variant?: "context" | "dropdown";
  disabled?: boolean;
}

export function FileSaveAsMenuItem(props: Props) {
  const services = useOptionalServices();
  const platform = usePlatform();
  const { intl } = useZodyIntl();
  const Item = props.variant === "context" ? ContextMenuItem : DropdownMenuItem;
  if (!services || !platform.saveFile) {
    return (
      <Item disabled title={intl.formatMessage({ id: "fileActions.saveAsUnavailable" })}>
        <DownloadIcon className="size-4" />
        {intl.formatMessage({ id: "fileActions.saveAs" })}
      </Item>
    );
  }
  return <WorkspaceFileSaveAsMenuItem {...props} />;
}

function WorkspaceFileSaveAsMenuItem(props: Props) {
  const platform = usePlatform();
  const { intl } = useZodyIntl();
  const { fileService } = useWorkspaceServices(
    props.workspacePath,
    props.workspaceRemoteSessionId,
    props.workspaceIdentity,
  );
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const Item = props.variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const save = async () => {
    if (pending.current || !platform.saveFile) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await saveFileCopy(fileService, props.path, platform.saveFile.bind(platform));
      const messageId = fileSaveSuccessMessageId(result);
      if (messageId) toast(intl.formatMessage({ id: messageId }));
    } catch (error) {
      logger.warn("[FileSaveAs] 保存文件副本失败", { path: props.path, error: String(error) });
      const code = error instanceof Error ? error.message : "";
      toast(
        intl.formatMessage({
          id:
            code === "file_too_large"
              ? "fileActions.saveAsTooLarge"
              : code === "file_size_unavailable"
                ? "fileActions.saveAsUnavailable"
                : "fileActions.saveAsFailed",
        }),
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <Item disabled={props.disabled || saving} onSelect={() => void save()}>
      <DownloadIcon className="size-4" />
      {intl.formatMessage({ id: "fileActions.saveAs" })}
    </Item>
  );
}
