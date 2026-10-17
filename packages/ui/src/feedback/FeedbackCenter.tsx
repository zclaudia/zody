import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
// fork（F2.9，决策门 D7）：官方工单提交停用，反馈中心收敛为本地面板——
// 「导出诊断日志」+「打开 fork 问题反馈地址」（构建期 ZCODE_FEEDBACK_ISSUE_URL，未配置不显示）。
// 旧的提交表单 / 工单列表 / 产品需求弹窗文件保留（阶段 4 删除），此处不再挂载。
import { ZCODE_FEEDBACK_ISSUE_URL } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { memo } from "react";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";

export const FeedbackCenter = memo(function FeedbackCenterComponent({
  platform,
}: {
  feedbackService?: IFeedbackService;
  platform: IPlatformService;
}) {
  // 「问题上报」与「给产品提需求」两类入口都落到同一个本地面板；
  // store 的 openFeatureRequest 会把 open 置 false，这里必须合并判定才能响应全部入口。
  const open = useFeedbackStore((state) => state.open || state.featureRequestOpen);
  const close = useFeedbackStore((state) => state.close);
  const { intl } = useZCodeIntl();

  const handleExportLogs = () => {
    void runExportLogsAction(platform, intl);
  };
  const handleOpenIssuePage = () => {
    if (ZCODE_FEEDBACK_ISSUE_URL) {
      void platform.openExternal(ZCODE_FEEDBACK_ISSUE_URL);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="w-[min(26rem,calc(100vw-2rem))] gap-0 p-6">
        <DialogHeader className="p-0 pb-2">
          <DialogTitle className="min-w-0 truncate text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "feedback.center.localTitle" })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "feedback.center.localDescription" })}
          </p>
          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" size="lg" onClick={handleExportLogs}>
              <DownloadIcon className="size-4" />
              {intl.formatMessage({ id: "feedback.center.exportLogsAction" })}
            </Button>
            {ZCODE_FEEDBACK_ISSUE_URL ? (
              <Button
                type="button"
                variant="outline"
                size="lg"
                data-testid="feedback-open-issue-page"
                onClick={handleOpenIssuePage}
              >
                <ExternalLinkIcon className="size-4" />
                {intl.formatMessage({ id: "feedback.center.openIssuePage" })}
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
