import { CRON_DEFAULT_GROUP_ID } from "@zcode/shared";

/** 系统分组标题按语言环境本地化展示，忽略 DB 里存的固定占位标题（'cron'）。
 * fork（F4.3）：OFF_PEAK_DEFAULT_GROUP_ID 分支随闲时任务全链路删除；
 * 历史库中的 off-peak 分组行回落展示 DB 占位标题。 */
function getTaskGroupDisplayTitle(
  group: { id: string; title: string },
  localizedSystemTitles: { cron: string },
): string {
  if (group.id === CRON_DEFAULT_GROUP_ID) return localizedSystemTitles.cron;
  return group.title;
}

export { getTaskGroupDisplayTitle };
