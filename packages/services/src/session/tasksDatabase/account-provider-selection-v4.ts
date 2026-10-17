// fork（F4.1a）：官方账号 provider 从 Built-in Config 下线后，自动化任务里
// 仍指向 account:* 的模型选择会永远解析失败。按产品规则清空为「未配置模型」
// （SQL NULL，执行时抛「模型选择不可用，请重新选择」，绝不静默改选其他付费 provider）。
// 只动 automations 定义层；automation_runs 的 model_selection 是历史执行事实，
// off_peak_tasks 随 F4.3 整体删除，均不在本次迁移范围。
export const ACCOUNT_PROVIDER_SELECTION_REMOVAL_MIGRATION_SQL = `
UPDATE automations
SET model_selection = NULL
WHERE json_valid(model_selection)
  AND json_extract(model_selection, '$.providerId') LIKE 'account:%';
`;
