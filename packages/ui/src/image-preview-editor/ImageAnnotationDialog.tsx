import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { ImagePreviewSurface } from "@/image-preview-editor/ImagePreviewSurface.js";

// F15：独立标注编辑器弹窗（裁决 4——不并入 ChatMediaAttachmentPreviewDialog 等只读预览）。
// 宿主只负责弹窗壳与开关；标注状态、导出与接收方捕获全部由 ImagePreviewSurface 持有。
export interface ImageAnnotationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  filename: string;
  alt?: string;
}

export function ImageAnnotationDialog({
  open,
  onOpenChange,
  src,
  filename,
  alt,
}: ImageAnnotationDialogProps) {
  const { intl } = useZodyIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // 不能写 `relative`：DialogContent 基类靠 `fixed` 定位居中，tailwind-merge 对
        // position 组只保留后写的类，会把 fixed 删掉使弹窗掉进文档流、渲染到视口外
        // （F15③ E2E 反例定位的真实缺陷）。fixed 本身就是定位祖先，Surface 的
        // absolute 子元素可直接锚到弹窗内容。
        className="flex h-[min(84vh,760px)] max-w-5xl flex-col overflow-hidden p-0"
        showCloseButton
      >
        <DialogTitle className="sr-only">{filename}</DialogTitle>
        <DialogDescription className="sr-only">
          {intl.formatMessage({ id: "imageEditor.dialogDescription" })}
        </DialogDescription>
        <ImagePreviewSurface
          src={src}
          alt={alt ?? filename}
          filename={filename}
          onClose={() => onOpenChange(false)}
          // 保存成功即关闭编辑器；新 PNG 附件已由接收方走既有 addAttachmentFiles 入草稿。
          onSaved={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
