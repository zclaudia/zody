# R20.5 默认数据路径：主控复核

基线 `f28dfddcbd4e646d7fa93d2e593b91a62063b2b6`。按精确授权检查七个工具/说明/metadata 文件、领域 spec 和新的 Node 回归测试；未扩大到自动用户数据迁移或新的配置解析能力。

主控审阅差异：当前默认目标和备份/manifest 根使用 `.zody`；restore 的旧快照默认输入仍为 `.zcode/v2/sessions`，既有显式输入和数据库路径参数保持原样。局部 `zcodeRoot`/`ZCODE_PROVIDER` 改名与全部本地引用同步，`glm` 等 provider 值、历史来源、序列化键未改变。技能说明只描述实际支持的默认路径及参数，不宣称会自动识别自定义数据库配置。

Terra 先在正式工作树落地 spec 和测试，实际记录旧实现两项失败，再应用修复得到两项通过。主控又实际执行：

- `node --test scripts/test/zody-manual-data-paths.test.mjs`：2/2 通过，退出 0。
- `pnpm typecheck`：退出 0。
- `pnpm lint`：退出 0，303 warnings、0 errors。

Node 24.14.0 使用实施工作区内的绝对工具链路径。独立日志为 `output/zody-rename-validation/controller-manual-data-paths-{tests,types,lint}.log`。新测试使用异步文件/子进程 IO，所有实际生成、恢复、verify/delete 操作仅作用于独立临时 HOME/USERPROFILE 及测试库/快照；保留真实 HOME 的隔离断言。该测试采用简化 schema，证明目标路径与数据隔离，不证明完整应用数据库升级、Windows/Linux 或原生 E2E。两份 E2E metadata 仅做静态路径核对。

同候选另含 basename 后续收口：audit 脚本遗留的 store 路径前缀由 `zcodeSessionStore` 改为 `zodySessionStore`。该规则前面已有更宽的 `packages/ui/src` 分类，因此六个现行 store 文件的分类保持 `compat-type`；不增加兼容旧路径分支。`node --check` 通过。一次按 store 目录运行的 CLI JSON 扫描没有命中任何候选，不能拿它作为正向分类证据；独立规则核对及此局限记录于 `final-d49/audit-prefix-followup.*`。主控确认源码仅此一个精确前缀替换。

Terra 已执行当前变更的架构检查（0 violations）和新测试格式化；主控复核各文件 SHA、精确写范围及 diff。未运行安装、WDIO、原生构建或真实用户数据操作。本批提交后交独立 DeepSeek 审查，R20 其余类型/符号和最终门禁仍未完成。

主控冻结前再次运行增量架构检查，退出 0；日志 `controller-manual-data-paths-architecture.log`。
