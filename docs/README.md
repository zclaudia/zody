# docs 目录说明

`docs/` 下的大部分设计、计划、调查与问题分析文档写于 Zody 改名之前，记录的是当时的背景和决策过程。其中出现的 “ZCode”、`~/.zcode/`、`~/.zcoder/`、上游 CDN、上游仓库与运营服务等，均指上游 ZCode 时期或早期 fork 阶段的状态，不代表 Zody 当前的产品名称、路径、服务或行为。这些文档保留作历史参考，不逐篇改写。

当前产品规则以 `specs/` 和发行文档为准，冲突时以它们为准：

- [Zody 0.1.0 首发规格](../specs/zody-0.1.0-release.md)：品牌、数据目录、平台、签名与分发等首发决策。
- [Zody 首发品牌残留清理规格](../specs/zody-brand-residual-cleanup.md)：保留的内部标识与已确认的改名决策。
- [路径兼容契约](../apps/zcode-cli/docs/design/v2/zody-path-compatibility.md)：`~/.zody/` 与项目级 `.zody/`、`.zcode/` 的读写规则。
- [0.1.0 发行说明](releases/zody-0.1.0.md) 与 [验收记录](releases/zody-0.1.0-validation.md)。

以下文档按 Zody 当前状态维护：

- macOS Computer Use 首期：[集成 spec（待实现提案）](../specs/computer-use-macos-phase1.md)、[详细设计评审稿](design/computer-use-macos-phase1.md)与[实施计划](plans/computer-use-macos-phase1-implementation.md)；设计完成不关闭 P0，不改变 0.1.0 未签名预览版隐藏系统级 CUA 的发行规则。
- [上游维护规则：定期审查，按需合入](fork/upstream-sync-policy.md) 与 [审查/移植台账](fork/upstream-review-ledger.md)
- [上游 v3.16.2：21 项候选补全计划](plans/upstream-v3.16.2-port-plan.md)
- [从源码构建与发布](fork/build.md)
- [Android 手机远控](mobile-remote-control-android.md)
- [Agent 远程部署](remote/zcode-agent-remote-deployment.md)
- [品牌图标草稿](brand/)：应用图标的设计母版与生成提示词，接入规则见 [应用图标接入](../specs/fork-app-icon-integration.md)。
