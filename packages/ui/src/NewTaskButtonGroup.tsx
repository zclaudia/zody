import { Plus } from "lucide-react";
import { TID_TASK_NEW_BUTTON } from "@zody/shared";
import { cn } from "@/components/lib/utils.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export function NewTaskButtonGroup({
  onCreateTask,
  disabled = false,
}: {
  onCreateTask: () => void;
  disabled?: boolean;
}) {
  const { intl } = useZodyIntl();
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={TID_TASK_NEW_BUTTON}
      onClick={() => {
        if (!disabled) {
          runUserAction({
            input: { featureId: "task.lifecycle", action: "create", trigger: "button" },
            operation: onCreateTask,
            completed: { resultSource: "optimistic_projection" },
            failureStage: "task_create",
          });
        }
      }}
      className={cn(
        "inline-flex h-9 w-full shrink-0 items-center gap-2 rounded-md border px-2.5 text-left text-ui-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
        disabled
          ? "cursor-not-allowed border-border bg-surface text-foreground-subtle"
          : "cursor-pointer border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
      )}
    >
      <Plus aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate">{intl.formatMessage({ id: "taskList.newThread" })}</span>
      {newTaskShortcutLabel ? (
        <kbd className="ml-auto shrink-0 rounded-sm border border-current/30 px-1 font-mono text-ui-xs font-normal">
          {newTaskShortcutLabel}
        </kbd>
      ) : null}
    </button>
  );
}
