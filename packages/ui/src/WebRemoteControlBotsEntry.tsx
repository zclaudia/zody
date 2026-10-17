import { memo, useState } from "react";
import type { BotProvider } from "@zcode/shared";
import { Bot as BotIcon } from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<BotProvider, "weixin" | "feishu" | "lark" | "telegram">;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

/**
 * Bot Channel 入口卡片，从 WebRemoteControlDialog 抽出的独立组件。
 * 入口本身与远控会话状态无关（不读 status、不调 start/stop），这样打开/关闭远控
 * 不再影响 Bot 入口；`data-testid="web-remote-control-open-bots"` 保持不变。
 */
export const WebRemoteControlBotsEntry = memo(function WebRemoteControlBotsEntryComponent({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] = useState<RemoteControlBotProvider | null>(null);

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlBotsEntry] 打开 Bot Channel 配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlBotsEntry] 打开 Bots 总配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  return (
    <>
      <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
        <div className="mb-4 flex items-start gap-2">
          <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 space-y-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({
                id: "webRemoteControl.botChannel.title",
              })}
            </div>
            <p className="text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({
                id: "webRemoteControl.botChannel.description",
              })}
            </p>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 gap-3">
          {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
            const regionTagLabelId = getBotProviderRegionTagLabelId(entry.provider);

            return (
              <button
                key={entry.provider}
                type="button"
                className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                onClick={() => handleOpenBotEntry(entry.provider)}
              >
                {/* Bugfix: 远控 Bot Channel 入口原来用通用 lucide 图标，用户无法一眼区分微信、飞书和 Telegram。
                    这里直接复用 BotsDialog 的渠道 logo，不再额外包裹容器，保证品牌图标本身作为视觉识别。 */}
                <ProviderIcon provider={entry.provider} className="size-12 shrink-0" />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                    <span className="min-w-0 truncate">
                      {intl.formatMessage({
                        id: `webRemoteControl.botChannel.${entry.provider}.title`,
                      })}
                    </span>
                    {regionTagLabelId ? (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                        {intl.formatMessage({ id: regionTagLabelId })}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-ui-base/relaxed text-foreground-subtle">
                    {intl.formatMessage({
                      id: `webRemoteControl.botChannel.${entry.provider}.description`,
                    })}
                  </span>
                  <span className="block text-ui-base font-medium text-primary">
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.configure",
                    })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            data-testid="web-remote-control-open-bots"
            className="w-full justify-center gap-2 enabled:cursor-pointer"
            onClick={handleOpenBotsDialog}
          >
            <BotIcon className="size-3.5" />
            {intl.formatMessage({
              id: "webRemoteControl.botChannel.manageBots",
            })}
          </Button>
        </div>
      </section>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
