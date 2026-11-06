# 第三方许可收集中的 workspace 身份

生产许可声明和全部已安装包的许可检查由许可收集脚本共同负责。workspace 身份以 pnpm 项目目录的规范真实路径为准；包名、命名空间或名称与版本相同不能证明包来自 workspace。生产图中的 workspace 别名和符号链接须通过实际目标路径或可验证的 lock importer link 确认，同一 identity 规则用于实际图与 lockfile-only 图；无法证明的本地 link 应报出父路径、alias 和目标，不得静默排除。workspace 节点本身不列作第三方，但必须遍历其生产依赖。

已安装扫描按真实路径识别 workspace，保留同名同版本的外部包及全部不同物理来源；同一包的多个物理副本许可或来源不一致时停止并列出路径，不能随机选用一个。生产依赖按精确 name/version 与锁图匹配，dev-only 安装包参与基础许可检查而不自动进入生产 notices。平台和 peer 筛选、现有第三方版本、来源、许可原文及 reviewRequired 不因身份修复被改写。

验收：真实 workspace debug@0.1.0 与 npm debug@4.4.3 可同图共存，只有真实 workspace 被排除；npm debug@2.6.9 参与安装检查但不因仅安装就进入生产 notices。覆盖 workspace alias/symlink、同名同版本不同路径、workspace 的外部子依赖、未知 link、不同许可多副本、实际和 lockfile-only 图；生产声明使用真实已安装包的 LICENSE 原文字节和哈希。根锁不变，生成对须在固定干净候选中重新生成并审查；strict 未解决义务不得静默移除。

安装扫描以 name/version 为键，`copies` 列出所有不同真实目录及其 manifest；同一真实目录的别名只计一次，重复副本的许可原文和来源一致才可共用声明。pnpm 递归图的 link 相对于顶层 importer，实际路径与 link 可验证目标冲突时必须失败。

`productionPackages` 可在未传 identity 时对绝对路径做精确匹配；实际 pnpm 图必须预先使用 `prepareWorkspaceIdentity` 解析符号链接。基础检查通过 `collectInstalledLicenseRecords` 对所有物理外部包检查并标记生产归属。
