import { ArrowLeft, ChevronRight, Rocket, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

interface MobileSettingsSection {
  id: SettingsSectionId;
  icon: LucideIcon;
  titleId: string;
}

interface MobileSettingsGroup {
  id: string;
  titleId: string;
  sections: readonly MobileSettingsSection[];
}

function MobileSettingsTopBar({
  title,
  onBack,
  backLabelId = "workspace.backToWorkspace",
}: {
  title: string;
  onBack?: () => void;
  backLabelId?: string;
}) {
  const { intl } = useZodyIntl();
  return (
    <div className="zcode-safe-area-top shrink-0 border-b border-border bg-header">
      <div className="flex h-11 items-center gap-1 px-2">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-11 shrink-0"
            aria-label={intl.formatMessage({ id: backLabelId })}
            onClick={onBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium">{title}</span>
      </div>
    </div>
  );
}

export function MobileSettingsIndex({
  groups,
  onSelectSection,
  onBack,
  onOpenOnboarding,
}: {
  groups: readonly MobileSettingsGroup[];
  onSelectSection: (section: SettingsSectionId) => void;
  onBack?: () => void;
  onOpenOnboarding: () => void;
}) {
  const { intl } = useZodyIntl();
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-mobile-settings-index="true"
    >
      <MobileSettingsTopBar title={intl.formatMessage({ id: "settings.title" })} onBack={onBack} />
      <nav
        aria-label={intl.formatMessage({ id: "settings.navLabel" })}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`mobile-settings-group-${group.id}`}>
              <h2
                id={`mobile-settings-group-${group.id}`}
                className="px-3 pb-2 text-ui-sm font-medium text-foreground-subtle"
              >
                {intl.formatMessage({ id: group.titleId })}
              </h2>
              <div className="overflow-hidden rounded-xl border border-card-border bg-card">
                {group.sections.map(({ id, icon: Icon, titleId }) => (
                  <button
                    key={id}
                    type="button"
                    data-testid={`mobile-settings-section-${id}`}
                    className="flex min-h-11 w-full items-center gap-3 border-t border-border px-3 py-2 text-left first:border-t-0 hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2"
                    onClick={() => onSelectSection(id)}
                  >
                    <Icon className="size-4 shrink-0 text-foreground-subtle" />
                    <span className="min-w-0 flex-1 text-ui-base text-foreground">
                      {intl.formatMessage({ id: titleId })}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-foreground-subtlest" />
                  </button>
                ))}
              </div>
            </section>
          ))}
          <button
            type="button"
            className="flex min-h-11 items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover"
            onClick={onOpenOnboarding}
          >
            <Rocket className="size-4 shrink-0" />
            {intl.formatMessage({ id: "settings.onboarding" })}
            <ChevronRight className="ml-auto size-4 shrink-0 text-foreground-subtlest" />
          </button>
        </div>
        <div className="zcode-safe-area-bottom" aria-hidden="true" />
      </nav>
    </section>
  );
}

export function MobileSettingsSectionHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  // 分区页返回的是设置首页，而不是离开设置；沿用通用返回文案。
  return <MobileSettingsTopBar title={title} onBack={onBack} backLabelId="common.back" />;
}
